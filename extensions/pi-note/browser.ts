// The `/memory` browser overlay: a two-level view over one project's memory
// dir. Level 1 lists the MEMORY.md topics (title + hook) and filters them by
// fuzzy search; Enter opens the linked file rendered as markdown, ESC goes
// back to the list, ESC again closes. Ctrl+D twice deletes the selected
// memory; in the detail view Enter opens the file in the external editor.
//
// Sizing note: a pi overlay clips a component's lines to `maxHeight` by
// slicing from the top, and `ScrollView` only scrolls when the layout system
// drives it (tui.js resolveOverlayLayout / ScrollView.updateLayout). So this
// component never relies on either: it renders exactly `overlayHeight(rows)`
// lines and scrolls its own body by slicing an array.
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	Markdown,
	fuzzyFilter,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type Focusable,
	type Keybindings,
	type KeyId,
	type MarkdownTheme,
} from "@earendil-works/pi-tui";
import { topicMatchText, type MemoryTopic } from "./memory-index.ts";
import { byteLength, formatBytes, resolveInside, type MemoryBody, type MemoryMutationResult } from "./memory-store.ts";

/** Width of the selection cursor prefix (`› `). */
const CURSOR_WIDTH = 2;
/** Keep at least this much room for the title before showing the meta column. */
const MIN_TITLE_WIDTH = 10;

/** Lines that are never part of the scrolling body: 3 above, 4 below. */
export const CHROME_LINES = 7;
/** Chrome in the detail view: `CHROME_LINES` plus the absolute-path row. */
export const DETAIL_CHROME_LINES = CHROME_LINES + 1;
const MAX_OVERLAY_HEIGHT = 34;
const DELETE_KEY: KeyId = Key.ctrl("d");

/** Total overlay height in rows for a terminal `terminalRows` rows tall. */
export function overlayHeight(terminalRows: number): number {
	const wanted = Math.floor(terminalRows * 0.78);
	const available = Math.max(CHROME_LINES + 1, terminalRows - 2);
	return Math.max(CHROME_LINES + 1, Math.min(wanted, MAX_OVERLAY_HEIGHT, available));
}

type Row = { kind: "section"; label: string } | { kind: "topic"; topic: MemoryTopic };

interface DetailState {
	topic: MemoryTopic;
	body: MemoryBody;
	/** UTF-8 size, shown in the header. */
	bytes: number;
	scrollTop: number;
	/** markdown lines, cached for `linesWidth` */
	lines: string[];
	linesWidth: number;
}

export interface MemoryBrowserOptions {
	topics: MemoryTopic[];
	/** Header label for the memory dir, e.g. `home/sjet/repo/pi-setup`. */
	label: string;
	/** Absolute memory dir, used for the detail path row. */
	memoryDir: string;
	/** Live terminal height, so the overlay follows a resize. */
	terminalRows: () => number;
	/** Live clock, so the relative ages are testable and never frozen at open. */
	now: () => number;
	theme: Theme;
	markdownTheme: MarkdownTheme;
	keybindings: KeybindingsManager;
	readBody: (topic: MemoryTopic) => MemoryBody;
	/** Re-read MEMORY.md + the dir listing after a delete or an edit. */
	reloadTopics: () => MemoryTopic[];
	/** Remove the file and its MEMORY.md line. */
	deleteTopic: (topic: MemoryTopic) => MemoryMutationResult;
	/** Hand the file to the external editor; resolves with an error, or undefined. */
	editFile: (topic: MemoryTopic) => Promise<string | undefined>;
	/** Render again after an async editor round trip. */
	requestRender: () => void;
	onDone: () => void;
}

interface Notice {
	text: string;
	level: "dim" | "warning" | "error";
}

export class MemoryBrowserOverlay implements Component, Focusable {
	private readonly searchInput = new Input({
		prompt: "",
		placeholder: "type to filter",
		placeholderStyle: (text) => this.options.theme.fg("dim", text),
	});
	private topics: MemoryTopic[];
	private level: "list" | "detail" = "list";
	private detail?: DetailState;
	private selectedIndex = 0;
	private windowStart = 0;
	/** Set by the first Ctrl+D; the second one deletes. Any other key clears it. */
	private pendingDelete?: MemoryTopic;
	/** Transient message in the hint row (delete/editor outcome), cleared on input. */
	private notice?: Notice;
	/** An editor round trip is in flight; ignore a second Enter. */
	private editing = false;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;

