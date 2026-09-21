import assert from "node:assert/strict";
import test from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	buildStatsLine,
	composeTopBorder,
	formatDuration,
	formatNum,
	TpsTracker,
	type StatsColor,
	type TpsSnapshot,
} from "../tps.ts";

const plain: StatsColor = (_role, text) => text;

const T0 = 1_000_000;

function snapshot(overrides: Partial<TpsSnapshot> = {}): TpsSnapshot {
	return {
		tps: 42,
		inputTokens: 12_300,
		inputKnown: true,
		outputTokens: 4_500,
		toolCount: 3,
		ttftMs: 1_200,
		thinkTokens: 12,
		llmDurationMs: 2_100,
		...overrides,
	};
}

// ── formatting ───────────────────────────────────────────────────────────

test("formatNum scales k/M", () => {
	assert.equal(formatNum(0), "0");
	assert.equal(formatNum(999), "999");
	assert.equal(formatNum(1_000), "1.0k");
	assert.equal(formatNum(12_345), "12.3k");
	assert.equal(formatNum(2_000_000), "2.0M");
});

test("formatDuration switches to minutes past 60s", () => {
	assert.equal(formatDuration(0), "0.0s");
	assert.equal(formatDuration(1_200), "1.2s");
	assert.equal(formatDuration(59_900), "59.9s");
	assert.equal(formatDuration(65_000), "1m 5s");
});

// ── tracker ──────────────────────────────────────────────────────────────

test("tracker reports nothing until the first assistant message", () => {
	const tracker = new TpsTracker();
	assert.equal(tracker.snapshot(T0), null);

	tracker.agentStart();
	assert.equal(tracker.isWorking, true);
	assert.equal(tracker.snapshot(T0), null);
});

test("tracker derives ttft, think tokens and llm duration from the request time", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.beforeProviderRequest(T0 + 100);
	tracker.messageStart(T0 + 150, { input: 400 });

	assert.equal(tracker.snapshot(T0 + 150)?.tps, null);

	tracker.messageDelta(T0 + 250, { thinking: 80 });
	const s = tracker.snapshot(T0 + 250);
	assert.ok(s);
	assert.equal(s.ttftMs, 150); // T0+250 - requestSent(T0+100)
	assert.equal(s.llmDurationMs, 150);
	assert.equal(s.thinkTokens, 20); // 80 / 4
	assert.equal(s.outputTokens, 20);
	assert.equal(s.inputTokens, 400);
	assert.equal(s.inputKnown, true);
	assert.equal(s.toolCount, 0);
});

test("tracker ignores before_provider_request outside a turn", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.turnEnd();
	tracker.beforeProviderRequest(T0 + 500); // compaction-style request: ignored
	tracker.messageStart(T0 + 600);
	tracker.messageDelta(T0 + 700, { hasThinkingContent: true });

	// Falls back to the message start instead of the ignored request time.
	assert.equal(tracker.snapshot(T0 + 700)?.ttftMs, 100);
});

test("tracker smooths tps and settles once the window grows", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.beforeProviderRequest(T0);
	tracker.messageStart(T0 + 10);
	tracker.messageDelta(T0 + 20, { text: 350 });

	const first = tracker.snapshot(T0 + 20)?.tps;
	assert.ok(typeof first === "number" && first > 0);

	// Same character rate, but one second of extra window: the estimate drops.
	tracker.messageDelta(T0 + 1_020, { text: 350 });
	const second = tracker.snapshot(T0 + 1_020)?.tps;
	assert.ok(typeof second === "number" && second > 0);
	assert.ok(second < first, `expected ${second} < ${first}`);
});

