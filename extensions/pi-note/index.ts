// pi-note — persistent file-based memory (project-level) + per-session
// scratchpad for pi. Port of Claude Code's two mechanisms (SPEC.md).
//
// Three hooks, no registered tools or commands (SPEC §2):
//   session_start        create dirs, export PI_NOTE_SCRATCHPAD_DIR, snapshot MEMORY.md
//   before_agent_start   append rules text + index snapshot to the system prompt
//   tool_call            expand the scratchpad var in non-shell tool arguments
// Memory reads/writes are left entirely to the agent's own read/write/edit tools.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { SCRATCH_ENV_VAR, resolvePaths } from "./paths.ts";
import { prepareSession } from "./prepare.ts";
import { buildPromptAppend } from "./prompt.ts";
import { expandInputStrings } from "./expand.ts";

export default function piNoteExtension(pi: ExtensionAPI) {
	// Per-session state. session_start fires on startup/new/resume/fork/reload
	// (the extension instance is reloaded between sessions), so these are
	// re-initialized from disk on every one of those transitions.
	let ready = false;
	let memoryDir = "";
	let scratchDir = "";
	let snapshot = "";

	pi.on("session_start", (_event, ctx) => {
		try {
			const paths = resolvePaths(
				getAgentDir(),
				ctx.sessionManager.getCwd(),
				ctx.sessionManager.getSessionId(),
			);
			const prepared = prepareSession(paths.memoryDir, paths.scratchDir);
			memoryDir = paths.memoryDir;
			scratchDir = paths.scratchDir;
			snapshot = prepared.snapshot;
			// D1: scratchpad goes through the environment. bash resolves
			// process.env on every spawn, so this is enough — no bash override.
			process.env[SCRATCH_ENV_VAR] = scratchDir;
			ready = true;
		} catch (err) {
			// F1 step 5: one failure puts the plugin out of service — no
			// injection, no expansion. Throwing would be swallowed by pi's
			// runner (it never kills the process), so an explicit flag is the
			// only way to stop the later hooks from acting.
			ready = false;
			memoryDir = "";
			scratchDir = "";
			snapshot = "";
			delete process.env[SCRATCH_ENV_VAR]; // never leave a stale path behind
			ctx.ui.notify(
				`pi-note init failed — memory/scratchpad disabled: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!ready) return undefined;
		// F2: the system prompt is rebuilt from base every turn and extension
		// changes do not accumulate, so re-append each round. The appended
		// block is byte-identical for the whole session (snapshot is frozen at
		// session_start), preserving pi's prompt-prefix caching.
		return { systemPrompt: event.systemPrompt + buildPromptAppend(memoryDir, snapshot) };
	});

	pi.on("tool_call", (event) => {
		if (!ready || scratchDir === "") return;
		// F3: bash (and user `!` commands) reach the shell, where the real env
		// var expands natively. Everything else — read/write/edit/grep/find/ls
		// and custom tools — gets the literal prefix rewritten in place.
		if (event.toolName === "bash") return;
		// event.input is a union of the built-in tool inputs; at runtime it is
		// always a flat object of string parameters. Mutate in place (no
		// recursion into arrays / nested objects).
		expandInputStrings(event.input as Record<string, unknown>, scratchDir);
	});
}
