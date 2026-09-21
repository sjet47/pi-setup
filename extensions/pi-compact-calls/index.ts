/**
 * pi-compact-calls — fold consecutive built-in tool calls into one compact block.
 *
 * A block is a run of consecutive built-in tool calls. While it runs, the collapsed
 * block is two lines — the header plus the call in progress:
 *
 *   ⠋ 7 tool calls (4 read, 2 grep, 1 bash) · 3.2s · Ctrl+O to expand
 *   └ ⠋ bash: sleep 3 && echo one (3.0s)
 *
 * Once every call of the batch is done (the block is closed and nothing is running)
 * the activity line goes away and only the header — the block's stat line — is left:
 *
 *   ✓ 7 tool calls (4 read, 2 grep, 1 bash) · 3.2s · Ctrl+O to expand
 *
 * A failure keeps its tail there, since that line is then the only trace of the run:
 *
 *   ✗ 3 tool calls (2 bash, 1 edit) · 1 failed · 3.0s — cd: /nope: No such file or directory (exit 1) · Ctrl+O to expand
 *
 * After Ctrl+O either kind shows one row per tool with a result preview (bash:
 * last lines, edit: its diff, everything else: first lines):
 *
 *   ✗ 3 tool calls (2 bash, 1 edit) · 1 failed · 3.0s
 *   ├ ✓ bash: sleep 3 && echo one (3.0s)
 *   │   one
 *   ├ ✓ edit: src/a.ts +2 −1 (0.0s)
 *   │   -12 old line
 *   │   +12 new line
 *   └ ✗ bash: cd /nope (0.0s) — cd: /nope: No such file or directory (exit 1)
 *
 * instead of native rows (blank / `$ cmd` / blank / output / blank /
 * `Took X.Xs` / blank each).
 *
 * Icons: ○ queued (args streaming, waiting, or never ran) · spinner running ·
 * ✓ / ✗ finished. The header shows a static ⠿ while the block is still open
 * but nothing is executing (the model is writing the next call) and settles to
 * ✓ / ✗ / ○ only once the block is closed. Header time is the union of the
 * tool execution intervals, i.e. pure tool time.
 *
 * Design notes:
 *
 * - The 7 built-in tools are re-registered as `{ ...native, renderShell: "self",
 *   renderCall, renderResult }`. Spreading the native definition keeps
 *   description / promptSnippet / promptGuidelines / constrainedSampling and the
 *   native execute implementation — only presentation changes. (pi-compact-ui
 *   rebuilt the definition by hand and silently dropped all of that.)
 *
 * - A block = one run of consecutive tool calls (parallel batches and multi-step
 *   batches alike), ended by visible assistant text, a new user turn, or a tool
 *   that is not one of ours. Grouping uses a leader row: the first tool row of a
 *   group renders the whole block, every other member renders 0 lines. `renderShell: "self"` is required
 *   for that — under the default shell an empty row still keeps
 *   ToolExecutionComponent's own `Spacer(1)`, i.e. one blank line per tool.
 *
 * - No prototype patching. pi re-renders the whole tree every frame without dirty
 *   skipping, so the leader picks up tools that join later on its own; repaints
 *   come from pi's own tool events plus our spinner interval, which reuses
 *   `context.invalidate()` (it already calls `ui.requestRender()`), so the TUI
 *   instance never has to be captured through a widget.
 *
 * - renderCall fires while the args are still streaming, before
 *   tool_execution_start. While the agent is live (agent_start..agent_end) such
 *   a row joins the open block right away, in the queued state, so it never
 *   paints as a solo row that later collapses to 0 lines. pending/startedAt are
 *   still owned by tool_execution_start.
 *
 * - Pure logic (formatting, selection, width-based layout) lives in format.ts
 *   and is unit-tested with `node --test tests/*.test.ts`.
 *
 * - Thinking folds into the block: pi renders one *hidden* `Thinking...` row per
 *   assistant message, so a turn that thinks between calls stacks identical rows
 *   beside the folded block. The only hook pi offers is the assistant message
 *   component, so `updateContent` is wrapped (see installThinkingFold) to hand the
 *   native renderer a copy of the message with the absorbed runs removed; their
 *   text is kept on the tool entry and shown above that step's row when the block
 *   is expanded. Replayed history, non-built-in tools and messages with visible
 *   prose keep the native row. This is the only patch in the extension.
 *
 * - Replayed history (resume, tree navigation, /reload) produces no
 *   tool_execution_* events, so those rows cannot be grouped from events. Their
 *   blocks are derived from the session's stored messages instead (replayGroups),
 *   which makes stored batches fold into their stat line just like live ones, and
 *   gets recomputed on session_start / session_tree / session_compact.
 */

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionContext,
	type Theme,
	renderDiff,
	sessionEntryToContextMessages,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import {
	captureText,
	composeHeader,
	composeToolLine,
	countLines,
	type DiffStat,
	diffStat,
	errorTail,
	foldThinking,
	formatDuration,
	headerState,
	type Paint,
	pickCollapsedTool,
	previewModeOf,
	replayGroups,
	selectPreview,
	shouldSealText,
	summaryOf,
	toolState,
	typeBreakdown,
	unionDuration,
} from "./format.ts";
// Namespace import on purpose: pi's root bundle re-exports the interactive
// components, but if a future version drops this one the extension must still
// load — see installThinkingFold().
import * as piAgent from "@earendil-works/pi-coding-agent";

