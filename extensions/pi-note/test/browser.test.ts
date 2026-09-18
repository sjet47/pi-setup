// Overlay tests for `/memory`: list rendering, fuzzy search, level switching
// and detail scrolling. Driven with a stub theme/keybindings so no terminal is
// needed; the fs is faked through the injected readBody.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { CHROME_LINES, MemoryBrowserOverlay, formatAge, overlayHeight } from "../browser.ts";
import { buildTopics, type MemoryFileInfo, type MemoryTopic } from "../memory-index.ts";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const WIDTH = 78;
const ROWS = 40;
/** Fixed clock so the right-hand age column is deterministic. */
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

/** Listing entry with stats; `age` is how long ago the file was modified. */
function file(name: string, size = 100, ageMs = DAY_MS): MemoryFileInfo {
	return { name, size, mtimeMs: NOW - ageMs };
}

const identity = (text: string) => text;
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: identity,
	italic: identity,
	underline: identity,
	inverse: identity,
	strikethrough: identity,
} as unknown as Theme;
const markdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
} as MarkdownTheme;
const keybindings = { matches: () => false } as unknown as KeybindingsManager;

/**
 * A theme that tags each color with a distinct SGR code, so a test can assert
 * *which* color a cell got. The identity stub above cannot: it erases color.
 * The codes are ANSI, so `visibleWidth` still ignores them.
 */
const COLOR_CODE: Record<string, number> = { border: 36, borderMuted: 90 };
const taggingTheme = {
	...theme,
	fg: (color: string, text: string) => `\u001b[${COLOR_CODE[color] ?? 32}m${text}\u001b[0m`,
} as unknown as Theme;

