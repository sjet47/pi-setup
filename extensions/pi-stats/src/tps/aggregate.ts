import type { TpsRawEvent, TpsScale, TpsTrendPoint, ThinkingLevelSummary } from "./types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function aggregateTrend(events: TpsRawEvent[], scale: TpsScale): TpsTrendPoint[] {
  if (events.length === 0) return [];

  const first = events[0].createdAt;
  const last = events[events.length - 1].createdAt;
  const start = bucketStart(first, scale);
  const end = bucketStart(last + 1, scale);
  const byBucket = new Map<number, {
    samples: number;
    ttftMs: number;
    durationMs: number;
    outputTokens: number;
    reasoningTokens: number;
  }>();

  for (const event of events) {
    const key = bucketStart(event.createdAt, scale);
    const current = byBucket.get(key) ?? {
      samples: 0,
      ttftMs: 0,
      durationMs: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    current.samples += 1;
    current.ttftMs += event.ttftMs;
    current.durationMs += event.durationMs;
    current.outputTokens += event.outputTokens;
    current.reasoningTokens += event.reasoningTokens;
    byBucket.set(key, current);
  }

  const points: TpsTrendPoint[] = [];
  for (let cursor = start; cursor <= end; cursor = nextBucketStart(cursor, scale)) {
    const bucket = byBucket.get(cursor);
    if (!bucket) continue;
    points.push({
      bucketStart: cursor,
      samples: bucket.samples,
      avgTtftMs: bucket.ttftMs / bucket.samples,
      avgTps: bucket.outputTokens / Math.max(bucket.durationMs / 1000, 0.001),
      avgThinkingTokens: bucket.reasoningTokens / bucket.samples,
    });
  }
  return points;
}

export function aggregateThinkingLevels(events: TpsRawEvent[]): ThinkingLevelSummary[] {
  const byLevel = new Map<string, { samples: number; reasoningTokens: number }>();
  for (const event of events) {
    const level = event.thinkingLevel || "unknown";
    const current = byLevel.get(level) ?? { samples: 0, reasoningTokens: 0 };
    current.samples += 1;
    current.reasoningTokens += event.reasoningTokens;
    byLevel.set(level, current);
  }
  return [...byLevel.entries()]
    .map(([level, value]) => ({
      level,
      samples: value.samples,
      avgThinkingTokens: value.reasoningTokens / value.samples,
    }))
    .sort((a, b) => b.samples - a.samples || a.level.localeCompare(b.level));
}

function bucketStart(timestamp: number, scale: TpsScale): number {
  if (scale === "hour") return Math.floor(timestamp / 3_600_000) * 3_600_000;
  if (scale === "4h") {
    // Align to the local wall-clock 4-hour boundary (00/04/08/12/16/20) so the
    // buckets line up with the hour-of-day the user sees.
    const date = new Date(timestamp);
    date.setHours(Math.floor(date.getHours() / 4) * 4, 0, 0, 0);
    return date.getTime();
  }
  if (scale === "day") {
    const date = new Date(timestamp);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }
  const dayStart = new Date(timestamp);
  dayStart.setHours(0, 0, 0, 0);
  const weekdayOffset = (dayStart.getDay() + 6) % 7;
  return dayStart.getTime() - weekdayOffset * 24 * 60 * 60 * 1000;
}

function nextBucketStart(timestamp: number, scale: TpsScale): number {
  if (scale === "hour") return timestamp + 3_600_000;
  if (scale === "4h") return timestamp + 4 * 60 * 60 * 1000;
  if (scale === "day") return timestamp + 24 * 60 * 60 * 1000;
  return timestamp + WEEK_MS;
}