// =============================================================================
// Tunables
// =============================================================================
/** Result lines shown per tool when the block is expanded (Ctrl+O). */
const EXPANDED_RESULT_LINES = 5;
/** Diff lines shown for an edit when the block is expanded. */
const EXPANDED_DIFF_LINES = 20;
/** Keep at most this much result text per tool in memory (for previews). */
const RESULT_TEXT_LIMIT = 4000;
/** Same bound for the thinking absorbed from a step. */
const THINKING_TEXT_LIMIT = 8000;
/** Same bound for the edit diff kept for the expanded view. */
const DIFF_TEXT_LIMIT = 8000;
const SPINNER_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** One leading space, matching tool rows rendered in pi's default shell (Box paddingX = 1). */
/** A call that has neither started nor produced a result (args streaming, waiting, or never ran). */
const QUEUED_ICON = "○";
/** Open block with nothing executing: the model is generating the next call. Static on purpose — no timer runs for it. */
const IDLE_ICON = "⠿";
const EXPAND_HINT = "Ctrl+O to expand";
const INDENT = " ";
/** Lead of a preview row: the rail continues under every tool but the last. Same width for both. */
const SUB_INDENT = "    ";
const SUB_INDENT_RAIL = "│   ";
const RAIL_MID = "├ ";
const RAIL_END = "└ ";

const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "find", "grep", "ls"] as const;
type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];
const BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set(BUILTIN_TOOLS);

/** Render context type without importing it (it is not exported from the package root). */
type RenderContext = Parameters<NonNullable<ToolDefinition<any, any, any>["renderCall"]>>[2];

/** Shared 0-line component: rows rendered with `renderShell: "self"` disappear entirely. */
const NO_LINES: Component = {
	render: () => [],
	invalidate: () => {},
};

// =============================================================================
// State
// =============================================================================
type ToolEntry = {
	toolCallId: string;
	name: string;
	args: any;
	/** Set by tool_execution_start. Undefined for replayed history and for rows whose execution never started. */
	startedAt?: number;
	endedAt?: number;
	/** Bounded result text: its tail for bash, its head for everything else. */
	resultText: string;
	/** Line count of the full result text, before it was bounded. */
	resultLineCount: number;
	/** Last meaningful output line, shown on the tool line when the call failed. */
	errorTail: string;
	/** edit only: `details.diff`, cut to whole lines within DIFF_TEXT_LIMIT. */
	diff?: string;
	/** edit only: counted on the full diff before it was cut. */
	diffStat?: DiffStat;
	diffLineCount?: number;
	/** Thinking of the step that made this call, absorbed out of its message (expanded view only). */
	thinking?: string;
	thinkingLineCount?: number;
	isError: boolean;
	/** Executing right now; set by tool_execution_start only, never by a renderer. */
	pending: boolean;
	/** A final result exists (tool_execution_end, or a non-partial renderResult — replayed rows included). */
	hasResult: boolean;
	/** Mirrors pi's Ctrl+O (app.tools.expand) state as seen by this row. */
	expanded: boolean;
	/** Assigned when the tool joins a live group; undefined ⇒ render as a standalone compact row (replayed history). */
	group?: ToolGroup;
	row?: Component;
};

type ToolGroup = {
	/** Ctrl+O state, driven by the leader row. */
	expanded: boolean;
	closed: boolean;
	/** Derived from a stored transcript: it has no execution timing to report. */
	replay: boolean;
	/** Tool call ids in transcript order (replay groups only): rows attach in whatever
	 * order they are created, and the first one is the leader, so the order is restored. */
	order?: string[];
	tools: ToolEntry[];
};

