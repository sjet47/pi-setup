import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Feature rules ──────────────────────────────────────────────────

type FastRule = {
  /** Glob-style match on model.api. If the model's api starts with this prefix, the rule applies. */
  api: string;
  /** Key to inject into the provider request payload. */
  injectionKey: string;
  /** Value for the injection key. */
  injectionValue: string;
  /** Optional: only apply when model.provider matches as well. */
  provider?: string;
  /** Optional: restrict to specific model IDs (glob/regex). Omit = all models with matching api. */
  modelIds?: RegExp;
};

const DEFAULT_RULES: FastRule[] = [
  // OpenAI-compatible APIs → service_tier
  { api: "openai-", injectionKey: "service_tier", injectionValue: "priority" },
  // Anthropic-compatible APIs → speed + beta header
  { api: "anthropic-", injectionKey: "speed", injectionValue: "fast" },
];

// ── Status ─────────────────────────────────────────────────────────

const STATUS_KEY = "fast-mode";
const STATE_ENTRY_TYPE = "fast-mode";

// ── Helpers ────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function ruleMatches(rule: FastRule, model: { provider: string; api: string; id: string }): boolean {
  if (rule.provider && rule.provider !== model.provider) return false;
  if (!model.api.startsWith(rule.api)) return false;
  if (rule.modelIds && !rule.modelIds.test(model.id)) return false;
  return true;
}

function findRule(rules: FastRule[], model: { provider: string; api: string; id: string }): FastRule | undefined {
  return rules.find((r) => ruleMatches(r, model));
}

// ── Config (optional override file) ────────────────────────────────

interface UserConfig {
  enabled?: boolean;
  rules?: FastRule[];
  /** Model IDs explicitly excluded (glob). */
  exclude?: string[];
}

const GLOBAL_CONFIG_DIR = join(process.env.HOME ?? "/tmp", ".pi", "agent", "extensions", "pi-fast-mode");
const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");
const PROJECT_CONFIG_NAME = ".pi-fast-mode.json";

async function configExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

async function loadConfig(cwd: string): Promise<UserConfig> {
  // project-level first
  const projectPath = join(cwd, PROJECT_CONFIG_NAME);
  if (await configExists(projectPath)) {
    return JSON.parse(await readFile(projectPath, "utf8")) as UserConfig;
  }
  // then global
  if (await configExists(GLOBAL_CONFIG_PATH)) {
    return JSON.parse(await readFile(GLOBAL_CONFIG_PATH, "utf8")) as UserConfig;
  }
  return {};
}

