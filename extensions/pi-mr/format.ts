// Rendering for pi-mr's status line. Pure: colors come in as a `Colorize`
// callback so tests can assert on structure without a terminal theme.
import type { CiState, MrInfo, MrState } from "./forge.ts";

export type ColorRole = "accent" | "success" | "error" | "warning" | "muted" | "dim" | "text";
export type Colorize = (role: ColorRole, text: string) => string;

const STATE_ICON: Record<MrState, string> = {
	opened: "⬤",
	draft: "◌",
	merged: "✔",
	closed: "✕",
};

const STATE_ROLE: Record<MrState, ColorRole> = {
	opened: "success",
	draft: "dim",
	merged: "accent",
	closed: "error",
};

const CI_TOKEN: Record<Exclude<CiState, "none">, { text: string; role: ColorRole }> = {
	success: { text: "✓CI", role: "success" },
	failed: { text: "✗CI", role: "error" },
	running: { text: "⋯CI", role: "warning" },
};

/** OSC 8 hyperlink, so the request ref is clickable in the footer. */
function link(url: string, text: string): string {
	if (!url) return text;
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * One footer line: `⬤ !1234 ✓CI 登录改造`, or `✔ !123 ✗CI …` once merged.
 *
 * The branch name is deliberately absent — pi's footer already shows it in the
 * `~/repo/foo (branch)` line right above.
 */
export function renderMrLine(info: MrInfo, color: Colorize): string {
	const parts = [
		color(STATE_ROLE[info.state], STATE_ICON[info.state]),
		color("accent", link(info.url, info.ref)),
	];
	if (info.ci !== "none") {
		const token = CI_TOKEN[info.ci];
		parts.push(color(token.role, token.text));
	}
	if (info.conflicts) parts.push(color("warning", "⚠冲突"));
	if (info.title) parts.push(color("muted", info.title));
	return parts.join(" ");
}
