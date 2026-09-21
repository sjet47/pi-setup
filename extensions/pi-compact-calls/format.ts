/**
 * Pure formatting / selection logic for pi-compact-calls.
 *
 * Nothing in here touches the pi runtime, so it can be unit-tested with plain
 * `node --test` (see tests/).
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { homedir } from "os";

/** Theme access, injected so the helpers stay testable without a pi theme. */
export type Paint = {
	fg(color: string, text: string): string;
	bold(text: string): string;
};

export const PLAIN_PAINT: Paint = { fg: (_color, text) => text, bold: (text) => text };

/**
 * Sanity bound for a summary string. The visible length is decided later by the
 * terminal width (see composeToolLine), not by this.
 */
export const SUMMARY_HARD_LIMIT = 240;
/** An error tail narrower than this is not worth showing. */
const MIN_ERROR_TAIL_WIDTH = 12;

/** The slice of a tool entry the pure helpers need. */
export type ToolView = {
	name: string;
	args: any;
	/** Executing right now (between tool_execution_start and its end). */
	pending: boolean;
	/** A final result exists (live end event, or a replayed history row). */
	hasResult: boolean;
	isError: boolean;
};

/**
 * - queued:  the call is known (args streaming / waiting for its turn) but has
 *            neither started nor produced a result; also where calls that never
 *            ran (abort) end up.
 * - running: between tool_execution_start and tool_execution_end.
 * - ok / failed: a final result exists.
 */
export type ToolState = "queued" | "running" | "ok" | "failed";

export function toolState(tool: ToolView): ToolState {
	if (tool.pending) return "running";
	if (tool.hasResult) return tool.isError ? "failed" : "ok";
	return "queued";
}

