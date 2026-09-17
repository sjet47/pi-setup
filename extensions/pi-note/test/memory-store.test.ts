// Filesystem tests for the `/memory` browser: topic loading, body reads and
// the path guard. Uses a throwaway directory.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byteLength, formatBytes, loadTopics, readTopicBody, resolveInside } from "../memory-store.ts";

function withTempMemory(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "pi-note-browser-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("loadTopics merges MEMORY.md with the files on disk", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "MEMORY.md"), "- [Indexed](indexed.md) — hook\n- [Gone](gone.md) — hook\n");
		writeFileSync(join(dir, "indexed.md"), "# Indexed\n");
		writeFileSync(join(dir, "orphan.md"), "# Orphan\n");
		const topics = loadTopics(dir);
		assert.deepEqual(topics.map((topic) => [topic.file, topic.indexed, topic.exists]), [
			["indexed.md", true, true],
			["gone.md", true, false],
			["orphan.md", false, true],
		]);
	});
});

test("loadTopics survives a missing dir and a missing index", () => {
	withTempMemory((dir) => {
		assert.deepEqual(loadTopics(join(dir, "nope")), []);
		writeFileSync(join(dir, "only.md"), "# Only\n");
		assert.deepEqual(loadTopics(dir).map((topic) => topic.file), ["only.md"]);
	});
});

test("readTopicBody returns content, or an error for a missing file", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "a.md"), "# A\n");
		assert.deepEqual(readTopicBody(dir, "a.md"), { ok: true, text: "# A\n" });
		assert.deepEqual(readTopicBody(dir, "b.md"), { ok: false, error: "file is missing" });
	});
});

test("readTopicBody refuses paths that escape the memory dir", () => {
	withTempMemory((dir) => {
		for (const file of ["../secret.md", "/etc/passwd", ""]) {
			assert.deepEqual(readTopicBody(dir, file), { ok: false, error: "unsafe path in MEMORY.md" });
		}
		assert.equal(resolveInside(dir, "nested/a.md"), join(dir, "nested", "a.md"));
		assert.equal(resolveInside(dir, "nested/../../a.md"), undefined);
	});
});

test("formatBytes and byteLength agree on the size of a memory file", () => {
	assert.equal(formatBytes(623), "623 B");
	assert.equal(formatBytes(2048), "2.0 KB");
	assert.equal(formatBytes(1024 * 1024 * 3), "3.0 MB");
	assert.equal(byteLength("双 seat"), 8);
});

test("readTopicBody reads a nested target from the index", () => {
	withTempMemory((dir) => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "sub", "n.md"), "# Nested\n");
		assert.deepEqual(readTopicBody(dir, "sub/n.md"), { ok: true, text: "# Nested\n" });
	});
});
