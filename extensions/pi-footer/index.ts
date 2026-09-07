import { CustomEditor, type ExtensionAPI, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";

/**
 * Editor subclass that renders the current session name (set via /name) into
 * the right edge of the input box's top border, Claude Code style:
 *
 *   ──────────────────────────────── feat/auth ─
 *    input text…
 *   ─────────────────────────────────────────────
 *
 * The label only appears while an explicit session name is set — pi's
 * getSessionName() returns undefined otherwise. When editor content is scrolled
 * (hidden lines above), the top border shows the "↑ n more" indicator instead;
 * the label is skipped in that case so the scroll indicator stays intact.
 */
class SessionNameEditor extends CustomEditor {
	private readonly getName: () => string | undefined;
	private readonly color: (text: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		getName: () => string | undefined,
		color: (text: string) => string,
	) {
		super(tui, theme, keybindings);
		this.getName = getName;
		this.color = color;
	}

	override renderTopBorder(width: number, hiddenLineCount: number): string {
		// Keep the "↑ n more" scroll indicator when lines are hidden above.
		if (hiddenLineCount > 0) return super.renderTopBorder(width, hiddenLineCount);

		const name = this.getName();
		if (!name) return super.renderTopBorder(width, hiddenLineCount);

		// ` session-name ` flanked by a dash run on the left and one dash on the right.
		const label = this.color(` ${name} `);
		const labelWidth = visibleWidth(label);
		// Need room for the label plus at least one trailing dash.
		if (labelWidth + 1 > width) return super.renderTopBorder(width, hiddenLineCount);

		const fill = width - labelWidth - 1;
		return this.borderColor("─".repeat(fill)) + label + this.borderColor("─");
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
