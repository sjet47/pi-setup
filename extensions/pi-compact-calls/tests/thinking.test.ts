import assert from "node:assert/strict";
import test from "node:test";

import { foldThinking, type ContentItem } from "../format.ts";

/**
 * Guards the rule that decides which thinking runs move into a block.
 *
 * pi renders one hidden `Thinking...` row per assistant message, so a turn that
 * thinks between calls (one message per step) stacks identical rows beside the
 * folded block. A run is absorbed when a call that ends up in a block follows it in
 * the same message — prose in between does not matter (prose and block are the same
 * step). A trailing run, or one in front of a call of ours that is not folded
 * (non-built-in tool), keeps rendering natively.
 */

const thinking = (text: string): ContentItem => ({ type: "thinking", thinking: text });
const toolCall = (id: string, name = "bash"): ContentItem => ({ type: "toolCall", id, name, arguments: {} });
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

test("foldThinking: a run in front of a folded call is absorbed even with prose around it", () => {
	assert.ok(foldThinking([text("先说明一下"), thinking("再想"), toolCall("t1")], all));
	assert.ok(foldThinking([thinking("想"), text("说明"), toolCall("t1")], all));
	assert.ok(foldThinking([text("  \n "), thinking("想"), toolCall("t1")], all));
	// The prose stays where it was: only the run (and the row it would have painted) goes away.
	const folded = foldThinking([thinking("想"), text("说明"), toolCall("t1")], all)!;
	assert.deepEqual(folded.content.map((item) => item.type), ["text", "toolCall"]);
});

test("foldThinking: a foreign call in between keeps the run", () => {
	// The run's text belongs above the row that renders natively, not below it.
	assert.equal(foldThinking([thinking("想"), toolCall("x", "TaskList"), toolCall("t1")], only("t1")), undefined);
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
