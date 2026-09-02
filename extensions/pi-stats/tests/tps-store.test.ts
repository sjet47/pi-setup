import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteStatsStore } from "../src/store";
import { aggregateThinkingLevels, aggregateTrend } from "../src/tps/aggregate";
import type { TpsRawEvent } from "../src/tps/types";

let tempDir: string;
let store: SQLiteStatsStore;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pi-stats-tps-test-"));
  store = SQLiteStatsStore.create(tempDir);
});

afterEach(() => {
  store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function sample(overrides: Partial<Parameters<SQLiteStatsStore["insertSample"]>[0]> = {}) {
  return {
    provider: "provider-a",
    model: "model-1",
    project: "project",
    createdAt: 1_700_000_000,
    thinkingLevel: "medium",
    ttftMs: 800,
    durationMs: 10_000,
    outputTokens: 100,
    reasoningTokens: 40,
    originKey: "msg:same",
    ...overrides,
  };
}

describe("store", () => {
  it("stores skill, tool, and tps data in one database", () => {
    expect(store.insert({ skill: "tdd", project: "/project", createdAt: 1_700_000_000, originKey: "skill:1" })).toBe(true);
    expect(store.insertTool({ tool: "read", project: "/project", createdAt: 1_700_000_000, originKey: "tool:1" })).toBe(true);
    expect(store.insertSample(sample())).toBe(true);

    expect(store.queryTop({ project: "/project" })).toEqual([
      { skill: "tdd", total: 1, lastUsed: 1_700_000_000 },
    ]);
    expect(store.queryTopTools({ project: "/project" })).toEqual([
      { tool: "read", total: 1, lastUsed: 1_700_000_000 },
    ]);
    expect(store.listModels()).toHaveLength(1);
  });

  it("stores raw metrics and deduplicates by origin key", () => {
    expect(store.insertSample(sample())).toBe(true);
    expect(store.insertSample(sample())).toBe(false);

    const rows = store.listModels();
    expect(rows).toHaveLength(1);
    expect(rows[0].samples).toBe(1);
  });

  it("lists provider/model summaries with tps, ttft, and thinking averages", () => {
    store.insertSample(sample({ createdAt: 1_700_000_000, ttftMs: 800, durationMs: 10_000, outputTokens: 100, reasoningTokens: 40, originKey: "k1" }));
    store.insertSample(sample({ createdAt: 1_700_000_100, ttftMs: 1200, durationMs: 5_000, outputTokens: 150, reasoningTokens: 60, originKey: "k2" }));

    const rows = store.listModels();
    expect(rows).toHaveLength(1);
    expect(rows[0].samples).toBe(2);
    expect(rows[0].avgTtftMs).toBeCloseTo(1000);
    expect(rows[0].avgTps).toBeCloseTo((100 + 150) / 15);
    expect(rows[0].avgThinkingTokens).toBeCloseTo(50);
  });

  it("aggregates ttft, tps, and thinking tokens by scale", () => {
    const base = new Date();
    const baseMs = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), 10, 0).getTime();
    store.insertSample(sample({ createdAt: Math.floor(baseMs / 1000), ttftMs: 500, durationMs: 10_000, outputTokens: 100, reasoningTokens: 40, originKey: "k1" }));
    store.insertSample(sample({ createdAt: Math.floor((baseMs + 20 * 60 * 1000) / 1000), ttftMs: 1500, durationMs: 20_000, outputTokens: 300, reasoningTokens: 80, originKey: "k2" }));

    const hourly = store.queryTrend({ provider: "provider-a", model: "model-1", scale: "hour", since: 0 });
    expect(hourly.points).toHaveLength(1);
    expect(hourly.points[0].samples).toBe(2);
    expect(hourly.points[0].avgTtftMs).toBeCloseTo(1000);
    expect(hourly.points[0].avgTps).toBeCloseTo(400 / 30);
    expect(hourly.points[0].avgThinkingTokens).toBeCloseTo(60);
  });

  it("keeps the newest samples when the event limit is exceeded", () => {
    const base = new Date(2026, 0, 1, 0, 0, 0).getTime();
    for (let hour = 0; hour < 5; hour += 1) {
      store.insertSample(sample({
        createdAt: Math.floor((base + hour * 3_600_000) / 1000),
        ttftMs: 100,
        durationMs: 10_000,
        outputTokens: 100,
        reasoningTokens: 0,
        originKey: `limit-k${hour}`,
      }));
    }
    // The two earliest hours must be dropped by the limit, not the latest.
    const trend = store.queryTrend({ provider: "provider-a", model: "model-1", scale: "hour", since: 0, limit: 3 });
    expect(trend.points.map((point) => point.bucketStart)).toEqual([
      base + 2 * 3_600_000,
      base + 3 * 3_600_000,
      base + 4 * 3_600_000,
    ]);
  });

  it("groups thinking tokens by thinking level", () => {
    store.insertSample(sample({ createdAt: 1_700_000_000, thinkingLevel: "high", reasoningTokens: 100, originKey: "k1" }));
    store.insertSample(sample({ createdAt: 1_700_000_100, thinkingLevel: "high", reasoningTokens: 200, originKey: "k2" }));
    store.insertSample(sample({ createdAt: 1_700_000_200, thinkingLevel: "off", reasoningTokens: 0, originKey: "k3" }));

    const trend = store.queryTrend({ provider: "provider-a", model: "model-1", scale: "day", since: 0 });
    expect(trend.thinkingLevels).toEqual([
      { level: "high", samples: 2, avgThinkingTokens: 150 },
      { level: "off", samples: 1, avgThinkingTokens: 0 },
    ]);
  });
});

describe("aggregate", () => {
  it("aggregates raw events into trend points", () => {
    const base = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const events: TpsRawEvent[] = [
      { provider: "a", model: "m", project: "p", createdAt: base, thinkingLevel: "medium", ttftMs: 400, durationMs: 10_000, outputTokens: 100, reasoningTokens: 30 },
      { provider: "a", model: "m", project: "p", createdAt: base + 3_600_000, thinkingLevel: "medium", ttftMs: 800, durationMs: 20_000, outputTokens: 300, reasoningTokens: 90 },
    ];

    const hourly = aggregateTrend(events, "hour");
    expect(hourly).toHaveLength(2);
    expect(hourly[0].avgTps).toBeCloseTo(10);
    expect(hourly[1].avgTps).toBeCloseTo(15);

    const daily = aggregateTrend(events, "day");
    expect(daily).toHaveLength(1);
    expect(daily[0].samples).toBe(2);
    expect(daily[0].avgTtftMs).toBeCloseTo(600);
    expect(daily[0].avgThinkingTokens).toBeCloseTo(60);
  });

  it("groups thinking tokens by level", () => {
    const events: TpsRawEvent[] = [
      { provider: "a", model: "m", project: "p", createdAt: 1, thinkingLevel: "off", ttftMs: 0, durationMs: 1000, outputTokens: 10, reasoningTokens: 0 },
      { provider: "a", model: "m", project: "p", createdAt: 2, thinkingLevel: "high", ttftMs: 0, durationMs: 1000, outputTokens: 10, reasoningTokens: 80 },
    ];
    expect(aggregateThinkingLevels(events)).toEqual([
      { level: "high", samples: 1, avgThinkingTokens: 80 },
      { level: "off", samples: 1, avgThinkingTokens: 0 },
    ]);
  });
});
