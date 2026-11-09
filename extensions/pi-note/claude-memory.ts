// Filesystem/env half of the memory location: read Claude Code's own config so
// pi-note lands on the exact directory Claude Code uses (paths.ts owns the pure
// path math). Kept out of paths.ts so that module stays fs-free and testable.
//
// What is mirrored:
// 1. `$CLAUDE_CONFIG_DIR` (else `~/.claude`) — the base Claude Code resolves
//    `projects/` under; a stale copy of this would put memories somewhere
//    Claude Code never reads.
// 2. `autoMemoryDirectory` from `<config>/settings.json` (user settings) —
//    Claude Code then stops keying memories per project and uses that one dir,
//    so mirroring it is the only way to keep sharing the files.
//
// What is deliberately NOT mirrored (documented in docs/pi-note.md §3 D4.2):
// `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE`, `CLAUDE_CODE_REMOTE_MEMORY_DIR`
// (cowork/cloud-session modes pi does not run in), and `autoMemoryEnabled`
// (a Claude Code toggle must not silently switch pi's memory off).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ClaudeMemoryConfig } from "./paths.ts";

/** Env var Claude Code resolves its config dir from. */
export const CLAUDE_CONFIG_DIR_ENV = "CLAUDE_CONFIG_DIR";

/** Claude Code's config dir: `$CLAUDE_CONFIG_DIR`, else `<home>/.claude`. */
export function claudeConfigDir(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): string {
	const configured = env[CLAUDE_CONFIG_DIR_ENV]?.trim();
	if (configured !== undefined && configured !== "") return expandHome(configured, home);
	return join(home, ".claude");
}

/** Expand a leading `~/` (the only expansion Claude Code performs on it). */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return resolve(home);
	if (path.startsWith("~/")) return resolve(join(home, path.slice(2)));
	return resolve(path);
}

/**
 * Normalize a parsed Claude Code settings object (or anything a failed read
 * produced) into the memory config pi-note needs. A mistyped or relative
 * `autoMemoryDirectory` is ignored rather than guessed at: landing somewhere
 * Claude Code does not read is worse than following the default layout.
 */
export function normalizeClaudeMemoryConfig(
	raw: unknown,
	configDir: string,
	home: string = homedir(),
): ClaudeMemoryConfig {
	if (typeof raw !== "object" || raw === null) return { configDir };
	const value = (raw as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
	if (typeof value !== "string" || value.trim() === "") return { configDir };
	return { configDir, autoMemoryDirectory: expandHome(value.trim(), home) };
}

/** Read `<configDir>/settings.json`; unreadable or malformed means "defaults". */
export function resolveClaudeMemoryConfig(
	env: Record<string, string | undefined> = process.env,
	home: string = homedir(),
): ClaudeMemoryConfig {
	const configDir = claudeConfigDir(env, home);
	try {
		const raw: unknown = JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8"));
		return normalizeClaudeMemoryConfig(raw, configDir, home);
	} catch {
		return { configDir };
	}
}