const entries = new Map<string, ToolEntry>();
let currentGroup: ToolGroup | null = null;
/**
 * Text blocks of the current assistant message that already sealed the open block.
 * Keyed by contentIndex and cleared per message — see shouldSealText() for why
 * sealing twice per text block strands the message's own tool rows.
 */
const sealedTextIndexes = new Set<number>();
/**
 * True between agent_start and agent_end. While live, a row that shows up in
 * renderCall (its args are still streaming) joins the open group right away, so
 * it never paints as a solo row that vanishes once execution starts.
 */
let live = false;
/**
 * Blocks derived from the session's stored messages, keyed by tool call id: the
 * grouping for rows that are replayed instead of streamed. Undefined until a
 * session's transcript has been read (see regroupFromSession).
 */
let replaySpec: Map<string, ToolGroup> | undefined;
/** Latest theme seen by a renderer (pi has no theme-change event). */
let currentTheme: Theme | undefined;
/** `context.invalidate()` of some live row — repaint without capturing the TUI. */
let repaint: (() => void) | undefined;
let animTimer: ReturnType<typeof setInterval> | undefined;

function resetState(): void {
	stopAnimation();
	entries.clear();
	sealedTextIndexes.clear();
	currentGroup = null;
	replaySpec = undefined;
	live = false;
	// `repaint` is deliberately kept: it is only a way to ask pi for a frame, and the
	// next session may need one before any of its rows has called renderCall.
}

/**
 * Re-derive the block structure of the transcript. Rows replayed from a stored
 * session produce no tool events, so their grouping comes from the session's own
 * messages instead, and it has to be recomputed whenever that transcript can have
 * changed underneath us (/reload, /tree, compaction).
 */
function regroupFromSession(ctx: ExtensionContext): void {
	stopAnimation();
	sealedTextIndexes.clear();
	currentGroup = null;
	live = false;
	for (const entry of entries.values()) entry.group = undefined;
	replaySpec = buildReplaySpec(ctx);
	// Rows may already exist (pi restores the chat before session_start on /reload), so
	// ask for a frame: ones that predate this grouping attach to it while rendering.
	repaint?.();
}

/** Group the session's stored tool calls into the blocks they were live in. */
function buildReplaySpec(ctx: ExtensionContext): Map<string, ToolGroup> | undefined {
	try {
		const messages = ctx.sessionManager
			.buildContextEntries()
			.flatMap((entry) => sessionEntryToContextMessages(entry));
		const spec = new Map<string, ToolGroup>();
		for (const ids of replayGroups(messages, (toolName) => BUILTIN_TOOL_NAMES.has(toolName))) {
			// Stored blocks are finished by definition, so they render as their stat line.
			const group: ToolGroup = { expanded: false, closed: true, replay: true, order: ids, tools: [] };
			for (const id of ids) spec.set(id, group);
		}
		return spec;
	} catch {
		// An unreadable session shape must not break rendering: rows stay standalone lines.
		return undefined;
	}
}

function openGroup(): ToolGroup {
	const group: ToolGroup = {
		expanded: false,
		closed: false,
		replay: false,
		tools: [],
	};
	currentGroup = group;
	return group;
}

/** A boundary (visible text, user message, agent_end) ends the current group. */
function closeGroup(): void {
	if (currentGroup) {
		currentGroup.closed = true;
		currentGroup = null;
	}
}

function hasRun(entry: ToolEntry): boolean {
	return entry.startedAt !== undefined || entry.hasResult;
}

/**
 * A tool we do not own is about to paint its native row. Calls of ours that are
 * still queued sit *after* that row in the transcript (start events fire in
 * call order), so they move to a fresh group; the calls that already ran stay
 * in the old one, which is closed. Visual order keeps matching the transcript.
 */
function splitGroupAtForeignTool(): void {
	const group = currentGroup;
	if (!group) return;
	const queued = group.tools.filter((tool) => !hasRun(tool));
	if (queued.length === group.tools.length) return; // nothing of ours precedes the foreign row
	closeGroup();
	if (queued.length === 0) return;
	group.tools = group.tools.filter(hasRun);
	const next = openGroup();
	for (const tool of queued) {
		tool.group = next;
		next.tools.push(tool);
	}
	next.expanded = queued[0]!.expanded;
}

/** Look up (or create) the entry for a tool call. */
function ensureEntry(toolCallId: string, name: string, args: any): ToolEntry {
	let entry = entries.get(toolCallId);
	if (!entry) {
		entry = {
			toolCallId,
			name,
			args,
			resultText: "",
			resultLineCount: 0,
			errorTail: "",
			isError: false,
			pending: false,
			hasResult: false,
			expanded: false,
		};
		entries.set(toolCallId, entry);
	}
	if (args !== undefined) entry.args = args;
	return entry;
}

