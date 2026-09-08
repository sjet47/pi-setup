// Pure path math for pi-note. No fs, no pi imports — unit-testable in isolation.
//
// Two scopes (SPEC §3 D1/D4/D5):
// - memory is project-level: every session in the same working directory shares
//   one dir, keyed by the same slug pi uses to name its session dirs.
// - scratchpad is session-level: one dir per globally-unique session id.
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const MEMORY_DIR_NAME = "pi-note";
export const MEMORY_INDEX_NAME = "MEMORY.md";
/** env var name injected at session_start and expanded in non-shell tools */
export const SCRATCH_ENV_VAR = "PI_NOTE_SCRATCHPAD_DIR";

/**
 * Encode a working directory as the slug pi uses for its session dir names
 * (mirror of session-manager's getDefaultSessionDirPath, which is not
 * exported): resolve to an absolute path, drop a leading separator, replace
 * `/`, `\` and `:` with `-`, wrap in `--`. E.g. `/home/sjet/repo/pi-setup`
 * -> `--home-sjet-repo-pi-setup--`.
 */
export function slugForCwd(cwd: string): string {
	const resolved = resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Project memory dir: <agentDir>/pi-note/<slug>. */
export function memoryDirFor(agentDir: string, cwd: string): string {
	return join(agentDir, MEMORY_DIR_NAME, slugForCwd(cwd));
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
	return join(tmpDir, `pi-note-${uid}`);
}

/** Session scratchpad dir: <root>/<session-id>. Session ids are global UUIDs. */
export function scratchpadDirFor(sessionId: string, root?: string): string {
	return join(root ?? scratchpadRoot(), sessionId);
}

export interface PiNotePaths {
	/** project memory dir: <agentDir>/pi-note/<slug> */
	memoryDir: string;
	/** MEMORY.md index path inside memoryDir */
	memoryIndex: string;
	/** session scratchpad dir */
	scratchDir: string;
}

/** One call that yields every path the session needs. */
export function resolvePaths(
	agentDir: string,
	cwd: string,
	sessionId: string,
	opts: { tmpDir?: string; uid?: number } = {},
): PiNotePaths {
	const memoryDir = memoryDirFor(agentDir, cwd);
	return {
		memoryDir,
		memoryIndex: join(memoryDir, MEMORY_INDEX_NAME),
		scratchDir: scratchpadDirFor(sessionId, scratchpadRoot(opts.tmpDir, opts.uid)),
	};
}
