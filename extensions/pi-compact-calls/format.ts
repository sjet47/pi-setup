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
/** A truncated error tail narrower than this is not worth showing. */
const MIN_ERROR_TAIL_WIDTH = 12;

/**
 * Should this text event seal the open block?
 *
 * A text block streams as text_start / text_delta … / text_end, and every one of
 * those events carries the *accumulated* text — so a naive `text.trim() !== ""`
 * check fires over and over. Pi dispatches to extensions before its UI creates
 * rows for the same event, but rows created by an earlier update may already
 * have joined a group. A second seal would strand those calls as one-tool
 * blocks. Seal at most once per text block.
 */
export function shouldSealText(sealed: ReadonlySet<number>, contentIndex: number, text: string): boolean {
	return text.trim().length > 0 && !sealed.has(contentIndex);
}

export function toolCallIdsAfterBoundary(
	content: readonly { type?: string; id?: unknown }[],
	boundaryIndex: number,
): Set<string> {
	return new Set(
		content.slice(boundaryIndex + 1)
			.filter((block) => block?.type === "toolCall" && typeof block.id === "string")
			.map((block) => block.id as string),
	);
}

/** Partition one existing group without moving calls that have already run. */
export function partitionQueuedAfterBoundary<T extends { toolCallId: string }>(
	tools: readonly T[],
	afterIds: ReadonlySet<string>,
	hasRun: (tool: T) => boolean,
): { before: T[]; after: T[] } {
	const before: T[] = [];
	const after: T[] = [];
	for (const tool of tools) {
		if (afterIds.has(tool.toolCallId) && !hasRun(tool)) after.push(tool);
		else before.push(tool);
	}
	return { before, after };
}

/**
 * Group the tool calls of a stored transcript into the blocks a live session would
 * have folded them into: runs of consecutive built-in calls, broken by a new user
 * turn, by visible assistant text, or by a call we do not own. Rows replayed from a
 * session get no events, so the transcript is the only source of their grouping.
 *
 * Content is walked in order, which is the order the live path sees it: text in the
 * middle of a message seals the block that the calls before it joined. Foreign
 * calls only break the block — they render natively, so they are not returned.
 *
 * Returns the tool call ids of each block, in transcript order.
 */
export function replayGroups(messages: readonly any[], isBuiltin: (toolName: string) => boolean): string[][] {
	const blocks: string[][] = [];
	let current: string[] | null = null;
	const seal = () => {
		if (current && current.length > 0) blocks.push(current);
		current = null;
	};
	for (const message of messages) {
		const role = message?.role;
		// Tool results only carry the outcome of a call the transcript already accounted for.
		if (role === "toolResult") continue;
		if (role !== "assistant") {
			seal(); // user turn, custom message, compaction or branch summary
			continue;
		}
		const content = Array.isArray(message.content) ? message.content : [];
		for (const item of content) {
			if (item?.type === "text" && String(item.text ?? "").trim()) {
				seal();
				continue;
			}
			if (item?.type !== "toolCall" || typeof item.id !== "string") continue;
			if (!isBuiltin(String(item.name ?? ""))) {
				seal();
				continue;
			}
			current ??= [];
			current.push(item.id);
		}
	}
	seal();
	return blocks;
}

/** The slice of an assistant message content item the thinking fold needs. */
export type ContentItem = { type?: string; [key: string]: any };

export type ThinkingFold = {
	/** The message content with the absorbed thinking runs taken out (other items keep their identity). */
	content: ContentItem[];
	/** Thinking text per tool call that absorbed it, in content order. */
	attributions: { toolCallId: string; text: string }[];
};

/**
 * Absorb the thinking that belongs to tool calls folded into a block.
 *
 * pi renders one *hidden* `Thinking...` row per assistant message, so a turn that
 * thinks between calls stacks identical rows beside the block; once the row
 * itself renders empty the component's own `Spacer(1)` is left behind as a
 * stray blank line. Thinking belongs to the step that produced the call, so it
 * moves into the block instead of keeping its own row — also when the message has
 * prose, since the prose and the block belong to the same step.
 *
 * Only a run that is followed, later in the same message, by a folded call is
 * absorbed:
 *
 * - a trailing run with no folded call after it stays visible (what the model
 *   thought before answering keeps its row);
 * - a run in front of a call that isn't folded (non-built-in tool) stays visible,
 *   even when a folded call comes after that one: its text belongs above the row
 *   that renders natively.
 *
 * Returns undefined when there is nothing to absorb, so callers can skip the
 * message copy entirely.
 */
