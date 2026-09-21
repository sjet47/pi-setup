import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	captureText,
	composeHeader,
	composeToolLine,
	countLines,
	diffStat,
	errorTail,
	formatDuration,
	headerState,
	type Paint,
	pickCollapsedTool,
	previewModeOf,
	selectPreview,
	shortenPath,
	summaryOf,
	toolState,
	type ToolView,
	truncatePlain,
	typeBreakdown,
	unionDuration,
} from "../format.ts";

function tool(name: string, state: "queued" | "running" | "ok" | "failed", args: any = {}): ToolView {
	return {
		name,
		args,
		pending: state === "running",
		hasResult: state === "ok" || state === "failed",
		isError: state === "failed",
	};
}

/** Wraps styled text in real SGR codes so width maths is tested against ANSI input. */
const ansiPaint: Paint = {
	fg: (_color, text) => `\x1b[31m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

test("formatDuration: sub-minute values keep one decimal", () => {
	assert.equal(formatDuration(0), "0.0s");
	assert.equal(formatDuration(-5), "0.0s");
	assert.equal(formatDuration(3049), "3.0s");
	assert.equal(formatDuration(59_940), "59.9s");
});

test("formatDuration: rounding carries into the next unit", () => {
	assert.equal(formatDuration(59_960), "1m 0s");
	assert.equal(formatDuration(119_600), "2m 0s");
	assert.equal(formatDuration(61_400), "1m 1s");
	assert.equal(formatDuration(3_599_600), "1h 0m");
	assert.equal(formatDuration(3_725_000), "1h 2m");
});

test("toolState: queued until started, result decides ok/failed", () => {
	assert.equal(toolState(tool("bash", "queued")), "queued");
	assert.equal(toolState(tool("bash", "running")), "running");
	assert.equal(toolState(tool("bash", "ok")), "ok");
	assert.equal(toolState(tool("bash", "failed")), "failed");
	// An error flag without a result (never ran) is not a failure.
	assert.equal(toolState({ ...tool("bash", "queued"), isError: true }), "queued");
});

test("summaryOf: paths, read ranges, grep glob", () => {
	assert.equal(shortenPath("/home/u/src/a.ts", "/home/u"), "~/src/a.ts");
	assert.equal(shortenPath("/etc/hosts", "/home/u"), "/etc/hosts");
	assert.equal(summaryOf("read", { path: "foo.ts" }), "foo.ts");
	assert.equal(summaryOf("read", { path: "foo.ts", offset: 120, limit: 61 }), "foo.ts:120-180");
	assert.equal(summaryOf("read", { path: "foo.ts", offset: 120 }), "foo.ts:120+");
	assert.equal(summaryOf("read", { path: "foo.ts", limit: 50 }), "foo.ts:1-50");
	assert.equal(summaryOf("grep", { pattern: "TODO", path: "src", glob: "*.ts" }), "TODO in src [*.ts]");
	assert.equal(summaryOf("grep", { pattern: "TODO" }), "TODO in .");
	assert.equal(summaryOf("find", { pattern: "*.md", path: "docs" }), "*.md in docs");
	assert.equal(summaryOf("ls", {}), ".");
	assert.equal(summaryOf("edit", { path: "a/b.ts", edits: [] }), "a/b.ts");
	assert.equal(summaryOf("bash", undefined), "…");
});

test("summaryOf: bash shows the first line of a multi-line command", () => {
	assert.equal(summaryOf("bash", { command: "echo   one" }), "echo one");
	assert.equal(summaryOf("bash", { command: "\ncat <<EOF > x\nhello\nEOF\n" }), "cat <<EOF > x …");
	assert.equal(summaryOf("bash", { command: "echo one\n" }), "echo one");
	// No fixed 60-char cap any more: the width-based layout decides.
	const long = `echo ${"x".repeat(100)}`;
	assert.equal(summaryOf("bash", { command: long }), long);
});

test("pickCollapsedTool: newest running > most recent failed > last", () => {
	const a = tool("bash", "running");
	const b = tool("read", "failed");
	const c = tool("bash", "running");
	const d = tool("grep", "ok");
	assert.equal(pickCollapsedTool([a, b, c, d]), c);
	assert.equal(pickCollapsedTool([tool("ls", "ok"), b, tool("read", "failed"), d]).name, "read");
	const failures = [tool("ls", "ok"), b, d];
	assert.equal(pickCollapsedTool(failures), b);
	assert.equal(pickCollapsedTool([tool("ls", "ok"), d, tool("write", "queued")]).name, "write");
});

test("unionDuration: parallel calls count once, gaps do not count", () => {
	assert.equal(unionDuration([], 1000), 0);
	assert.equal(unionDuration([{ start: 0, end: 3000 }, { start: 0, end: 1000 }, { start: 500, end: 2000 }], 9999), 3000);
	// 2s of model thinking between the two calls is left out.
	assert.equal(unionDuration([{ start: 0, end: 1000 }, { start: 3000, end: 3500 }], 9999), 1500);
	// A running call counts up to now; order of the input does not matter.
	assert.equal(unionDuration([{ start: 4000 }, { start: 0, end: 1000 }], 6000), 3000);
	assert.equal(unionDuration([{ start: 5000, end: 4000 }], 9999), 0);
});

test("diffStat / countLines", () => {
	const diff = [" 1 keep", "-2 old", "+2 new", "+3 newer", "   ...", " 9 keep", "-10 gone"].join("\n");
	assert.deepEqual(diffStat(diff), { added: 2, removed: 2 });
	assert.deepEqual(diffStat(""), { added: 0, removed: 0 });
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
	assert.equal(countLines("a\nb\n"), 2);
	assert.equal(countLines("a\nb\nc"), 3);
	assert.equal(countLines(undefined), 0);
});

test("selectPreview: head for file-ish tools, tail for bash", () => {
	assert.equal(previewModeOf("bash"), "tail");
	assert.equal(previewModeOf("read"), "head");
	const text = ["1", "2", "3", "4", "5", "6", "7"].join("\n");
	assert.deepEqual(selectPreview(text, 5, "head"), { lines: ["1", "2", "3", "4", "5"], hidden: 2, mode: "head" });
	assert.deepEqual(selectPreview(text, 5, "tail"), { lines: ["3", "4", "5", "6", "7"], hidden: 2, mode: "tail" });
	assert.deepEqual(selectPreview("a\nb", 5, "tail"), { lines: ["a", "b"], hidden: 0, mode: "tail" });
	assert.deepEqual(selectPreview("", 5, "head"), { lines: [], hidden: 0, mode: "head" });
	// The full text had 100 lines before it was bounded.
	assert.equal(selectPreview(text, 5, "tail", 100).hidden, 95);
});

test("captureText: keeps the end the preview needs, drops the cut line", () => {
	const full = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
	const head = captureText(full, 40, "head");
	assert.equal(head.totalLines, 50);
	assert.ok(full.startsWith(head.text));
	assert.ok(head.text.length <= 40);
	assert.ok(/line-\d+$/.test(head.text) && full.includes(`${head.text}\n`));
	const tail = captureText(full, 40, "tail");
	assert.equal(tail.totalLines, 50);
	assert.ok(full.endsWith(tail.text));
	assert.ok(tail.text.startsWith("line-"));
	assert.deepEqual(captureText("short", 40, "tail"), { text: "short", totalLines: 1 });
	assert.deepEqual(captureText("", 40, "head"), { text: "", totalLines: 0 });
});

test("errorTail: last non-empty line, bash exit line folded in", () => {
	assert.equal(errorTail("a\nb\n\n"), "b");
	assert.equal(errorTail(""), "");
	assert.equal(
		errorTail("bash: cd: /nope: No such file or directory\n\nCommand exited with code 1"),
		"bash: cd: /nope: No such file or directory (exit 1)",
	);
	assert.equal(errorTail("Command exited with code 2"), "Command exited with code 2");
});

test("typeBreakdown: by count, ties in order of appearance, empty for one type", () => {
	assert.equal(typeBreakdown(["read", "bash", "grep", "read", "grep", "read", "read"]), "4 read, 2 grep, 1 bash");
	assert.equal(typeBreakdown(["bash", "read"]), "1 bash, 1 read");
	assert.equal(typeBreakdown(["bash", "bash"]), "");
	assert.equal(typeBreakdown([]), "");
});

test("headerState: no success before the block is closed", () => {
	const done = [tool("bash", "ok"), tool("read", "ok")];
	assert.equal(headerState(done, false), "idle");
	assert.equal(headerState(done, true), "ok");
	assert.equal(headerState([...done, tool("bash", "running")], true), "running");
	assert.equal(headerState([...done, tool("bash", "failed")], false), "idle");
	assert.equal(headerState([...done, tool("bash", "failed")], true), "failed");
	assert.equal(headerState([...done, tool("bash", "queued")], true), "incomplete");
});

test("composeHeader: full line, then parts drop by priority", () => {
	const parts = {
		state: "running" as const,
		icon: "⠋",
		count: 7,
		failed: 1,
		durationMs: 3200,
		breakdown: "4 read, 2 grep, 1 bash",
		hint: "Ctrl+O to expand",
	};
	const full = "⠋ 7 tool calls (4 read, 2 grep, 1 bash) · 1 failed · 3.2s · Ctrl+O to expand";
	assert.equal(composeHeader(parts, 200), full);
	assert.equal(composeHeader(parts, visibleWidth(full)), full);
	// hint first, then breakdown, then duration, then failed; the count always stays.
	assert.equal(composeHeader(parts, visibleWidth(full) - 1), "⠋ 7 tool calls (4 read, 2 grep, 1 bash) · 1 failed · 3.2s");
	assert.equal(composeHeader(parts, 40), "⠋ 7 tool calls · 1 failed · 3.2s");
	assert.equal(composeHeader(parts, 26), "⠋ 7 tool calls · 1 failed");
	assert.equal(composeHeader(parts, 20), "⠋ 7 tool calls");
	assert.equal(composeHeader(parts, 3), "⠋ 7 tool calls");
	assert.equal(composeHeader({ ...parts, failed: 0, breakdown: undefined, hint: undefined }, 200), "⠋ 7 tool calls · 3.2s");
});

test("composeHeader: width is measured without ANSI codes", () => {
	const parts = { state: "ok" as const, icon: "✓", count: 3, failed: 0, durationMs: 6100, hint: "Ctrl+O to expand" };
	const plain = composeHeader(parts, 200);
	const styled = composeHeader(parts, visibleWidth(plain), ansiPaint);
	assert.equal(visibleWidth(styled), visibleWidth(plain));
	assert.ok(styled.includes("Ctrl+O to expand"));
});

test("composeToolLine: the summary gives way, the duration survives", () => {
	const parts = {
		rail: "├ ",
		icon: "✓",
		iconColor: "success",
		name: "bash",
		summary: `echo ${"x".repeat(100)}`,
		duration: "3.0s",
	};
	for (const paint of [undefined, ansiPaint]) {
		const line = composeToolLine(parts, 40, paint);
		assert.equal(visibleWidth(line), 40);
		assert.ok(line.includes("(3.0s)"));
		assert.ok(line.includes("…"));
	}
	assert.equal(composeToolLine({ ...parts, summary: "echo hi" }, 40), "├ ✓ bash: echo hi (3.0s)");
	// Stat is reserved as well.
	const edit = composeToolLine({ ...parts, name: "edit", summary: "src/very/long/path/to/some/file.ts", stat: "+3 −1" }, 36);
	assert.equal(visibleWidth(edit), 36);
	assert.ok(edit.endsWith("+3 −1 (3.0s)"));
});

test("composeToolLine: wide characters are measured by column", () => {
	const line = composeToolLine(
		{ rail: "", icon: "✓", iconColor: "success", name: "read", summary: "文档/很长的中文路径/文件名称.md", duration: "0.1s" },
		30,
	);
	assert.ok(visibleWidth(line) <= 30);
	assert.ok(line.endsWith("(0.1s)"));
	assert.equal(truncatePlain("你好世界", 5), "你好…");
	assert.equal(truncatePlain("abc", 0), "");
	assert.equal(truncatePlain("abc", 10), "abc");
});

test("composeToolLine: error tail shares the leftover width", () => {
	const parts = {
		rail: "└ ",
		icon: "✗",
		iconColor: "error",
		name: "bash",
		summary: "cd /nonexistent-dir-xyz",
		duration: "0.0s",
		errorTail: "bash: cd: /nonexistent-dir-xyz: No such file or directory (exit 1)",
	};
	const wide = composeToolLine(parts, 200);
	assert.equal(wide, `└ ✗ bash: cd /nonexistent-dir-xyz (0.0s) — ${parts.errorTail}`);
	const narrow = composeToolLine(parts, 64);
	assert.ok(visibleWidth(narrow) <= 64);
	assert.ok(narrow.includes("cd /nonexistent-dir-xyz (0.0s) — bash: cd:"));
	// Too narrow for a useful tail: it is dropped, the rest stays intact.
	const tiny = composeToolLine(parts, 30);
	assert.ok(!tiny.includes("—"));
	assert.ok(tiny.endsWith("(0.0s)"));
	assert.ok(visibleWidth(tiny) <= 30);
});
