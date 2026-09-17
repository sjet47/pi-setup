// Overlay tests for `/memory`: list rendering, fuzzy search, level switching
// and detail scrolling. Driven with a stub theme/keybindings so no terminal is
// needed; the fs is faked through the injected readBody.
// Run: cd extensions/pi-note && node --import tsx --test test/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { CHROME_LINES, MemoryBrowserOverlay, overlayHeight } from "../browser.ts";
import { buildTopics, type MemoryTopic } from "../memory-index.ts";

const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const WIDTH = 78;
const ROWS = 40;

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

function harness(options: {
	topics: MemoryTopic[];
	bodies?: Record<string, string>;
	rows?: number;
}) {
	const bodies = options.bodies ?? {};
	let closed = 0;
	const overlay = new MemoryBrowserOverlay({
		topics: options.topics,
		label: "home/sjet/repo/pi-setup",
		terminalRows: () => options.rows ?? ROWS,
		theme,
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
		["MEMORY.md", "alpha.md", "beta.md", "orphan.md"],
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
		topics: buildTopics("- [Gone](gone.md) — hook\n", ["MEMORY.md"]),
	});
	assert.match(render(), /Gone \(missing\)/);
	overlay.handleInput(ENTER);
	const detail = render();
	assert.match(detail, /gone\.md — file is missing/);
	assert.match(detail, /no content|—/);
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
