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
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { homedir } from "os";

// =============================================================================
// Tunables
// =============================================================================
/** Result lines shown per tool when the block is expanded (Ctrl+O). */
const EXPANDED_RESULT_LINES = 5;
/** Argument summary length. */
const SUMMARY_MAX_CHARS = 60;
/** Keep at most this much result text per tool in memory (for previews). */
const RESULT_TEXT_LIMIT = 4000;
const SPINNER_MS = 100;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** One leading space, matching tool rows rendered in pi's default shell (Box paddingX = 1). */
const INDENT = " ";
const SUB_INDENT = "    ";
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
	resultText: string;
	isError: boolean;
	pending: boolean;
	/** Mirrors pi's Ctrl+O (app.tools.expand) state as seen by this row. */
	expanded: boolean;
	/** Assigned when the tool joins a live group; undefined ⇒ render as a standalone compact row. */
	group?: ToolGroup;
	row?: Component;
};

type ToolGroup = {
	seq: number;
	startedAt: number;
	endedAt?: number;
	/** Ctrl+O state, driven by the leader row. */
	expanded: boolean;
	closed: boolean;
	tools: ToolEntry[];
};

const entries = new Map<string, ToolEntry>();
let currentGroup: ToolGroup | null = null;
let groupSeq = 0;
/** Latest theme seen by a renderer (pi has no theme-change event). */
let currentTheme: Theme | undefined;
/** `context.invalidate()` of some live row — repaint without capturing the TUI. */
let repaint: (() => void) | undefined;
let animTimer: ReturnType<typeof setInterval> | undefined;

function resetState(): void {
	stopAnimation();
	entries.clear();
	currentGroup = null;
	repaint = undefined;
}

function openGroup(): ToolGroup {
	const group: ToolGroup = {
		seq: ++groupSeq,
		startedAt: Date.now(),
		expanded: false,
		closed: false,
		tools: [],
	};
	currentGroup = group;
	return group;
}

/** A boundary (visible text, user message, foreign tool) ends the current group. */
function closeGroup(): void {
	if (currentGroup) {
		currentGroup.closed = true;
		currentGroup = null;
	}
}

/**
 * Look up (or create) the entry for a tool call.
 *
 * `live` is true only for `tool_execution_start`, i.e. when we know the call is
 * executing right now in this process — that is what makes a group. Rows created
 * by the renderer before the start event, and rows replayed from a stored
 * session, stay ungrouped and render as a standalone line.
 */
function ensureEntry(toolCallId: string, name: string, args: any, live: boolean): ToolEntry {
	let entry = entries.get(toolCallId);
	if (!entry) {
		entry = {
			toolCallId,
			name,
			args,
			resultText: "",
			isError: false,
			pending: false,
			expanded: false,
		};
		entries.set(toolCallId, entry);
	}
	if (args !== undefined) entry.args = args;
	if (live && !entry.group) {
		const group = currentGroup && !currentGroup.closed ? currentGroup : openGroup();
		if (group.tools.length === 0) group.startedAt = Date.now();
		group.tools.push(entry);
		entry.group = group;
		entry.startedAt = Date.now();
		if (entry.expanded) group.expanded = true;
	}
	return entry;
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
function shortenPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown, max = SUMMARY_MAX_CHARS): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, ms) / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds % 60);
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function entryDuration(entry: ToolEntry): string | undefined {
	if (entry.startedAt === undefined) return undefined;
	const end = entry.endedAt ?? (entry.pending ? Date.now() : undefined);
	if (end === undefined) return undefined;
	return formatDuration(end - entry.startedAt);
}

function summaryOf(entry: ToolEntry): string {
	const args: any = entry.args ?? {};
	switch (entry.name) {
		case "bash":
			return oneLine(args.command ?? "…");
		case "read":
		case "write":
		case "edit":
			return oneLine(shortenPath(String(args.path ?? "…")));
		case "find":
		case "grep":
			return oneLine(`${args.pattern ?? ""} in ${shortenPath(String(args.path ?? "."))}`);
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

function resultTextOf(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const text = content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item.text ?? ""))
		.join("\n")
		.trim();
	return text.length > RESULT_TEXT_LIMIT ? text.slice(0, RESULT_TEXT_LIMIT) : text;
}

function spinnerFrame(now: number): string {
	return SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length]!;
}