/**
 * Put a live call into the open group (creating one if needed). Called from
 * renderCall while the agent is live and from tool_execution_start; rows
 * replayed from a stored session never get here and stay standalone.
 */
function joinGroup(entry: ToolEntry): void {
	if (entry.group) return;
	const group = currentGroup ?? openGroup();
	addToGroup(group, entry);
}

function addToGroup(group: ToolGroup, entry: ToolEntry): void {
	group.tools.push(entry);
	entry.group = group;
	if (entry.expanded) group.expanded = true;
	// Rows may attach in any order (a repaint can invalidate one of them before the
	// frame that attaches the rest), so a replayed group restores its transcript order.
	if (group.order) group.tools.sort((a, b) => group.order!.indexOf(a.toolCallId) - group.order!.indexOf(b.toolCallId));
}

/**
 * Put a row replayed from a stored session into the block that transcript puts it
 * in, and report whether it joined one. Rows that come back with a session produce
 * no tool events at all, so their grouping is derived offline from the session's
 * messages (see replayGroups) — recomputed whenever the transcript can have changed.
 */
function attachReplayGroup(entry: ToolEntry): boolean {
	const group = replaySpec?.get(entry.toolCallId);
	if (!group || entry.group) return false;
	addToGroup(group, entry);
	return true;
}

function isLeader(entry: ToolEntry): boolean {
	return entry.group !== undefined && entry.group.tools[0] === entry;
}

// =============================================================================
// Animation — only while some row is still running
// =============================================================================
function hasPendingTool(): boolean {
	for (const entry of entries.values()) {
		if (entry.pending) return true;
	}
	return false;
}

function ensureAnimation(): void {
	if (animTimer) return;
	animTimer = setInterval(() => {
		if (!hasPendingTool()) stopAnimation();
		repaint?.();
	}, SPINNER_MS);
}

function stopAnimation(): void {
	if (animTimer) {
		clearInterval(animTimer);
		animTimer = undefined;
	}
}

// =============================================================================
// Formatting helpers
// =============================================================================
function entryDuration(entry: ToolEntry): string | undefined {
	if (entry.startedAt === undefined) return undefined;
	const end = entry.endedAt ?? (entry.pending ? Date.now() : undefined);
	if (end === undefined) return undefined;
	return formatDuration(end - entry.startedAt);
}

/** Keep a bounded copy of the result text (live output included) on the entry. */
function captureResult(entry: ToolEntry, result: any): void {
	const content = Array.isArray(result?.content) ? result.content : [];
	const full = content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item.text ?? ""))
		.join("\n")
		.trim();
	const captured = captureText(full, RESULT_TEXT_LIMIT, previewModeOf(entry.name));
	entry.resultText = captured.text;
	entry.resultLineCount = captured.totalLines;
	entry.errorTail = errorTail(full.slice(-RESULT_TEXT_LIMIT));
}

/** Keep the thinking absorbed out of a step's message (expanded view only). */
function absorbThinking(entry: ToolEntry, text: string): void {
	const captured = captureText(text, THINKING_TEXT_LIMIT, "head");
	entry.thinking = captured.text;
	entry.thinkingLineCount = captured.totalLines;
}

/** Remember an edit's diff (bounded) plus the stats of the full diff. */
function captureDetails(entry: ToolEntry, result: any): void {
	const diff = result?.details?.diff;
	if (entry.name !== "edit" || typeof diff !== "string" || diff.length === 0) return;
	entry.diffStat = diffStat(diff);
	entry.diffLineCount = diff.split("\n").length;
	if (diff.length <= DIFF_TEXT_LIMIT) {
		entry.diff = diff;
	} else {
		const cut = diff.slice(0, DIFF_TEXT_LIMIT);
		const lastBreak = cut.lastIndexOf("\n");
		entry.diff = lastBreak > 0 ? cut.slice(0, lastBreak) : cut;
	}
}

function spinnerFrame(now: number): string {
	return SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length]!;
}

function statusIcon(entry: ToolEntry, now: number): { icon: string; color: string } {
	switch (toolState(entry)) {
		case "running":
			return { icon: spinnerFrame(now), color: "accent" };
		case "failed":
			return { icon: "✗", color: "error" };
		case "ok":
			return { icon: "✓", color: "success" };
		case "queued":
			return { icon: QUEUED_ICON, color: "muted" };
	}
}

// =============================================================================
// Rendering
// =============================================================================
function fg(color: string, text: string): string {
	return currentTheme ? currentTheme.fg(color as any, text) : text;
}

