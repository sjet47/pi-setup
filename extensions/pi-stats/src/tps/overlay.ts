import { fuzzyFilter, Input, Key, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable } from "@earendil-works/pi-tui";
import { border as borderText, cell as cellText, clamp, formatTimestamp, line as lineText, pad2, type StatsOverlayTheme } from "../overlay-common";
import type { ModelTpsSummary, ThinkingLevelSummary, TpsScale, TpsTrendPoint, TpsTrendResult } from "./types";

const VISIBLE_ROWS = 14;
const SCALES: TpsScale[] = ["hour", "4h", "day", "week"];
const DEFAULT_TREND_METRIC = 2; // tps
const TREND_METRICS: { key: "n" | "ttft" | "tps" | "think"; value: (point: TpsTrendPoint) => number }[] = [
  { key: "n", value: (point) => point.samples },
  { key: "ttft", value: (point) => point.avgTtftMs },
  { key: "tps", value: (point) => point.avgTps },
  { key: "think", value: (point) => point.avgThinkingTokens },
];

type OverlayMode = "list" | "detail";

export class TpsStatsOverlay implements Component, Focusable {
  private readonly searchInput = new Input();
  private readonly trendCache = new Map<string, TpsTrendResult>();
  private cachedWidth?: number;
  private cachedLines?: string[];
  private _focused = false;
  private selectedIndex = 0;
  private windowStart = 0;
  private trendWindowStart = 0;
  private mode: OverlayMode = "list";
  private scale: TpsScale = "hour";
  private metricIndex = DEFAULT_TREND_METRIC;

