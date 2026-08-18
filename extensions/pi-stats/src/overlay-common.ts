import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type StatsOverlayColor = "accent" | "border" | "borderMuted" | "dim" | "muted" | "success" | "warning";

export interface StatsOverlayTheme {
	fg(color: StatsOverlayColor, text: string): string;
	bold(text: string): string;
}

export function cell(value: string, width: number, align: "left" | "right" = "left"): string {
	const truncated = truncateToWidth(value, width, "…");
	const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	return align === "right" ? padding + truncated : truncated + padding;
}

export function line(theme: StatsOverlayTheme, content: string, contentWidth: number): string {
	const truncated = truncateToWidth(content, contentWidth, "…");
	const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
	return theme.fg("border", "│") + " " + truncated + padding + " " + theme.fg("border", "│");
}

export function border(theme: StatsOverlayTheme, position: "top" | "bottom", width: number): string {
	const left = position === "top" ? "╭" : "╰";
	const right = position === "top" ? "╮" : "╯";
	return theme.fg("border", left + "─".repeat(Math.max(0, width - 2)) + right);
}

export function formatTimestamp(timestamp: number, variant: "long" | "short" = "long"): string {
	if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
	const date = new Date(timestamp * 1000);
	const day = `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
	if (variant === "short") return day;
	return `${day} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

export function pad2(value: number): string {
	return String(value).padStart(2, "0");
}

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