	constructor(private readonly options: MemoryBrowserOptions) {
		this.topics = options.topics;
		this.searchInput.onSubmit = () => this.openSelected();
		this.searchInput.onEscape = () => this.options.onDone();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	handleInput(data: string): void {
		if (this.notice !== undefined) {
			this.notice = undefined;
			this.invalidate();
		}
		if (this.level === "detail") this.handleDetailInput(data);
		else this.handleListInput(data);
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth(" Memory", Math.max(0, width), "")];
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;

		const contentWidth = Math.max(1, width - 2);
		const bodyHeight = this.bodyHeight();
		const detailLines = this.level === "detail" ? this.detailLines(contentWidth) : [];
		const body = this.level === "detail"
			? this.detailBody(contentWidth, bodyHeight)
			: this.listBody(contentWidth, bodyHeight);
		const pathRow = this.showPathRow()
			? [this.line(this.detailPathLine(contentWidth), contentWidth)]
			: [];
		const lines = [
			this.border("top", width),
			this.line(this.headerLine(contentWidth, detailLines.length), contentWidth),
			...pathRow,
			this.separator(contentWidth),
			...body.map((line) => this.line(line, contentWidth)),
			this.separator(contentWidth),
			this.line(this.statusLine(contentWidth, detailLines.length), contentWidth),
			this.line(this.hintLine(), contentWidth),
			this.border("bottom", width),
		];
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.searchInput.invalidate();
	}

	// === input ============================================================

	private handleListInput(data: string): void {
		if (this.isCancel(data)) {
			this.pendingDelete = undefined;
			this.options.onDone();
			return;
		}
		// Ctrl+D arms the delete; the next Ctrl+D on the same row pulls the
		// trigger. Any other key disarms it, whether or not it also acts.
		if (matchesKey(data, DELETE_KEY)) {
			this.deleteSelected();
			return;
		}
		if (this.pendingDelete !== undefined) {
			this.pendingDelete = undefined;
			this.invalidate();
		}
		if (this.matches(data, "tui.select.up", Key.up)) return this.moveSelection(-1);
		if (this.matches(data, "tui.select.down", Key.down)) return this.moveSelection(1);
		if (this.matches(data, "tui.select.pageUp", Key.pageUp)) {
			return this.moveSelection(-Math.max(1, this.bodyHeight() - 1));
		}
		if (this.matches(data, "tui.select.pageDown", Key.pageDown)) {
			return this.moveSelection(Math.max(1, this.bodyHeight() - 1));
		}
		if (matchesKey(data, Key.home)) return this.selectEdge(false);
		if (matchesKey(data, Key.end)) return this.selectEdge(true);
		if (this.matches(data, "tui.select.confirm", Key.enter)) {
			this.openSelected();
			return;
		}

		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (before !== this.searchInput.getValue()) {
			// Best match first: fuzzyFilter sorts by score.
			this.selectedIndex = 0;
			this.windowStart = 0;
			this.ensureVisible();
			this.invalidate();
		}
	}

	private handleDetailInput(data: string): void {
		// Ctrl+C closes the browser from either level; ESC only steps back.
		if (matchesKey(data, Key.ctrl("c"))) {
			this.options.onDone();
			return;
		}
		if (this.isCancel(data)) {
			this.level = "list";
			this.detail = undefined;
			this.invalidate();
			return;
		}
		if (this.matches(data, "tui.select.confirm", Key.enter)) {
			void this.editSelected();
			return;
		}
		const page = Math.max(1, this.bodyHeight() - 1);
		if (matchesKey(data, Key.up)) this.scrollBy(-1);
		else if (matchesKey(data, Key.down)) this.scrollBy(1);
		else if (matchesKey(data, Key.pageUp)) this.scrollBy(-page);
		else if (matchesKey(data, Key.pageDown)) this.scrollBy(page);
		else if (matchesKey(data, Key.home)) this.scrollTo(0);
		else if (matchesKey(data, Key.end)) this.scrollTo(Number.MAX_SAFE_INTEGER);
	}

	private isCancel(data: string): boolean {
		return (
			this.options.keybindings.matches(data, "tui.select.cancel") ||
			matchesKey(data, Key.escape)
		);
	}

	/** Keybinding id or literal key — either one triggers the action. */
	private matches(data: string, binding: keyof Keybindings, key: KeyId): boolean {
		return this.options.keybindings.matches(data, binding) || matchesKey(data, key);
	}

