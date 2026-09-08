// System-prompt material for pi-note: the rules text from SPEC §7, injected
// verbatim with only <MEMORY_DIR> substituted, plus the "## Memory index"
// snapshot section when a memory index exists. Pure string assembly.
//
// Byte stability is the whole point (SPEC §3 D2): the snapshot is read once at
// session_start and held in memory, so for every turn of a session this module
// produces byte-identical output and pi's prompt-prefix caching is preserved —
// memories written mid-session never change the injected block.

/** Literal placeholder inside the rules text, replaced with the absolute memory dir. */
export const MEMORY_DIR_PLACEHOLDER = "<MEMORY_DIR>";

/** Header of the injected snapshot section. */
export const MEMORY_INDEX_HEADER = "## Memory index";

/**
 * Rules text (SPEC §7), verbatim. The text is aimed at the model; the memory
 * dir appears as <MEMORY_DIR> (substituted at assembly time) while the
 * scratchpad dir stays as the literal $PI_NOTE_SCRATCHPAD_DIR variable so the
 * prompt never changes between fork/resume.
 */
export const RULES_TEXT = `# Memory

You have a persistent file-based memory for this project at \`<MEMORY_DIR>\`. This directory already exists — write to it directly. Do not run mkdir and do not check whether it exists.

Each memory is one markdown file holding one topic that can be updated on its own, named \`<short-kebab-case-slug>.md\`, no frontmatter. Worth saving: who the user is (role, expertise, preferences); guidance the user has given on how you should work, with the why; ongoing work, goals, or constraints not derivable from the code or git history (convert relative dates to absolute); pointers to external resources (URLs, dashboards, tickets).

After writing the file, add a one-line pointer in \`<MEMORY_DIR>/MEMORY.md\`: \`- [Title](file.md) — hook\`. One line per memory, never put memory content there.

The index is included below as a snapshot taken at session start. When a line looks relevant to the task at hand, read that file before acting on the topic; do not guess at its contents from the hook. Memories you write during this session will not appear in the snapshot; read \`<MEMORY_DIR>/MEMORY.md\` directly when you need the authoritative current list, and after context compaction before acting on past agreements.

Before saving, check the index for an existing entry that already covers it. Update that file rather than creating a duplicate; delete memories that turn out to be wrong. Don't save what the repo already records (code structure, past fixes, git history, AGENTS.md) or what only matters to the current conversation; if asked to remember one of those, ask what was non-obvious about it and save that instead. Never save secrets or credentials. Memories reflect what was true when written — if one names a file, function, or flag, verify it still exists before recommending it.

# Scratchpad

\`$PI_NOTE_SCRATCHPAD_DIR\` is a scratch directory for this session. Use it for temporary files — intermediate results, throwaway scripts, command output that doesn't belong in the project — instead of \`/tmp\` or the working directory. It already exists and is session-specific. Write the path literally as \`$PI_NOTE_SCRATCHPAD_DIR/<file>\` in any tool; it is expanded for you. Only use \`/tmp\` if the user explicitly asks.`;

/**
 * Build the byte-exact block appended to the system prompt for this session
 * (SPEC §6 F2). Always returns the rules text (leading blank line for
 * separation); when the snapshot is non-empty the "## Memory index" section is
 * appended after it, otherwise no index section — no "you have no memories
 * yet" noise. Caller prepends the existing system prompt.
 */
export function buildPromptAppend(memoryDir: string, snapshot: string): string {
	const rules = RULES_TEXT.split(MEMORY_DIR_PLACEHOLDER).join(memoryDir);
	if (snapshot === "") {
		return "\n\n" + rules;
	}
	return "\n\n" + rules + "\n\n" + MEMORY_INDEX_HEADER + "\n\n" + snapshot;
}
