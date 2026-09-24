import {
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

import {
	describeSaveOutcome,
	FooterConfigStore,
	footerConfigPath,
	type FooterConfig,
	type SaveOutcome,
} from "./config.ts";
import {
	buildStatsLine,
	composeTopBorder,
	PRESET_NAMES,
	presetColor,
	presetIdleColor,
	TpsTracker,
	type StatsColor,
	type StatsRole,
} from "./tps.ts";

/**
 * pi-footer owns the input box's top border.
 *
 * Right edge: the session name (set via `/name`), Claude Code style. Left of
 * it: the live TPS stats line (absorbed from `pi-tps`), which degrades segment
 * by segment on narrow terminals. pi's native status spinners (working /
 * compaction / retry / branch summary) are embedded in the same border line:
 *
 *   ── ⠼ Working ──────── ⚡42t/s ↑12.3k ↓4.5k  feat/auth ─
 *    input text…
 *   ───────────────────────────────────────────────────────
 *
 * With no session name and no stats yet the border is the plain dash run pi
 * draws natively. Embedding the status requires `embedWorkingStatus`; without
 * it pi falls back to a standalone status row above the input box. pi's own
 * top-border renderer cannot be reused once we add content (it owns the whole
 * line), so this override rebuilds the same layout.
 *
 * While the editor content is scrolled (hidden lines above), pi's renderer
 * keeps ownership so its "↑ n more" overflow indicator stays intact; the name
 * and the stats line are skipped in that case.
 */

// ── colors ───────────────────────────────────────────────────────────────

type AppTheme = ExtensionContext["ui"]["theme"];
type ThemeColorName = Parameters<AppTheme["fg"]>[0];

const THEME_ROLES: Record<StatsRole, ThemeColorName> = {
	core: "text",
	input: "muted",
	output: "success",
	tools: "accent",
	ttft: "warning",
	think: "thinkingText",
	duration: "dim",
};

/** Colorizer for the stats line: theme-driven, or one of pi-tps' 256-color presets. */
function statsColorizer(theme: AppTheme, preset: string, idle: boolean): StatsColor {
	if (preset !== "theme") return idle ? presetIdleColor(preset) : presetColor(preset);
	if (idle) return (_role, text) => theme.fg("muted", text);
	return (role, text) => theme.fg(THEME_ROLES[role], text);
}

// ── editor ───────────────────────────────────────────────────────────────

interface EditorDeps {
	tracker: TpsTracker;
	getName: () => string | undefined;
	getConfig: () => FooterConfig;
	getTheme: () => AppTheme;
	accent: (text: string) => string;
}

class StatsEditor extends CustomEditor {
	private readonly deps: EditorDeps;
	// Captured from setWorkingStatusIndicator(): CustomEditor keeps its own copy
	// private, and the border renderer needs the rendered status text.
	private indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0] | undefined;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, deps: EditorDeps) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.deps = deps;
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		super.setWorkingStatusIndicator(indicator);
		this.indicator = indicator;
	}

	override renderTopBorder(width: number, hiddenLineCount: number): string {
		// Keep pi's "↑ n more" scroll indicator (and its status layout) when lines
		// are hidden above.
		if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);

		const { tracker, getConfig, getTheme } = this.deps;
		const config = getConfig();
		const snapshot = config.showStats ? tracker.snapshot(Date.now()) : null;
		const color = statsColorizer(getTheme(), config.colorPreset, !tracker.isWorking);
		const name = this.deps.getName();

		const line = composeTopBorder({
			width,
			nameLabel: name ? this.deps.accent(` ${name} `) : "",
			border: this.borderColor,
			renderStats: (maxWidth) =>
				snapshot ? buildStatsLine(snapshot, { showTtft: config.showTtft, maxWidth, color }) : "",
			renderStatus: (allowance) => this.renderEmbeddedStatus(allowance) ?? "",
		});

		// Safety net: never hand the editor a line wider (or narrower) than the
		// border it is drawing into.
		return visibleWidth(line) === width ? line : super.renderTopBorder(width, hiddenLineCount);
	}

	/** Embedded status text for `allowance` free columns, degrading like pi does. */
	private renderEmbeddedStatus(allowance: number): string | undefined {
		const indicator = this.indicator;
		if (!this.embedWorkingStatus || !indicator || allowance <= 0) return undefined;

		const status = indicator.renderInBorder(allowance);
		if (visibleWidth(status) > 0) return status;

		const spinner = indicator.renderSpinnerInBorder(allowance);
		return visibleWidth(spinner) > 0 ? spinner : undefined;
	}
}

// ── extension ────────────────────────────────────────────────────────────

/** Repaint throttle for streaming deltas (the working spinner already drives 80ms frames). */
const DELTA_RENDER_MS = 80;