  constructor(
    private readonly rows: ModelTpsSummary[],
    private readonly theme: StatsOverlayTheme,
    private readonly onClose: () => void,
    private readonly getTrend: (provider: string, model: string, scale: TpsScale) => TpsTrendResult,
  ) {
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

  shouldCloseOnEscape(): boolean {
    return this.mode === "list";
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
      if (matchesKey(data, Key.tab)) {
        this.cycleScale(1);
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        this.cycleScale(-1);
        return;
      }
      // Digit keys pick which column the trend bar follows.
      if (data.length === 1 && data >= "0" && data <= String(TREND_METRICS.length - 1)) {
        this.setTrendMetric(Number(data));
        return;
      }
      // ←/→ page the trend: newer buckets sit at the top, so left pages
      // toward older samples and right snaps back toward the newest page.
      if (matchesKey(data, Key.left)) {
        this.moveTrendWindow(VISIBLE_ROWS);
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.moveTrendWindow(-VISIBLE_ROWS);
        return;
      }
      if (matchesKey(data, Key.up)) {
        this.moveTrendWindow(-1);
        return;
      }
      if (matchesKey(data, Key.down)) {
        this.moveTrendWindow(1);
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
    if (width < 4) return [truncateToWidth("tps-stats", Math.max(0, width), "")];
    const safeWidth = width;
    if (this.cachedWidth === safeWidth && this.cachedLines) return this.cachedLines;

    const contentWidth = Math.max(0, safeWidth - 4);
    const lines = this.mode === "detail"
      ? this.renderDetail(safeWidth, contentWidth)
      : this.renderList(safeWidth, contentWidth);
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
    const query = this.searchInput.getValue().trim();
    const filtered = this.filteredRows();
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, filtered.length - 1));
    this.windowStart = clamp(this.windowStart, 0, Math.max(0, filtered.length - VISIBLE_ROWS));
    const visible = filtered.slice(this.windowStart, this.windowStart + VISIBLE_ROWS);
    const summary = query
      ? `${filtered.length}/${this.rows.length} matches for “${query}”`
      : `${this.rows.length} provider/model pairs`;

    const lines = [
      this.border("top", safeWidth),
      this.line(`${this.theme.fg("accent", this.theme.bold("TPS stats"))}  ${this.theme.fg("dim", summary)}`, contentWidth),
      this.line(this.renderSearch(contentWidth), contentWidth),
      this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
    ];

    if (this.rows.length === 0) {
      lines.push(this.line(this.theme.fg("muted", "No TPS samples recorded yet."), contentWidth));
      lines.push(this.line(this.theme.fg("muted", "Stats start collecting from the next model call."), contentWidth));
    } else if (visible.length === 0) {
      lines.push(this.line(this.theme.fg("warning", "No matching provider/model rows."), contentWidth));
    } else {
      lines.push(...this.renderTable(visible, contentWidth));
    }

    lines.push(
      this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
      this.line(this.theme.fg("dim", "↑/↓ select · Enter trend · Type to search · Esc close"), contentWidth),
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
    const trend = this.trendFor(row.provider, row.model);
    // Newest bucket first: windowStart 0 shows the latest page and grows
    // toward the past.
    const descending = [...trend.points].reverse();
    this.trendWindowStart = clamp(this.trendWindowStart, 0, Math.max(0, descending.length - VISIBLE_ROWS));
    const visible = descending.slice(this.trendWindowStart, this.trendWindowStart + VISIBLE_ROWS);
    const metric = TREND_METRICS[this.metricIndex];
    const maxValue = Math.max(1, ...trend.points.map((point) => metric.value(point)));
    const bucketWidth = 17;
    const samplesWidth = 5;
    const ttftWidth = 9;
    const tpsWidth = 9;
    const thinkWidth = 9;
    const barWidth = Math.max(4, contentWidth - bucketWidth - samplesWidth - ttftWidth - tpsWidth - thinkWidth - 15);

    const lines = [
      this.border("top", safeWidth),
      this.line(
        `${this.theme.fg("accent", this.theme.bold("TPS trend"))}  ${this.theme.fg("dim", `${row.provider} / ${row.model}`)}`,
        contentWidth,
      ),
      this.renderScaleTabs(contentWidth),
      this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
      this.renderTrendHeader(contentWidth, bucketWidth, samplesWidth, ttftWidth, tpsWidth, thinkWidth),
    ];

    if (trend.points.length === 0) {
      lines.push(this.line(this.theme.fg("muted", "No samples in the selected time range."), contentWidth));
    } else {
      for (const point of visible) {
        const filled = Math.max(1, Math.round((metric.value(point) / maxValue) * barWidth));
        const bar = this.theme.fg("success", "█".repeat(filled)) + this.theme.fg("borderMuted", "░".repeat(Math.max(0, barWidth - filled)));
        lines.push(
          this.line(
            `${this.cell(formatBucket(point.bucketStart, this.scale), bucketWidth)} ` +
              `${this.cell(String(point.samples), samplesWidth, "right")} ` +
              `${this.cell(formatTtft(point.avgTtftMs), ttftWidth, "right")} ` +
              `${this.cell(formatTps(point.avgTps), tpsWidth, "right")} ` +
              `${this.cell(formatInt(point.avgThinkingTokens), thinkWidth, "right")} ` +
              bar,
            contentWidth,
          ),
        );
      }
    }

    lines.push(
      this.line(this.theme.fg("borderMuted", "─".repeat(contentWidth)), contentWidth),
      ...this.renderThinkingLevels(trend.thinkingLevels, contentWidth),
      this.line(
        this.theme.fg("dim", `0-3 trend column · Tab/⇧Tab scale · ←/→ page · ↑/↓ scroll · Enter/Esc back`),
        contentWidth,
      ),
      this.border("bottom", safeWidth),
    );
    return lines;
  }

  private renderThinkingLevels(levels: ThinkingLevelSummary[], contentWidth: number): string[] {
    if (levels.length === 0) return [this.line(this.theme.fg("muted", "No thinking-level samples."), contentWidth)];
    const lines = [this.line(this.theme.fg("accent", this.theme.bold("Avg thinking tokens by level")), contentWidth)];
    const levelWidth = Math.max(12, Math.floor(contentWidth * 0.4));
    const samplesWidth = 8;
    const tokensWidth = Math.max(10, contentWidth - levelWidth - samplesWidth - 8);
    const header = `${this.cell("level", levelWidth)} ${this.cell("n", samplesWidth, "right")} ${this.cell("avg tokens", tokensWidth, "right")}`;
    lines.push(this.line(this.theme.fg("borderMuted", header), contentWidth));
    for (const level of levels) {
      lines.push(
        this.line(
          `${this.cell(level.level, levelWidth)} ${this.cell(String(level.samples), samplesWidth, "right")} ${this.cell(formatInt(level.avgThinkingTokens), tokensWidth, "right")}`,
          contentWidth,
        ),
      );
    }
    return lines;
  }

  private renderTrendHeader(
    contentWidth: number,
    bucketWidth: number,
    samplesWidth: number,
    ttftWidth: number,
    tpsWidth: number,
    thinkWidth: number,
  ): string {
    const active = TREND_METRICS[this.metricIndex];
    const header =
      this.cell(this.theme.fg("muted", "bucket"), bucketWidth) + " " +
      this.renderMetricCell(0, samplesWidth, "right") + " " +
      this.renderMetricCell(1, ttftWidth, "right") + " " +
      this.renderMetricCell(2, tpsWidth, "right") + " " +
      this.renderMetricCell(3, thinkWidth, "right") + " " +
      this.theme.fg("accent", this.theme.bold(`· ${active.key}`)) + this.theme.fg("muted", " ▸");
    return this.line(header, contentWidth);
  }

  private renderMetricCell(index: number, width: number, align: "left" | "right"): string {
    const meta = TREND_METRICS[index];
    const label = `${meta.key}[${index}]`;
    const styled = index === this.metricIndex
      ? this.theme.fg("accent", this.theme.bold(label))
      : this.theme.fg("muted", label);
    return this.cell(styled, width, align);
  }

  private renderScaleTabs(contentWidth: number): string {
    const labels = SCALES.map((scale) => this.scale === scale
      ? this.theme.fg("accent", `[${scale}]`)
      : this.theme.fg("muted", scale));
    const line = `${this.theme.fg("dim", "Scale:")} ${labels.join("  ")}`;
    return this.line(line, contentWidth);
  }

  private renderSearch(contentWidth: number): string {
    const label = this.theme.fg("muted", "Search: ");
    const inputWidth = Math.max(8, contentWidth - visibleWidth("Search: "));
    const renderedInput = this.searchInput.render(inputWidth)[0] ?? "";
    return label + renderedInput;
  }

  private renderTable(rows: ModelTpsSummary[], contentWidth: number): string[] {
    const samplesWidth = 6;
    const tpsWidth = 9;
    const lastWidth = Math.max(10, Math.min(19, Math.floor(contentWidth * 0.16)));
    const fixedWidth = 2 + 12 + samplesWidth + tpsWidth + lastWidth;
    const available = Math.max(22, contentWidth - fixedWidth);
    const providerWidth = Math.max(10, Math.floor(available * 0.4));
    const modelWidth = Math.max(12, available - providerWidth);

    const header = this.cell("", 2) +
      this.cell("provider", providerWidth) +
      " │ " + this.cell("model", modelWidth) +
      " │ " + this.cell("n", samplesWidth, "right") +
      " │ " + this.cell("avg tps", tpsWidth, "right") +
      " │ " + this.cell("last seen", lastWidth);
    const rule = [2 + providerWidth, modelWidth, samplesWidth, tpsWidth, lastWidth]
      .map((columnWidth) => "─".repeat(columnWidth))
      .join("─┼─");

    const lines = [
      this.line(this.theme.fg("accent", this.theme.bold(header)), contentWidth),
      this.line(this.theme.fg("borderMuted", rule), contentWidth),
    ];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const marker = this.windowStart + index === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
      const values = this.cell(marker, 2) +
        this.cell(truncate(row.provider, providerWidth), providerWidth) +
        " │ " + this.cell(truncate(row.model, modelWidth), modelWidth) +
        " │ " + this.cell(String(row.samples), samplesWidth, "right") +
        " │ " + this.cell(formatTps(row.avgTps), tpsWidth, "right") +
        " │ " + this.cell(formatTimestamp(row.lastSeen, lastWidth <= 16 ? "short" : "long"), lastWidth);
      lines.push(this.line(values, contentWidth));
    }
    return lines;
  }

