// Path-resolution tests (SPEC §10 "路径解析").
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	MEMORY_DIR_NAME,
	MEMORY_INDEX_NAME,
	memoryDirFor,
	resolvePaths,
	scratchpadDirFor,
	scratchpadRoot,
	slugForCwd,
} from "../paths.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

test("slugForCwd matches pi's session-dir naming for absolute paths", () => {
	// Must match the directory name pi uses under ~/.pi/agent/sessions/
	// (SPEC §3 D4): drop leading /, swap / \ : for -, wrap in --.
	assert.equal(slugForCwd("/home/sjet/repo/pi-setup"), "--home-sjet-repo-pi-setup--");
	assert.equal(slugForCwd("/"), "----");
	assert.equal(slugForCwd("/tmp"), "--tmp--");
});

test("same cwd yields the same slug; different cwds differ (--no-session isolation)", () => {
	assert.equal(slugForCwd("/a/b"), slugForCwd("/a/b"));
	assert.notEqual(slugForCwd("/a/b"), slugForCwd("/a/c"));
	assert.notEqual(slugForCwd("/home/a"), slugForCwd("/home/b"));
});

test("relative and '..'-containing cwds are normalized to the same slug", () => {
	// slugForCwd resolves to absolute first, like pi's getDefaultSessionDirPath.
	assert.equal(slugForCwd("/home/x/proj"), slugForCwd("/home/x/other/../proj"));
});

test("memoryDirFor nests under <agentDir>/pi-note/<slug>", () => {
	const agentDir = "/tmp/fake-agent";
	const got = memoryDirFor(agentDir, "/home/sjet/repo/pi-setup");
	assert.equal(got, join(agentDir, MEMORY_DIR_NAME, "--home-sjet-repo-pi-setup--"));
});

test("scratchpadRoot / scratchpadDirFor honor the per-user tmp root", () => {
	const root = scratchpadRoot("/scratchbase", 1000);
	assert.equal(root, join("/scratchbase", "pi-note-1000"));
	const dir = scratchpadDirFor(SESSION_ID, root);
	assert.equal(dir, join(root, SESSION_ID));
});

test("resolvePaths returns memory + scratch dirs for the session", () => {
	const agentDir = "/tmp/fake-agent";
	const p = resolvePaths(agentDir, "/home/sjet/repo/pi-setup", SESSION_ID, {
		tmpDir: "/scratchbase",
		uid: 1000,
	});
	assert.equal(p.memoryDir, join(agentDir, MEMORY_DIR_NAME, "--home-sjet-repo-pi-setup--"));
	assert.equal(p.memoryIndex, join(p.memoryDir, MEMORY_INDEX_NAME));
	assert.equal(p.scratchDir, join("/scratchbase", "pi-note-1000", SESSION_ID));
});

test("same cwd + different session ids share memory but not scratchpads", () => {
	const agentDir = "/tmp/fake-agent";
	const a = resolvePaths(agentDir, "/home/x/proj", SESSION_ID, { tmpDir: "/s", uid: 1 });
	const b = resolvePaths(agentDir, "/home/x/proj", "99999999-0000-4000-8000-000000000000", {
		tmpDir: "/s",
		uid: 1,
	});
	assert.equal(a.memoryDir, b.memoryDir); // project-level memory: shared
	assert.notEqual(a.scratchDir, b.scratchDir); // session-level scratchpad: separate
});