	// === navigation =======================================================

	private openSelected(): void {
		const row = this.rows()[this.selectedIndex];
		if (!row || row.kind !== "topic") return;
		const body = this.options.readBody(row.topic);
		this.detail = {
			topic: row.topic,
			body,
			bytes: body.ok ? byteLength(body.text) : 0,
			scrollTop: 0,
			lines: [],
			linesWidth: 0,
		};
		this.level = "detail";
		this.invalidate();
	}

	/**
	 * Two-step delete from the list. The first Ctrl+D only arms the row; the
	 * second removes the file and its MEMORY.md line, then re-reads both from
	 * disk so the list can never disagree with what is on disk.
	 */
	private deleteSelected(): void {
		const row = this.rows()[this.selectedIndex];
		if (!row || row.kind !== "topic") return;
		if (this.pendingDelete?.file !== row.topic.file) {
			this.pendingDelete = row.topic;
			this.invalidate();
			return;
		}
		this.pendingDelete = undefined;
		const result = this.options.deleteTopic(row.topic);
		this.notice = result.ok
			? { text: `Deleted ${row.topic.file}`, level: "dim" }
			: { text: `Delete failed — ${result.error}`, level: "error" };
		this.refreshTopics();
		this.invalidate();
	}

	/**
	 * Enter in the detail view hands the file to the external editor (the same
	 * Ctrl+G editor pi uses), then re-reads the file: the editor writes it behind
	 * the overlay's back, so the rendered body would otherwise be stale.
	 */
	private async editSelected(): Promise<void> {
		const detail = this.detail;
		if (!detail || this.editing) return;
		if (!detail.body.ok) {
			this.notice = { text: `${detail.topic.file} — ${detail.body.error}`, level: "warning" };
			this.invalidate();
			return;
		}
		this.editing = true;
		const file = detail.topic.file;
		let error: string | undefined;
		try {
			error = await this.options.editFile(detail.topic);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			this.editing = false;
		}
		this.notice = error === undefined ? undefined : { text: `Editor failed — ${error}`, level: "error" };
		this.refreshTopics(file);
		const fresh = this.topics.find((topic) => topic.file === file);
		if (fresh) detail.topic = fresh;
		const body = this.options.readBody(detail.topic);
		detail.body = body;
		detail.bytes = body.ok ? byteLength(body.text) : 0;
		detail.lines = [];
		detail.linesWidth = 0;
		this.invalidate();
		this.options.requestRender();
	}

	/**
	 * Swap in a fresh topic list after a mutation, keeping the cursor on
	 * `preferredFile` when it still exists and on the nearest row when it does
	 * not (the row that slid into the deleted one's place).
	 */
	private refreshTopics(preferredFile?: string): void {
		this.topics = this.options.reloadTopics();
		const rows = this.rows();
		const positions = this.selectableRows(rows);
		if (positions.length === 0) {
			this.selectedIndex = 0;
			this.windowStart = 0;
			return;
		}
		const preferred = preferredFile === undefined
			? -1
			: positions.findIndex((index) => {
				const row = rows[index];
				return row.kind === "topic" && row.topic.file === preferredFile;
			});
		if (preferred >= 0) {
			this.selectedIndex = positions[preferred];
		} else {
			this.selectedIndex =
				positions.find((index) => index >= this.selectedIndex) ?? positions[positions.length - 1];
		}
		this.windowStart = Math.min(this.windowStart, Math.max(0, rows.length - 1));
		this.ensureVisible(rows);
	}

	private scrollBy(delta: number): void {
		if (!this.detail) return;
		this.detail.scrollTop += delta;
		this.invalidate();
	}

	private scrollTo(position: number): void {
		if (!this.detail) return;
		this.detail.scrollTop = position;
		this.invalidate();
	}

	private moveSelection(delta: number): void {
		const positions = this.selectableRows();
		if (positions.length === 0) return;
		const current = positions.indexOf(this.selectedIndex);
		const next = current < 0 ? 0 : clamp(current + delta, 0, positions.length - 1);
		this.selectedIndex = positions[next];
		this.ensureVisible();
		this.invalidate();
	}

	private selectEdge(last: boolean): void {
		const positions = this.selectableRows();
		if (positions.length === 0) return;
		this.selectedIndex = last ? positions[positions.length - 1] : positions[0];
		this.ensureVisible();
		this.invalidate();
	}

