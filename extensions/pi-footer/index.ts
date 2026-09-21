import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * Editor subclass that renders the current session name (set via /name) into
 * the right edge of the input box's top border, Claude Code style, while
 * keeping pi's native status spinners (working / compaction / retry / branch
 * summary) embedded in the same border line:
 *
 *   ── ⠼ Working ────────────────── feat/auth ─
 *    input text…
 *   ───────────────────────────────────────────
 *
 * Idle (unchanged from before):
 *
 *   ───────────────────────────── feat/auth ─
 *    input text…
 *   ───────────────────────────────────────────
 *
 * Embedding requires the `embedWorkingStatus` opt-in; without it pi falls back
 * to a standalone status row above the input box. pi's own top-border renderer
 * cannot be reused directly once a label is set (it owns the whole line), so
 * this override rebuilds the same layout with the label appended on the right.
 *
 * The label only appears while an explicit session name is set — pi's
 * getSessionName() returns undefined otherwise. When editor content is scrolled
 * (hidden lines above), pi's renderer keeps ownership so its "↑ n more"
 * overflow indicator and optional status stay intact; the label is skipped in
 * that case.
 */
class SessionNameEditor extends CustomEditor {
	private readonly getName: () => string | undefined;
	private readonly color: (text: string) => string;
	// Captured from setWorkingStatusIndicator(): CustomEditor keeps its own copy
	// private, and the border renderer needs the rendered status text.
	private indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0] | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getName: () => string | undefined,
		color: (text: string) => string,
	) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.getName = getName;
		this.color = color;
	}

	override setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		super.setWorkingStatusIndicator(indicator);
		this.indicator = indicator;
	}

	override renderTopBorder(width: number, hiddenLineCount: number): string {
		// Keep pi's "↑ n more" scroll indicator (and its status layout) when lines
		// are hidden above.
		if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);

		const name = this.getName();
		if (!name) return super.renderTopBorder(width, hiddenLineCount);

		// ` session-name ` flanked by a dash run on the left and one dash on the right.
		const label = this.color(` ${name} `);
		const labelWidth = visibleWidth(label);
		// Need room for the label plus at least one trailing dash.
		if (labelWidth + 1 > width) return super.renderTopBorder(width, hiddenLineCount);

		const room = width - labelWidth - 1;
		const status = this.renderEmbeddedStatus(room);
		if (status === undefined) {
			return this.borderColor("─".repeat(room)) + label + this.borderColor("─");
		}

		// `── <status> ──── label ─`, mirroring pi's `── <status> ────` left block.
		const gap = room - 5 - visibleWidth(status);
		if (gap < 1) {
			return this.borderColor("─".repeat(room)) + label + this.borderColor("─");
		}
		return (
			this.borderColor("── ") +
			status +
			this.borderColor(` ${"─".repeat(gap)}`) +
			label +
			this.borderColor("─")
		);
	}

	/** Embedded status text for `room` free columns, degrading like pi does. */
	private renderEmbeddedStatus(room: number): string | undefined {
		const indicator = this.indicator;
		if (!this.embedWorkingStatus || !indicator || room <= 0) return undefined;

		const allowance = Math.max(1, room - 5);
		const status = indicator.renderInBorder(allowance);
		const statusWidth = visibleWidth(status);
		if (statusWidth === 0) return undefined;
		if (room - 5 - statusWidth >= 1) return status;

		// Not enough room for the label + message: keep just the spinner.
		const spinner = indicator.renderSpinnerInBorder(allowance);
		const spinnerWidth = visibleWidth(spinner);
		if (spinnerWidth === 0 || room - 5 - spinnerWidth < 1) return undefined;
		return spinner;
	}
}

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;

	// Repaint the border label whenever the session name changes (/name …).
	pi.on("session_info_changed", () => requestRender?.());

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			return new SessionNameEditor(
				tui,
				theme,
				keybindings,
				() => pi.getSessionName(),
				// Resolve the accent color at render time so theme switches apply.
				(text) => ctx.ui.theme.fg("accent", text),
			);
		});
	});

	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
