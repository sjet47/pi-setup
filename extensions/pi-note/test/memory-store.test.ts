// Filesystem tests for the `/memory` browser: topic loading, body reads and
// the path guard. Uses a throwaway directory.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	byteLength,
	deleteTopic,
	formatBytes,
	listMemoryFiles,
	loadTopics,
	readTopicBody,
	resolveInside,
} from "../memory-store.ts";
import type { MemoryTopic } from "../memory-index.ts";

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

test("listMemoryFiles reports size and mtime and skips non-files", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "a.md"), "0123456789");
		writeFileSync(join(dir, "MEMORY.md"), "");
		mkdirSync(join(dir, "sub"));
		mkdirSync(join(dir, "weird.md")); // a directory that looks like a memory
		const when = new Date("2020-02-02T02:02:02Z");
		utimesSync(join(dir, "a.md"), when, when);

		const files = listMemoryFiles(dir);
		assert.ok(files);
		const byName = new Map(files.map((entry) => [entry.name, entry]));
		assert.equal(byName.get("a.md")?.size, 10);
		assert.equal(byName.get("a.md")?.mtimeMs, when.getTime());
		assert.ok(byName.has("MEMORY.md"));
		assert.ok(!byName.has("sub"));
		assert.ok(!byName.has("weird.md"));
	});
});

test("listMemoryFiles follows a symlinked memory and drops a broken one", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "real.md"), "0123");
		symlinkSync(join(dir, "real.md"), join(dir, "linked.md"));
		symlinkSync(join(dir, "nope.md"), join(dir, "broken.md"));

		const files = listMemoryFiles(dir);
		assert.ok(files);
		const names = files.map((entry) => entry.name);
		assert.ok(names.includes("linked.md"));
		assert.equal(files.find((entry) => entry.name === "linked.md")?.size, 4);
		// A broken link is not a readable memory: absent from the listing, so an
		// index line pointing at it reads as missing.
		assert.ok(!names.includes("broken.md"));
	});
});

test("listMemoryFiles returns undefined when the dir cannot be listed", () => {
	withTempMemory((dir) => {
		assert.equal(listMemoryFiles(join(dir, "nope")), undefined);
	});
});

test("loadTopics carries size and mtime through to the topics", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "MEMORY.md"), "- [Indexed](indexed.md) — hook\n- [Gone](gone.md) — hook\n");
		writeFileSync(join(dir, "indexed.md"), "01234");
		writeFileSync(join(dir, "orphan.md"), "0123456789");
		const byName = new Map(loadTopics(dir).map((topic) => [topic.file, topic]));
		assert.equal(byName.get("indexed.md")?.size, 5);
		assert.equal(typeof byName.get("indexed.md")?.mtimeMs, "number");
		assert.equal(byName.get("orphan.md")?.size, 10);
		// A missing file has no stats to show, only the missing flag.
		assert.equal(byName.get("gone.md")?.exists, false);
		assert.equal(byName.get("gone.md")?.size, undefined);
	});
});

test("deleteTopic removes the file and its index line, keeping the rest intact", () => {
	withTempMemory((dir) => {
		const index = ["# Memory", "", "- [Keep](keep.md) — k", "- [Gone](gone.md) — g", "", "- [Tail](tail.md) — t", ""].join("\n");
		writeFileSync(join(dir, "MEMORY.md"), index);
		chmodSync(join(dir, "MEMORY.md"), 0o600);
		for (const name of ["keep.md", "gone.md", "tail.md"]) writeFileSync(join(dir, name), name);
		const topic = loadTopics(dir).find((entry) => entry.file === "gone.md");
		assert.ok(topic);

		assert.deepEqual(deleteTopic(dir, topic), { ok: true });
		assert.equal(existsSync(join(dir, "gone.md")), false);
		assert.equal(existsSync(join(dir, "keep.md")), true);
		assert.equal(
			readFileSync(join(dir, "MEMORY.md"), "utf8"),
			["# Memory", "", "- [Keep](keep.md) — k", "", "- [Tail](tail.md) — t", ""].join("\n"),
		);
		// The atomic write leaves no temp file behind and keeps the index's mode.
		assert.ok(!readdirSync(dir).some((name) => name.includes(".tmp-")));
		assert.equal(statSync(join(dir, "MEMORY.md")).mode & 0o777, 0o600);
	});
});

test("deleteTopic removes every duplicate index line pointing at the file", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "MEMORY.md"), "- [A](a.md) — one\n- [A again](a.md) — two\n- [B](b.md) — b\n");
		writeFileSync(join(dir, "a.md"), "a");
		writeFileSync(join(dir, "b.md"), "b");
		const topic = loadTopics(dir).find((entry) => entry.file === "a.md");
		assert.ok(topic);
		assert.deepEqual(deleteTopic(dir, topic), { ok: true });
		assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), "- [B](b.md) — b\n");
	});
});

test("deleteTopic cleans up a stale index line whose file is already gone", () => {
	withTempMemory((dir) => {
		writeFileSync(join(dir, "MEMORY.md"), "- [Gone](gone.md) — stale\n- [Kept](kept.md) — k\n");
		writeFileSync(join(dir, "kept.md"), "k");
		const topic = loadTopics(dir).find((entry) => entry.file === "gone.md");
		assert.ok(topic);
		assert.equal(topic.exists, false);
		assert.deepEqual(deleteTopic(dir, topic), { ok: true });
		assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), "- [Kept](kept.md) — k\n");
	});
});

test("deleteTopic deletes an orphan file without rewriting MEMORY.md", () => {
	withTempMemory((dir) => {
		const index = "# Memory\n- [Kept](kept.md) — k\n";
		writeFileSync(join(dir, "MEMORY.md"), index);
		writeFileSync(join(dir, "kept.md"), "k");
		writeFileSync(join(dir, "orphan.md"), "o");
		const topic = loadTopics(dir).find((entry) => entry.file === "orphan.md");
		assert.ok(topic);
		assert.equal(topic.indexed, false);
		assert.deepEqual(deleteTopic(dir, topic), { ok: true });
		assert.equal(existsSync(join(dir, "orphan.md")), false);
		assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), index);
	});
});

test("deleteTopic refuses an index line that escapes the memory dir", () => {
	withTempMemory((dir) => {
		const outside = join(dir, "..", "outside-memory.md");
		writeFileSync(outside, "do not delete me");
		try {
			const topic: MemoryTopic = {
				title: "Outside",
				file: "../outside-memory.md",
				hook: "",
				indexed: true,
				exists: true,
			};
			assert.deepEqual(deleteTopic(dir, topic), { ok: false, error: "unsafe path in MEMORY.md" });
			assert.equal(existsSync(outside), true);
		} finally {
			rmSync(outside, { force: true });
		}
	});
});

test("deleteTopic handles a nested target", () => {
	withTempMemory((dir) => {
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "MEMORY.md"), "- [Nested](sub/n.md) — n\n");
		writeFileSync(join(dir, "sub", "n.md"), "n");
		const topic = loadTopics(dir).find((entry) => entry.file === "sub/n.md");
		assert.ok(topic);
		assert.deepEqual(deleteTopic(dir, topic), { ok: true });
		assert.equal(existsSync(join(dir, "sub", "n.md")), false);
		assert.equal(readFileSync(join(dir, "MEMORY.md"), "utf8"), "");
	});
});
