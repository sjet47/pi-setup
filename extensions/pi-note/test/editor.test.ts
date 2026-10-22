// External-editor tests for the `/memory` detail view: command resolution and
// the spawn wrapper. Uses real, tiny commands (`true` / `false`) so no editor
// is needed.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { editFileInEditor, resolveEditorCommand } from "../editor.ts";

test("resolveEditorCommand prefers the setting, then VISUAL, then EDITOR", () => {
	assert.equal(resolveEditorCommand("nvim -f", { VISUAL: "vim", EDITOR: "nano" }), "nvim -f");
	assert.equal(resolveEditorCommand("  ", { VISUAL: "vim", EDITOR: "nano" }), "vim");
	assert.equal(resolveEditorCommand(undefined, { EDITOR: "nano" }), "nano");
	assert.equal(resolveEditorCommand(undefined, {}, "linux"), "nano");
	assert.equal(resolveEditorCommand(undefined, {}, "win32"), "notepad");
	// A non-string setting is ignored, not stringified.
	assert.equal(resolveEditorCommand(42, { EDITOR: "nano" }), "nano");
});

test("editFileInEditor reports a zero exit as success", async () => {
	assert.deepEqual(await editFileInEditor("true", "/tmp/does-not-need-to-exist.md"), { ok: true });
});

test("editFileInEditor surfaces a non-zero exit", async () => {
	const result = await editFileInEditor("false", "/tmp/does-not-need-to-exist.md");
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /exited with code 1/);
});

test("editFileInEditor surfaces a missing binary instead of throwing", async () => {
	const result = await editFileInEditor("pi-note-no-such-editor", "/tmp/x.md");
	assert.equal(result.ok, false);
	assert.match(result.ok ? "" : result.error, /ENOENT|not found/);
});

test("editFileInEditor rejects an empty command", async () => {
	assert.deepEqual(await editFileInEditor("  ", "/tmp/x.md"), {
		ok: false,
		error: "no external editor configured",
	});
});
