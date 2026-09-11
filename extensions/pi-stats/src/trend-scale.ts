/**
 * Time scales shared by every trend chart in pi-stats. Skill/tool usage and
 * TPS samples bucket their history with the same granularity so a `Tab` press
 * means the same thing in every overlay.
 */
export type TrendScale = "hour" | "4h" | "day" | "week";

export const TREND_SCALES: TrendScale[] = ["hour", "4h", "day", "week"];
