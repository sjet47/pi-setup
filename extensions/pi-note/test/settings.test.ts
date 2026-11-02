// Settings tests: every failure falls back to the defaults, and the refresh
// switch defaults to on. Real temp agent dirs, nothing touches ~/.pi/agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_NOTE_SETTINGS, normalizeNoteSettings, readNoteSettings } from "../settings.ts";

function withAgentDir(run: (agentDir: string, writeSettings: (text: string) => void) => void): void {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-note-settings-"));
	try {
		run(agentDir, (text) => writeFileSync(join(agentDir, "settings.json"), text, "utf8"));
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test("a missing settings.json yields the defaults (refresh on)", () => {
	withAgentDir((agentDir) => {
		assert.deepEqual(readNoteSettings(agentDir), DEFAULT_NOTE_SETTINGS);
		assert.deepEqual(DEFAULT_NOTE_SETTINGS, { memoryRefresh: true, memoryRefreshMaxChars: 16_000 });
	});
});

test("unreadable settings (malformed JSON) yields the defaults", () => {
	withAgentDir((agentDir, write) => {
		write("{ not json at all");
		assert.deepEqual(readNoteSettings(agentDir), DEFAULT_NOTE_SETTINGS);
	});
});

test("settings.json that is not an object yields the defaults", () => {
	withAgentDir((agentDir, write) => {
		write('"just a string"');
		assert.deepEqual(readNoteSettings(agentDir), DEFAULT_NOTE_SETTINGS);
	});
});

test("only an explicit false disables the refresh", () => {
	withAgentDir((agentDir, write) => {
		write(JSON.stringify({ memoryRefresh: false }));
		assert.deepEqual(readNoteSettings(agentDir), { memoryRefresh: false, memoryRefreshMaxChars: 16_000 });
		write(JSON.stringify({ memoryRefresh: "false" }));
		assert.equal(readNoteSettings(agentDir).memoryRefresh, true); // unknown => on
		write(JSON.stringify({ memoryRefresh: null }));
		assert.equal(readNoteSettings(agentDir).memoryRefresh, true);
	});
});

test("a configured cap is used, mistyped values fall back", () => {
	withAgentDir((agentDir, write) => {
		write(JSON.stringify({ memoryRefreshMaxChars: 500 }));
		assert.equal(readNoteSettings(agentDir).memoryRefreshMaxChars, 500);
		write(JSON.stringify({ memoryRefreshMaxChars: 12.7 }));
		assert.equal(readNoteSettings(agentDir).memoryRefreshMaxChars, 12);
		write(JSON.stringify({ memoryRefreshMaxChars: 0 }));
		assert.equal(readNoteSettings(agentDir).memoryRefreshMaxChars, 16_000);
		write(JSON.stringify({ memoryRefreshMaxChars: "8000" }));
		assert.equal(readNoteSettings(agentDir).memoryRefreshMaxChars, 16_000);
	});
});

test("unrelated settings are ignored", () => {
	assert.deepEqual(normalizeNoteSettings({ externalEditor: "vim", model: "x" }), DEFAULT_NOTE_SETTINGS);
});