  private cycleScale(delta: number): void {
    const current = SCALES.indexOf(this.scale);
    this.scale = SCALES[clamp(current + delta, 0, SCALES.length - 1)];
    this.trendWindowStart = 0;
    this.invalidate();
  }

  private setTrendMetric(index: number): void {
    if (!TREND_METRICS[index] || index === this.metricIndex) return;
    // Keep the current trend window: switching the column must not jump the
    // bucket list back to the newest page.
    this.metricIndex = index;
    this.invalidate();
  }

  private moveSelection(delta: number): void {
    const rows = this.filteredRows();
    if (rows.length === 0) return;
    this.selectedIndex = clamp(this.selectedIndex + delta, 0, rows.length - 1);
    if (this.selectedIndex < this.windowStart) this.windowStart = this.selectedIndex;
    if (this.selectedIndex >= this.windowStart + VISIBLE_ROWS) this.windowStart = this.selectedIndex - VISIBLE_ROWS + 1;
    this.invalidate();
  }

  private moveTrendWindow(delta: number): void {
    const trend = this.trendFor(this.selectedRow()?.provider ?? "", this.selectedRow()?.model ?? "");
    this.trendWindowStart = clamp(this.trendWindowStart + delta, 0, Math.max(0, trend.points.length - VISIBLE_ROWS));
    this.invalidate();
  }

