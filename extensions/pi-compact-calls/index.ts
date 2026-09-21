/**
 * pi-compact-calls — fold consecutive built-in tool calls into one compact block.
 *
 * A live turn renders as:
 *
 *   ⠋ 3 tool calls · 6.1s
 *   ├ ✓ bash: sleep 3 && echo one (3.0s)
 *   ├ ✓ bash: echo two (0.0s)
 *   └ ✓ bash: ls /tmp | head -3 (0.0s)
 *
 * instead of three native rows (blank / `$ cmd` / blank / output / blank /
 * `Took X.Xs` / blank each). Ctrl+O expands the block to show per-tool result
 * previews.
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
 * - Thinking is deliberately untouched: pi keeps rendering its own `Thinking...`
 *   row (click to expand). Nothing here depends on pi internals.
 *
 * - Replayed history (resume, tree navigation, /reload) produces no
 *   tool_execution_* events, so those rows cannot be grouped; they render as a
 *   single compact line instead of the native multi-line block.
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
	formatDuration,
	headerState,
	type Paint,
	pickCollapsedTool,
	previewModeOf,
	selectPreview,
	summaryOf,
	toolState,
	unionDuration,
} from "./format.ts";

// =============================================================================
// Tunables
// =============================================================================
/** Result lines shown per tool when the block is expanded (Ctrl+O). */
const EXPANDED_RESULT_LINES = 5;
/** Diff lines shown for an edit when the block is expanded. */
const EXPANDED_DIFF_LINES = 20;
/** Keep at most this much result text per tool in memory (for previews). */
const RESULT_TEXT_LIMIT = 4000;
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
	tools: ToolEntry[];
};

const entries = new Map<string, ToolEntry>();
let currentGroup: ToolGroup | null = null;
/**
 * True between agent_start and agent_end. While live, a row that shows up in
 * renderCall (its args are still streaming) joins the open group right away, so
 * it never paints as a solo row that vanishes once execution starts.
 */
let live = false;
/** Latest theme seen by a renderer (pi has no theme-change event). */
let currentTheme: Theme | undefined;
/** `context.invalidate()` of some live row — repaint without capturing the TUI. */
let repaint: (() => void) | undefined;
let animTimer: ReturnType<typeof setInterval> | undefined;

function resetState(): void {
	stopAnimation();
	entries.clear();
	currentGroup = null;
	live = false;
	repaint = undefined;
}

function openGroup(): ToolGroup {
	const group: ToolGroup = {
		expanded: false,
		closed: false,
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
	group.tools.push(entry);
	entry.group = group;
	if (entry.expanded) group.expanded = true;
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

function renderGroupBlock(group: ToolGroup, width: number): string[] {
	const now = Date.now();
	const state = headerState(group.tools, group.closed);
	const contentWidth = Math.max(1, width - INDENT.length);

	// A single tool needs no header: the tool line already carries state, summary
	// and duration. Only batches show the “N tool calls · total” summary.
	const lines: string[] = [];
	if (group.tools.length > 1) {
		// Pure tool time: the union of the execution intervals, so parallel calls do
		// not double count and the model's thinking time between calls is left out.
		const intervals = group.tools
			.filter((tool) => tool.startedAt !== undefined)
			.map((tool) => ({ start: tool.startedAt!, end: tool.endedAt }));
		lines.push(
			composeHeader(
				{
					state,
					icon: headerIcon(state, now),
					count: group.tools.length,
					failed: group.tools.filter((tool) => toolState(tool) === "failed").length,
					durationMs: unionDuration(intervals, now),
					hint: group.expanded ? undefined : EXPAND_HINT,
				},
				contentWidth,
				paint,
			),
		);
	}

	// Collapsed = header + one activity line: the call still running if there is
	// one, else the most recent failure, else the last call. The header carries
	// the total count and the expand hint. A single-tool block is just its line.
	const visible = group.expanded ? group.tools : [pickCollapsedTool(group.tools)];
	visible.forEach((tool, index) => {
		const isLast = index === visible.length - 1;
		const rail = group.tools.length === 1 ? "" : isLast ? RAIL_END : RAIL_MID;
		lines.push(toolLine(rail, tool, now, contentWidth));
		if (group.expanded) lines.push(...resultPreviewLines(tool, contentWidth, isLast ? SUB_INDENT : SUB_INDENT_RAIL));
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
		if (!this.entry.group) return renderSoloRow(this.entry, width);
		// Exactly one row per group paints the block; the rest render 0 lines.
		if (!isLeader(this.entry)) return [];
		return renderGroupBlock(this.entry.group, width);
	}

	invalidate(): void {}
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
				// Join while the args are still streaming; pending/startedAt stay
				// untouched until tool_execution_start says the call really runs.
				if (live && !entry.hasResult) joinGroup(entry);
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
		resetState();
	});

	pi.on("session_shutdown", () => {
		resetState();
	});

	pi.on("message_start", (event) => {
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
		const text = block?.type === "text" ? String(block.text ?? "").trim() : "";
		if (text.length > 0) closeGroup();
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
