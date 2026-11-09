// Topic-model tests for the `/memory` browser: index parsing, orphan
// discovery and the search text. Pure functions, no fs.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildTopics,
	normalizeLink,
	parseIndex,
	removeIndexEntry,
	splitFrontmatter,
	stripHook,
	topicMatchText,
	type MemoryFileInfo,
} from "../memory-index.ts";

/** Listing entry; size/mtime default to 0 because most tests do not care. */
function file(name: string, size = 0, mtimeMs = 0): MemoryFileInfo {
	return { name, size, mtimeMs };
}

test("parseIndex reads title, file and hook from index lines", () => {
	const topics = parseIndex(
		[
			"# Memory",
			"",
			"- [Computer use 路线决策](computer-use-preference.md) — 因 Hyprland 不支持双 seat，首版采用真实桌面。",
			"- [插件管理分工](plugin-management-boundary.md) — settings.json 负责多机同步。",
		].join("\n"),
	);
	assert.equal(topics.length, 2);
	assert.deepEqual(topics[0], {
		title: "Computer use 路线决策",
		file: "computer-use-preference.md",
		hook: "因 Hyprland 不支持双 seat，首版采用真实桌面。",
		indexed: true,
		exists: true,
	});
	assert.equal(topics[1].file, "plugin-management-boundary.md");
});

test("parseIndex tolerates bullets, numbering, dashes and missing hooks", () => {
	const topics = parseIndex(
		[
			"* [A](a.md): hook A",
			"1. [B](b.md) - hook B",
			"+ [C](c.md)",
			"   - [D](./sub/d.md) — nested target",
			"- plain text line, not a link",
		].join("\n"),
	);
	assert.deepEqual(topics.map((topic) => topic.file), ["a.md", "b.md", "c.md", "sub/d.md"]);
	assert.deepEqual(topics.map((topic) => topic.hook), ["hook A", "hook B", "", "nested target"]);
});

test("parseIndex keeps the first line per file and ignores external links", () => {
	const topics = parseIndex(
		[
			"- [First](dup.md) — kept",
			"- [Second](dup.md) — dropped",
			"- [Docs](https://example.com/x.md) — not a memory",
			"- [Anchor](#section) — not a memory",
		].join("\n"),
	);
	assert.equal(topics.length, 1);
	assert.equal(topics[0].title, "First");
});

test("normalizeLink handles angle targets, link titles and escaping", () => {
	assert.equal(normalizeLink("./a.md"), "a.md");
	assert.equal(normalizeLink("<a.md>"), "a.md");
	assert.equal(normalizeLink('a.md "Title"'), "a.md");
	assert.equal(normalizeLink("my%20memory.md"), "my memory.md");
	assert.equal(normalizeLink("mailto:x@y.z"), undefined);
	assert.equal(normalizeLink("#top"), undefined);
	assert.equal(normalizeLink(""), undefined);
});

test("stripHook removes only the leading separator", () => {
	assert.equal(stripHook("— 双 seat 留待后续"), "双 seat 留待后续");
	assert.equal(stripHook("- hook"), "hook");
	assert.equal(stripHook(": hook"), "hook");
	assert.equal(stripHook(""), "");
});

test("buildTopics appends unindexed files after the index, sorted by name", () => {
	const topics = buildTopics(
		"- [Indexed](indexed.md) — hook\n",
		[file("MEMORY.md"), file("indexed.md"), file("z-orphan.md"), file("a-orphan.md"), file("notes.txt")],
	);
	assert.deepEqual(topics.map((topic) => topic.file), [
		"indexed.md",
		"a-orphan.md",
		"z-orphan.md",
	]);
	assert.equal(topics[0].indexed, true);
	assert.equal(topics[1].indexed, false);
	assert.equal(topics[1].hook, "");
	assert.equal(topics[1].exists, true);
	// MEMORY.md itself and non-markdown files are never listed.
	assert.ok(!topics.some((topic) => topic.file === "MEMORY.md" || topic.file === "notes.txt"));
});

test("buildTopics marks index lines whose file is gone as missing", () => {
	const topics = buildTopics("- [Gone](gone.md) — hook\n- [Kept](kept.md) — hook\n", [file("kept.md")]);
	assert.deepEqual(topics.map((topic) => [topic.file, topic.exists]), [
		["gone.md", false],
		["kept.md", true],
	]);
});

test("buildTopics assumes nested targets and unknown listings exist", () => {
	const nested = buildTopics("- [Nested](sub/n.md) — hook\n", [file("MEMORY.md")]);
	assert.equal(nested[0].exists, true);
	const unknown = buildTopics("- [Any](any.md) — hook\n");
	assert.equal(unknown[0].exists, true);
	assert.deepEqual(unknown.map((topic) => topic.file), ["any.md"]);
});

test("removeIndexEntry drops every line for one file and keeps the rest byte for byte", () => {
	const index = [
		"# Memory",
		"",
		"- [Keep](keep.md) — k",
		"- [Gone](gone.md) — g",
		"1. [Gone again](./gone.md) — duplicate",
		"- [Tail](tail.md) — t",
		"",
	].join("\n");
	assert.equal(
		removeIndexEntry(index, "gone.md"),
		["# Memory", "", "- [Keep](keep.md) — k", "- [Tail](tail.md) — t", ""].join("\n"),
	);
	// A file the index does not mention leaves the text untouched.
	assert.equal(removeIndexEntry(index, "other.md"), index);
});

test("topicMatchText covers title, file and hook", () => {
	const [topic] = buildTopics("- [插件管理分工](plugin-management-boundary.md) — settings.json 负责同步\n");
	assert.match(topicMatchText(topic), /插件管理分工/);
	assert.match(topicMatchText(topic), /plugin-management-boundary\.md/);
	assert.match(topicMatchText(topic), /settings\.json/);
});

test("splitFrontmatter reads Claude Code's nested metadata.type and strips the block", () => {
	const text = [
		"---",
		"name: ask-behavior-not-tech",
		'description: "问可见行为，不问技术选型"',
		"metadata:",
		"  node_type: memory",
		"  type: feedback",
		"  modified: 2026-11-05T03:07:43.147Z",
		"---",
		"",
		"正文第一行",
	].join("\n");
	const doc = splitFrontmatter(text);
	assert.deepEqual(doc.frontmatter, {
		name: "ask-behavior-not-tech",
		description: "问可见行为，不问技术选型",
		type: "feedback",
	});
	assert.equal(doc.body, "\n正文第一行");
});

test("splitFrontmatter accepts a top-level type (older files) and partial frontmatter", () => {
	const doc = splitFrontmatter("---\ntype: project\n---\nbody\n");
	assert.deepEqual(doc.frontmatter, { type: "project" });
	assert.equal(doc.body, "body\n");
});

test("splitFrontmatter leaves frontmatter-free files untouched", () => {
	const plain = "# Notes\n\nno frontmatter here\n";
	assert.deepEqual(splitFrontmatter(plain), { body: plain });
	// An unclosed block is not frontmatter either: showing it beats eating the file.
	const unclosed = "---\nname: x\nbody without a close";
	assert.deepEqual(splitFrontmatter(unclosed), { body: unclosed });
	// A rule later in the body must not be mistaken for the block's end.
	assert.equal(splitFrontmatter("hello\n---\nname: x\n---\n").frontmatter, undefined);
});
