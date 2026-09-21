/**
 * Pure TPS stats logic for pi-footer.
 *
 * Ported from `pi-tps` (github.com/summertime-wu/pi-tps) with the multi-line
 * waterfall timeline dropped: only the single stats line survives, and instead
 * of a standalone widget above the editor it is rendered into the input box's
 * top border, next to the session name.
 *
 * Nothing in here touches the pi runtime — every timestamp is passed in as a
 * `now` argument — so it is unit-testable with plain `node --test` (see
 * tests/tps.test.ts).
 */

import { visibleWidth } from "@earendil-works/pi-tui";

// ── formatting ───────────────────────────────────────────────────────────

export function formatNum(num: number): string {
	if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + "M";
	if (num >= 1_000) return (num / 1_000).toFixed(1) + "k";
	return num.toFixed(0);
}

export function formatDuration(ms: number): string {
	const s = ms / 1000;
	if (s >= 60) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
	return s.toFixed(1) + "s";
}

// ── snapshot ─────────────────────────────────────────────────────────────

/** Everything the stats line needs, frozen at read time. */
export interface TpsSnapshot {
	/** Smoothed tokens/s, rounded; null until one output token is known. */
	tps: number | null;
	/** Tokens sent so far in this agent run (sum of the finished messages). */
	inputTokens: number;
	inputKnown: boolean;
	/** Tokens generated so far in this agent run. */
	outputTokens: number;
	toolCount: number;
	ttftMs: number | null;
	thinkTokens: number | null;
	llmDurationMs: number | null;
}

export interface TpsUsage {
	input?: number;
	output?: number;
}

export interface TpsDelta {
	/** Characters of assistant text received. */
	text?: number;
	/** Characters of thinking received. */
	thinking?: number;
	/** Set when the message carries thinking content without deltas. */
	hasThinkingContent?: boolean;
	usage?: TpsUsage;
}

// Tuning constants carried over from upstream (upstream clamps the generation
// window to 0.1s first, which makes its 0.05 clamp unreachable — 0.1 is the
// effective floor).
const REFRESH_MS = 80; // throttle for the EMA update
const EMA_WEIGHT = 0.15;
const MIN_ELAPSED_S = 0.1;
const THINK_CHARS_PER_TOKEN = 4;
const TEXT_CHARS_PER_TOKEN = 3.5;

/**
 * Event-driven TPS state machine.
 *
 * Mirrors the numbers pi-tps showed: tokens/s smoothed over the current
 * message's pure generation window, cumulative input/output per agent run,
 * per-run tool count, TTFT and the LLM call duration.
 */
export class TpsTracker {
	private working = false;
	/** pi's `turn` only — `before_provider_request` outside a turn (compaction) is ignored. */
	private turnActive = false;
	private requestSentTime = 0;

	private messageLive = false;
	private msgStartTime = 0;
	private msgEndTime = 0;
	private msgRequestSentTime = 0;
	private msgStartInputTokens = 0;
	private liveUsageInput = 0;
	private liveUsageOutput = 0;
	/** What the frozen (non-live) line shows after the run totals were updated. */
	private msgDisplayInput = 0;
	private msgDisplayOutput = 0;
	private firstContentTime = 0;
	private textStartTime = 0;
	private streamedTextLen = 0;
	private streamedThinkLen = 0;
	private lastEmaAt = 0;
	private smoothedTps = 0;

	private totalInput = 0;
	private totalOutput = 0;
	private toolCount = 0;
	private hasRun = false;