test("tracker folds a finished message into the run totals and freezes it", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.beforeProviderRequest(T0);
	tracker.messageStart(T0 + 10, { input: 300 });
	tracker.messageDelta(T0 + 100, { text: 350 });
	tracker.messageEnd(T0 + 1_000, { input: 1_000, output: 120 });

	const done = tracker.snapshot(T0 + 5_000);
	assert.ok(done);
	assert.equal(done.inputTokens, 1_000);
	assert.equal(done.outputTokens, 120);
	// Frozen: advancing the clock does not inflate the numbers.
	assert.equal(done.llmDurationMs, 1_000);

	// A second message adds to the run totals instead of replacing them.
	tracker.messageStart(T0 + 6_000, { input: 1_500 });
	tracker.messageDelta(T0 + 6_100, { text: 70 });
	const second = tracker.snapshot(T0 + 6_100);
	assert.ok(second);
	assert.equal(second.inputTokens, 2_500); // 1_000 + 1_500
	assert.equal(second.outputTokens, 140); // 120 + 20
});

test("tracker reports tokens/s against upstream's 100ms window floor", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.beforeProviderRequest(T0);
	tracker.messageStart(T0 + 10);
	// First text delta defines the window start, so elapsed is the floor: 100
	// characters / 0.1s = 1000 t/s (upstream clamps to 0.1s, not 0.05s).
	tracker.messageDelta(T0 + 20, { text: 350 });
	assert.equal(tracker.snapshot(T0 + 20)?.tps, 1000);
});

test("tracker finalizes tps with the reported count even right after a delta", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.beforeProviderRequest(T0);
	tracker.messageStart(T0 + 10);
	tracker.messageDelta(T0 + 1_000, { text: 350 });
	const mid = tracker.snapshot(T0 + 1_000)?.tps;

	// 10ms later the message ends with a much smaller reported count: the final
	// sample must not be swallowed by the 80ms EMA throttle.
	tracker.messageEnd(T0 + 1_010, { input: 100, output: 10 });
	const done = tracker.snapshot(T0 + 1_010)?.tps;
	assert.ok(typeof done === "number" && typeof mid === "number");
	assert.ok(done < mid, `expected final ${done} < mid-flight ${mid}`);
});

test("tracker uses reported usage for display and tps alike", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.beforeProviderRequest(T0);
	tracker.messageStart(T0 + 10);
	// 350 characters (≈100 estimated tokens) but the provider reports 40.
	tracker.messageDelta(T0 + 1_000, { text: 350, usage: { output: 40 } });
	const s = tracker.snapshot(T0 + 1_000);
	assert.ok(s);
	assert.equal(s.outputTokens, 40, "display follows the reported count");
	// Same numerator for tps: 40 over the 0.1s floor window. Using the estimate
	// (100 tokens) would give 1000 here.
	assert.equal(s.tps, 400);
});

test("tracker keeps estimates out of the run totals", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.messageStart(T0 + 10);
	tracker.messageDelta(T0 + 1_000, { text: 350 });
	// Aborted message: no usage at all.
	tracker.messageEnd(T0 + 1_000, undefined);

	// The frozen line still shows the estimate for this message…
	assert.equal(tracker.snapshot(T0 + 2_000)?.outputTokens, 100);

	// …but the next message starts from reported usage only.
	tracker.messageStart(T0 + 3_000, { input: 10 });
	tracker.messageDelta(T0 + 3_100, { text: 35 });
	tracker.messageEnd(T0 + 3_200, { input: 10, output: 20 });
	assert.equal(tracker.snapshot(T0 + 4_000)?.outputTokens, 20);
	// The aborted message reported no input either, so the run total is just the
	// second message's 10 — no silently accumulated guess.
	assert.equal(tracker.snapshot(T0 + 4_000)?.inputTokens, 10);
});

test("tracker counts tools and keeps the numbers after the run ends", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.messageStart(T0);
	tracker.messageDelta(T0 + 50, { text: 350 });
	tracker.messageEnd(T0 + 500, { input: 900, output: 100 });
	tracker.toolStart();
	tracker.toolStart();
	tracker.agentEnd();

	assert.equal(tracker.isWorking, false);
	assert.equal(tracker.snapshot(T0 + 9_999)?.toolCount, 2);

	// New run: the previous run's numbers are gone, not shown as current.
	tracker.agentStart();
	assert.equal(tracker.snapshot(T0 + 10_000), null);
	assert.equal(tracker.isWorking, true);
});