function bold(text: string): string {
	return currentTheme ? currentTheme.bold(text) : text;
}

function italic(text: string): string {
	return currentTheme ? currentTheme.italic(text) : text;
}

const paint: Paint = { fg, bold };

/** `+N −M` for an edit, `N lines` for a write; empty for everything else. */
function statOf(entry: ToolEntry): string {
	if (entry.name === "edit" && entry.diffStat) {
		return `${fg("toolDiffAdded", `+${entry.diffStat.added}`)} ${fg("toolDiffRemoved", `−${entry.diffStat.removed}`)}`;
	}
	if (entry.name === "write" && typeof entry.args?.content === "string") {
		const lines = countLines(entry.args.content);
		return fg("muted", `${lines} line${lines === 1 ? "" : "s"}`);
	}
	return "";
}

function toolLine(rail: string, entry: ToolEntry, now: number, contentWidth: number): string {
	const { icon, color } = statusIcon(entry, now);
	return composeToolLine(
		{
			rail,
			icon,
			iconColor: color,
			name: entry.name,
			summary: summaryOf(entry.name, entry.args),
			stat: statOf(entry),
			duration: entryDuration(entry),
			errorTail: toolState(entry) === "failed" ? entry.errorTail : undefined,
		},
		contentWidth,
		paint,
	);
}

/** pi's own diff renderer (intra-line highlights); plain theme colors if it is unavailable. */
function colorDiff(diffText: string): string[] {
	try {
		return renderDiff(diffText).split("\n");
	} catch {
		return diffText.split("\n").map((line) =>
			fg(line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "toolDiffContext", line),
		);
	}
}

/** An edit shows its diff instead of the "Successfully replaced…" text. */
function diffPreviewLines(entry: ToolEntry, contentWidth: number, lead: string): string[] {
	const shown = entry.diff!.split("\n").slice(0, EXPANDED_DIFF_LINES);
	const total = Math.max(entry.diffLineCount ?? shown.length, shown.length);
	const rows = colorDiff(shown.join("\n")).map(
		(line) => fg("dim", lead) + truncateToWidth(line, Math.max(1, contentWidth - lead.length), "…"),
	);
	if (total > shown.length) {
		rows.push(`${fg("dim", lead)}${fg("muted", `… ${total - shown.length} more lines`)}`);
	}
	return rows;
}

/** Result preview rows for an expanded block (live output included while running). */
function resultPreviewLines(entry: ToolEntry, contentWidth: number, lead: string = SUB_INDENT): string[] {
	if (entry.diff && !entry.isError) return diffPreviewLines(entry, contentWidth, lead);
	const preview = selectPreview(entry.resultText, EXPANDED_RESULT_LINES, previewModeOf(entry.name), entry.resultLineCount);
	const note = (text: string) => `${fg("dim", lead)}${fg("muted", text)}`;
	const rows: string[] = [];
	// bash shows its last lines, so the omitted part comes first.
	if (preview.hidden > 0 && preview.mode === "tail") rows.push(note(`… ${preview.hidden} earlier lines`));
	for (const line of preview.lines) {
		rows.push(fg("dim", lead) + truncateToWidth(fg("toolOutput", line), Math.max(1, contentWidth - lead.length), "…"));
	}
	if (preview.hidden > 0 && preview.mode === "head") rows.push(note(`… ${preview.hidden} more lines`));
	return rows;
}

/**
 * Thinking that was absorbed out of a step's message, above that step's tool row.
 * Styled like pi's own thinking text (italic, thinkingText) so it is not
 * mistaken for tool output.
 */
function thinkingLines(entry: ToolEntry, contentWidth: number, lead: string): string[] {
	if (!entry.thinking) return [];
	const preview = selectPreview(entry.thinking, EXPANDED_RESULT_LINES, "head", entry.thinkingLineCount ?? 0);
	const rows = preview.lines.map(
		(line) =>
			fg("dim", lead) +
			truncateToWidth(italic(fg("thinkingText", line)), Math.max(1, contentWidth - lead.length), "…"),
	);
	if (preview.hidden > 0) rows.push(`${fg("dim", lead)}${fg("muted", `… ${preview.hidden} more lines`)}`);
	return rows;
}

function headerIcon(state: ReturnType<typeof headerState>, now: number): string {
	switch (state) {
		case "running":
			return spinnerFrame(now);
		case "idle":
			return IDLE_ICON;
		case "ok":
			return "✓";
		case "failed":
			return "✗";
		case "incomplete":
			return QUEUED_ICON;
	}
}