export default function (pi: ExtensionAPI) {
	const tracker = new TpsTracker();
	// getAgentDir() honours PI_CODING_AGENT_DIR; the store owns read/write of the file.
	const store = new FooterConfigStore(footerConfigPath(getAgentDir()));
	let config = store.current;
	let requestRender: (() => void) | undefined;
	let lastDeltaRender = 0;

	const repaint = () => requestRender?.();

	// Repaint the border label whenever the session name changes (/name …).
	pi.on("session_info_changed", () => repaint());

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		config = store.reload();

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			return new StatsEditor(tui, theme, keybindings, {
				tracker,
				getName: () => pi.getSessionName(),
				getConfig: () => config,
				getTheme: () => ctx.ui.theme,
				// Resolve the accent color at render time so theme switches apply.
				accent: (text) => ctx.ui.theme.fg("accent", text),
			});
		});
	});

	// ── TPS tracking (absorbed from pi-tps) ──

	pi.on("agent_start", () => {
		tracker.agentStart();
		repaint();
	});

	pi.on("turn_start", () => tracker.turnStart());

	pi.on("turn_end", () => {
		tracker.turnEnd();
		repaint();
	});

	pi.on("before_provider_request", () => tracker.beforeProviderRequest(Date.now()));

	pi.on("message_start", (event) => {
		if (event.message.role !== "assistant") return;
		tracker.messageStart(Date.now(), { input: event.message.usage?.input });
		repaint();
	});

	pi.on("message_update", (event) => {
		if (event.message.role !== "assistant") return;

		const delta = event.assistantMessageEvent;
		const text = delta?.type === "text_delta" && delta.delta ? delta.delta.length : 0;
		const thinking = delta?.type === "thinking_delta" && delta.delta ? delta.delta.length : 0;
		// Tool-call arguments are generated tokens too: without them a message that
		// streams a large `write` shows no rate at all, or a rate that keeps sinking.
		const toolCall = delta?.type === "toolcall_delta" && delta.delta ? delta.delta.length : 0;
		// pi appends the thinking block before its first token arrives, so an empty
		// block must not be mistaken for first content (it would report a TTFT of
		// roughly the prefill time instead of the time to the first token).
		const hasThinkingContent = (event.message.content ?? []).some(
			(block) => block.type === "thinking" && block.thinking.length > 0,
		);
		if (text === 0 && thinking === 0 && toolCall === 0 && !hasThinkingContent) return;

		const now = Date.now();
		tracker.messageDelta(now, {
			text,
			thinking,
			toolCall,
			hasThinkingContent,
			usage: event.message.usage,
		});

		if (now - lastDeltaRender >= DELTA_RENDER_MS) {
			lastDeltaRender = now;
			repaint();
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		tracker.messageEnd(Date.now(), event.message.usage);
		repaint();
	});

	pi.on("tool_execution_start", () => {
		tracker.toolStart();
		repaint();
	});

	pi.on("tool_execution_end", () => repaint());

	// The run is over: keep the numbers on screen (muted) instead of clearing
	// them — pi-execution-time already reports the elapsed time in the footer.
	pi.on("agent_end", () => {
		tracker.agentEnd();
		repaint();
	});

	// ── /pi-footer ──

	pi.registerCommand("pi-footer", {
		description: "Configure the input box border (TPS stats, TTFT, colors)",
		handler: async (_args, ctx) => {
			// Applies immediately (the border repaints with the new value) and reports the
			// disk outcome separately: a failed write must not look like a success.
			const apply = async (update: Partial<FooterConfig>, label: string): Promise<void> => {
				const saved = store.set(update);
				config = store.current;
				repaint();
				let outcome: SaveOutcome = { ok: true };
				try {
					await saved;
				} catch (error) {
					outcome = { ok: false, error };
				}
				const { message, level } = describeSaveOutcome(label, outcome);
				ctx.ui.notify(message, level);
			};

			const choices = [
				`TPS stats         [${config.showStats ? "on" : "off"}]`,
				`Show TTFT         [${config.showTtft ? "on" : "off"}]`,
				`Color preset      [${config.colorPreset}]`,
			];
			const choice = await ctx.ui.select("pi-footer:", choices);
			if (!choice) return;

			if (choice === choices[0]) {
				const showStats = !config.showStats;
				await apply({ showStats }, `showStats = ${showStats ? "on" : "off"}`);
			} else if (choice === choices[1]) {
				const showTtft = !config.showTtft;
				await apply({ showTtft }, `showTtft = ${showTtft ? "on" : "off"}`);
			} else if (choice === choices[2]) {
				const options = [
					"theme (follow the pi theme)",
					...PRESET_NAMES.map((name) => {
						const swatch = presetColor(name);
						return `${name}  ${swatch("core", "█")}${swatch("output", "█")}${swatch("tools", "█")}${swatch("duration", "█")}`;
					}),
				];
				const picked = await ctx.ui.select("Color preset:", options);
				if (!picked) return;
				const colorPreset = picked.startsWith("theme") ? "theme" : picked.split("  ")[0];
				await apply({ colorPreset }, `colorPreset = ${colorPreset}`);
			}
		},
	});

	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