	/** Start of an agent run: drop everything, including the frozen last-turn numbers. */
	agentStart(): void {
		this.working = true;
		this.turnActive = false;
		this.requestSentTime = 0;
		this.messageLive = false;
		this.msgStartTime = 0;
		this.msgEndTime = 0;
		this.msgRequestSentTime = 0;
		this.msgStartInputTokens = 0;
		this.liveUsageInput = 0;
		this.liveUsageOutput = 0;
		this.msgDisplayInput = 0;
		this.msgDisplayOutput = 0;
		this.firstContentTime = 0;
		this.textStartTime = 0;
		this.streamedTextLen = 0;
		this.streamedThinkLen = 0;
		this.lastEmaAt = 0;
		this.smoothedTps = 0;
		this.totalInput = 0;
		this.totalOutput = 0;
		this.toolCount = 0;
		this.hasRun = false;
	}

	turnStart(): void {
		this.turnActive = true;
	}

	turnEnd(): void {
		this.turnActive = false;
		this.requestSentTime = 0;
	}

	beforeProviderRequest(now: number): void {
		if (this.turnActive) this.requestSentTime = now;
	}

	messageStart(now: number, usage?: TpsUsage): void {
		this.hasRun = true;
		this.messageLive = true;
		this.msgStartTime = now;
		this.msgEndTime = 0;
		this.msgRequestSentTime = this.requestSentTime;
		this.msgStartInputTokens = usage?.input ?? 0;
		this.liveUsageInput = usage?.input ?? 0;
		this.liveUsageOutput = usage?.output ?? 0;
		this.msgDisplayInput = 0;
		this.msgDisplayOutput = 0;
		this.firstContentTime = 0;
		this.textStartTime = 0;
		this.streamedTextLen = 0;
		this.streamedThinkLen = 0;
		this.lastEmaAt = 0;
	}

	messageDelta(now: number, delta: TpsDelta): void {
		if (delta.text) this.streamedTextLen += delta.text;
		if (delta.thinking) this.streamedThinkLen += delta.thinking;
		if (delta.usage) {
			this.liveUsageInput = delta.usage.input ?? this.liveUsageInput;
			this.liveUsageOutput = delta.usage.output ?? this.liveUsageOutput;
		}

		const hasContent =
			this.streamedTextLen > 0 || this.streamedThinkLen > 0 || (delta.hasThinkingContent ?? false);
		// First content (text or thinking) marks TTFT; first text delta ends thinking.
		if (this.firstContentTime === 0 && hasContent) this.firstContentTime = now;
		if (this.textStartTime === 0 && (delta.text ?? 0) > 0) this.textStartTime = now;

		this.refreshTps(now, this.liveOutputTokens());
	}

	messageEnd(now: number, usage?: TpsUsage): void {
		if (!this.messageLive) return;
		this.messageLive = false;
		this.msgEndTime = now;

		// Display keeps the estimate when the provider reported nothing; the run
		// totals only take reported usage (upstream behaves the same way, so an
		// aborted message does not inflate the following messages).
		const reportedOutput = usage?.output ?? 0;
		const displayOutput = this.reportedOrEstimate(reportedOutput);
		this.msgDisplayOutput = reportedOutput > 0 ? 0 : displayOutput;
		this.msgDisplayInput = 0;
		// Force the final sample past the throttle: this one carries the exact count.
		this.refreshTps(now, displayOutput, true);

		this.totalInput += Math.max(usage?.input ?? 0, this.msgStartInputTokens);
		this.totalOutput += reportedOutput;
		this.liveUsageInput = 0;
		this.liveUsageOutput = 0;
	}

	toolStart(): void {
		this.toolCount++;
	}

	/** Agent run finished: keep the numbers, switch the line to its muted idle look. */
	agentEnd(): void {
		this.working = false;
		this.turnActive = false;
		this.requestSentTime = 0;
	}

