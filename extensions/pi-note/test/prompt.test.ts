// Rules-text assembly tests (SPEC §10 "规则文本组装"). The rules text is
// locked against a committed golden file: any edit to SPEC §7 wording must
// update test/rules-text.golden.txt, and the golden is compared byte-for-byte.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
	buildPromptAppend,
	MEMORY_DIR_PLACEHOLDER,
	MEMORY_INDEX_HEADER,
	RULES_TEXT,
} from "../prompt.ts";

const MEMORY_DIR = "/home/user/.pi/agent/pi-note/--home-sjet-repo-pi-setup--";

function readGolden(): string {
	return readFileSync(new URL("./rules-text.golden.txt", import.meta.url), "utf8");
}

test("RULES_TEXT is byte-locked to the SPEC §7 golden text", () => {
	assert.equal(RULES_TEXT, readGolden());
});

test("rules text still contains the placeholders it is supposed to substitute", () => {
	assert.ok(RULES_TEXT.includes(MEMORY_DIR_PLACEHOLDER));
	assert.ok(RULES_TEXT.includes("$PI_NOTE_SCRATCHPAD_DIR"));
});

test("empty snapshot -> rules only, no index section, no noise", () => {
	const append = buildPromptAppend(MEMORY_DIR, "");
	assert.ok(!append.includes(MEMORY_INDEX_HEADER));
	assert.ok(append.includes("You have a persistent file-based memory"));
});

test("non-empty snapshot -> rules + index section with snapshot verbatim", () => {
	const snapshot = "- [CLI](cli.md) — jq/glab\n- [Clones](two-clone-workflow.md) — sync both\n";
	const append = buildPromptAppend(MEMORY_DIR, snapshot);
	assert.ok(append.includes(MEMORY_INDEX_HEADER));
	assert.ok(append.endsWith(snapshot)); // snapshot byte-verbatim at the tail
	assert.ok(append.includes(MEMORY_DIR + "/MEMORY.md"));
});

test("<MEMORY_DIR> is replaced everywhere; scratchpad var stays literal", () => {
	const append = buildPromptAppend(MEMORY_DIR, "");
	assert.ok(!append.includes(MEMORY_DIR_PLACEHOLDER));
	assert.ok(append.includes(MEMORY_DIR)); // absolute path present in the rules
	assert.ok(append.includes("$PI_NOTE_SCRATCHPAD_DIR")); // literal, never resolved
});

test("same inputs -> byte-identical output (session prompt stability)", () => {
	const a = buildPromptAppend(MEMORY_DIR, "- [x](a.md) — one\n");
	const b = buildPromptAppend(MEMORY_DIR, "- [x](a.md) — one\n");
	assert.equal(a, b);
});

test("rules portion is identical regardless of the snapshot (prefix caching)", () => {
	const empty = buildPromptAppend(MEMORY_DIR, "");
	const full = buildPromptAppend(MEMORY_DIR, "- [x](a.md) — one\n");
	const rulesOnly = full.slice(0, empty.length);
	assert.equal(rulesOnly, empty);
});
