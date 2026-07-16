import type { Component, Focusable } from "@earendil-works/pi-tui";
import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolUsageAggregate, UsageAggregate, UsageTrendPoint } from "./store";

export type StatsScope = "project" | "all";
export type StatsKind = "skill" | "tool";
type UsageStatsRow = UsageAggregate | ToolUsageAggregate;
type OverlayMode = "list" | "detail";

const VISIBLE_ROWS = 20;

interface SkillStatsTableTheme {
	fg(color: "accent" | "border" | "borderMuted" | "dim" | "muted" | "success" | "warning", text: string): string;
	bold(text: string): string;
}

export class SkillStatsOverlay implements Component, Focusable {
	private readonly searchInput = new Input();
	private readonly trendCache = new Map<string, UsageTrendPoint[]>();
	private cachedWidth?: number;
	private cachedLines?: string[];
	private _focused = false;
	private selectedIndex = 0;
	private windowStart = 0;
	private mode: OverlayMode = "list";

	constructor(
		private readonly rows: UsageStatsRow[],
		private readonly scope: StatsScope,
		private readonly theme: SkillStatsTableTheme,
		initialQuery: string,
		private readonly onClose: () => void,
		private readonly kind: StatsKind = "skill",
		private readonly getTrend: (name: string) => UsageTrendPoint[] = () => [],
	) {
		this.searchInput.setValue(initialQuery);
		this.searchInput.onEscape = onClose;
		this.searchInput.onSubmit = () => this.openSelected();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.mode === "list";
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}
		if (this.mode === "detail") {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
				this.mode = "list";
				this.searchInput.focused = this._focused;
				this.invalidate();
				return;
			}
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.openSelected();
			return;
		}
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		if (this.searchInput.getValue() !== before) {
			this.selectedIndex = 0;
			this.windowStart = 0;
		}
		this.invalidate();
	}

	render(width: number): string[] {
		if (width < 4) return [truncateToWidth(`${this.itemLabel()} stats`, Math.max(0, width), "")];
		const safeWidth = width;
		if (this.cachedWidth === safeWidth && this.cachedLines) return this.cachedLines;

		const contentWidth = Math.max(0, safeWidth - 4);
		const lines = this.mode === "detail" ? this.renderDetail(safeWidth, contentWidth) : this.renderList(safeWidth, contentWidth);
		this.cachedWidth = safeWidth;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.searchInput.invalidate();
	}

	private renderList(safeWidth: number, contentWidth: number): string[] {
		const title = this.scope === "all" ? `${this.itemLabel()} stats · all projects` : `${this.itemLabel()} stats · current project`;
		const query = this.searchInput.getValue().trim();
		const filteredRows = this.filteredRows();
		this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, filteredRows.length - 1));
		this.windowStart = clamp(this.windowStart, Math.max(0, this.selectedIndex - VISIBLE_ROWS + 1), this.selectedIndex);
		this.windowStart = clamp(this.windowStart, 0, Math.max(0, filteredRows.length - VISIBLE_ROWS));
		const rows = filteredRows.slice(this.windowStart, this.windowStart + VISIBLE_ROWS);
		const summary = query
			? `${filteredRows.length}/${this.rows.length} matches for “${query}”`
			: `${this.rows.length} ${this.kind}s recorded`;

		const lines = [
			this.border("top", safeWidth),
			this.line(`${this.theme.fg("accent", this.theme.bold(title))}  ${this.theme.fg("dim", summary)}`, contentWidth),
			this.line(this.renderSearch(contentWidth), contentWidth),
			this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
		];

		if (this.rows.length === 0) {
			lines.push(this.line(this.theme.fg("muted", `No ${this.kind} usage recorded yet.`), contentWidth));
		} else if (rows.length === 0) {
			lines.push(this.line(this.theme.fg("warning", `No matching ${this.kind} names.`), contentWidth));
		} else {
			lines.push(...this.renderTable(rows, contentWidth));
		}

		lines.push(
			this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
			this.line(this.theme.fg("dim", `↑/↓ select · Enter trend · Type to search ${this.kind} · Esc close`), contentWidth),
			this.border("bottom", safeWidth),
		);
		return lines;
	}

	private renderDetail(safeWidth: number, contentWidth: number): string[] {
		const row = this.selectedRow();
		if (!row) {
			this.mode = "list";
			return this.renderList(safeWidth, contentWidth);
		}
		const name = this.rowName(row);
		const trend = this.trendFor(name);
		const maxTotal = Math.max(1, ...trend.map((point) => point.total));
		const countWidth = Math.max(5, String(maxTotal).length);
		const bucketWidth = 10;
		const separatorWidth = 4;
		const barWidth = Math.max(1, contentWidth - bucketWidth - countWidth - separatorWidth);
		const title = `${this.itemLabel()} trend · ${name}`;
		const lines = [
			this.border("top", safeWidth),
			this.line(`${this.theme.fg("accent", this.theme.bold(title))}  ${this.theme.fg("dim", `${row.total} total`)}`, contentWidth),
			this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
		];

		if (trend.length === 0) {
			lines.push(this.line(this.theme.fg("muted", "No historical usage points found."), contentWidth));
		} else {
			for (const point of trend) {
				const filled = Math.max(1, Math.round((point.total / maxTotal) * barWidth));
				const bar = this.theme.fg("success", "█".repeat(filled)) + this.theme.fg("borderMuted", "░".repeat(Math.max(0, barWidth - filled)));
				lines.push(this.line(`${this.cell(point.bucket, bucketWidth)}  ${bar}  ${this.cell(String(point.total), countWidth, "right")}`, contentWidth));
			}
		}

		lines.push(
			this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
			this.line(this.theme.fg("dim", "Enter/Esc back · Ctrl-C close"), contentWidth),
			this.border("bottom", safeWidth),
		);
		return lines;
	}

	private trendFor(name: string): UsageTrendPoint[] {
		const cached = this.trendCache.get(name);
		if (cached) return cached;
		let trend: UsageTrendPoint[];
		try {
			trend = this.getTrend(name);
		} catch {
			trend = [];
		}
		this.trendCache.set(name, trend);
		return trend;
	}

	private renderSearch(contentWidth: number): string {
		const label = this.theme.fg("muted", "Search: ");
		const inputWidth = Math.max(8, contentWidth - visibleWidth("Search: "));
		const renderedInput = this.searchInput.render(inputWidth)[0] ?? "";
		return label + renderedInput;
	}

	private renderTable(rows: UsageStatsRow[], contentWidth: number): string[] {
		const separatorWidth = 3 * 4;
		const totalWidth = 10;
		const minimumNameWidth = 8;
		const minimumLastWidth = 32;
		const availableWidth = Math.max(minimumNameWidth + minimumLastWidth, contentWidth - separatorWidth - 2 - totalWidth);
		const skillWidth = Math.max(minimumNameWidth, Math.floor(availableWidth / 3));
		const lastWidth = Math.max(minimumLastWidth, availableWidth - skillWidth);

		const header = [
			this.cell("", 2),
			this.cell(this.itemLabel(), skillWidth),
			this.cell("Total", totalWidth, "right"),
			this.cell("Last used", lastWidth),
		].join(this.theme.fg("borderMuted", " │ "));
		const rule = [2, skillWidth, totalWidth, lastWidth]
			.map((columnWidth) => this.theme.fg("borderMuted", "─".repeat(columnWidth)))
			.join(this.theme.fg("borderMuted", "─┼─"));

		const lines = [this.line(this.theme.fg("accent", this.theme.bold(header)), contentWidth), this.line(rule, contentWidth)];
		for (let index = 0; index < rows.length; index += 1) {
			const row = rows[index];
			const marker = this.windowStart + index === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
			const values = [
				this.cell(marker, 2),
				this.cell(this.rowName(row), skillWidth),
				this.cell(this.theme.fg("success", String(row.total)), totalWidth, "right"),
				this.cell(formatTimestamp(row.lastUsed, lastWidth <= 32 ? "short" : "long"), lastWidth),
			].join(this.theme.fg("borderMuted", " │ "));
			lines.push(this.line(values, contentWidth));
		}
		return lines;
	}

	private moveSelection(delta: number): void {
		const rows = this.filteredRows();
		if (rows.length === 0) return;
		this.selectedIndex = clamp(this.selectedIndex + delta, 0, rows.length - 1);
		if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex;
		if (this.selectedIndex >= this.windowStart + VISIBLE_ROWS) this.windowStart = this.selectedIndex - VISIBLE_ROWS + 1;
		this.invalidate();
	}

	private openSelected(): void {
		if (!this.selectedRow()) return;
		this.mode = "detail";
		this.searchInput.focused = false;
		this.invalidate();
	}

	private selectedRow(): UsageStatsRow | undefined {
		return this.filteredRows()[this.selectedIndex];
	}

	private filteredRows(): UsageStatsRow[] {
		const query = this.searchInput.getValue().trim();
		return query ? fuzzyFilter(this.rows, query, (row) => this.rowName(row)) : this.rows;
	}

	private itemLabel(): string {
		return this.kind === "tool" ? "Tool" : "Skill";
	}

	private rowName(row: UsageStatsRow): string {
		return this.kind === "tool" ? (row as ToolUsageAggregate).tool : (row as UsageAggregate).skill;
	}

	private cell(value: string, width: number, align: "left" | "right" = "left"): string {
		const truncated = truncateToWidth(value, width, "…");
		const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
		return align === "right" ? padding + truncated : truncated + padding;
	}

	private line(content: string, contentWidth: number): string {
		const truncated = truncateToWidth(content, contentWidth, "…");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
		return this.theme.fg("border", "│") + " " + truncated + padding + " " + this.theme.fg("border", "│");
	}

	private border(position: "top" | "bottom", width: number): string {
		const left = position === "top" ? "╭" : "╰";
		const right = position === "top" ? "╮" : "╯";
		return this.theme.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
	}
}

export function formatTimestamp(timestamp: number, variant: "long" | "short" = "long"): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
	const date = new Date(timestamp * 1000);
	const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
	if (variant === "short") return day;
	return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
