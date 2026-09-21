/**
 * Pure formatting / selection logic for pi-compact-calls.
 *
 * Nothing in here touches the pi runtime, so it can be unit-tested with plain
 * `node --test` (see tests/).
 */

import { homedir } from "os";

/** Argument summary length. */
export const SUMMARY_MAX_CHARS = 60;

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

export function oneLine(value: unknown, max = SUMMARY_MAX_CHARS): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, ms) / 1000;
	if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds % 60);
	if (minutes < 60) return `${minutes}m ${seconds}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function summaryOf(name: string, rawArgs: any): string {
	const args: any = rawArgs ?? {};
	switch (name) {
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

/**
 * The single call shown while collapsed: the newest still-running call wins, and
 * once the whole batch is done the last call in it.
 */
export function pickCollapsedTool<T extends ToolView>(tools: readonly T[]): T {
	for (let index = tools.length - 1; index >= 0; index--) {
		const tool = tools[index]!;
		if (tool.pending) return tool;
	}
	return tools[tools.length - 1]!;
}