/** Error tail of the most recent failed call, for a collapsed block's stat line. */
function collapsedErrorTail(tools: readonly ToolEntry[]): string | undefined {
	for (let index = tools.length - 1; index >= 0; index -= 1) {
		const tool = tools[index]!;
		if (toolState(tool) === "failed" && tool.errorTail) return tool.errorTail;
	}
	return undefined;
}

function renderGroupBlock(group: ToolGroup, width: number): string[] {
	const now = Date.now();
	const state = headerState(group.tools, group.closed);
	const contentWidth = Math.max(1, width - INDENT.length);
	const multi = group.tools.length > 1;
	// Nothing left to watch: the batch ran to completion, so the activity line goes
	// away and the header alone stays. A group closed while a call was still running
	// (abort) is not settled — the running call stays visible.
	const settled = group.closed && state !== "running";
	// Pure tool time: the union of the execution intervals, so parallel calls do not
	// double count and the model's thinking time between calls is left out.
	const intervals = group.tools
		.filter((tool) => tool.startedAt !== undefined)
		.map((tool) => ({ start: tool.startedAt!, end: tool.endedAt }));
	const headerLine = (icon: string, hint?: string, errorTail?: string) =>
		composeHeader(
			{
				state,
				icon,
				count: group.tools.length,
				failed: group.tools.filter((tool) => toolState(tool) === "failed").length,
				durationMs: group.replay ? undefined : unionDuration(intervals, now),
				breakdown: typeBreakdown(group.tools.map((tool) => tool.name)) || undefined,
				hint,
				errorTail,
			},
			contentWidth,
			paint,
		);

	// A single tool needs no header: the tool line already carries state, summary and
	// duration. A collapsed multi-tool block is the header plus the call in progress
	// while it runs — and, once the batch is done, the header alone.
	const lines: string[] = [];
	let visible: readonly ToolEntry[] = [];
	if (group.expanded) {
		visible = group.tools;
		if (multi) lines.push(headerLine(headerIcon(state, now)));
	} else if (!multi) {
		visible = group.tools.slice(0, 1);
	} else if (!settled) {
		// The call still running, else the most recent failure, else the last call.
		visible = [pickCollapsedTool(group.tools)];
		lines.push(headerLine(headerIcon(state, now), EXPAND_HINT));
	} else {
		// Done: the header line is all that is left of the batch, so it carries what the
		// block did (`1 failed`) and why it failed (the error tail).
		lines.push(headerLine(headerIcon(state, now), EXPAND_HINT, collapsedErrorTail(group.tools)));
	}

	visible.forEach((tool, index) => {
		const isLast = index === visible.length - 1;
		const rail = group.tools.length === 1 ? "" : isLast ? RAIL_END : RAIL_MID;
		const lead = isLast ? SUB_INDENT : SUB_INDENT_RAIL;
		// Absorbed thinking comes first: it is what produced this call.
		if (group.expanded) lines.push(...thinkingLines(tool, contentWidth, lead));
		lines.push(toolLine(rail, tool, now, contentWidth));
		if (group.expanded) lines.push(...resultPreviewLines(tool, contentWidth, lead));
	});

	if (state === "running") ensureAnimation();
	return lines.map((line) => INDENT + truncateToWidth(line, contentWidth, "…"));
}

/** Standalone row: a tool without a live group (replayed history, aborted calls). */
function renderSoloRow(entry: ToolEntry, width: number): string[] {
	const now = Date.now();
	const contentWidth = Math.max(1, width - INDENT.length);
	const lines = [toolLine("", entry, now, contentWidth)];
	if (entry.expanded) lines.push(...resultPreviewLines(entry, contentWidth));
	if (entry.pending) ensureAnimation();
	return lines.map((line) => INDENT + truncateToWidth(line, contentWidth, "…"));
}

class RowComponent implements Component {
	constructor(readonly entry: ToolEntry) {}

	render(width: number): string[] {
		// A row that was created before its grouping was known — pi restores the chat
		// before session_start on /reload — joins its block here, then asks for one more
		// frame so the leader re-renders with the full member list.
		if (!this.entry.group && attachReplayGroup(this.entry)) repaint?.();
		if (!this.entry.group) return renderSoloRow(this.entry, width);
		// Exactly one row per group paints the block; the rest render 0 lines.
		if (!isLeader(this.entry)) return [];
		return renderGroupBlock(this.entry.group, width);
	}

	invalidate(): void {}
}