/** SGR code of the first cell of every rendered row. */
function frameCodes(lines: string[]): string[] {
	return lines.map((line) => /^\u001b\[(\d+)m/.exec(line)?.[1] ?? "none");
}

function harness(options: {
	topics: MemoryTopic[];
	bodies?: Record<string, string>;
	rows?: number;
	theme?: Theme;
}) {
	const bodies = options.bodies ?? {};
	let closed = 0;
	const overlay = new MemoryBrowserOverlay({
		topics: options.topics,
		label: "home/sjet/repo/pi-setup",
		terminalRows: () => options.rows ?? ROWS,
		now: () => NOW,
		theme: options.theme ?? theme,
		markdownTheme,
		keybindings,
		readBody: (topic) =>
			topic.file in bodies
				? { ok: true, text: bodies[topic.file] }
				: { ok: false, error: "file is missing" },
		onDone: () => {
			closed += 1;
		},
	});
	return {
		overlay,
		closedCount: () => closed,
		lines: () => overlay.render(WIDTH),
		render: () => overlay.render(WIDTH).join("\n"),
	};
}

function sampleTopics(): MemoryTopic[] {
	return buildTopics(
		"- [Alpha](alpha.md) — first memory\n- [Beta](beta.md) — second memory\n",
		[file("MEMORY.md", 50), file("alpha.md", 2048), file("beta.md", 900, 400 * DAY_MS), file("orphan.md", 12, 3 * DAY_MS)],
	);
}

test("level 1 shows the header, topics, hooks and the unindexed section", () => {
	const { render } = harness({
		topics: sampleTopics(),
		bodies: { "alpha.md": "# Alpha\n", "beta.md": "# Beta\n", "orphan.md": "# Orphan\n" },
	});
	const screen = render();
	assert.match(screen, /Memory · home\/sjet\/repo\/pi-setup/);
	assert.match(screen, /2 topics · 1 unindexed/);
	assert.match(screen, /› Alpha/);
	assert.match(screen, /first memory/);
	assert.match(screen, /Beta/);
	assert.match(screen, /second memory/);
	assert.match(screen, /unindexed \(1\)/);
	assert.match(screen, /orphan\.md/);
	assert.match(screen, /Search:/);
	assert.match(screen, /Enter open · Esc close/);
});

test("every level renders exactly the overlay height", () => {
	const { lines, overlay } = harness({
		topics: sampleTopics(),
		bodies: { "alpha.md": "# Alpha\nbody\n" },
		rows: 24,
	});
	const height = overlayHeight(24);
	assert.equal(height, 18);
	assert.equal(lines().length, height);
	overlay.handleInput(ENTER);
	assert.equal(lines().length, height);
	assert.equal(height - CHROME_LINES, 11); // body height the scroll math uses
});

test("typing filters topics by title, file and hook", () => {
	const { overlay, render } = harness({ topics: sampleTopics() });
	for (const char of "beta") overlay.handleInput(char);
	const screen = render();
	assert.match(screen, /Beta/);
	assert.doesNotMatch(screen, /› Alpha/);
	assert.match(screen, /1\/3 matches/);
	for (let press = 0; press < 4; press += 1) overlay.handleInput("\x7f"); // backspace
	assert.match(render(), /3 topics/);
	assert.match(render(), /Alpha/);
});

test("counts are pluralized: `1 topic` and `1 line`, not `1 topics` / `1 lines`", () => {
	const one = harness({
		topics: buildTopics("- [Only](only.md) — hook\n", [file("only.md", 40)]),
		bodies: { "only.md": "# Only\n" },
	});
	assert.match(one.render(), /1 topic *│/);
	assert.doesNotMatch(one.render(), /1 topics/);

	one.overlay.handleInput(ENTER);
	// The detail header counts rendered lines and the body's bytes, not the file's.
	assert.match(one.render(), /1 line · 7 B/);
	assert.doesNotMatch(one.render(), /1 lines/);

	assert.match(harness({ topics: sampleTopics() }).render(), /3 topics/);
	assert.match(harness({ topics: [] }).render(), /0 topics/); // 0 takes the plural
});

test("a query with no match shows the empty message", () => {
	const { overlay, render } = harness({ topics: sampleTopics() });
	for (const char of "zzz") overlay.handleInput(char);
	assert.match(render(), /no topic matches/);
});

test("Enter opens the selected file as markdown; Esc goes back a level", () => {
	const { overlay, render, closedCount } = harness({
		topics: sampleTopics(),
		bodies: { "alpha.md": "# Alpha\n\nALPHA-BODY-MARKER\n", "beta.md": "# Beta\n\nBETA-BODY-MARKER\n" },
	});
	for (const char of "alpha") overlay.handleInput(char); // the query survives the round trip
	overlay.handleInput(ENTER);
	const detail = render();
	assert.match(detail, /ALPHA-BODY-MARKER/);
	assert.match(detail, /Alpha/);
	assert.match(detail, /Esc back/);
	assert.match(detail, /lines 1-3 of 3/);

	overlay.handleInput(ESC);
	const list = render();
	assert.match(list, /Esc close/);
	assert.match(list, /Search: alpha/);
	assert.match(list, /› Alpha/);
	assert.equal(closedCount(), 0, "Esc in the detail view must not close the browser");

	overlay.handleInput(ESC);
	assert.equal(closedCount(), 1, "Esc in the list closes the browser");
});

test("selection skips the unindexed section header", () => {
	const { overlay, render } = harness({
		topics: sampleTopics(),
		bodies: { "orphan.md": "# Orphan\n\nORPHAN-BODY-MARKER\n" },
	});
	overlay.handleInput(DOWN);
	assert.match(render(), /› Beta/);
	overlay.handleInput(DOWN);
	const third = render();
	assert.doesNotMatch(third, /› unindexed/);
	assert.match(third, /› orphan\.md/);
	overlay.handleInput(ENTER);
	assert.match(render(), /ORPHAN-BODY-MARKER/);
});

test("detail scrolling follows the file and clamps at the end", () => {
	const list = Array.from({ length: 60 }, (_v, index) => `- LINE-${String(index + 1).padStart(2, "0")}`).join("\n");
	const { overlay, render } = harness({
		topics: sampleTopics(),
		bodies: { "alpha.md": list },
		rows: 24, // body height 11
	});
	overlay.handleInput(ENTER);
	assert.match(render(), /LINE-01/);
	assert.match(render(), /lines 1-11 of 60/);

	for (let press = 0; press < 20; press += 1) overlay.handleInput(PAGE_DOWN);
	const bottom = render();
	assert.match(bottom, /LINE-60/);
	assert.doesNotMatch(bottom, /LINE-01/);
	assert.match(bottom, /lines 50-60 of 60/);

	for (let press = 0; press < 5; press += 1) overlay.handleInput(PAGE_DOWN);
	assert.match(render(), /lines 50-60 of 60/);
});

test("an index line whose file is gone is marked and reports the error", () => {
	const { overlay, render } = harness({
		topics: buildTopics("- [Gone](gone.md) — hook\n", [file("MEMORY.md", 50)]),
	});
	assert.match(render(), /Gone\s+missing/);
	overlay.handleInput(ENTER);
	const detail = render();
	assert.match(detail, /gone\.md — file is missing/);
	assert.match(detail, /no content|—/);
});

test("every rendered line is exactly the overlay width, CJK included", () => {
	// pi composites overlay lines into the frame and truncates anything wider
	// than the declared width, so an over-long line corrupts the layout. CJK
	// (double-width) content and long unbreakable words are the usual culprits.
	const topics = buildTopics(
		"- [" + "很长的中文标题".repeat(12) + "](long-title.md) — 钩子\n" +
			"- [CJK](cjk.md) — 因 Hyprland 不支持双 seat，首版明确采用真实桌面单 seat；双 seat 留待后续。\n" +
			"- [Wide](wide.md) — " + "x".repeat(200) + "\n" +
			"- [Gone](gone.md) — 索引指向不存在的文件\n" +
			"- [Nested](sub/n.md) — 嵌套目标没有统计信息\n",
		// Every meta-column shape: wide size + long age, tiny size + "now",
		// missing (no stats) and a nested target (no stats either).
		[
			file("long-title.md", 1536, 3 * DAY_MS),
			file("cjk.md", 3_500_000, 400 * DAY_MS),
			file("wide.md", 12, 0),
		],
	);
	const { overlay, lines } = harness({
		topics,
		bodies: {
			"cjk.md": "# 中文标题\n\n" + "很长的中文段落，用来验证换行。".repeat(8) + "\n\n```ts\nconst aVeryLongIdentifierName = \"x\";\n```\n",
			"wide.md": "# Wide\n\n" + "y".repeat(500) + "\n",
		},
		rows: 24,
	});
	const assertWidths = (label: string) => {
		const rendered = lines();
		assert.ok(rendered.length > 0, `${label}: nothing rendered`);
		for (const [index, line] of rendered.entries()) {
			assert.equal(
				visibleWidth(line),
				WIDTH,
				`${label}: line ${index} is ${visibleWidth(line)} wide, expected ${WIDTH}`,
			);
		}
	};
	assertWidths("level 1");
	// Guard against the invariant silently degenerating: without stats there is
	// no meta column at all, which is what this test is most likely to miss.
	assert.match(lines().join("\n"), /1\.5 KB · 3d/);
	assert.match(lines().join("\n"), /12 B · now/);
	assert.match(lines().join("\n"), /missing/);
	for (let press = 0; press < 3; press += 1) overlay.handleInput(DOWN);
	assertWidths("level 1 scrolled");
	overlay.handleInput(ENTER);
	assertWidths("level 2");
	overlay.handleInput(PAGE_DOWN);
	assertWidths("level 2 scrolled");
	overlay.handleInput(ESC);
	for (const char of "中文") overlay.handleInput(char);
	assertWidths("level 1 filtered");
});

test("level 1 shows the file size and age right-aligned on the title row", () => {
	const { render } = harness({
		topics: buildTopics(
			"- [Alpha](alpha.md) — first memory\n- [Beta](beta.md) — second memory\n",
			[file("alpha.md", 1536, 3 * DAY_MS), file("beta.md", 12, 400 * DAY_MS)],
		),
	});
	const rows = render().split("\n").filter((line) => line.includes("B ·"));
	assert.equal(rows.length, 2);
	assert.match(rows[0], /Alpha +1\.5 KB · 3d *│$/);
	assert.match(rows[1], /Beta +12 B · 1y *│$/);
	// The age column is right-aligned against the panel edge on every wide row.
	for (const row of rows) assert.ok(row.endsWith("│"), row);
});

test("a missing file takes the meta column over with `missing`", () => {
	const { render } = harness({
		topics: buildTopics("- [Gone](gone.md) — hook\n- [Kept](kept.md) — hook\n", [file("kept.md", 100)]),
	});
	const [gone, kept] = render().split("\n").filter((line) => /Gone|Kept/.test(line));
	assert.match(gone, /Gone +missing *│$/);
	assert.doesNotMatch(gone, /B ·/);
	assert.match(kept, /Kept +100 B · 1d *│$/);
});

test("a topic with no stats (nested target) renders without a meta column", () => {
	const { render } = harness({
		topics: buildTopics("- [Nested](sub/n.md) — hook\n", [file("other.md", 100)]),
	});
	const row = render().split("\n").find((line) => line.includes("Nested"));
	assert.ok(row);
	assert.doesNotMatch(row, /B ·|missing/);
});

test("a narrow overlay drops the meta column instead of crushing the title", () => {
	const topics = buildTopics("- [Alpha](alpha.md) — hook\n", [file("alpha.md", 1536, 3 * DAY_MS)]);
	const wide = harness({ topics, rows: ROWS }).overlay.render(78)[3];
	assert.match(wide, /1\.5 KB · 3d/);
	// "1.5 KB · 3d" is 11 cols; it survives while the title keeps >= 10 cols,
	// i.e. contentWidth >= 23, i.e. width >= 25.
	const atBoundary = harness({ topics, rows: ROWS }).overlay.render(26)[3];
	assert.match(atBoundary, /1\.5 KB · 3d/);
	const narrow = harness({ topics, rows: ROWS }).overlay.render(24)[3];
	assert.doesNotMatch(narrow, /KB/);
	assert.match(narrow, /Alpha/);
});

test("formatAge brackets minutes, hours, days, months and years", () => {
	const at = (ms: number) => formatAge(NOW - ms, NOW);
	assert.equal(at(0), "now");
	assert.equal(at(59_000), "now");
	assert.equal(at(60_000), "1m");
	assert.equal(at(59 * 60_000), "59m");
	assert.equal(at(60 * 60_000), "1h");
	assert.equal(at(23 * 60 * 60_000), "23h");
	assert.equal(at(DAY_MS), "1d");
	assert.equal(at(29 * DAY_MS), "29d");
	assert.equal(at(30 * DAY_MS), "1mo");
	assert.equal(at(360 * DAY_MS), "12mo");
	assert.equal(at(364 * DAY_MS), "12mo");
	assert.equal(at(365 * DAY_MS), "1y");
	assert.equal(at(900 * DAY_MS), "2y");
	// A clock skewed into the future never renders a negative age.
	assert.equal(formatAge(NOW + 10 * DAY_MS, NOW), "now");
});

test("the frame keeps one color on every row, separators included", () => {
	// Regression: the separator rows used to paint their own frame cells with
	// borderMuted, so the vertical border showed a dark notch wherever a
	// separator crossed it.
	const tagged = harness({
		topics: sampleTopics(),
		bodies: { "alpha.md": "# Alpha\n\nBODY\n" },
		theme: taggingTheme,
	});
	const list = frameCodes(tagged.lines());
	assert.deepEqual([...new Set(list)], ["36"], `frame color varies per row: ${list.join(",")}`);

	tagged.overlay.handleInput(ENTER);
	const detail = frameCodes(tagged.lines());
	assert.deepEqual([...new Set(detail)], ["36"], `frame color varies per row: ${detail.join(",")}`);

	// The muted dashes are still muted: the fix must not flatten everything to
	// one color.
	const separatorRow = tagged.lines().find((line) => line.includes("─") && line.includes("│"));
	assert.ok(separatorRow);
	assert.match(separatorRow, /\u001b\[90m─+/);
});

test("an unreadable file never throws out of render", () => {
	const { overlay, render } = harness({ topics: sampleTopics() });
	overlay.handleInput(ENTER); // alpha.md has no fake body -> error path
	assert.match(render(), /alpha\.md — file is missing/);
});

test("an empty memory dir renders a hint instead of rows", () => {
	const { render } = harness({ topics: [] });
	assert.match(render(), /no memories yet/);
	assert.match(render(), /0 topics/);
});

test("overlayHeight stays inside the terminal and inside its limits", () => {
	assert.equal(overlayHeight(100), 34);
	assert.equal(overlayHeight(40), 31);
	assert.equal(overlayHeight(24), 18);
	assert.equal(overlayHeight(9), CHROME_LINES + 1);
});

test("a very short overlay still renders a usable single-line body", () => {
	const { lines } = harness({ topics: sampleTopics(), rows: 9 });
	assert.equal(lines().length, CHROME_LINES + 1);
});

test("a too-narrow render does not throw", () => {
	const { overlay } = harness({ topics: sampleTopics() });
	assert.deepEqual(overlay.render(2).length, 1);
});