	/** Current numbers, or null when this agent run produced nothing yet. */
	snapshot(now: number): TpsSnapshot | null {
		if (!this.hasRun) return null;

		const live = this.messageLive;
		const currentOutput = live ? this.liveOutputTokens() : this.msgDisplayOutput;
		const currentInput = live
			? Math.max(this.liveUsageInput, this.msgStartInputTokens)
			: this.msgDisplayInput;
		const inputTokens = this.totalInput + currentInput;
		const outputTokens = this.totalOutput + currentOutput;

		const base = this.msgRequestSentTime > 0 ? this.msgRequestSentTime : this.msgStartTime;
		const end = live ? now : this.msgEndTime;
		const ttftMs = this.firstContentTime > 0 && base > 0 ? Math.max(this.firstContentTime - base, 0) : null;
		const llmDurationMs = base > 0 ? Math.max(end - base, 0) : null;
		const thinkTokens = Math.floor(this.streamedThinkLen / THINK_CHARS_PER_TOKEN);

		return {
			tps: this.smoothedTps > 0 ? Math.round(this.smoothedTps) : null,
			inputTokens,
			inputKnown: inputTokens > 0,
			outputTokens,
			toolCount: this.toolCount,
			ttftMs,
			thinkTokens: thinkTokens > 0 ? thinkTokens : null,
			llmDurationMs,
		};
	}

	get isWorking(): boolean {
		return this.working;
	}

	private refreshTps(now: number, tokens: number, force = false): void {
		if (tokens <= 0) return;
		if (!force && this.lastEmaAt > 0 && now - this.lastEmaAt < REFRESH_MS) return;
		this.lastEmaAt = now;

		const elapsed = Math.max((now - this.generationStart()) / 1000, MIN_ELAPSED_S);
		const raw = tokens / elapsed;
		this.smoothedTps = this.smoothedTps === 0 ? raw : EMA_WEIGHT * raw + (1 - EMA_WEIGHT) * this.smoothedTps;
	}

	/**
	 * Output tokens to show/smooth right now: reported usage wins (it is the exact
	 * count), the character estimate is the fallback while streaming. Display and
	 * TPS always use the same number.
	 */
	private liveOutputTokens(): number {
		return this.reportedOrEstimate(this.liveUsageOutput);
	}

	private reportedOrEstimate(reported: number): number {
		return reported > 0 ? reported : this.estimateOutputTokens();
	}

	/** TPS window: text generation > first content > message start. */
	private generationStart(): number {
		return this.textStartTime || this.firstContentTime || this.msgStartTime;
	}

	private estimateOutputTokens(): number {
		return (
			Math.floor(this.streamedThinkLen / THINK_CHARS_PER_TOKEN) +
			Math.floor(this.streamedTextLen / TEXT_CHARS_PER_TOKEN)
		);
	}
}

// ── colors ───────────────────────────────────────────────────────────────

export type StatsRole = "core" | "input" | "output" | "tools" | "ttft" | "think" | "duration";
export type StatsColor = (role: StatsRole, text: string) => string;

/** 256-color codes inherited from pi-tps' `colorPreset` table. */
const PRESET_CODES: Record<string, Record<StatsRole, number>> = {
	morandi: { core: 252, input: 244, output: 108, tools: 67, ttft: 180, think: 103, duration: 244 },
	forest: { core: 250, input: 243, output: 114, tools: 109, ttft: 187, think: 101, duration: 243 },
	ocean: { core: 252, input: 244, output: 80, tools: 68, ttft: 117, think: 67, duration: 244 },
	retro: { core: 254, input: 242, output: 106, tools: 103, ttft: 215, think: 95, duration: 242 },
	ice: { core: 254, input: 247, output: 152, tools: 146, ttft: 152, think: 146, duration: 247 },
	dusk: { core: 254, input: 246, output: 182, tools: 110, ttft: 181, think: 140, duration: 246 },
	mono: { core: 254, input: 242, output: 247, tools: 245, ttft: 250, think: 239, duration: 242 },
	nord: { core: 252, input: 244, output: 110, tools: 67, ttft: 180, think: 61, duration: 244 },
};

export const PRESET_NAMES = Object.keys(PRESET_CODES);

const RESET = "\x1b[0m";
const paint = (code: number) => (text: string) => `\x1b[38;5;${code}m${text}${RESET}`;

