import assert from "node:assert/strict";
import test from "node:test";

import { partitionQueuedAfterBoundary, shouldSealText, toolCallIdsAfterBoundary } from "../format.ts";

/**
 * Regression guard for the boundary rule.
 *
 * `text_start` / `text_delta` / `text_end` all carry the accumulated text. Pi
 * dispatches each event to extensions before its interactive UI creates tool
 * rows. Without deduplication, a later event for the same text block (notably
 * `text_end`) can close the group populated by an earlier event's tool rows,
 * splitting this message's calls into separate one-line blocks.
 */
test("shouldSealText: one text block seals at most once", () => {
	const sealed = new Set<number>();

	// text_start / text_delta: the first non-empty event seals
	assert.equal(shouldSealText(sealed, 0, "先说明一下"), true);
	sealed.add(0);

	// later deltas of the same block, including text_end with the full text
	assert.equal(shouldSealText(sealed, 0, "先说明一下要做什么"), false);
	assert.equal(shouldSealText(sealed, 0, "先说明一下要做什么，然后调用两个工具"), false);

	// a different text block in the same message seals again
	assert.equal(shouldSealText(sealed, 1, "第二段说明"), true);
});

test("shouldSealText: empty or whitespace-only text never seals", () => {
	const sealed = new Set<number>();
	assert.equal(shouldSealText(sealed, 0, ""), false);
	assert.equal(shouldSealText(sealed, 0, "   \n\t "), false);
	assert.equal(sealed.size, 0);
});

test("late text moves only following queued calls to the next group", () => {
	const tools = [
		{ toolCallId: "before", ran: false },
		{ toolCallId: "after-1", ran: false },
		{ toolCallId: "after-2", ran: false },
	];
	const content = [
		{ type: "toolCall", id: "before" },
		{ type: "text", text: "now visible" },
		{ type: "toolCall", id: "after-1" },
		{ type: "toolCall", id: "after-2" },
	];
	const { before, after } = partitionQueuedAfterBoundary(tools, toolCallIdsAfterBoundary(content, 1), (tool) => tool.ran);
	assert.deepEqual(before.map((tool) => tool.toolCallId), ["before"]);
	assert.deepEqual(after.map((tool) => tool.toolCallId), ["after-1", "after-2"]);
});

test("late text leaves started and unrelated calls in their original group", () => {
	const tools = [
		{ toolCallId: "started", ran: true },
		{ toolCallId: "queued", ran: false },
		{ toolCallId: "another-message", ran: false },
	];
	const content = [
		{ type: "text", text: "now visible" },
		{ type: "toolCall", id: "started" },
		{ type: "toolCall", id: "queued" },
	];
	const { before, after } = partitionQueuedAfterBoundary(tools, toolCallIdsAfterBoundary(content, 0), (tool) => tool.ran);
	assert.deepEqual(before.map((tool) => tool.toolCallId), ["started", "another-message"]);
	assert.deepEqual(after.map((tool) => tool.toolCallId), ["queued"]);
});

test("earlier and later boundaries identify the correct queued calls", () => {
	const content = [
		{ type: "text", text: "first" },
		{ type: "toolCall", id: "a" },
		{ type: "toolCall", id: "foreign" },
		{ type: "toolCall", id: "b" },
		{ type: "text", text: "second" },
		{ type: "toolCall", id: "c" },
	];
	const tools = ["a", "b", "c"].map((toolCallId) => ({ toolCallId }));
	for (const [index, expected] of [[4, ["c"]], [2, ["b", "c"]], [0, ["a", "b", "c"]]] as const) {
		const afterIds = toolCallIdsAfterBoundary(content, index);
		const after = partitionQueuedAfterBoundary(tools, afterIds, () => false).after;
		assert.deepEqual(after.map((tool) => tool.toolCallId), expected);
	}
});