function statusIcon(entry: ToolEntry, now: number): { icon: string; color: string } {
	if (entry.pending) return { icon: spinnerFrame(now), color: "accent" };
	if (entry.isError) return { icon: "✗", color: "error" };
	return { icon: "✓", color: "success" };
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

function toolLine(rail: string, entry: ToolEntry, now: number): string {
	const { icon, color } = statusIcon(entry, now);
	const duration = entryDuration(entry);
	return (
		fg("dim", rail) +
		fg(color, icon) +
		" " +
		fg("toolTitle", bold(entry.name)) +
		fg("dim", ":") +
		" " +
		fg("dim", summaryOf(entry)) +
		(duration ? ` ${fg("muted", `(${duration})`)}` : "")
	);
}

/** Result preview rows for an expanded block (live output included while running). */
function resultPreviewLines(entry: ToolEntry, contentWidth: number): string[] {
	if (!entry.resultText) return [];
	const allLines = entry.resultText.split("\n");
	const lines = allLines.slice(0, EXPANDED_RESULT_LINES);
	const rows = lines.map((line) =>
		fg("dim", SUB_INDENT) + truncateToWidth(fg("toolOutput", line), Math.max(1, contentWidth - SUB_INDENT.length), "…"),
	);
	if (allLines.length > lines.length) {
		rows.push(`${fg("dim", SUB_INDENT)}${fg("muted", `… ${allLines.length - lines.length} more lines`)}`);
	}
	return rows;
}

/**
 * The single call shown while collapsed: the newest still-running call wins, and
 * once the whole batch is done the last call in it.
 */
function pickCollapsedTool(tools: ToolEntry[]): ToolEntry {
	for (let index = tools.length - 1; index >= 0; index--) {
		const tool = tools[index]!;
		if (tool.pending) return tool;
	}
	return tools[tools.length - 1]!;
}

function groupEndedAt(group: ToolGroup): number | undefined {
	let end: number | undefined;
	for (const tool of group.tools) {
		if (tool.endedAt !== undefined && (end === undefined || tool.endedAt > end)) end = tool.endedAt;
	}
	return end;
}

function renderGroupBlock(group: ToolGroup, width: number): string[] {
	const now = Date.now();
	const pending = group.tools.some((tool) => tool.pending);
	const failed = group.tools.some((tool) => tool.isError);
	const icon = pending ? spinnerFrame(now) : failed ? "✗" : "✓";
	const headColor = pending ? "accent" : failed ? "error" : "success";
	const endedAt = pending ? now : (groupEndedAt(group) ?? now);
	const contentWidth = Math.max(1, width - INDENT.length);

	// A single tool needs no header: the tool line already carries state, summary
	// and duration. Only batches show the “N tool calls · total” summary.
	const lines: string[] = [];
	if (group.tools.length > 1) {
		lines.push(
			`${fg(headColor, icon)} ${fg(headColor, bold(`${group.tools.length} tool call${group.tools.length === 1 ? "" : "s"}`))} ${fg("muted", `· ${formatDuration(endedAt - group.startedAt)}`)}`,
		);
	}

	// Collapsed shows exactly one call — the one still running if there is one,
	// otherwise the most recent. The header carries the total count.
	const visible = group.expanded ? group.tools : [pickCollapsedTool(group.tools)];
	const hiddenCount = group.tools.length - visible.length;
	visible.forEach((tool, index) => {
		const isLastRow = index === visible.length - 1 && hiddenCount === 0;
		const rail = visible.length === 1 ? "" : isLastRow ? RAIL_END : RAIL_MID;
		lines.push(toolLine(rail, tool, now));
		if (group.expanded) lines.push(...resultPreviewLines(tool, contentWidth));
	});
	if (hiddenCount > 0) {
		lines.push(`${fg("dim", "… ")}${fg("muted", `${hiddenCount} more call${hiddenCount === 1 ? "" : "s"}`)} ${fg("dim", "(Ctrl+O to expand)")}`);
	}

	if (pending) ensureAnimation();
	return lines.map((line) => INDENT + truncateToWidth(line, contentWidth, "…"));
}

/** Standalone row: a tool without a live group (replayed history, aborted calls). */
function renderSoloRow(entry: ToolEntry, width: number): string[] {
	const now = Date.now();
	const contentWidth = Math.max(1, width - INDENT.length);
	const lines = [toolLine("", entry, now)];
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
				const entry = ensureEntry(context.toolCallId, name, args, false);
				entry.expanded = context.expanded;
				if (isLeader(entry)) entry.group!.expanded = context.expanded;
				entry.row ??= new RowComponent(entry);
				return entry.row;
			},
			renderResult: (result: any, options: any, renderTheme: Theme, context: RenderContext) => {
				currentTheme = renderTheme;
				repaint = context.invalidate;
				const entry = entries.get(context.toolCallId);
				if (entry) {
					entry.resultText = resultTextOf(result);
					// NOTE: the object passed to renderResult only carries content/details —
					// `result.isError` is undefined here and would clobber the flag set by
					// tool_execution_end. context.isError mirrors the row's real state and
					// is also correct for replayed history.
					entry.isError = context.isError;
					if (!options?.isPartial) entry.pending = false;
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
		if (!BUILTIN_TOOL_NAMES.has(event.toolName)) {
			// A tool we do not own renders its own native row; end the block so the
			// visual order keeps matching the transcript order.
			closeGroup();
			return;
		}
		const entry = ensureEntry(event.toolCallId, event.toolName, event.args, true);
		entry.pending = true;
		entry.startedAt ??= Date.now();
		ensureAnimation();
	});

	pi.on("tool_execution_update", (event) => {
		const entry = entries.get(event.toolCallId);
		if (!entry) return;
		// Streaming output: keep it visible when the block is expanded.
		entry.resultText = resultTextOf(event.partialResult);
	});

	pi.on("tool_execution_end", (event) => {
		const entry = entries.get(event.toolCallId);
		if (!entry) return;
		entry.pending = false;
		entry.endedAt = Date.now();
		entry.isError = Boolean(event.isError);
		entry.resultText = resultTextOf(event.result);
		if (!hasPendingTool()) stopAnimation();
		repaint?.();
	});

	pi.on("agent_end", () => {
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
