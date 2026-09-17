// Filesystem side of the `/memory` browser. Read-only: the plugin still never
// writes memories itself (SPEC §2) — the overlay only shows what is on disk,
// read fresh on every open so it is never stale against the session snapshot.
import { readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MEMORY_INDEX_NAME } from "./paths.ts";
import { buildTopics, type MemoryTopic } from "./memory-index.ts";

/** Read the memory dir into topic rows. Never throws; missing dir = no topics. */
export function loadTopics(memoryDir: string): MemoryTopic[] {
	let indexText = "";
	try {
		indexText = readFileSync(join(memoryDir, MEMORY_INDEX_NAME), "utf8");
	} catch {
		// No MEMORY.md yet: every file in the dir becomes an orphan row.
		indexText = "";
	}
	let fileNames: string[] | undefined;
	try {
		fileNames = readdirSync(memoryDir);
	} catch {
		fileNames = undefined;
	}
	return buildTopics(indexText, fileNames);
}

export type MemoryBody =
	| { ok: true; text: string }
	| { ok: false; error: string };

/** Read one memory file. A failed read is data, not an exception. */
export function readTopicBody(memoryDir: string, file: string): MemoryBody {
	const target = resolveInside(memoryDir, file);
	if (target === undefined) return { ok: false, error: "unsafe path in MEMORY.md" };
	try {
		return { ok: true, text: readFileSync(target, "utf8") };
	} catch {
		return { ok: false, error: "file is missing" };
	}
}

/**
 * Resolve `file` inside `dir`, or undefined when it escapes the dir (absolute
 * paths and `..` traversal). Memory files are written by the agent, so the
 * index is trusted content — but a bad line must not read `/etc/shadow`.
 */
export function resolveInside(dir: string, file: string): string | undefined {
	if (file === "" || isAbsolute(file)) return undefined;
	const root = resolve(dir);
	const target = resolve(root, file);
	const rel = relative(root, target);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return target;
}

/** UTF-8 size of a memory file, for the detail header. */
export function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** `623 B` / `1.2 KB` / `3.4 MB` — for the detail header. */
export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
	return `${(kb / 1024).toFixed(1)} MB`;
}