async function saveEnabledState(enabled: boolean): Promise<void> {
  try {
    await mkdir(GLOBAL_CONFIG_DIR, { recursive: true });
    // Read existing config, merge enabled, write back
    let cfg: UserConfig = {};
    try { cfg = JSON.parse(await readFile(GLOBAL_CONFIG_PATH, "utf8")) as UserConfig; } catch { /* ignore */ }
    cfg.enabled = enabled;
    await writeFile(GLOBAL_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
  } catch { /* best-effort */ }
}

function isExcluded(model: { id: string }, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  // Simple prefix/glob matching
  return exclude.some((pat) => {
    if (pat.endsWith("*")) return model.id.startsWith(pat.slice(0, -1));
    return model.id === pat;
  });
}

// ── Anthropic beta header management ───────────────────────────────

const ANTHROPIC_FAST_BETA = "fast-mode-2026-02-01";

function syncAnthropicBeta(model: { provider: string; api: string; headers?: Record<string, string> } | undefined, enabled: boolean): void {
  if (!model || model.provider !== "anthropic") return;
  const headers = model.headers ?? (model as Record<string, unknown>).headers as Record<string, string> | undefined;
  if (!headers) return;
  const existing = (headers["anthropic-beta"] ?? headers["Anthropic-Beta"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const next = enabled
    ? Array.from(new Set([...existing, ANTHROPIC_FAST_BETA]))
    : existing.filter((b) => b !== ANTHROPIC_FAST_BETA);
  delete headers["Anthropic-Beta"];
  if (next.length > 0) headers["anthropic-beta"] = next.join(",");
  else delete headers["anthropic-beta"];
}

// ── Extension ──────────────────────────────────────────────────────

export default function fastModeExtension(pi: ExtensionAPI) {
  let enabled = false;
  let rules: FastRule[] = [...DEFAULT_RULES];
  let exclude: string[] = [];
  let configWarnShown = false;

  function currentModelLabel(ctx: ExtensionContext): string {
    const m = ctx.model;
    return m ? `${m.provider}/${m.id} (api=${m.api})` : "none";
  }

  function resolveModel(ctx: ExtensionContext): { provider: string; api: string; id: string; headers?: Record<string, string> } | undefined {
    const m = ctx.model;
    if (!m) return undefined;
    // The model object shape: { provider, id, api, ... }. `api` may be on the provider config, not each model.
    // Use provider-level api from the model registry.
    return {
      provider: m.provider,
      api: (m as Record<string, unknown>).api as string ?? "",
      id: m.id,
      headers: (m as Record<string, unknown>).headers as Record<string, string> | undefined,
    };
  }

  function modelStatus(ctx: ExtensionContext): { rule: FastRule | undefined; supported: boolean; reason?: string } {
    const model = resolveModel(ctx);
    if (!model) return { rule: undefined, supported: false, reason: "no model" };
    const rule = findRule(rules, model);
    if (!rule) return { rule: undefined, supported: false, reason: `${model.provider}/${model.id} 没有匹配的 fast mode 规则 (api=${model.api})` };
    if (isExcluded(model, exclude)) return { rule, supported: false, reason: `${model.id} 在排除列表中` };
    return { rule, supported: true };
  }

  function statusText(ctx: ExtensionContext): string {
    const m = resolveModel(ctx);
    if (!enabled) return "Fast mode OFF";
    const st = modelStatus(ctx);
    if (!st.supported) return `Fast mode ON — ${st.reason ?? "当前模型不支持"}`;
    return `Fast mode ON — 注入 ${st.rule!.injectionKey}=${st.rule!.injectionValue}`;
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!enabled) { ctx.ui.setStatus(STATUS_KEY, undefined); return; }
    const st = modelStatus(ctx);
    const theme = ctx.ui.theme;
    if (!st.supported) {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("muted", "⚡"));
    } else {
      ctx.ui.setStatus(STATUS_KEY, theme.fg("accent", "⚡fast"));
    }
  }

  function persistState(ctx: ExtensionContext): void {
    pi.appendEntry(STATE_ENTRY_TYPE, { enabled });
    saveEnabledState(enabled);
  }

  async function restoreState(ctx: ExtensionContext): Promise<void> {
    // Check session history
    const entries = ctx.sessionManager.getBranch();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "custom" && e.customType === STATE_ENTRY_TYPE && isRecord(e.data) && typeof e.data.enabled === "boolean") {
        enabled = e.data.enabled;
        updateStatus(ctx);
        return;
      }
    }
    // Fall back to config file
    try {
      const cfg = await loadConfig(ctx.cwd);
      if (typeof cfg.enabled === "boolean") {
        enabled = cfg.enabled;
        updateStatus(ctx);
        return;
      }
    } catch { /* ignore */ }
    // Fall back to flag or default
    enabled = pi.getFlag("fast") === true;
    updateStatus(ctx);
  }

  async function loadRules(ctx: ExtensionContext): Promise<void> {
    try {
      const cfg = await loadConfig(ctx.cwd);
      if (cfg.rules && cfg.rules.length > 0) rules = cfg.rules;
      if (cfg.exclude) exclude = cfg.exclude;
      configWarnShown = false;
    } catch (err) {
      rules = [...DEFAULT_RULES];
      exclude = [];
      if (!configWarnShown) {
        ctx.ui.notify(`pi-fast-mode: 配置加载失败，使用默认规则: ${(err as Error).message}`, "warning");
        configWarnShown = true;
      }
    }
  }

  // ── Commands ────────────────────────────────────────

  pi.registerCommand("fast", {
    description: "Toggle fast mode on/off. Usage: /fast [on|off|status]",
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();
      if (cmd === "on" || cmd === "enable") { enabled = true; }
      else if (cmd === "off" || cmd === "disable") { enabled = false; }
      else if (cmd === "status" || cmd === "") { /* show below */ }
      else if (cmd === "reload") {
        await loadRules(ctx);
        ctx.ui.notify(`pi-fast-mode: 规则已重新加载 (${rules.length} 条)`, "info");
        return;
      }
      else { ctx.ui.notify("用法: /fast [on|off|status|reload]", "warning"); return; }

      persistState(ctx);
      updateStatus(ctx);
      ctx.ui.notify(statusText(ctx), enabled ? "info" : "info");
    },
  });

  pi.registerShortcut("f3", {
    description: "Toggle fast mode",
    handler: async (ctx) => {
      enabled = !enabled;
      persistState(ctx);
      updateStatus(ctx);
      ctx.ui.notify(statusText(ctx), "info");
    },
  });

  pi.registerFlag("fast", {
    description: "Start with fast mode enabled",
    type: "boolean",
    default: false,
  });

  // ── Events ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    await loadRules(ctx);
    await restoreState(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreState(ctx);
  });

  pi.on("session_shutdown", async () => {
    enabled = false;
  });

  pi.on("model_select", async (_event, ctx) => {
    const model = resolveModel(ctx);
    syncAnthropicBeta(model, enabled);
    updateStatus(ctx);
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!enabled) return;
    const model = resolveModel(ctx);
    if (!model) return;
    const st = modelStatus(ctx);
    if (!st.supported || !st.rule) return;
    if (!isRecord(event.payload)) return;

    // Already has the key set — don't override
    if (st.rule.injectionKey in event.payload) return;

    return {
      ...event.payload,
      [st.rule.injectionKey]: st.rule.injectionValue,
    };
  });
}