// =============================================================================
// Thinking folded into the block
// =============================================================================
/**
 * pi renders one *hidden* `Thinking...` row per assistant message (per thinking
 * run, actually). A multi-step turn is one message per step, so a turn that
 * thinks between calls stacks identical rows beside the folded block — and once
 * the row renders empty, the component's own `Spacer(1)` is left behind as a
 * stray blank line.
 *
 * pi exposes no per-message hook for this (`registerMessageRenderer` only covers
 * custom messages, and the markdown transformer only runs while thinking is
 * visible), so the one entry point is the assistant message component's
 * `updateContent`. We wrap it, hand the native implementation a copy of the
 * message with the absorbed runs removed, and keep their text on the tool entry
 * that absorbed it, where the expanded block renders it.
 *
 * The wrapper is deliberately narrow:
 *
 * - `foldThinking` only absorbs a run that is followed by a tool call of ours
 *   that actually joined a block, so replayed history (no blocks), non-built-in
 *   tools and messages with visible prose keep their native rows;
 * - folding is skipped while thinking is set to *visible* (the component's
 *   `hideThinkingBlock` is false): then the rows carry the full text and there is
 *   no pile-up of one-line labels to fix;
 * - a throw inside the fold falls back to the untouched message;
 * - a missing export (future pi) leaves the extension fully working, just with
 *   native thinking rows.
 */
function installThinkingFold(): void {
	const component = (piAgent as unknown as { AssistantMessageComponent?: { prototype: any } }).AssistantMessageComponent;
	const proto = component?.prototype;
	if (!proto || typeof proto.updateContent !== "function" || proto.piCompactCallsThinkingFold) return;
	const native = proto.updateContent as (message: any, isStreaming?: boolean) => void;
	proto.updateContent = function (this: any, message: any, isStreaming?: boolean) {
		let rendered = message;
		try {
			// Fold only while thinking renders as a label: with thinking set to visible
			// the user is reading the full text, and a five-line preview in the block
			// would be a downgrade. `hideThinkingBlock` is a private field of this very
			// component; anything unreadable keeps native rendering (no fold).
			if (this?.hideThinkingBlock === true) rendered = foldThinkingOfMessage(message) ?? message;
		} catch {
			rendered = message;
		}
		return native.call(this, rendered, isStreaming);
	};
	proto.piCompactCallsThinkingFold = true;
}

/** Move the thinking of a message into the blocks its tool calls joined. */
function foldThinkingOfMessage(message: any): any | undefined {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	const folded = foldThinking(message.content, (toolCallId) => entries.get(toolCallId)?.group !== undefined);
	if (!folded) return undefined;
	// Rows are created right after the message update that first carries the call,
	// so on that first frame `entries` may not know the id yet; the next update
	// (further streaming, or message_end) absorbs it. Attributions are never
	// cleared, and the filtered copy has no thinking left, so re-rendering it is
	// a no-op that keeps the stored text.
	for (const { toolCallId, text } of folded.attributions) {
		const entry = entries.get(toolCallId);
		if (entry) absorbThinking(entry, text);
	}
	return { ...message, content: folded.content };
}

// =============================================================================
// Tool registration
// =============================================================================
type NativeTool = ToolDefinition<any, any, any>;

const nativeToolCache = new Map<string, Record<BuiltinToolName, NativeTool>>();

function nativeTools(cwd: string): Record<BuiltinToolName, NativeTool> {
	let tools = nativeToolCache.get(cwd);
	if (!tools) {
		tools = {
			read: createReadTool(cwd) as unknown as NativeTool,
			bash: createBashTool(cwd) as unknown as NativeTool,
			edit: createEditTool(cwd) as unknown as NativeTool,
			write: createWriteTool(cwd) as unknown as NativeTool,
			find: createFindTool(cwd) as unknown as NativeTool,
			grep: createGrepTool(cwd) as unknown as NativeTool,
			ls: createLsTool(cwd) as unknown as NativeTool,
		};
		nativeToolCache.set(cwd, tools);
	}
	return tools;
}

