// Scratchpad variable expansion tests (SPEC §10 "变量展开").
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandInputStrings, expandScratchVar } from "../expand.ts";

const DIR = "/tmp/pi-note-1000/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("bare variable expands to the dir", () => {
	assert.equal(expandScratchVar("$PI_NOTE_SCRATCHPAD_DIR", DIR), DIR);
});

test("braced bare variable expands to the dir", () => {
	assert.equal(expandScratchVar("${PI_NOTE_SCRATCHPAD_DIR}", DIR), DIR);
});

test("variable followed by a path expands (both spellings)", () => {
	assert.equal(expandScratchVar("$PI_NOTE_SCRATCHPAD_DIR/a.txt", DIR), `${DIR}/a.txt`);
	assert.equal(
		expandScratchVar("${PI_NOTE_SCRATCHPAD_DIR}/sub/out.json", DIR),
		`${DIR}/sub/out.json`,
	);
});

test("variable name that is only a prefix of a longer name is NOT expanded", () => {
	// next char after the var name is `_`, not `/` or end-of-string
	assert.equal(
		expandScratchVar("$PI_NOTE_SCRATCHPAD_DIR_BACKUP/x", DIR),
		"$PI_NOTE_SCRATCHPAD_DIR_BACKUP/x",
	);
	assert.equal(
		expandScratchVar("${PI_NOTE_SCRATCHPAD_DIR}_backup/x", DIR),
		"${PI_NOTE_SCRATCHPAD_DIR}_backup/x",
	);
});

test("variable appearing mid-string is NOT expanded", () => {
	assert.equal(
		expandScratchVar("cat $PI_NOTE_SCRATCHPAD_DIR/a.txt", DIR),
		"cat $PI_NOTE_SCRATCHPAD_DIR/a.txt",
	);
	assert.equal(
		expandScratchVar('echo "x $PI_NOTE_SCRATCHPAD_DIR"', DIR),
		'echo "x $PI_NOTE_SCRATCHPAD_DIR"',
	);
});

test("values without the variable are returned unchanged", () => {
	assert.equal(expandScratchVar("", DIR), "");
	assert.equal(expandScratchVar("plain/path.md", DIR), "plain/path.md");
	assert.equal(expandScratchVar("$OTHER_VAR/x", DIR), "$OTHER_VAR/x");
});

test("expandInputStrings patches every top-level string value", () => {
	const input: Record<string, unknown> = {
		path: "$PI_NOTE_SCRATCHPAD_DIR/a.txt",
		pattern: "nope.txt",
		limit: 42,
		content: "body with $PI_NOTE_SCRATCHPAD_DIR mid-string stays",
	};
	expandInputStrings(input, DIR);
	assert.equal(input.path, `${DIR}/a.txt`);
	assert.equal(input.pattern, "nope.txt");
	assert.equal(input.limit, 42); // non-strings untouched
	assert.equal(input.content, "body with $PI_NOTE_SCRATCHPAD_DIR mid-string stays");
});

test("expandInputStrings never recurses into arrays or nested objects", () => {
	const edits = [
		{ path: "$PI_NOTE_SCRATCHPAD_DIR/e1.md", body: "unchanged" },
	];
	const input: Record<string, unknown> = { path: "$PI_NOTE_SCRATCHPAD_DIR/f.md", edits };
	expandInputStrings(input, DIR);
	assert.equal(input.path, `${DIR}/f.md`);
	// nested content stays literal (SPEC §6 F3: top-level strings only)
	assert.equal(edits[0].path, "$PI_NOTE_SCRATCHPAD_DIR/e1.md");
	assert.equal(edits[0].body, "unchanged");
});

test("bash is not handled here (real env does it) — caller skips before calling", () => {
	// Sanity anchor: expansion of a shell command is *not* what this module does.
	assert.equal(
		expandScratchVar("ls $PI_NOTE_SCRATCHPAD_DIR", DIR),
		"ls $PI_NOTE_SCRATCHPAD_DIR",
	);
});
