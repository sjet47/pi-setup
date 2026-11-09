// Pure path math for pi-note. No fs, no pi imports — unit-testable in isolation.
//
// Memory is NOT pi-note's own directory any more: it is Claude Code's
// auto-memory directory, so one project's memories are the same files whichever
// agent wrote them (pi, Claude Code, dsh). Claude Code's rules, as of 2.1.319:
//
// 1. the dir is `<config>/projects/<slug>/memory`, where `<config>` is
//    `$CLAUDE_CONFIG_DIR` or `~/.claude` (see claude-memory.ts, which owns the
//    config/env/filesystem half);
// 2. `<slug>` is the working directory with every character outside
//    `[A-Za-z0-9]` replaced by `-` (case kept, runs NOT collapsed), truncated
//    to 200 characters plus `-<base36 of a Java-style hash>` when longer;
// 3. the directory it keys on is the repository's main worktree, so every
//    linked worktree of one repo shares one memory dir — same input as
//    git-root.ts produces.
//
// Scratchpad stays pi-note's own, session-scoped thing (SPEC §3 D5).
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

export const MEMORY_INDEX_NAME = "MEMORY.md";
/** env var name injected at session_start and expanded in non-shell tools */
export const SCRATCH_ENV_VAR = "PI_NOTE_SCRATCHPAD_DIR";
/** subdirectory of Claude Code's config dir that holds per-project dirs */
export const CLAUDE_PROJECTS_DIR = "projects";
/** Claude Code's name for the auto-memory dir inside a project dir */
export const CLAUDE_MEMORY_DIR_NAME = "memory";
/** prefix of the per-user scratchpad root under the tmpdir */
export const SCRATCHPAD_ROOT_PREFIX = "pi-note";

/**
 * Claude Code's project key for a directory: `/home/sjet/repo/pi-setup` ->
 * `-home-sjet-repo-pi-setup`. Mirrors `fL()` in Claude Code: sanitize every
 * non-alphanumeric to `-`, and only when that is longer than 200 characters
 * append `-<hash>` computed over the unsanitized path (Java `hashCode`, base36,
 * absolute value) — the truncation exists so one deep path cannot overflow a
 * filename, and matching it exactly matters: a mismatch silently splits one
 * project's memories across two dirs.
 */
export function claudeSlugFor(dir: string): string {
	const base = resolve(dir);
	const sanitized = base.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= 200) return sanitized;
	return `${sanitized.slice(0, 200)}-${Math.abs(javaHash(base)).toString(36)}`;
}

/** Java's `String.hashCode`, which Claude Code uses for the truncation suffix. */
function javaHash(text: string): number {
	let hash = 0;
	for (let index = 0; index < text.length; index += 1) {
		hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
	}
	return hash;
}

/**
 * Short label for a memory root, used as the `/memory` browser header:
 * `/home/sjet/repo/pi-setup` -> `~/repo/pi-setup`. Deliberately derived from
 * the real path, not from the slug — the slug is lossy, so reversing it would
 * turn `pi-setup` into `pi/setup`.
 */
export function memoryRootLabel(memoryRoot: string, home: string = homedir()): string {
	const resolved = resolve(memoryRoot);
	if (home === "") return resolved;
	const root = resolve(home);
	if (resolved === root) return "~";
	return resolved.startsWith(root + sep) ? `~${resolved.slice(root.length)}` : resolved;
}

/**
 * Where Claude Code keeps one project's memories. `autoMemoryDirectory` wins
 * when set: Claude Code then ignores the project keying entirely and uses that
 * one dir for every project, so mirroring it is the only way to stay on the
 * same files (`~/` is already expanded by claude-memory.ts).
 */
export function memoryDirFor(config: ClaudeMemoryConfig, memoryRoot: string): string {
	if (config.autoMemoryDirectory !== undefined) return config.autoMemoryDirectory;
	return join(
		config.configDir,
		CLAUDE_PROJECTS_DIR,
		claudeSlugFor(memoryRoot),
		CLAUDE_MEMORY_DIR_NAME,
	);
}

/** The Claude Code side of the memory location, resolved from env + settings. */
export interface ClaudeMemoryConfig {
	/** `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
	configDir: string;
	/** `autoMemoryDirectory` from Claude Code's user settings, absolute. */
	autoMemoryDirectory?: string;
}

/** Numeric OS user id; 0 when the runtime does not expose it (non-POSIX). */
export function currentUid(): number {
	return typeof process.getuid === "function" ? process.getuid() : 0;
}

/**
 * Scratchpad root under the shared tmpdir. Layout is `/tmp/pi-note-<uid>/`
 * where `<uid>` is read as the numeric OS user id (process.getuid): the
 * scratchpad lives in the world-writable /tmp, so per-user isolation keeps
 * different users of one machine from colliding.
 */
export function scratchpadRoot(
	tmpDir: string = tmpdir(),
	uid: number = currentUid(),
): string {
	return join(tmpDir, `${SCRATCHPAD_ROOT_PREFIX}-${uid}`);
}

/** Session scratchpad dir: <root>/<session-id>. Session ids are global UUIDs. */
export function scratchpadDirFor(sessionId: string, root?: string): string {
	return join(root ?? scratchpadRoot(), sessionId);
}

export interface PiNotePaths {
	/** project memory dir: <configDir>/projects/<slug>/memory */
	memoryDir: string;
	/** MEMORY.md index path inside memoryDir */
	memoryIndex: string;
	/** session scratchpad dir */
	scratchDir: string;
}

/** One call that yields every path the session needs. `memoryRoot` is a working
 *  directory: the cwd, or the git root when the cwd is a linked worktree. */
export function resolvePaths(
	config: ClaudeMemoryConfig,
	memoryRoot: string,
	sessionId: string,
	opts: { tmpDir?: string; uid?: number } = {},
): PiNotePaths {
	const memoryDir = memoryDirFor(config, memoryRoot);
	return {
		memoryDir,
		memoryIndex: join(memoryDir, MEMORY_INDEX_NAME),
		scratchDir: scratchpadDirFor(sessionId, scratchpadRoot(opts.tmpDir, opts.uid)),
	};
}