export default function (pi: ExtensionAPI) {
	installThinkingFold();
	for (const name of BUILTIN_TOOLS) {
		const native = nativeTools(process.cwd())[name];
		pi.registerTool({
			// Keep pi's own metadata (description / promptSnippet / promptGuidelines)
			// and constrained sampling request; only the renderers change.
			...native,
			renderShell: "self",
			execute: (
				toolCallId: string,
				params: any,
				signal: AbortSignal | undefined,
				onUpdate: any,
				ctx: ExtensionContext,
			) => nativeTools(ctx?.cwd ?? process.cwd())[name].execute(toolCallId, params, signal, onUpdate, ctx),
			renderCall: (args: any, renderTheme: Theme, context: RenderContext) => {
				currentTheme = renderTheme;
				repaint = context.invalidate;
				const entry = ensureEntry(context.toolCallId, name, args);
				entry.expanded = context.expanded;
				// Join while the args are still streaming; pending/startedAt stay untouched
				// until tool_execution_start says the call really runs. A row that belongs to
				// a stored transcript joins the block that transcript puts it in instead.
				if (!entry.group && !attachReplayGroup(entry) && live && !entry.hasResult) joinGroup(entry);
				if (isLeader(entry)) entry.group!.expanded = context.expanded;
				entry.row ??= new RowComponent(entry);
				return entry.row;
			},
			renderResult: (result: any, options: any, renderTheme: Theme, context: RenderContext) => {
				currentTheme = renderTheme;
				repaint = context.invalidate;
				const entry = entries.get(context.toolCallId);
				if (entry) {
					captureResult(entry, result);
					captureDetails(entry, result);
					// NOTE: the object passed to renderResult only carries content/details —
					// `result.isError` is undefined here and would clobber the flag set by
					// tool_execution_end. context.isError mirrors the row's real state and
					// is also correct for replayed history.
					entry.isError = context.isError;
					if (!options?.isPartial) {
						entry.pending = false;
						entry.hasResult = true;
					}
					entry.expanded = context.expanded;
					if (isLeader(entry)) entry.group!.expanded = context.expanded;
				}
				return NO_LINES;
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		currentTheme = ctx.ui.theme;
		// Entries and rows may already exist: a /reload restores the chat *before* this
		// event. Keep them, only re-derive the block structure they belong to.
		regroupFromSession(ctx);
	});

	pi.on("session_shutdown", () => {
		resetState();
	});

	// Both rebuild the transcript (and the chat with it): the blocks derived from it,
	// and the one still being collected, no longer match what is on screen.
	pi.on("session_tree", (_event, ctx) => {
		regroupFromSession(ctx);
	});

	pi.on("session_compact", (_event, ctx) => {
		regroupFromSession(ctx);
	});

	pi.on("message_start", (event) => {
		if ((event.message as any)?.role === "assistant") sealedTextIndexes.clear();
		// Only a new user turn ends a block. Assistant messages do NOT: within one
		// turn, every tool call that is not separated by visible prose belongs to the
		// same block, which the single collapsed line keeps showing live.
		if ((event.message as any)?.role === "user") closeGroup();
	});

	pi.on("message_update", (event) => {
		const stream = event.assistantMessageEvent as any;
		if (!stream || typeof stream.type !== "string" || !stream.type.startsWith("text_")) return;
		// The first visible assistant text ends the current block, so a later tool
		// call starts a new one instead of joining the previous group.
		const content = (event.message as any)?.content;
		const index = Number(stream.contentIndex);
		const block = Array.isArray(content) && Number.isInteger(index) ? content[index] : undefined;
		const text = block?.type === "text" ? String(block.text ?? "") : "";
		if (!shouldSealText(sealedTextIndexes, index, text)) return;
		sealedTextIndexes.add(index);
		closeGroup();
	});

	pi.on("tool_execution_start", (event) => {
		live = true;
		if (!BUILTIN_TOOL_NAMES.has(event.toolName)) {
			splitGroupAtForeignTool();
			return;
		}
		const entry = ensureEntry(event.toolCallId, event.toolName, event.args);
		joinGroup(entry);
		entry.pending = true;
		entry.startedAt = Date.now();
		ensureAnimation();
	});

	pi.on("tool_execution_update", (event) => {
		const entry = entries.get(event.toolCallId);
		if (!entry) return;
		// Streaming output: keep it visible when the block is expanded.
		captureResult(entry, event.partialResult);
	});

	pi.on("tool_execution_end", (event) => {
		const entry = entries.get(event.toolCallId);
		if (!entry) return;
		entry.pending = false;
		entry.hasResult = true;
		entry.endedAt = Date.now();
		entry.isError = Boolean(event.isError);
		captureResult(entry, event.result);
		captureDetails(entry, event.result);
		if (!hasPendingTool()) stopAnimation();
		repaint?.();
	});

	pi.on("agent_start", () => {
		live = true;
	});

	pi.on("agent_end", () => {
		// Calls that never started keep the queued icon: they did not succeed.
		live = false;
		closeGroup();
		for (const entry of entries.values()) {
			if (!entry.pending) continue;
			entry.pending = false;
			entry.endedAt ??= Date.now();
		}
		stopAnimation();
		repaint?.();
	});
}
