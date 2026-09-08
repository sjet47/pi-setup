// Directory-preparation tests (SPEC §6 F1 / §10): real temp dirs via
// mkdtempSync, nothing touches ~/.pi/agent/pi-note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePaths } from "../paths.ts";
import { prepareSession } from "../prepare.ts";

const SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function tmpAgentDir(): string {
	return mkdtempSync(join(tmpdir(), "pi-note-agent-"));
}

test("first run creates memory dir, empty MEMORY.md and a 0700 scratchpad", () => {
	const agentDir = tmpAgentDir();
	const tmpBase = mkdtempSync(join(tmpdir(), "pi-note-tmp-"));
	try {
		const p = resolvePaths(agentDir, "/home/sjet/repo/pi-setup", SESSION_ID, {
			tmpDir: tmpBase,
			uid: 1000,
		});
		const prepared = prepareSession(p.memoryDir, p.scratchDir);

		statSync(p.memoryDir); // memory dir exists
		const index = statSync(p.memoryIndex);
		assert.ok(index.isFile());
		assert.equal(index.size, 0); // empty index on first run

		const scratchStat = statSync(p.scratchDir);
		assert.ok(scratchStat.isDirectory());
		// scratchpad must be 0700 (SPEC §4 / F1)
		assert.equal(scratchStat.mode & 0o777, 0o700);

		assert.equal(prepared.snapshot, ""); // empty file => no index snapshot
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tmpBase, { recursive: true, force: true });
	}
});

test("existing memory is picked up as the snapshot on a later start", () => {
	const agentDir = tmpAgentDir();
	const tmpBase = mkdtempSync(join(tmpdir(), "pi-note-tmp-"));
	try {
		const p = resolvePaths(agentDir, "/home/sjet/repo/pi-setup", SESSION_ID, {
			tmpDir: tmpBase,
			uid: 1000,
		});
		const prepared = prepareSession(p.memoryDir, p.scratchDir);
		assert.equal(prepared.snapshot, "");

		// agent writes a memory + index entry mid-session (simulated)
		writeFileSync(join(p.memoryDir, "cli-preferences.md"), "Use jq for JSON.\n", "utf8");
		writeFileSync(p.memoryIndex, "- [CLI prefs](cli-preferences.md) — jq/glab\n", "utf8");

		// next session_start re-reads the index
		const second = prepareSession(p.memoryDir, p.scratchDir);
		assert.equal(second.snapshot, "- [CLI prefs](cli-preferences.md) — jq/glab\n");
		statSync(p.memoryDir); // still a dir (no re-create failure)
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tmpBase, { recursive: true, force: true });
	}
});

test("two sessions share the memory dir but keep separate scratchpads", () => {
	const agentDir = tmpAgentDir();
	const tmpBase = mkdtempSync(join(tmpdir(), "pi-note-tmp-"));
	try {
		const p1 = resolvePaths(agentDir, "/home/sjet/repo/pi-setup", SESSION_ID, {
			tmpDir: tmpBase,
			uid: 1000,
		});
		const p2 = resolvePaths(
			agentDir,
			"/home/sjet/repo/pi-setup",
			"99999999-0000-4000-8000-000000000000",
			{ tmpDir: tmpBase, uid: 1000 },
		);
		prepareSession(p1.memoryDir, p1.scratchDir);
		prepareSession(p2.memoryDir, p2.scratchDir);

		// US-7: both write the same filename, land in different dirs
		writeFileSync(join(p1.scratchDir, "output.json"), "one", "utf8");
		writeFileSync(join(p2.scratchDir, "output.json"), "two", "utf8");
		assert.notEqual(p1.scratchDir, p2.scratchDir);
		assert.equal(p1.memoryDir, p2.memoryDir);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tmpBase, { recursive: true, force: true });
	}
});

test("init failure when the memory dir path is blocked by a regular file (US-9)", () => {
	const agentDir = tmpAgentDir();
	const tmpBase = mkdtempSync(join(tmpdir(), "pi-note-tmp-"));
	try {
		const p = resolvePaths(agentDir, "/home/sjet/repo/pi-setup", SESSION_ID, {
			tmpDir: tmpBase,
			uid: 1000,
		});
		// Occupy the memory dir path with a plain file -> mkdir cannot proceed.
		mkdirSync(join(agentDir, "pi-note"), { recursive: true });
		writeFileSync(p.memoryDir, "I am a file, not a dir", "utf8");

		assert.throws(() => prepareSession(p.memoryDir, p.scratchDir));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tmpBase, { recursive: true, force: true });
	}
});

test("re-running prepareSession is idempotent (fork/reload re-enter)", () => {
	const agentDir = tmpAgentDir();
	const tmpBase = mkdtempSync(join(tmpdir(), "pi-note-tmp-"));
	try {
		const p = resolvePaths(agentDir, "/home/sjet/repo/pi-setup", SESSION_ID, {
			tmpDir: tmpBase,
			uid: 1000,
		});
		const first = prepareSession(p.memoryDir, p.scratchDir);
		const second = prepareSession(p.memoryDir, p.scratchDir);
		assert.deepEqual(second, first);
		// scratchpad stays 0700 across re-runs
		assert.equal(statSync(p.scratchDir).mode & 0o777, 0o700);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tmpBase, { recursive: true, force: true });
	}
});