test("tracker drops thinking tokens when the next message has none", () => {
	const tracker = new TpsTracker();
	tracker.agentStart();
	tracker.turnStart();
	tracker.messageStart(T0);
	tracker.messageDelta(T0 + 50, { thinking: 80 });
	assert.equal(tracker.snapshot(T0 + 50)?.thinkTokens, 20);
	tracker.messageEnd(T0 + 100, { input: 10, output: 20 });

	tracker.messageStart(T0 + 200);
	tracker.messageDelta(T0 + 250, { text: 35 });
	assert.equal(tracker.snapshot(T0 + 250)?.thinkTokens, null);
});

// ── stats line ───────────────────────────────────────────────────────────

const FULL_LINE = "⚡42t/s 🔧3 ⏱1.2s 🧠12 ⏳2.1s";
const FULL_WIDTH = visibleWidth(FULL_LINE); // 29

test("stats line renders every segment in a stable order", () => {
	assert.equal(FULL_WIDTH, 29);
	assert.equal(buildStatsLine(snapshot(), { showTtft: true, maxWidth: FULL_WIDTH, color: plain }), FULL_LINE);
});

test("stats line shows the TPS core instead of the token counts", () => {
	// The ↑/↓ run totals are computed by the tracker but never drawn here: pi's
	// own footer reports them one line below the border.
	const line = buildStatsLine(snapshot(), { showTtft: true, maxWidth: 200, color: plain });
	assert.ok(!line.includes("↑"), line);
	assert.ok(!line.includes("↓"), line);
});

test("stats line drops detail before the core", () => {
	const line = (maxWidth: number) =>
		buildStatsLine(snapshot(), { showTtft: true, maxWidth, color: plain });

	assert.equal(line(FULL_WIDTH - 1), "⚡42t/s 🔧3 ⏱1.2s 🧠12"); // ⏳ dropped
	assert.equal(line(21), "⚡42t/s 🔧3 ⏱1.2s"); // 🧠 dropped
	assert.equal(line(16), "⚡42t/s ⏱1.2s"); // 🔧 dropped
	assert.equal(line(12), "⚡42t/s"); // ⏱ dropped
	assert.equal(line(6), ""); // core alone does not fit either
	assert.equal(line(7), "⚡42t/s");
});

test("stats line omits ttft unless it is enabled", () => {
	const line = buildStatsLine(snapshot(), { showTtft: false, maxWidth: 100, color: plain });
	assert.equal(line, "⚡42t/s 🔧3 🧠12 ⏳2.1s");
});

test("stats line stays empty until there is something to show", () => {
	const empty = snapshot({ tps: null, inputTokens: 0, inputKnown: false, outputTokens: 0, toolCount: 0, ttftMs: null, thinkTokens: null, llmDurationMs: null });
	assert.equal(buildStatsLine(empty, { showTtft: true, maxWidth: 100, color: plain }), "");

	const starting = snapshot({ tps: null, inputTokens: 0, inputKnown: false, outputTokens: 0, thinkTokens: null, llmDurationMs: null, ttftMs: null, toolCount: 0 });
	assert.equal(buildStatsLine(starting, { showTtft: true, maxWidth: 100, color: plain }), "");
});

test("stats line needs the core segment before it reports anything", () => {
	// TTFT/thinking/duration are known before the first token — still no line.
	const ttftOnly = snapshot({ tps: null, inputTokens: 0, inputKnown: false, outputTokens: 0, toolCount: 0 });
	assert.equal(buildStatsLine(ttftOnly, { showTtft: true, maxWidth: 100, color: plain }), "");

	// A tool call alone is worth showing, with the TPS estimate still pending.
	const toolOnly = snapshot({ tps: null, inputTokens: 0, inputKnown: false, outputTokens: 0, toolCount: 2, ttftMs: null, thinkTokens: null, llmDurationMs: null });
	assert.equal(buildStatsLine(toolOnly, { showTtft: true, maxWidth: 100, color: plain }), "⚡… 🔧2");
});

