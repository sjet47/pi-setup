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
	/** Characters of tool-call arguments (JSON) received. */
	toolCall?: number;
	/** Set when the message carries thinking content without deltas. */
	hasThinkingContent?: boolean;
	usage?: TpsUsage;
}

// Tuning constants carried over from upstream (upstream clamps the generation
// window to 0.1s first, which makes its 0.05 clamp unreachable — 0.1 is the
// effective floor).
const REFRESH_MS = 80; // throttle for the mid-stream EMA update
const EMA_WEIGHT = 0.15;
const MIN_ELAPSED_S = 0.1;
const THINK_CHARS_PER_TOKEN = 4;
const TEXT_CHARS_PER_TOKEN = 3.5;

/**
 * Event-driven TPS state machine.
 *
 * Mirrors the numbers pi-tps showed: tokens/s smoothed over the current
 * message's generation window, cumulative input/output per agent run, per-run
 * tool count, TTFT and the LLM call duration.
 *
 * The TPS line always describes *one* message's generation rate:
 *
 *  - the EMA starts over at every `messageStart`, so a slow message is not
 *    dragged down by the fast one before it (and vice versa);
 *  - numerator and window cover the same span — content accumulates and the
 *    clock starts at `firstContentTime`, so ending thinking does not reset the
 *    denominator while the thinking tokens stay in the numerator;
 *  - the numerator prefers reported usage while it is *current* and falls back
 *    to the character estimate otherwise (see `outputTokensNow`);
 *  - `messageEnd` recomputes the rate over the whole message window and lets it
 *    replace the EMA, so the frozen line ends up near the message's real rate;
 *  - until the new message has numbers of its own, the line keeps showing the
 *    previous message's TPS / TTFT / thinking (see `held*`), so a turn never
 *    blanks back to the `⚡…` placeholder between two messages.
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
	private streamedTextLen = 0;
	private streamedThinkLen = 0;
	private streamedToolCallLen = 0;
	/** Content chars streamed when the reported output count was last revised. */
	private usageAnchorChars = 0;
	private lastEmaAt = 0;
	private smoothedTps = 0;
	/** Previous message's numbers, shown until the current message replaces them. */
	private heldTps: number | null = null;
	private heldTtftMs: number | null = null;
	private heldThinkTokens: number | null = null;

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
		this.streamedTextLen = 0;
		this.streamedThinkLen = 0;
		this.streamedToolCallLen = 0;
		this.usageAnchorChars = 0;
		this.lastEmaAt = 0;
		this.smoothedTps = 0;
		this.heldTps = null;
		this.heldTtftMs = null;
		this.heldThinkTokens = null;
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
		// Carry what the line shows right now over to the new message; `snapshot`
		// already folds in older held values, so a message that produced nothing
		// keeps the one before it on screen.
		const shown = this.snapshot(now);
		this.heldTps = shown?.tps ?? null;
		this.heldTtftMs = shown?.ttftMs ?? null;
		this.heldThinkTokens = shown?.thinkTokens ?? null;

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
		this.streamedTextLen = 0;
		this.streamedThinkLen = 0;
		this.streamedToolCallLen = 0;
		// Nothing streamed yet, so a count coming from `message_start` is current
		// until the first content delta arrives.
		this.usageAnchorChars = 0;
		this.lastEmaAt = 0;
		// The EMA describes this message only: the previous message's rate must not
		// leak into it (a single 0.15-weighted sample would carry ~85% of it over).
		// The old rate stays *visible* through `heldTps` until the first sample.
		this.smoothedTps = 0;
	}

	messageDelta(now: number, delta: TpsDelta): void {
		if (delta.text) this.streamedTextLen += delta.text;
		if (delta.thinking) this.streamedThinkLen += delta.thinking;
		if (delta.toolCall) this.streamedToolCallLen += delta.toolCall;
		if (delta.usage) {
			if (delta.usage.input !== undefined) this.liveUsageInput = delta.usage.input;
			const output = delta.usage.output;
			// pi hands the same usage object to every `message_update`, so only a
			// *changed* count is a revision; an unchanged one keeps its old anchor and
			// therefore reads as stale as soon as more content arrives.
			if (output !== undefined && output !== this.liveUsageOutput) {
				this.liveUsageOutput = output;
				this.usageAnchorChars = this.streamedChars();
			}
		}

		const hasContent = this.streamedChars() > 0 || (delta.hasThinkingContent ?? false);
		// First content (text, thinking or tool-call arguments) marks TTFT and starts
		// the TPS window.
		if (this.firstContentTime === 0 && hasContent) this.firstContentTime = now;

		this.refreshTps(now, this.outputTokensNow());
	}

	messageEnd(now: number, usage?: TpsUsage): void {
		if (!this.messageLive) return;
		this.messageLive = false;
		this.msgEndTime = now;

		const reportedOutput = usage?.output ?? 0;
		// The end-of-stream usage is the provider's final word — Anthropic delivers
		// the real `output_tokens` in the trailing `message_delta`, which reaches us
		// as a revision here. A value that never moved since `message_start` is the
		// opening placeholder, not a final count, so it does not get adopted.
		if (reportedOutput > 0 && reportedOutput !== this.liveUsageOutput) {
			this.liveUsageOutput = reportedOutput;
			this.usageAnchorChars = this.streamedChars();
		}
		const displayOutput = this.outputTokensNow();

		// Freeze the estimate when the provider supplied no usable final count.
		// Run totals still use reported usage, so an aborted message cannot inflate
		// the following message's baseline.
		// The run total already includes the reported count. Keep only the
		// difference so the frozen display matches the tokens used for TPS.
		this.msgDisplayOutput = displayOutput - reportedOutput;
		this.msgDisplayInput = 0;
		// The final sample is computed over the whole message, so it already *is*
		// this message's rate: it replaces the EMA instead of being blended in with
		// weight 0.15, which would leave the frozen line on the last mid-stream
		// sample even though the exact count just arrived.
		this.finalizeTps(now, displayOutput);

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
		const currentOutput = live ? this.outputTokensNow() : this.msgDisplayOutput;
		const currentInput = live
			? Math.max(this.liveUsageInput, this.msgStartInputTokens)
			: this.msgDisplayInput;
		const inputTokens = this.totalInput + currentInput;
		const outputTokens = this.totalOutput + currentOutput;

		const base = this.msgRequestSentTime > 0 ? this.msgRequestSentTime : this.msgStartTime;
		const end = live ? now : this.msgEndTime;
		const ttftMs =
			this.firstContentTime === 0
				? this.heldTtftMs
				: base > 0
					? Math.max(this.firstContentTime - base, 0)
					: null;
		const llmDurationMs = base > 0 ? Math.max(end - base, 0) : null;
		const ownThink = Math.floor(this.streamedThinkLen / THINK_CHARS_PER_TOKEN);
		// Thinking of the previous message stays until this one either thinks too or
		// moves on to text / tool calls without thinking (then there is none to show).
		const thinkTokens =
			ownThink > 0
				? ownThink
				: this.streamedTextLen + this.streamedToolCallLen > 0
					? null
					: this.heldThinkTokens;

		return {
			tps: this.smoothedTps > 0 ? Math.round(this.smoothedTps) : this.heldTps,
			inputTokens,
			inputKnown: inputTokens > 0,
			outputTokens,
			toolCount: this.toolCount,
			ttftMs,
			thinkTokens,
			llmDurationMs,
		};
	}

	get isWorking(): boolean {
		return this.working;
	}

	/** Mid-stream sample: throttled, and blended into the message's own EMA. */
	private refreshTps(now: number, tokens: number): void {
		if (tokens <= 0) return;
		if (this.lastEmaAt > 0 && now - this.lastEmaAt < REFRESH_MS) return;
		this.lastEmaAt = now;

		const raw = tokens / this.elapsedSeconds(now);
		this.smoothedTps = this.smoothedTps === 0 ? raw : EMA_WEIGHT * raw + (1 - EMA_WEIGHT) * this.smoothedTps;
	}

	/**
	 * Final sample at `message_end`: the window covers the whole message, so the
	 * value is an average already and supersedes the mid-stream EMA (the throttle
	 * does not apply — this may follow the last delta by a few milliseconds).
	 */
	private finalizeTps(now: number, tokens: number): void {
		if (tokens <= 0) return;
		this.lastEmaAt = now;
		this.smoothedTps = tokens / this.elapsedSeconds(now);
	}

	/**
	 * Output tokens to show/smooth right now. Display and TPS always use the same
	 * number.
	 *
	 * Reported usage and the character estimate are *different units* — a real
	 * token count versus `chars / 3.5` — so the two are never compared
	 * numerically; the estimate is not a lower bound for the reported count, and a
	 * reported count below the estimate is not treated as wrong. What decides is
	 * currency: the reported count wins only while nothing has streamed since it
	 * was last revised. Otherwise a provider that opens with a placeholder count
	 * (Anthropic sends `output_tokens: 1` in `message_start`, and pi hands us that
	 * same count on every delta until it is revised) would pin both the counter and
	 * the rate for the rest of the message. The price is that a count revised once
	 * and then left behind is dropped in favour of the estimate until it is revised
	 * again (or until `message_end`).
	 */
	private outputTokensNow(): number {
		const reported = this.liveUsageOutput;
		const current = reported > 0 && this.usageAnchorChars === this.streamedChars();
		return current ? reported : this.estimateOutputTokens();
	}

	private streamedChars(): number {
		return this.streamedTextLen + this.streamedThinkLen + this.streamedToolCallLen;
	}

	/**
	 * TPS window: the message's generation phase, i.e. since the first content
	 * delta. Content and clock start at the same instant, so the numerator and the
	 * denominator always cover the same span — a thinking→text switch neither
	 * rewinds the clock nor drops the thinking tokens already counted.
	 */
	private generationStart(): number {
		return this.firstContentTime || this.msgStartTime;
	}

	private elapsedSeconds(now: number): number {
		return Math.max((now - this.generationStart()) / 1000, MIN_ELAPSED_S);
	}

	private estimateOutputTokens(): number {
		return (
			Math.floor(this.streamedThinkLen / THINK_CHARS_PER_TOKEN) +
			Math.floor((this.streamedTextLen + this.streamedToolCallLen) / TEXT_CHARS_PER_TOKEN)
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

	// The dashes lead *and* are colored like the rest of the border (pi's own
	// renderer wraps them in `borderColor`; leaving them raw drops them out of
	// the thinking-level color the editor sets).
	const prefix = leadsWithStatus
		? input.border("── ") + `${status} `
		: statsWidth > 0
			? input.border("─".repeat(LEAD_WIDTH))
			: "";
	const fill = Math.max(
		0,
		input.width - visibleWidth(prefix) - statsWidth - nameBlock,
	);

	return prefix + stats + input.border("─".repeat(fill)) + nameLabel + (nameBlock > 0 ? input.border("─") : "");
}
