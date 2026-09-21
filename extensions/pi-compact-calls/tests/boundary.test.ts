import assert from "node:assert/strict";
import test from "node:test";

import { shouldSealText } from "../format.ts";

/**
 * Regression guard for the boundary rule.
 *
 * `text_start` / `text_delta` / `text_end` all carry the accumulated text, and by
 * the time `text_end` arrives the message content already holds this message's
 * toolCalls — pi creates those tool rows before extension handlers run. Sealing
 * more than once per text block therefore closes the block that the message's own
 * tools just joined, and each of them renders as its own one-line block.
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