test("stats line never degrades down to a lone placeholder", () => {
	const toolOnly = snapshot({ tps: null, inputTokens: 0, inputKnown: false, outputTokens: 0, toolCount: 2, ttftMs: null, thinkTokens: null, llmDurationMs: null });
	// Wide enough for the tool call…
	assert.equal(buildStatsLine(toolOnly, { showTtft: true, maxWidth: 20, color: plain }), "⚡… 🔧2");
	// …and narrow enough to force dropping it: give the slot back, don't show "⚡…".
	assert.equal(buildStatsLine(toolOnly, { showTtft: true, maxWidth: 3, color: plain }), "");
});

// ── top border ───────────────────────────────────────────────────────────

const NAME_LABEL = " feat/auth ";
/** Same shape as pi's own degradation: full text, then spinner only. */
const statusRenderer = (allowance: number) => (allowance >= 9 ? "⠼ Working" : allowance >= 1 ? "⠼" : "");

function compose(options: {
	width: number;
	withName?: boolean;
	withStatus?: boolean;
	statsWidth?: number;
}): string {
	const { width, withName = true, withStatus = true, statsWidth = FULL_WIDTH } = options;
	return composeTopBorder({
		width,
		nameLabel: withName ? NAME_LABEL : "",
		border: (text) => text,
		renderStats: (maxWidth) =>
			buildStatsLine(snapshot(), { showTtft: true, maxWidth: Math.min(maxWidth, statsWidth), color: plain }),
		renderStatus: withStatus ? statusRenderer : () => "",
	});
}

test("border puts the stats left of the fill and the name at the right edge", () => {
	const wide = compose({ width: 130 });
	assert.ok(wide.includes("⠼ Working ⚡42t/s"), wide);
	assert.ok(wide.includes("⏳2.1s"), "wide border keeps the full stats line");
	assert.ok(wide.indexOf("⚡42t/s") < wide.indexOf(" feat/auth "), wide);
	assert.ok(wide.endsWith(" feat/auth ─"), wide);
	assert.equal(visibleWidth(wide), 130);

	// Narrower: the stats degrade, the status and the name stay.
	const narrow = compose({ width: 45 });
	assert.ok(narrow.includes("⠼ Working"), narrow);
	assert.ok(narrow.includes(" feat/auth "), narrow);
	assert.ok(narrow.includes("⚡42t/s"), narrow);
	assert.ok(!narrow.includes("⏳"), "duration is the first thing to go");

	const tiny = compose({ width: 30 });
	assert.ok(tiny.includes(" feat/auth "), "session name is the last thing to go");
	assert.equal(visibleWidth(tiny), 30);
});

test("border gives the idle stats their own ── lead", () => {
	// No status to follow, so the stats get the same left margin a working
	// border has instead of starting flush at column 0.
	const idle = compose({ width: 80, withStatus: false });
	assert.ok(idle.startsWith("──⚡42t/s"), idle);
	assert.equal(visibleWidth(idle), 80);
});

test("border renders the stats line without a session name", () => {
	const line = compose({ width: 60, withName: false });
	assert.ok(line.includes("⚡42t/s"));
	assert.ok(!line.includes("feat/auth"));
	assert.equal(visibleWidth(line), 60);
});

test("border has no working status when the agent is idle", () => {
	const idle = compose({ width: 80, withStatus: false });
	assert.ok(!idle.includes("⠼"));
	assert.ok(idle.includes("⚡42t/s"));
	assert.ok(idle.endsWith(" feat/auth ─"), idle);
	assert.equal(visibleWidth(idle), 80);
});

test("border width is conserved across widths and content combinations", () => {
	for (const withName of [true, false]) {
		for (const withStatus of [true, false]) {
			for (const statsWidth of [0, 7, FULL_WIDTH]) {
				for (let width = 1; width <= 150; width++) {
					const line = compose({ width, withName, withStatus, statsWidth });
					assert.equal(
						visibleWidth(line),
						width,
						`width=${width} name=${withName} status=${withStatus} stats=${statsWidth} -> ${JSON.stringify(line)}`,
					);
				}
			}
		}
	}
});

test("border falls back to dashes when there is nothing to show", () => {
	assert.equal(compose({ width: 40, withName: false, withStatus: false, statsWidth: 0 }), "─".repeat(40));
});