/** Colorizer for one of the inherited 256-color presets. */
export function presetColor(name: string): StatsColor {
	const codes = PRESET_CODES[name] ?? PRESET_CODES.mono;
	return (role, text) => paint(codes[role])(text);
}

/** Idle look of a preset: everything in its muted shade. */
export function presetIdleColor(name: string): StatsColor {
	const codes = PRESET_CODES[name] ?? PRESET_CODES.mono;
	return (_role, text) => paint(codes.duration)(text);
}

// ── stats line ───────────────────────────────────────────────────────────

type StatsKey = "core" | "tools" | "ttft" | "think" | "duration";

interface StatsSegment {
	key: StatsKey;
	parts: { role: StatsRole; text: string }[];
}

/**
 * Drop order when the line does not fit — least useful first, so the core
 * `⚡Nt/s` is the very last thing to go. Detail (tools / thinking / duration)
 * goes before TTFT.
 */
const DROP_ORDER: StatsKey[] = ["duration", "think", "tools", "ttft", "core"];

export interface StatsLineOptions {
	showTtft: boolean;
	maxWidth: number;
	color: StatsColor;
}

/** Shown while the first token is still pending, i.e. before a TPS estimate exists. */
const CORE_PLACEHOLDER = "⚡…";

/**
 * The stats line, already degraded to `maxWidth` (returns "" when even the
 * core segment does not fit). Segments keep a stable visual order; shrinking
 * only ever removes trailing detail, never reorders.
 */
export function buildStatsLine(s: TpsSnapshot, o: StatsLineOptions): string {
	if (o.maxWidth <= 0) return "";

	let segments = statsSegments(s, o.showTtft);
	if (segments.length === 0) return "";

	let rendered = renderSegments(segments, o.color);
	while (segments.length > 1 && rendered.width > o.maxWidth) {
		segments = dropLowest(segments);
		rendered = renderSegments(segments, o.color);
	}

	if (rendered.width > o.maxWidth) return "";
	// Degrading all the way down to a lone placeholder leaves a border slot that
	// says nothing — better to give the space back to the status/name.
	if (segments.length === 1 && segments[0].parts[0].text === CORE_PLACEHOLDER) return "";
	return rendered.text;
}

function statsSegments(s: TpsSnapshot, showTtft: boolean): StatsSegment[] {
	// Everything hangs off the core segment: until there is a TPS estimate or a
	// tool call, a bare "⏳1.9s" would just be noise on the border. The ↑/↓ token
	// counts are deliberately not shown here — pi's own footer already reports
	// them one line below.
	if (s.tps === null && s.toolCount === 0) return [];

	const segments: StatsSegment[] = [
		{ key: "core", parts: [{ role: "core", text: s.tps !== null ? `⚡${s.tps}t/s` : CORE_PLACEHOLDER }] },
	];
	if (s.toolCount > 0) segments.push({ key: "tools", parts: [{ role: "tools", text: `🔧${s.toolCount}` }] });
	if (showTtft && s.ttftMs !== null) {
		segments.push({ key: "ttft", parts: [{ role: "ttft", text: `⏱${formatDuration(s.ttftMs)}` }] });
	}
	if (s.thinkTokens !== null) {
		segments.push({ key: "think", parts: [{ role: "think", text: `🧠${formatNum(s.thinkTokens)}` }] });
	}
	if (s.llmDurationMs !== null) {
		segments.push({ key: "duration", parts: [{ role: "duration", text: `⏳${formatDuration(s.llmDurationMs)}` }] });
	}

	return segments;
}

function dropLowest(segments: StatsSegment[]): StatsSegment[] {
	for (const key of DROP_ORDER) {
		const index = segments.findIndex((segment) => segment.key === key);
		if (index >= 0) {
			const next = segments.slice();
			next.splice(index, 1);
			return next;
		}
	}
	return segments;
}