export function shortenPath(path: string, home: string = homedir()): string {
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function oneLine(value: unknown, max = SUMMARY_HARD_LIMIT): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatDuration(ms: number): string {
	const clamped = Math.max(0, ms);
	// Round once, then split: rounding a part on its own can yield "60.0s" / "1m 60s".
	const tenths = Math.round(clamped / 100);
	if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
	const totalSeconds = Math.round(clamped / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${totalSeconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** A multi-line command shows its first non-empty line plus " …". */
function bashSummary(command: unknown): string {
	if (typeof command !== "string") return "…";
	const lines = command.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return "…";
	return lines.length > 1 ? `${oneLine(lines[0], SUMMARY_HARD_LIMIT - 2)} …` : oneLine(lines[0]);
}

/** read's 1-based offset/limit as `:120-180`, `:120+` (offset only) or `:1-50` (limit only). */
function readRange(offset: unknown, limit: unknown): string {
	const hasOffset = typeof offset === "number" && Number.isFinite(offset) && offset > 0;
	const hasLimit = typeof limit === "number" && Number.isFinite(limit) && limit > 0;
	if (!hasOffset && !hasLimit) return "";
	const first = hasOffset ? Math.floor(offset as number) : 1;
	return hasLimit ? `:${first}-${first + Math.floor(limit as number) - 1}` : `:${first}+`;
}

export function summaryOf(name: string, rawArgs: any): string {
	const args: any = rawArgs ?? {};
	switch (name) {
		case "bash":
			return bashSummary(args.command);
		case "read":
			return oneLine(shortenPath(String(args.path ?? "…")) + readRange(args.offset, args.limit));
		case "write":
		case "edit":
			return oneLine(shortenPath(String(args.path ?? "…")));
		case "find":
			return oneLine(`${args.pattern ?? ""} in ${shortenPath(String(args.path ?? "."))}`);
		case "grep": {
			const glob = typeof args.glob === "string" && args.glob.length > 0 ? ` [${args.glob}]` : "";
			return oneLine(`${args.pattern ?? ""} in ${shortenPath(String(args.path ?? "."))}${glob}`);
		}
		case "ls":
			return oneLine(shortenPath(String(args.path ?? ".")));
		default: {
			const preferred = args.path ?? args.query ?? args.name ?? args.description ?? args.url;
			if (preferred !== undefined) return oneLine(preferred);
			try {
				return oneLine(JSON.stringify(args));
			} catch {
				return "…";
			}
		}
	}
}

/**
 * The single call shown while collapsed: the newest still-running call wins,
 * then the most recent failure (so a collapsed block never hides one), then the
 * last call.
 */
export function pickCollapsedTool<T extends ToolView>(tools: readonly T[]): T {
	for (let index = tools.length - 1; index >= 0; index--) {
		if (tools[index]!.pending) return tools[index]!;
	}
	for (let index = tools.length - 1; index >= 0; index--) {
		if (toolState(tools[index]!) === "failed") return tools[index]!;
	}
	return tools[tools.length - 1]!;
}

export type DiffStat = { added: number; removed: number };

/**
 * Count changed lines in pi's display-oriented edit diff (`EditToolDetails.diff`):
 * every line is `+<num> text`, `-<num> text` or ` <num> text`, without file headers.
 */
export function diffStat(diff: string): DiffStat {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Lines in a written file; a trailing newline does not start another line. */
export function countLines(content: unknown): number {
	const text = typeof content === "string" ? content : "";
	if (text.length === 0) return 0;
	const breaks = text.split("\n").length - 1;
	return text.endsWith("\n") ? breaks : breaks + 1;
}

/**
 * The most telling line of a failed tool's output: its last non-empty line.
 * bash ends every failure with "Command exited with code N", which says nothing
 * about the cause, so the line before it is used and the code is appended.
 */
export function errorTail(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0);
	const last = lines[lines.length - 1];
	if (last === undefined) return "";
	const exit = /^Command exited with code (\d+)$/.exec(last);
	const before = lines[lines.length - 2];
	if (exit && before === "(no output)") return `exit ${exit[1]}`;
	// Drop the shell's own "/bin/bash: line 1: " lead so the cause survives truncation.
	if (exit && before !== undefined) return `${before.replace(/^\S*sh: (line \d+: )?/, "")} (exit ${exit[1]})`;
	return last;
}

export type PreviewMode = "head" | "tail";

/** bash output is most interesting at its end; file-ish results at their start. */
export function previewModeOf(toolName: string): PreviewMode {
	return toolName === "bash" ? "tail" : "head";
}

export type CapturedText = { text: string; totalLines: number };

/**
 * Bound the text kept in memory, keeping the end that the preview will show, and
 * remember how many lines the full text had so "… N more lines" stays truthful.
 * A line cut in half by the bound is dropped.
 */
export function captureText(full: string, limit: number, mode: PreviewMode): CapturedText {
	const totalLines = full.length === 0 ? 0 : full.split("\n").length;
	if (full.length <= limit) return { text: full, totalLines };
	if (mode === "tail") {
		const cut = full.slice(full.length - limit);
		const firstBreak = cut.indexOf("\n");
		return { text: firstBreak >= 0 ? cut.slice(firstBreak + 1) : cut, totalLines };
	}
	const cut = full.slice(0, limit);
	const lastBreak = cut.lastIndexOf("\n");
	return { text: lastBreak > 0 ? cut.slice(0, lastBreak) : cut, totalLines };
}

export type Preview = { lines: string[]; hidden: number; mode: PreviewMode };

/**
 * Pick the preview rows: the first `max` lines, or for "tail" the last `max`.
 * `totalLines` is the line count of the full (unbounded) text.
 */
export function selectPreview(text: string, max: number, mode: PreviewMode, totalLines = 0): Preview {
	if (text.length === 0 || max <= 0) return { lines: [], hidden: 0, mode };
	const all = text.split("\n");
	const lines = mode === "tail" ? all.slice(-max) : all.slice(0, max);
	return { lines, hidden: Math.max(totalLines, all.length) - lines.length, mode };
}

export type Interval = { start: number; end?: number };

/**
 * Total time covered by the union of the intervals: overlapping (parallel) calls
 * count once, gaps (the model generating the next call) do not count at all. An
 * interval without an end is still running and counts up to `now`.
 */
export function unionDuration(intervals: readonly Interval[], now: number): number {
	const spans = intervals
		.map((interval) => ({ start: interval.start, end: Math.max(interval.start, interval.end ?? now) }))
		.sort((a, b) => a.start - b.start);
	let total = 0;
	let coveredUntil = Number.NEGATIVE_INFINITY;
	for (const span of spans) {
		if (span.end <= coveredUntil) continue;
		total += span.end - Math.max(span.start, coveredUntil);
		coveredUntil = span.end;
	}
	return total;
}

/**
 * - running:    some call is executing.
 * - idle:       nothing executing, block still open — the model is producing the
 *               next call, so the outcome is not settled yet.
 * - ok / failed / incomplete: closed block; incomplete = some call never ran.
 */
export type HeaderState = "running" | "idle" | "ok" | "failed" | "incomplete";

export function headerState(tools: readonly ToolView[], closed: boolean): HeaderState {
	if (tools.some((tool) => tool.pending)) return "running";
	if (!closed) return "idle";
	if (tools.some((tool) => toolState(tool) === "failed")) return "failed";
	if (tools.some((tool) => toolState(tool) !== "ok")) return "incomplete";
	return "ok";
}

const HEADER_COLORS: Record<HeaderState, string> = {
	running: "accent",
	idle: "muted",
	ok: "success",
	failed: "error",
	incomplete: "muted",
};

/**
 * "4 read, 2 grep, 1 bash" — most frequent first, ties in order of appearance.
 * Empty when every call uses the same tool: the activity line already names it.
 */
export function typeBreakdown(names: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
	if (counts.size < 2) return "";
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1]) // stable: equal counts keep insertion order
		.map(([name, count]) => `${count} ${name}`)
		.join(", ");
}

export type HeaderParts = {
	state: HeaderState;
	icon: string;
	count: number;
	failed: number;
	durationMs: number;
	/** e.g. "4 read, 2 grep, 1 bash"; shown in parentheses after the count. */
	breakdown?: string;
	/** Dim trailing hint, e.g. "Ctrl+O to expand" (collapsed blocks only). */
	hint?: string;
};

/**
 * Compose the block header for `width` columns. When it does not fit, optional
 * parts are dropped lowest priority first; the priority (high → low) is
 * count > failed > duration > breakdown > hint.
 */
export function composeHeader(parts: HeaderParts, width: number, paint: Paint = PLAIN_PAINT): string {
	const color = HEADER_COLORS[parts.state];
	const sep = ` ${paint.fg("muted", "·")} `;
	const head = `${paint.fg(color, parts.icon)} ${paint.fg(color, paint.bold(`${parts.count} tool calls`))}`;
	// Display order; `drop` is the order in which parts are given up (0 first).
	const optional: { text: string; drop: number }[] = [];
	if (parts.breakdown) optional.push({ text: ` ${paint.fg("dim", `(${parts.breakdown})`)}`, drop: 1 });
	if (parts.failed > 0) optional.push({ text: sep + paint.fg("error", `${parts.failed} failed`), drop: 3 });
	optional.push({ text: sep + paint.fg("muted", formatDuration(parts.durationMs)), drop: 2 });
	if (parts.hint) optional.push({ text: sep + paint.fg("dim", parts.hint), drop: 0 });

	let kept = optional;
	for (;;) {
		const line = head + kept.map((part) => part.text).join("");
		if (visibleWidth(line) <= width || kept.length === 0) return line;
		const lowest = Math.min(...kept.map((part) => part.drop));
		kept = kept.filter((part) => part.drop !== lowest);
	}
}

/** Truncate plain (unstyled) text to `width` columns; wide characters are handled by pi-tui. */
export function truncatePlain(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	// pi-tui wraps the ellipsis in SGR resets; the input has no styling to protect.
	return truncateToWidth(text, width, "…").replaceAll("\x1b[0m", "");
}

export type ToolLineParts = {
	rail: string;
	icon: string;
	iconColor: string;
	name: string;
	/** Plain text; it gets whatever width is left over. */
	summary: string;
	/** Already styled, e.g. "+3 −1" or "40 lines"; never truncated. */
	stat?: string;
	/** e.g. "3.0s"; never truncated. */
	duration?: string;
	/** Plain text, failed calls only; shares the leftover width with the summary. */
	errorTail?: string;
};

/**
 * Lay one tool line out for `width` columns. Rail, icon, name, stat and duration
 * are reserved first, so the duration survives on a narrow terminal; the summary
 * takes the remainder and is cut with "…". A failed call's error tail may use up
 * to half of the remainder, or more when the summary is short.
 */
export function composeToolLine(parts: ToolLineParts, width: number, paint: Paint = PLAIN_PAINT): string {
	const prefix =
		paint.fg("dim", parts.rail) +
		paint.fg(parts.iconColor, parts.icon) +
		" " +
		paint.fg("toolTitle", paint.bold(parts.name)) +
		paint.fg("dim", ":") +
		" ";
	const suffix = (parts.stat ? ` ${parts.stat}` : "") + (parts.duration ? ` ${paint.fg("muted", `(${parts.duration})`)}` : "");
	const room = Math.max(0, width - visibleWidth(prefix) - visibleWidth(suffix));

	const tailLead = " — ";
	const tailWanted = parts.errorTail ? visibleWidth(tailLead) + visibleWidth(parts.errorTail) : 0;
	let tailWidth = Math.min(tailWanted, Math.floor(room / 2));
	if (tailWidth < MIN_ERROR_TAIL_WIDTH) tailWidth = 0;
	const summary = truncatePlain(parts.summary, room - tailWidth);
	if (tailWidth > 0) tailWidth = Math.min(tailWanted, room - visibleWidth(summary));

	const tail =
		tailWidth > 0
			? paint.fg("dim", tailLead) + paint.fg("error", truncatePlain(parts.errorTail!, tailWidth - visibleWidth(tailLead)))
			: "";
	return prefix + paint.fg("dim", summary) + suffix + tail;
}
