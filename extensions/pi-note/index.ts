// pi-note — persistent file-based memory (project-level) + per-session
// scratchpad for pi. Port of Claude Code's two mechanisms (docs/pi-note.md).
//
// Three hooks, no registered tools (SPEC §2):
//   session_start        create dirs, export PI_NOTE_SCRATCHPAD_DIR, snapshot MEMORY.md
//   before_agent_start   append rules text + index snapshot to the system prompt
//   tool_call            expand the scratchpad var in non-shell tool arguments
// Memory reads/writes are left entirely to the agent's own read/write/edit tools.
//
// One read-only command: `/memory` opens the browser overlay over the topics in
// MEMORY.md (browser.ts). It reads from disk on every invocation, so it shows
// memories written after session_start, and it never writes anything.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { SCRATCH_ENV_VAR, memoryRootLabel, resolvePaths } from "./paths.ts";
import { memoryRootFor } from "./git-root.ts";
import { prepareSession } from "./prepare.ts";
import { buildPromptAppend } from "./prompt.ts";
import { expandInputStrings } from "./expand.ts";
import { loadTopics, readTopicBody } from "./memory-store.ts";
import { MemoryBrowserOverlay } from "./browser.ts";

export default function piNoteExtension(pi: ExtensionAPI) {
	// Per-session state. session_start fires on startup/new/resume/fork/reload
	// (the extension instance is reloaded between sessions), so these are
	// re-initialized from disk on every one of those transitions.
	let ready = false;
	let memoryDir = "";
	let memoryRoot = "";
	let scratchDir = "";
	let snapshot = "";

	pi.on("session_start", (_event, ctx) => {
		try {
			// Key memory on the git root, not the raw cwd: every `git worktree`
			// of one repository shares the main checkout's memory dir (SPEC §3 D4).
			const root = memoryRootFor(ctx.sessionManager.getCwd());
			const paths = resolvePaths(getAgentDir(), root, ctx.sessionManager.getSessionId());
			const prepared = prepareSession(paths.memoryDir, paths.scratchDir);
			memoryDir = paths.memoryDir;
			memoryRoot = root;
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
			memoryRoot = "";
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

	pi.registerCommand("memory", {
		description: "Browse this project's memories (MEMORY.md topics)",
		handler: async (_args, ctx) => {
			if (!ready || memoryDir === "") {
				ctx.ui.notify("pi-note is not initialized in this session — nothing to browse.", "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The memory browser needs the interactive TUI.", "warning");
				return;
			}
			// Read fresh: the overlay is the authoritative on-disk view, unlike the
			// frozen session_start snapshot injected into the system prompt.
			const topics = loadTopics(memoryDir);
			const label = memoryRootLabel(memoryRoot);
			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) => {
					const overlay = new MemoryBrowserOverlay({
						topics,
						label,
						terminalRows: () => tui.terminal.rows,
						now: () => Date.now(),
						theme,
						markdownTheme: getMarkdownTheme(),
						keybindings,
						readBody: (topic) => readTopicBody(memoryDir, topic.file),
						onDone: () => done(undefined),
					});
					return {
						get focused() {
							return overlay.focused;
						},
						set focused(value: boolean) {
							overlay.focused = value;
						},
						render: (width: number) => overlay.render(width),
						invalidate: () => overlay.invalidate(),
						handleInput: (data: string) => {
							overlay.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "80%", minWidth: 56, margin: 1 },
				},
			);
		},
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