function renderSegments(segments: StatsSegment[], color: StatsColor): { text: string; width: number } {
	const text = segments
		.map((segment) => segment.parts.map((part) => color(part.role, part.text)).join(" "))
		.join(" ");
	return { text, width: visibleWidth(text) };
}

// ── top border layout ────────────────────────────────────────────────────

export interface TopBorderInput {
	width: number;
	/** Already colored ` name `, or "" when the session has no name. */
	nameLabel: string;
	/** Border colorizer (the Editor's `borderColor`). */
	border: (text: string) => string;
	/** Render the stats line within `maxWidth`; return "" when it does not fit. */
	renderStats: (maxWidth: number) => string;
	/** Render the inline working status within `allowance`; return "" when there is none. */
	renderStatus: (allowance: number) => string;
}

const TAIL_WIDTH = 1; // the single "─" closing the right block
const LEAD_WIDTH = 2; // "──" drawn in front of the stats when no status is shown
const FILL_MIN = 1; // at least one dash between the left block and the name
const STATUS_BLOCK_MIN = 5; // "── " + one indicator column + " "

/**
 * Compose the top border:
 *
 *   ── <working status> <stats> ────────── <session name> ─
 *
 * Width is conserved exactly. The left side carries the status and the stats
 * line, the right side keeps the session name, and the dashes fill whatever is
 * left between them. Allocation priority: session name (fixed) → working
 * status (its natural width, capped at a third of the row) → stats (elastic,
 * degrades segment by segment down to nothing).
 *
 * The stats sit right after the status. With no status to follow they get
 * their own `──` lead, so the line never starts with a bare stat and idling
 * borders keep the same left margin as working ones.
 */
export function composeTopBorder(input: TopBorderInput): string {
	// The session name is the last thing to go, but on a border narrower than the
	// label itself it has to give way — then there is nothing left to keep.
	const requestedNameWidth = input.nameLabel ? visibleWidth(input.nameLabel) : 0;
	const nameWidth = requestedNameWidth + TAIL_WIDTH <= input.width ? requestedNameWidth : 0;
	const nameLabel = nameWidth > 0 ? input.nameLabel : "";
	const nameBlock = nameWidth > 0 ? nameWidth + TAIL_WIDTH : 0;

	// 1) How much room does the working status want?
	const naturalStatus = input.renderStatus(Math.max(0, input.width - STATUS_BLOCK_MIN));
	const naturalStatusBlock = naturalStatus ? 3 + visibleWidth(naturalStatus) + 1 : 0;
	const statusReserve = Math.min(
		naturalStatusBlock,
		Math.max(STATUS_BLOCK_MIN, Math.floor(input.width / 3)),
	);

	// 2) Stats take what is left after the status block (or the `──` lead).
	const leftLead = statusReserve > 0 ? statusReserve : LEAD_WIDTH;
	const statsBudget = Math.max(0, input.width - nameBlock - leftLead - FILL_MIN);
	let stats = statsBudget > 0 ? input.renderStats(statsBudget) : "";
	if (!stats) stats = "";
	const statsWidth = visibleWidth(stats);

	// 3) The status gets the remaining room; the allowance is the widest status
	// that still leaves FILL_MIN dashes before the name, so a full "Working"
	// survives whenever the reserve above did.
	const room = input.width - nameBlock - statsWidth - FILL_MIN - (STATUS_BLOCK_MIN - 1);
	const status = room > 0 ? input.renderStatus(Math.max(0, room)) : "";
	const leadsWithStatus = status.length > 0;

	const prefix = leadsWithStatus
		? `── ${status} `
		: statsWidth > 0
			? input.border("─".repeat(LEAD_WIDTH))
			: "";
	const fill = Math.max(
		0,
		input.width - visibleWidth(prefix) - statsWidth - nameBlock,
	);

	return prefix + stats + input.border("─".repeat(fill)) + nameLabel + (nameBlock > 0 ? input.border("─") : "");
}
