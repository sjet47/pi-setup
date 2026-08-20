import { createHash } from "node:crypto";
import { Key, matchesKey, type OverlayHandle } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { StatsStore } from "../store";
import type { TpsScale } from "./types";
import { TpsStatsOverlay } from "./overlay";

interface TpsStatsExtensionDeps {
  ensureStore(ctx: ExtensionContext): Promise<StatsStore | undefined>;
}

export function registerTpsStatsExtension(pi: ExtensionAPI, deps: TpsStatsExtensionDeps) {
  interface TrackedMessage {
    provider: string;
    model: string;
    project: string;
    startAt: number;
    firstContentAt: number;
    thinkingLevel: string;
    streamedThinkChars: number;
  }

  let requestSentAt = 0;
  let tracked: TrackedMessage | null = null;

  pi.on("before_provider_request", () => {
    requestSentAt = Date.now();
  });

  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    const provider = stringValue(message.provider);
    const model = stringValue(message.model);
    if (!provider || !model) return;
    tracked = {
      provider,
      model,
      project: ctx.cwd,
      startAt: requestSentAt > 0 ? requestSentAt : numberValue(message.timestamp) || Date.now(),
      firstContentAt: 0,
      thinkingLevel: stringValue(pi.getThinkingLevel()),
      streamedThinkChars: 0,
    };
  });

  pi.on("message_update", (event) => {
    if (!tracked) return;
    const deltaEvent = event.assistantMessageEvent;
    if (!deltaEvent) return;
    if (deltaEvent.type === "text_delta" && typeof deltaEvent.delta === "string") {
      if (tracked.firstContentAt === 0) tracked.firstContentAt = Date.now();
    } else if (deltaEvent.type === "thinking_delta" && typeof deltaEvent.delta === "string") {
      if (tracked.firstContentAt === 0) tracked.firstContentAt = Date.now();
      tracked.streamedThinkChars += deltaEvent.delta.length;
    }
  });

  pi.on("message_end", async (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!tracked) return;

    const activeStore = await deps.ensureStore(ctx);
    if (!activeStore) return;

    const outputTokens = numberValue(message.usage?.output);
    if (outputTokens <= 0) {
      tracked = null;
      requestSentAt = 0;
      return;
    }

    const endAt = Date.now();
    const ttftMs = tracked.firstContentAt > 0 ? Math.max(tracked.firstContentAt - tracked.startAt, 0) : 0;
    const durationMs = tracked.firstContentAt > 0
      ? Math.max(endAt - tracked.firstContentAt, 0)
      : Math.max(endAt - tracked.startAt, 0);
    if (durationMs >= 250) {
      const reasoningTokens = numberValue((message.usage as { reasoning?: unknown } | undefined)?.reasoning) || Math.floor(tracked.streamedThinkChars / 4);
      const createdAt = Math.floor(tracked.startAt / 1000);
      const responseId = stringValue(message.responseId);
      const originKey = responseId
        ? `msg:${responseId}`
        : `msg:${sha1(`${tracked.provider}|${tracked.model}|${createdAt}|${messageFingerprint(message.content)}`)}`;
      activeStore.insertSample({
        provider: tracked.provider,
        model: tracked.model,
        project: tracked.project,
        createdAt,
        thinkingLevel: tracked.thinkingLevel || "unknown",
        ttftMs,
        durationMs,
        outputTokens,
        reasoningTokens,
        originKey,
      });
    }
    tracked = null;
    requestSentAt = 0;
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    tracked = null;
    requestSentAt = 0;
  });

  pi.registerCommand("tps-stats", {
    description: "Show live provider/model TPS trends (TTFT, throughput, thinking tokens)",
    handler: async (_args, ctx) => {
      const activeStore = await deps.ensureStore(ctx);
      if (!activeStore) {
        ctx.ui.notify("pi-stats is disabled; check the earlier warning for details.", "warning");
        return;
      }
      await showStatsOverlay(ctx, activeStore);
    },
  });

  async function showStatsOverlay(ctx: ExtensionContext, activeStore: StatsStore) {
    const rows = activeStore.listModels();
    let overlayHandle: OverlayHandle | undefined;
    const getTrend = (provider: string, model: string, scale: TpsScale) =>
      activeStore.queryTrend({ provider, model, scale });

    await ctx.ui.custom<null>(
      (tui, theme, _keybindings, done) => {
        let closed = false;
        let waitingForTopOverlay = false;
        let unsubscribeInput: (() => void) | undefined;

        const finishClose = () => {
          if (closed) return;
          closed = true;
          unsubscribeInput?.();
          done(null);
        };
        const close = () => finishClose();
        const closeFromUnderneath = () => {
          if (closed || waitingForTopOverlay || !overlayHandle) return;
          overlayHandle.hide();
          waitingForTopOverlay = true;
        };

        const overlay = new TpsStatsOverlay(rows, themeToOverlayTheme(theme), close, getTrend);
        unsubscribeInput = tui.addInputListener((data) => {
          if (waitingForTopOverlay) {
            // The top overlay handles the key first; once it is removed from
            // the stack, done() can safely finish this hidden custom UI.
            queueMicrotask(() => {
              if (!waitingForTopOverlay) return;
              if (!(tui as unknown as { hasOverlayEntries: boolean }).hasOverlayEntries) finishClose();
            });
            return undefined;
          }
          if (!matchesKey(data, Key.escape)) return undefined;
          if (!overlay.focused) {
            closeFromUnderneath();
            return { consume: true };
          }
          if (!overlay.shouldCloseOnEscape()) return undefined;
          close();
          return { consume: true };
        });
        return {
          get focused() {
            return overlay.focused;
          },
          set focused(value: boolean) {
            overlay.focused = value;
          },
          render: (width: number) => overlay.render(width),
          invalidate: () => overlay.invalidate(),
          handleInput: (data: string) => {
            overlay.handleInput(data);
            tui.requestRender();
          },
          dispose: () => {
            unsubscribeInput?.();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 72,
          maxHeight: "80%",
          anchor: "center",
          margin: 1,
        },
        onHandle: (handle) => {
          overlayHandle = handle;
        },
      },
    );
  }
}

function themeToOverlayTheme(theme: Theme) {
  return {
    fg: (color: "accent" | "border" | "borderMuted" | "dim" | "muted" | "success" | "warning", text: string) =>
      theme.fg(color, text),
    bold: (text: string) => theme.bold(text),
  };
}

function messageFingerprint(content: unknown): string {
  if (typeof content === "string") return sha1(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
    if (record.type === "thinking" && typeof record.thinking === "string") parts.push(record.thinking);
  }
  return sha1(parts.join("\n"));
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
