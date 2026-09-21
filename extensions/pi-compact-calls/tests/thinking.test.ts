import assert from "node:assert/strict";
import test from "node:test";

import { foldThinking, type ContentItem } from "../format.ts";

/**
 * Guards the rule that decides which thinking runs move into a block.
 *
 * pi renders one hidden `Thinking...` row per assistant message, so a turn that
 * thinks between calls (one message per step) stacks identical rows beside the
 * folded block. Only a run that is followed by a tool call of ours that joined a
 * block may be absorbed — everything else (visible prose, non-built-in tools,
 * replayed history, trailing runs) keeps rendering natively.
 */

const thinking = (text: string): ContentItem => ({ type: "thinking", thinking: text });
const toolCall = (id: string): ContentItem => ({ type: "toolCall", id, name: "bash", arguments: {} });
const text = (value: string): ContentItem => ({ type: "text", text: value });

const none = () => false;
const all = () => true;
const only = (...ids: string[]) => (id: string) => ids.includes(id);

test("foldThinking: absorbs the run in front of a folded call", () => {
	const content = [thinking("先看配置"), toolCall("t1")];
	const folded = foldThinking(content, all);

	assert.ok(folded);
	assert.deepEqual(folded.attributions, [{ toolCallId: "t1", text: "先看配置" }]);
	assert.deepEqual(
		folded.content.map((item) => item.type),
		["toolCall"],
	);
	// The surviving items are the original objects, not copies.
	assert.equal(folded.content[0], content[1]);
});

test("foldThinking: keeps the run when a visible text block precedes it", () => {
	// The prose sealed the block, so this run is not ours to take.
	assert.equal(foldThinking([text("先说明一下"), thinking("再想"), toolCall("t1")], all), undefined);
	assert.equal(foldThinking([thinking("想"), text("说明"), toolCall("t1")], all), undefined);
	// Whitespace-only text does not count as visible content.
	assert.ok(foldThinking([text("  \n "), thinking("想"), toolCall("t1")], all));
});

test("foldThinking: keeps the run in front of a call that is not folded", () => {
	// Non-built-in tool (subagent, MCP, …) or replayed history: no block to absorb into.
	assert.equal(foldThinking([thinking("想"), toolCall("t1")], none), undefined);
	assert.equal(foldThinking([thinking("想"), toolCall("t2")], only("t1")), undefined);
});

test("foldThinking: trailing run stays visible", () => {
	const content = [thinking("第一步的想法"), toolCall("t1"), thinking("第二步的想法，还没调工具")];
	const folded = foldThinking(content, all);

	assert.ok(folded);
	assert.deepEqual(
		folded.content.map((item) => item.type),
		["toolCall", "thinking"],
	);
	assert.equal(folded.content[1], content[2]);
});

test("foldThinking: one run per folded call, in content order", () => {
	const folded = foldThinking([thinking("第一段"), toolCall("t1"), thinking("第二段"), toolCall("t2")], all);

	assert.ok(folded);
	assert.deepEqual(folded.attributions, [
		{ toolCallId: "t1", text: "第一段" },
		{ toolCallId: "t2", text: "第二段" },
	]);
	assert.deepEqual(
		folded.content.map((item) => item.type),
		["toolCall", "toolCall"],
	);
});

test("foldThinking: consecutive runs before one call merge", () => {
	const folded = foldThinking([thinking("甲"), thinking("乙"), toolCall("t1")], all);

	assert.ok(folded);
	assert.deepEqual(folded.attributions, [{ toolCallId: "t1", text: "甲\n\n乙" }]);
});

test("foldThinking: nothing to absorb reports undefined", () => {
	// Empty runs: dropping them would change nothing visible.
	assert.equal(foldThinking([thinking("   "), toolCall("t1")], all), undefined);
	// No thinking at all.
	assert.equal(foldThinking([toolCall("t1")], all), undefined);
	// Runs without a following call.
	assert.equal(foldThinking([thinking("想")], all), undefined);
});

test("foldThinking: folding the folded content again is a no-op", () => {
	const content = [thinking("想"), toolCall("t1")];
	const once = foldThinking(content, all);
	assert.ok(once);
	// This is what re-rendering the copy (invalidate) does: the copy has no
	// thinking left, so the attributions already stored must not be recomputed.
	assert.equal(foldThinking(once.content, all), undefined);
});
