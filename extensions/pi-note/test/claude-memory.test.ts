// Claude Code config-dir resolution tests (SPEC §3 D4.1/D4.2). Every case runs
// against a throwaway dir; nothing reads the real ~/.claude.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	CLAUDE_CONFIG_DIR_ENV,
	claudeConfigDir,
	expandHome,
	normalizeClaudeMemoryConfig,
	resolveClaudeMemoryConfig,
} from "../claude-memory.ts";

const HOME = "/home/sjet";

test("claudeConfigDir honors $CLAUDE_CONFIG_DIR, else <home>/.claude", () => {
	assert.equal(claudeConfigDir({}, HOME), join(HOME, ".claude"));
	assert.equal(claudeConfigDir({ [CLAUDE_CONFIG_DIR_ENV]: "" }, HOME), join(HOME, ".claude"));
	assert.equal(claudeConfigDir({ [CLAUDE_CONFIG_DIR_ENV]: "  " }, HOME), join(HOME, ".claude"));
	assert.equal(claudeConfigDir({ [CLAUDE_CONFIG_DIR_ENV]: "/srv/claude" }, HOME), "/srv/claude");
	// Claude Code's own expansion applies here too.
	assert.equal(claudeConfigDir({ [CLAUDE_CONFIG_DIR_ENV]: "~/cfg" }, HOME), join(HOME, "cfg"));
});

test("expandHome expands only a leading ~/", () => {
	assert.equal(expandHome("~", HOME), HOME);
	assert.equal(expandHome("~/mem", HOME), join(HOME, "mem"));
	assert.equal(expandHome("/abs/mem", HOME), "/abs/mem");
	assert.equal(expandHome("mid~", HOME), resolve("mid~"));
});

test("normalizeClaudeMemoryConfig accepts only a non-empty string", () => {
	assert.deepEqual(normalizeClaudeMemoryConfig({}, "/cfg", HOME), { configDir: "/cfg" });
	assert.deepEqual(normalizeClaudeMemoryConfig(null, "/cfg", HOME), { configDir: "/cfg" });
	assert.deepEqual(normalizeClaudeMemoryConfig({ autoMemoryDirectory: 42 }, "/cfg", HOME), { configDir: "/cfg" });
	assert.deepEqual(normalizeClaudeMemoryConfig({ autoMemoryDirectory: "  " }, "/cfg", HOME), { configDir: "/cfg" });
	assert.deepEqual(normalizeClaudeMemoryConfig({ autoMemoryDirectory: "~/mem" }, "/cfg", HOME), {
		configDir: "/cfg",
		autoMemoryDirectory: join(HOME, "mem"),
	});
});

test("resolveClaudeMemoryConfig reads <configDir>/settings.json and degrades to defaults", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-note-claude-"));
	try {
		// No settings.json at all: default layout.
		assert.deepEqual(resolveClaudeMemoryConfig({ [CLAUDE_CONFIG_DIR_ENV]: root }, HOME), { configDir: root });

		// Malformed JSON: still the default layout, no throw.
		writeFileSync(join(root, "settings.json"), "{not json", "utf8");
		assert.deepEqual(resolveClaudeMemoryConfig({ [CLAUDE_CONFIG_DIR_ENV]: root }, HOME), { configDir: root });

		// Valid override wins, with ~ expanded against the given home.
		writeFileSync(join(root, "settings.json"), JSON.stringify({ autoMemoryDirectory: "~/mem" }), "utf8");
		assert.deepEqual(resolveClaudeMemoryConfig({ [CLAUDE_CONFIG_DIR_ENV]: root }, HOME), {
			configDir: root,
			autoMemoryDirectory: join(HOME, "mem"),
		});

		// A missing config dir behaves like a missing file.
		assert.deepEqual(resolveClaudeMemoryConfig({ [CLAUDE_CONFIG_DIR_ENV]: join(root, "nope") }, HOME), {
			configDir: join(root, "nope"),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