	/** Indices of the rows the cursor may land on (section rows are skipped). */
	private selectableRows(rows: Row[] = this.rows()): number[] {
		const positions: number[] = [];
		rows.forEach((row, index) => {
			if (row.kind === "topic") positions.push(index);
		});
		return positions;
	}

	/**
	 * Rolling window: the selected row is scrolled into view, never leaving a
	 * section header dangling as the last visible line.
	 */
	private ensureVisible(rows: Row[] = this.rows(), bodyHeight = this.bodyHeight()): void {
		if (rows.length === 0) {
			this.selectedIndex = 0;
			this.windowStart = 0;
			return;
		}
		let start = clamp(this.windowStart, 0, rows.length - 1);
		if (start > this.selectedIndex) start = this.selectedIndex;
		while (start < this.selectedIndex && this.rowsHeight(rows, start, this.selectedIndex + 1) > bodyHeight) {
			start += 1;
		}
		this.windowStart = start;
	}

	private rowsHeight(rows: Row[], from: number, toExclusive: number): number {
		let total = 0;
		for (let index = from; index < toExclusive; index += 1) {
			const row = rows[index];
			if (row.kind === "section") {
				total += 1;
				continue;
			}
			total += row.topic.hook === "" ? 1 : 2;
		}
		return total;
	}

	// === rows =============================================================

	private rows(): Row[] {
		const query = this.searchInput.getValue().trim();
		const topics = query
			? fuzzyFilter(this.topics, query, topicMatchText)
			: this.topics;
		const rows: Row[] = topics
			.filter((topic) => topic.indexed)
			.map((topic) => ({ kind: "topic", topic }));
		const orphans = topics.filter((topic) => !topic.indexed);
		if (orphans.length > 0) {
			rows.push({ kind: "section", label: `unindexed (${orphans.length})` });
			for (const topic of orphans) rows.push({ kind: "topic", topic });
		}
		return rows;
	}

	// === body =============================================================

	private bodyHeight(): number {
		return Math.max(1, this.overlayHeight() - this.chromeLines());
	}

	private overlayHeight(): number {
		return overlayHeight(this.options.terminalRows());
	}

	/** The path row is dropped (and the body keeps its line) on a tiny terminal. */
	private showPathRow(): boolean {
		return this.level === "detail" && this.overlayHeight() >= DETAIL_CHROME_LINES + 1;
	}

	private chromeLines(): number {
		return this.showPathRow() ? DETAIL_CHROME_LINES : CHROME_LINES;
	}

	private detailPathLine(contentWidth: number): string {
		const path = this.detailPath();
		// Keep the tail: the file name (and the project slug) is the part that
		// distinguishes a memory; the home prefix is the part worth losing.
		return this.options.theme.fg("dim", ` ${truncateFromStart(path, Math.max(1, contentWidth - 1))}`);
	}

	/** Absolute path of the open memory; the raw link target when it is unsafe. */
	private detailPath(): string {
		const detail = this.detail;
		if (!detail) return "";
		return resolveInside(this.options.memoryDir, detail.topic.file) ?? detail.topic.file;
	}

	private listBody(contentWidth: number, bodyHeight: number): string[] {
		const theme = this.options.theme;
		const rows = this.rows();
		if (rows.length === 0) {
			const message = this.topics.length === 0
				? "no memories yet"
				: `no topic matches “${this.searchInput.getValue().trim()}”`;
			return pad([theme.fg("muted", `  ${message}`)], bodyHeight);
		}
		this.ensureVisible(rows, bodyHeight);
		const body: string[] = [];
		for (let index = this.windowStart; index < rows.length && body.length < bodyHeight; index += 1) {
			const row = rows[index];
			if (row.kind === "section") {
				body.push(this.sectionLine(row, contentWidth));
				continue;
			}
			body.push(this.topicLine(row.topic, index === this.selectedIndex, contentWidth));
			if (body.length < bodyHeight && row.topic.hook !== "") {
				body.push(this.hookLine(row.topic.hook));
			}
		}
		return pad(body, bodyHeight);
	}

