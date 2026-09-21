import assert from "node:assert/strict";
import test from "node:test";

import { replayGroups } from "../format.ts";

const BUILTIN = new Set(["read", "bash", "edit", "write", "find", "grep", "ls"]);
const isBuiltin = (name: string) => BUILTIN.has(name);

const call = (id: string, name = "bash") => ({ type: "toolCall", id, name, arguments: {} });
const text = (value: string) => ({ type: "text", text: value });
const thinking = (value: string) => ({ type: "thinking", thinking: value });
const assistant = (...content: any[]) => ({ role: "assistant", content });
const user = (value = "hi") => ({ role: "user", content: value });
const result = (id: string) => ({ role: "toolResult", toolCallId: id, content: [] });

test("replayGroups: consecutive calls merge across messages", () => {
	const messages = [
		user(),
		assistant(call("a")),
		result("a"),
		assistant(call("b"), call("c")),
		result("b"),
		result("c"),
	];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a", "b", "c"]]);
});

test("replayGroups: visible prose and new user turns break the block", () => {
	const messages = [
		assistant(call("a")),
		result("a"),
		assistant(text("done with a"), call("b")),
		assistant(call("c")),
		user("next"),
		assistant(call("d")),
	];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a"], ["b", "c"], ["d"]]);
});

test("replayGroups: text after a call in the same message keeps that call in the block", () => {
	// Live seals when the text streams, which is after the call joined the block.
	const messages = [assistant(call("a"), text("and now the result")), assistant(call("b"))];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a"], ["b"]]);
});

test("replayGroups: thinking and tool results do not break a block", () => {
	const messages = [
		assistant(thinking("hmm"), call("a")),
		result("a"),
		assistant(thinking("still thinking"), call("b")),
	];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a", "b"]]);
});

test("replayGroups: blank text does not break a block", () => {
	const messages = [assistant(call("a")), assistant(text("   "), call("b"))];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a", "b"]]);
});

test("replayGroups: a foreign tool breaks the block and is not returned", () => {
	const messages = [assistant(call("a"), call("t", "TaskList"), call("b")), assistant(call("c"))];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a"], ["b", "c"]]);
});

test("replayGroups: custom messages and summaries break the block", () => {
	const messages = [
		assistant(call("a")),
		{ role: "custom", content: "note" },
		assistant(call("b")),
		{ role: "compactionSummary", summary: "…" },
		assistant(call("c")),
	];
	assert.deepEqual(replayGroups(messages, isBuiltin), [["a"], ["b"], ["c"]]);
});

test("replayGroups: empty transcript and calls outside messages are ignored", () => {
	assert.deepEqual(replayGroups([], isBuiltin), []);
	assert.deepEqual(replayGroups([result("a"), user()], isBuiltin), []);
	assert.deepEqual(replayGroups([assistant(call("a")), null!, undefined!], isBuiltin), [["a"]]);
});
