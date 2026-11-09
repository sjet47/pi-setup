// Path-resolution tests (SPEC §10 "路径解析").
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	CLAUDE_MEMORY_DIR_NAME,
	CLAUDE_PROJECTS_DIR,
	MEMORY_INDEX_NAME,
	claudeSlugFor,
	memoryDirFor,
	memoryRootLabel,
	resolvePaths,
	scratchpadDirFor,
	scratchpadRoot,
	type ClaudeMemoryConfig,
} from "../paths.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const CONFIG: ClaudeMemoryConfig = { configDir: "/home/sjet/.claude" };

test("claudeSlugFor reproduces Claude Code's project dir names", () => {
	// These two are asserted against real directories under
	// ~/.claude/projects/ on the author's machine: the underscore in
	// `heybox_script` is flattened to `-`, and there is no `--` wrapper.
	assert.equal(claudeSlugFor("/home/sjet/repo/pi-setup"), "-home-sjet-repo-pi-setup");
	assert.equal(claudeSlugFor("/home/sjet/heybox/repo/heybox_script"), "-home-sjet-heybox-repo-heybox-script");
	assert.equal(claudeSlugFor("/tmp"), "-tmp");
	assert.equal(claudeSlugFor("/"), "-");
	// Case is preserved (Claude Code does not lowercase).
	assert.equal(claudeSlugFor("/tmp/t3code/claude-title-rZ0QID"), "-tmp-t3code-claude-title-rZ0QID");
});

test("claudeSlugFor normalizes relative and '..'-containing paths first", () => {
	assert.equal(claudeSlugFor("/home/x/proj"), claudeSlugFor("/home/x/other/../proj"));
	assert.equal(claudeSlugFor("proj"), claudeSlugFor(process.cwd() + "/proj"));
});

test("claudeSlugFor appends a base36 hash only past the 200-character cap", () => {
	const exact = "/" + "a".repeat(199); // sanitized length 200: no suffix
	assert.equal(claudeSlugFor(exact), "-" + "a".repeat(199));
	const long = "/" + "a".repeat(200);
	const slug = claudeSlugFor(long);
	const marker = slug.lastIndexOf("-");
	assert.equal(slug.slice(0, marker), "-" + "a".repeat(199), "head is truncated to 200 characters");
	assert.match(slug.slice(marker + 1), /^[0-9a-z]+$/, "suffix is base36");
	// Two paths sharing the first 200 characters must still land in two dirs.
	const sibling = "/" + "a".repeat(199) + "b";
	assert.notEqual(claudeSlugFor(sibling), slug);
});

test("memoryDirFor nests under <configDir>/projects/<slug>/memory", () => {
	assert.equal(
		memoryDirFor(CONFIG, "/home/sjet/repo/pi-setup"),
		join("/home/sjet/.claude", CLAUDE_PROJECTS_DIR, "-home-sjet-repo-pi-setup", CLAUDE_MEMORY_DIR_NAME),
	);
});

test("memoryDirFor lets autoMemoryDirectory win over the project keying", () => {
	// Claude Code ignores per-project keying once autoMemoryDirectory is set, so
	// pi-note has to use that one dir too or the two stop sharing files.
	const config: ClaudeMemoryConfig = { configDir: "/home/sjet/.claude", autoMemoryDirectory: "/srv/memory" };
	assert.equal(memoryDirFor(config, "/home/sjet/repo/pi-setup"), "/srv/memory");
	assert.equal(memoryDirFor(config, "/home/sjet/repo/other"), "/srv/memory");
});

test("scratchpadRoot / scratchpadDirFor honor the per-user tmp root", () => {
	const root = scratchpadRoot("/scratchbase", 1000);
	assert.equal(root, join("/scratchbase", "pi-note-1000"));
	const dir = scratchpadDirFor(SESSION_ID, root);
	assert.equal(dir, join(root, SESSION_ID));
});

test("resolvePaths returns memory + scratch dirs for the session", () => {
	const p = resolvePaths(CONFIG, "/home/sjet/repo/pi-setup", SESSION_ID, {
		tmpDir: "/scratchbase",
		uid: 1000,
	});
	assert.equal(
		p.memoryDir,
		join("/home/sjet/.claude", CLAUDE_PROJECTS_DIR, "-home-sjet-repo-pi-setup", CLAUDE_MEMORY_DIR_NAME),
	);
	assert.equal(p.memoryIndex, join(p.memoryDir, MEMORY_INDEX_NAME));
	assert.equal(p.scratchDir, join("/scratchbase", "pi-note-1000", SESSION_ID));
});

test("same cwd + different session ids share memory but not scratchpads", () => {
	const a = resolvePaths(CONFIG, "/home/x/proj", SESSION_ID, { tmpDir: "/s", uid: 1 });
	const b = resolvePaths(CONFIG, "/home/x/proj", "99999999-0000-4000-8000-000000000000", {
		tmpDir: "/s",
		uid: 1,
	});
	assert.equal(a.memoryDir, b.memoryDir); // project-level memory: shared
	assert.notEqual(a.scratchDir, b.scratchDir); // session-level scratchpad: separate
});

test("memoryRootLabel shortens the home prefix and nothing else", () => {
	assert.equal(memoryRootLabel("/home/sjet/repo/pi-setup", "/home/sjet"), "~/repo/pi-setup");
	assert.equal(memoryRootLabel("/home/sjet", "/home/sjet"), "~");
	assert.equal(memoryRootLabel("/srv/work", "/home/sjet"), "/srv/work");
	assert.equal(memoryRootLabel("/home/sjeter/x", "/home/sjet"), "/home/sjeter/x");
	assert.equal(memoryRootLabel("/home/sjet/repo/pi-setup", ""), "/home/sjet/repo/pi-setup");
});