	private detailBody(contentWidth: number, bodyHeight: number): string[] {
		const theme = this.options.theme;
		const detail = this.detail;
		if (!detail) return pad([], bodyHeight);
		if (!detail.body.ok) {
			const message = `${detail.topic.file} — ${detail.body.error}`;
			const lines = wrapTextWithAnsi(message, contentWidth).map((line) => theme.fg("warning", line));
			return pad(["", ...lines], bodyHeight);
		}
		const all = this.detailLines(contentWidth);
		const maxScroll = Math.max(0, all.length - bodyHeight);
		detail.scrollTop = clamp(detail.scrollTop, 0, maxScroll);
		return pad(all.slice(detail.scrollTop, detail.scrollTop + bodyHeight), bodyHeight);
	}
	/** Markdown lines for the detail view, cached per width. */
	private detailLines(contentWidth: number): string[] {
		const detail = this.detail;
		if (!detail || !detail.body.ok) return [];
		if (detail.linesWidth === contentWidth) return detail.lines;
		const markdown = new Markdown(detail.body.text, 0, 0, this.options.markdownTheme);
		detail.lines = markdown.render(Math.max(1, contentWidth));
		detail.linesWidth = contentWidth;
		return detail.lines;
	}

	/**
	 * Title row: cursor + title on the left, `size · age` right-aligned. The meta
	 * column is dropped on a narrow overlay so the title keeps enough room; a
	 * missing file takes the column over with a `missing` marker (it has no
	 * size/age to show).
	 */
	private topicLine(topic: MemoryTopic, selected: boolean, contentWidth: number): string {
		const theme = this.options.theme;
		const pending = this.pendingDelete?.file === topic.file;
		const cursor = selected ? theme.fg("accent", "› ") : "  ";
		let meta = this.topicMeta(topic);
		// Narrow overlay: the title wins over the meta column.
		if (visibleWidth(meta) > contentWidth - CURSOR_WIDTH - MIN_TITLE_WIDTH) meta = "";
		const metaWidth = visibleWidth(meta);
		const titleWidth = Math.max(1, contentWidth - CURSOR_WIDTH - metaWidth - (metaWidth > 0 ? 2 : 0));
		// Truncate before styling: keep the width math free of ANSI nesting.
		const clipped = truncateToWidth(topic.title, titleWidth, "…");
		const title = pending
			? theme.fg("warning", theme.bold(clipped))
			: selected
				? theme.fg("accent", theme.bold(clipped))
				: clipped;
		const gap = Math.max(1, contentWidth - CURSOR_WIDTH - visibleWidth(title) - metaWidth);
		return `${cursor}${title}${meta === "" ? "" : " ".repeat(gap) + meta}`;
	}

	/** Right-hand meta column text, already styled; "" when there is nothing to show. */
	private topicMeta(topic: MemoryTopic): string {
		const theme = this.options.theme;
		if (!topic.exists) return theme.fg("warning", "missing");
		if (topic.size === undefined || topic.mtimeMs === undefined) return "";
		const text = `${formatBytes(topic.size)} · ${formatAge(topic.mtimeMs, this.options.now())}`;
		return theme.fg("dim", text);
	}

	private hookLine(hook: string): string {
		return `    ${this.options.theme.fg("dim", hook)}`;
	}

	private sectionLine(row: Extract<Row, { kind: "section" }>, contentWidth: number): string {
		const label = ` ${row.label} `;
		const fill = Math.max(0, contentWidth - visibleWidth(label) - 2);
		return this.options.theme.fg("borderMuted", `──${label}${"─".repeat(fill)}`);
	}

	// === chrome ===========================================================

	private headerLine(contentWidth: number, detailTotal: number): string {
		const theme = this.options.theme;
		if (this.level === "detail" && this.detail) {
			const detail = this.detail;
			const right = detail.body.ok
				? `${plural(detailTotal, "line")} · ${formatBytes(detail.bytes)}`
				: detail.body.error;
			return titlePair(theme.fg("accent", theme.bold(detail.topic.title)), theme.fg("dim", right), contentWidth);
		}
		const orphans = this.topics.filter((topic) => !topic.indexed).length;
		const counts = [
			plural(this.topics.length - orphans, "topic"),
			orphans > 0 ? `${orphans} unindexed` : "",
		].filter(Boolean).join(" · ");
		return titlePair(
			theme.fg("accent", theme.bold(`Memory · ${this.options.label}`)),
			theme.fg("dim", counts),
			contentWidth,
		);
	}