export function foldThinking(
	content: readonly ContentItem[],
	isFolded: (toolCallId: string) => boolean,
): ThinkingFold | undefined {
	const result: ContentItem[] = [];
	const attributions: { toolCallId: string; text: string }[] = [];
	let pending: ContentItem[] = [];
	const flush = () => {
		if (pending.length > 0) result.push(...pending);
		pending = [];
	};
	for (const item of content) {
		if (item?.type === "thinking") {
			pending.push(item);
			continue;
		}
		if (item?.type === "toolCall") {
			const toolCallId = String(item.id ?? "");
			if (toolCallId && isFolded(toolCallId)) {
				const text = pending
					.map((run) => String(run.thinking ?? "").trim())
					.filter((run) => run.length > 0)
					.join("\n\n");
				if (text) attributions.push({ toolCallId, text });
				pending = [];
			} else {
				flush();
			}
			result.push(item);
			continue;
		}
		// Prose (and anything else) stays where it is; the run keeps looking ahead for a
		// call of ours to belong to, since prose and block are the same step.
		result.push(item);
	}
	flush();
	return attributions.length > 0 ? { content: result, attributions } : undefined;
}

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
 * What the header line reports: whether the batch is still moving, never how it
 * turned out. Success, failure and abort are deliberately not distinguished here —
 * the tool lines carry the outcome, the header only says "still working" or "this
 * batch is over".
 *
 * - running: some call is executing.
 * - idle:    nothing executing, block still open — the model is producing the
 *            next call.
 * - settled: the block is sealed.
 */
export type HeaderState = "running" | "idle" | "settled";

export function headerState(tools: readonly ToolView[], closed: boolean): HeaderState {
	if (tools.some((tool) => tool.pending)) return "running";
	return closed ? "settled" : "idle";
}

const HEADER_COLORS: Record<HeaderState, string> = {
	running: "accent",
	idle: "muted",
	settled: "muted",
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
	/**
	 * Leading state glyph: the spinner while a call runs, the idle glyph while the
	 * block is still open, and nothing at all once it is sealed. Empty means no glyph,
	 * so a settled header starts straight at the count.
	 */
	icon: string;
	count: number;
	/** Omitted when no timing is known (a replayed block): the line then shows no duration. */
	durationMs?: number;
	/** e.g. "4 read, 2 grep, 1 bash"; shown in parentheses after the count. */
	breakdown?: string;
	/** Dim trailing hint, e.g. "Ctrl+O to expand" (collapsed blocks only). */
	hint?: string;
};

/**
 * Compose the block header — the line a collapsed block keeps — for `width` columns.
 * When it does not fit, optional parts are dropped lowest priority first; the priority
 * (high → low) is count > duration > breakdown > hint. The count alone always fits.
 *
 * The header reports progress, not outcome: it never says whether a call failed or
 * was aborted (see HeaderState).
 */
export function composeHeader(parts: HeaderParts, width: number, paint: Paint = PLAIN_PAINT): string {
	const color = HEADER_COLORS[parts.state];
	const sep = ` ${paint.fg("muted", "·")} `;
	const head =
		(parts.icon ? `${paint.fg(color, parts.icon)} ` : "") +
		paint.fg(color, paint.bold(`${parts.count} tool calls`));

	// Display order; `drop` is the order in which parts are given up (0 first).
	const optional: { text: string; drop: number }[] = [];
	if (parts.breakdown) optional.push({ text: ` ${paint.fg("dim", `(${parts.breakdown})`)}`, drop: 1 });
	if (parts.durationMs !== undefined) optional.push({ text: sep + paint.fg("muted", formatDuration(parts.durationMs)), drop: 2 });

	let kept = optional;
	let line: string;
	for (;;) {
		line = head + kept.map((part) => part.text).join("");
		if (visibleWidth(line) <= width || kept.length === 0) break;
		const lowest = Math.min(...kept.map((part) => part.drop));
		kept = kept.filter((part) => part.drop !== lowest);
	}
	// The hint is the first thing to go and the last thing on the line.
	if (parts.hint) {
		const hint = sep + paint.fg("dim", parts.hint);
		if (visibleWidth(line) + visibleWidth(hint) <= width) line += hint;
	}
	return line;
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
	// A cut tail must stay readable; a short one that fits whole is always fine.
	if (tailWidth < Math.min(MIN_ERROR_TAIL_WIDTH, tailWanted)) tailWidth = 0;
	const summary = truncatePlain(parts.summary, room - tailWidth);
	if (tailWidth > 0) tailWidth = Math.min(tailWanted, room - visibleWidth(summary));

	const tail =
		tailWidth > 0
			? paint.fg("dim", tailLead) + paint.fg("error", truncatePlain(parts.errorTail!, tailWidth - visibleWidth(tailLead)))
			: "";
	return prefix + paint.fg("dim", summary) + suffix + tail;
}