  private openSelected(): void {
    if (!this.selectedRow()) return;
    this.mode = "detail";
    this.trendWindowStart = 0;
    this.searchInput.focused = false;
    this.invalidate();
  }

  private selectedRow(): ModelTpsSummary | undefined {
    return this.filteredRows()[this.selectedIndex];
  }

  private filteredRows(): ModelTpsSummary[] {
    const query = this.searchInput.getValue().trim();
    if (!query) return this.rows;
    return fuzzyFilter(this.rows, query, (row) => `${row.provider} ${row.model}`);
  }

  private trendFor(provider: string, model: string): TpsTrendResult {
    const key = `${provider}\u0000${model}\u0000${this.scale}`;
    const cached = this.trendCache.get(key);
    if (cached) return cached;
    let trend: TpsTrendResult;
    try {
      trend = this.getTrend(provider, model, this.scale);
    } catch {
      trend = { points: [], thinkingLevels: [] };
    }
    this.trendCache.set(key, trend);
    return trend;
  }

  private cell(value: string, width: number, align: "left" | "right" = "left"): string {
    return cellText(value, width, align);
  }

  private line(content: string, contentWidth: number): string {
    return lineText(this.theme, content, contentWidth);
  }

  private border(position: "top" | "bottom", width: number): string {
    return borderText(this.theme, position, width);
  }
}

function formatTps(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  if (value >= 100) return value.toFixed(0);
  return value.toFixed(1);
}

function formatTtft(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function formatInt(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return Math.round(value).toString();
}

function formatBucket(timestamp: number, scale: TpsScale): string {
  const date = new Date(timestamp);
  if (scale === "hour" || scale === "4h") {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:00`;
  }
  if (scale === "week") {
    const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
    const end = new Date(date.getTime() + 6 * 24 * 60 * 60 * 1000);
    return `${day} ~ ${end.getFullYear()}-${pad2(end.getMonth() + 1)}-${pad2(end.getDate())}`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, Math.max(0, width - 1))}…`;
}