	private statusLine(contentWidth: number, detailTotal: number): string {
		const theme = this.options.theme;
		if (this.level === "detail" && this.detail) {
			const detail = this.detail;
			if (!detail.body.ok || detailTotal === 0) return theme.fg("muted", " —");
			const bodyHeight = this.bodyHeight();
			const first = detail.scrollTop + 1;
			const last = Math.min(detailTotal, detail.scrollTop + bodyHeight);
			return theme.fg("muted", ` lines ${first}-${last} of ${detailTotal}`);
		}
		const counts = truncateToWidth(this.matchSummary(), Math.max(0, Math.floor(contentWidth / 3)), "");
		const label = " Search: ";
		const inputWidth = Math.max(1, contentWidth - visibleWidth(label) - visibleWidth(counts));
		const input = this.searchInput.render(inputWidth)[0] ?? "";
		return `${theme.fg("muted", label)}${input}${theme.fg("dim", counts)}`;
	}

	private matchSummary(): string {
		const query = this.searchInput.getValue().trim();
		if (query === "") return plural(this.topics.length, "topic");
		const matches = this.rows().filter((row) => row.kind === "topic").length;
		return `${matches}/${this.topics.length} matches`;
	}

	private hintLine(): string {
		const theme = this.options.theme;
		if (this.pendingDelete !== undefined) {
			const title = truncateToWidth(this.pendingDelete.title, 40, "…");
			return theme.fg("warning", ` Ctrl+D again to delete “${title}” · any other key cancels`);
		}
		if (this.notice !== undefined) {
			const level = this.notice.level === "dim" ? "muted" : this.notice.level;
			return theme.fg(level, ` ${this.notice.text}`);
		}
		const hint = this.level === "detail"
			? "↑↓ scroll · PgUp/PgDn page · Enter edit · Esc back"
			: "↑↓ navigate · Enter open · Ctrl+D delete · Esc close";
		return theme.fg("dim", ` ${hint}`);
	}

	private line(content: string, contentWidth: number): string {
		const clipped = truncateToWidth(content, contentWidth, "...");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)));
		return this.options.theme.fg("border", "│") + clipped + padding + this.options.theme.fg("border", "│");
	}

	/**
	 * Horizontal rule between the header/footer and the body. Only the dashes are
	 * muted: the two frame cells must come from `line()`, or the vertical border
	 * gets a dark notch at every separator row (it did, colored borderMuted).
	 */
	private separator(contentWidth: number): string {
		return this.line(this.options.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth);
	}

	private border(position: "top" | "bottom", width: number): string {
		const [left, right] = position === "top" ? ["╭", "╮"] : ["╰", "╯"];
		return this.options.theme.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
	}
}

/**
 * Compact age of a memory: `now` / `5m` / `3h` / `12d` / `8mo` / `2y`. Relative
 * rather than absolute because the point of the column is spotting a memory
 * nobody has touched in months — `8mo` reads at a glance, `2025-01-07` does not.
 * A future mtime (clock skew, restored backup) clamps to `now`.
 */
export function formatAge(mtimeMs: number, nowMs: number): string {
	const elapsed = Math.max(0, nowMs - mtimeMs);
	const minutes = Math.floor(elapsed / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const years = Math.floor(days / 365);
	// 360-364 days is still "12mo": switching to years there would print "0y".
	return years < 1 ? `${Math.floor(days / 30)}mo` : `${years}y`;
}

/** `1 topic` / `2 topics` — 0 takes the plural form. */
function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Truncate path-like text from the left: `…/slug/memory.md`. The tail carries the
 * file name, which is what identifies the memory; the home prefix is the part
 * worth losing on a narrow overlay.
 */
export function truncateFromStart(text: string, width: number, ellipsis = "…"): string {
	if (visibleWidth(text) <= width) return text;
	const budget = Math.max(0, width - visibleWidth(ellipsis));
	let tail = "";
	const characters = [...text];
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		const candidate = characters[index] + tail;
		if (visibleWidth(candidate) > budget) break;
		tail = candidate;
	}
	return ellipsis + tail;
}

/** Body lines exactly `height` long: extra lines dropped, short ones padded. */
function pad(lines: string[], height: number): string[] {
	if (lines.length >= height) return lines.slice(0, height);
	return [...lines, ...Array.from({ length: height - lines.length }, () => "")];
}

function titlePair(left: string, right: string, width: number): string {
	const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
	return `${left}${" ".repeat(gap)}${right}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
