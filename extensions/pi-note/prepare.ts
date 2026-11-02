// Filesystem side of session setup, factored out of the hook so it can be
// exercised against throwaway directories. Throws on failure; the caller (the
// session_start hook) owns the degradation policy (SPEC §6 F1 step 5).
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_INDEX_NAME } from "./paths.ts";

export interface PreparedSession {
	/** MEMORY.md content at session start; "" means there is no index yet. */
	snapshot: string;
	/**
	 * Metadata of the file the snapshot was read from, when the two stats around
	 * the read agreed. The caller uses it as the refresh baseline, so the snapshot
	 * the model gets and the baseline always describe the same bytes; undefined
	 * means the file moved under the read and the baseline is discovered on the
	 * next turn instead.
	 */
	stat?: { mtimeNs: bigint; size: number };
}

/**
 * Create the project memory dir and an empty MEMORY.md if missing, create the
 * session scratchpad dir with mode 0700, then read MEMORY.md back as the
 * session snapshot. Idempotent: re-running on fork/reload is safe — existing
 * dirs are left untouched and the snapshot is re-read from disk.
 *
 * Both dirs MUST be pre-created here: the rules text tells the agent the dirs
 * already exist so it skips mkdir / existence checks on every write.
 */
export function prepareSession(memoryDir: string, scratchDir: string): PreparedSession {
	mkdirSync(memoryDir, { recursive: true });
	const memoryIndex = join(memoryDir, MEMORY_INDEX_NAME);
	if (!existsSync(memoryIndex)) writeFileSync(memoryIndex, "", "utf8");
	mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
	chmodSync(scratchDir, 0o700); // pin 0700 regardless of the process umask
	// Stat around the read: a snapshot whose metadata moved underneath it cannot
	// stand in as the refresh baseline, or a concurrent write would look like a
	// change the session already saw.
	const before = statSync(memoryIndex, { bigint: true });
	const snapshot = readFileSync(memoryIndex, "utf8");
	const after = statSync(memoryIndex, { bigint: true });
	if (before.mtimeNs !== after.mtimeNs || before.size !== after.size) return { snapshot };
	return { snapshot, stat: { mtimeNs: after.mtimeNs, size: Number(after.size) } };
}
