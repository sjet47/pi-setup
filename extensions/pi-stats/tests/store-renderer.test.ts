import { describe, expect, test } from "vitest";
import Database from "better-sqlite3";
import { formatTimestamp, SkillStatsOverlay } from "../src/stats-overlay";
import { SQLiteStatsStore, type ToolUsageEvent, type UsageEvent } from "../src/store";

// The trend buckets and timestamp rendering use the local timezone; the test
// expectations below assume UTC (the package.json test script pins TZ=UTC, and
// this makes the suite independent of the machine timezone either way).
process.env.TZ = "UTC";

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TREND_SCALES, type TrendScale } from "../src/trend-scale";

function localDateBucket(createdAt: number): number {
	const date = new Date(createdAt * 1000);
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localHourBucket(createdAt: number): number {
	return Math.floor((createdAt * 1000) / 3_600_000) * 3_600_000;
}

// Reference bucketing mirroring the SQL in store.ts; the week case subtracts on
// the calendar so a DST week still starts at local midnight.
function expectedBucket(createdAt: number, scale: TrendScale): number {
	if (scale === "hour") return localHourBucket(createdAt);
	const date = new Date(createdAt * 1000);
	if (scale === "4h") {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(date.getHours() / 4) * 4).getTime();
	}
	if (scale === "week") {
		return new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7)).getTime();
	}
	return localDateBucket(createdAt);
}

async function createStore() {
	const dir = mkdtempSync(join(tmpdir(), "pi-stats-test-"));
	const store = await SQLiteStatsStore.create(dir);
	return { store, dir };
}

function rowName(row: { skill?: string; tool?: string }): string {
	return row.tool ?? row.skill ?? "";
}

const testTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("SQLiteStatsStore", () => {
	test("inserts and aggregates by current project", async () => {
		const { store } = await createStore();
		store.insert({ skill: "tdd", project: "/a", createdAt: 10 });
		store.insert({ skill: "tdd", project: "/a", createdAt: 20 });
		store.insert({ skill: "diagnose", project: "/b", createdAt: 30 });

		expect(store).toBeDefined();
		expect(store.queryTop({ project: "/a" })).toEqual([
			{ skill: "tdd", total: 2, lastUsed: 20 },
		]);
	});

	test("aggregates globally and sorts by count, recency, name", async () => {
		const { store } = await createStore();
		store.insert({ skill: "alpha", project: "/a", createdAt: 40 });
		store.insert({ skill: "beta", project: "/a", createdAt: 30 });
		store.insert({ skill: "gamma", project: "/a", createdAt: 50 });
		store.insert({ skill: "gamma", project: "/b", createdAt: 60 });

		expect(store.queryTop({}).map((row) => row.skill)).toEqual(["gamma", "alpha", "beta"]);
	});

	test("inserts and aggregates tool calls", async () => {
		const { store } = await createStore();
		store.insertTool({ tool: "read", project: "/a", createdAt: 10 });
		store.insertTool({ tool: "read", project: "/a", createdAt: 20 });
		store.insertTool({ tool: "bash", project: "/b", createdAt: 30 });

		expect(store).toBeDefined();
		expect(store.queryTopTools({ project: "/a" })).toEqual([
			{ tool: "read", total: 2, lastUsed: 20 },
		]);
	});

	test("aggregates skill usage trend by day", async () => {
		const { store } = await createStore();
		store.insert({ skill: "tdd", project: "/a", createdAt: 1_700_000_000 });
		store.insert({ skill: "tdd", project: "/a", createdAt: 1_700_000_100 });
		store.insert({ skill: "tdd", project: "/a", createdAt: 1_700_100_000 });
		store.insert({ skill: "tdd", project: "/b", createdAt: 1_700_100_000 });

		expect(store.querySkillTrend({ skill: "tdd", project: "/a" })).toEqual([
			{ bucketStart: localDateBucket(1_700_000_000), total: 2 },
			{ bucketStart: localDateBucket(1_700_100_000), total: 1 },
		]);
	});

	test("aggregates tool usage trend by day", async () => {
		const { store } = await createStore();
		store.insertTool({ tool: "read", project: "/a", createdAt: 1_700_000_000 });
		store.insertTool({ tool: "read", project: "/a", createdAt: 1_700_100_000 });
		store.insertTool({ tool: "bash", project: "/a", createdAt: 1_700_100_000 });

		expect(store.queryToolTrend({ tool: "read", project: "/a", scale: "day" })).toEqual([
			{ bucketStart: localDateBucket(1_700_000_000), total: 1 },
			{ bucketStart: localDateBucket(1_700_100_000), total: 1 },
		]);

		expect(store.queryToolTrend({ tool: "read", project: "/a", scale: "week" })).toEqual([
			{ bucketStart: expectedBucket(1_700_100_000, "week"), total: 2 },
		]);

		expect(store.queryToolTrend({ tool: "read", project: "/a", scale: "hour" })).toEqual([
			{ bucketStart: localHourBucket(1_700_000_000), total: 1 },
			{ bucketStart: localHourBucket(1_700_100_000), total: 1 },
		]);

		// Every scale bucket starts at a boundary the shared reference agrees on.
		for (const scale of TREND_SCALES) {
			const buckets = store.queryToolTrend({ tool: "read", project: "/a", scale });
			expect(buckets.map((point) => point.bucketStart)).toEqual([
				...new Set([1_700_000_000, 1_700_100_000].map((at) => expectedBucket(at, scale))),
			]);
		}
	});

	test("recovers an unreadable database file at startup", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-stats-test-"));
		writeFileSync(join(dir, "stats.sqlite"), "not a sqlite database");

		const store = SQLiteStatsStore.create(dir);
		expect(store.queryTop({})).toEqual([]);
		expect(store.queryTopTools({})).toEqual([]);
		expect(readdirSync(dir).some((file) => file.startsWith("stats.sqlite.corrupt-"))).toBe(true);
		store.close();
	});

	test("recovers a malformed database that still opens", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-stats-test-"));
		const store = SQLiteStatsStore.create(dir);
		for (let i = 0; i < 500; i += 1) {
			store.insertTool({ tool: "read", project: "/a", createdAt: 1000 + i });
		}
		store.close();

		const dbPath = join(dir, "stats.sqlite");
		const checkpoint = new Database(dbPath);
		checkpoint.pragma("wal_checkpoint(TRUNCATE)");
		checkpoint.close();

		const bytes = readFileSync(dbPath);
		bytes[4096 * 2 + 12] = 0xff;
		bytes[4096 * 2 + 13] = 0xff;
		writeFileSync(dbPath, bytes);

		const recovered = SQLiteStatsStore.create(dir);
		expect(() => recovered.queryTopTools({})).not.toThrow();
		expect(recovered.insertTool({ tool: "bash", project: "/a", createdAt: 20 })).toBe(true);
		expect(readdirSync(dir).some((file) => file.startsWith("stats.sqlite.corrupt-"))).toBe(true);
		recovered.close();
	});
});

describe("SkillStatsOverlay", () => {
	test("filters by fuzzy skill name", () => {
		const overlay = new SkillStatsOverlay(
			[
				{ skill: "diagnose", total: 3, lastUsed: 30 },
				{ skill: "tdd", total: 2, lastUsed: 20 },
			],
			"project",
			testTheme,
			"td",
			() => {},
		);
		const output = overlay.render(90).join("\n");
		expect(output).toContain("tdd");
		expect(output).not.toContain("diagnose");
	});

	test("filters by fuzzy tool name", () => {
		const overlay = new SkillStatsOverlay(
			[
				{ tool: "read", total: 3, lastUsed: 30 },
				{ tool: "bash", total: 2, lastUsed: 20 },
			],
			"project",
			testTheme,
			"rd",
			() => {},
			"tool",
		);
		const output = overlay.render(90).join("\n");
		expect(output).toContain("read");
		expect(output).not.toContain("bash");
	});

	test("opens selected row trend chart lazily", () => {
		const requested: Array<{ name: string; scale: string }> = [];
		const day = (dayOfMonth: number) => new Date(2026, 5, dayOfMonth).getTime();
		const overlay = new SkillStatsOverlay(
			[
				{ skill: "diagnose", total: 3, lastUsed: 30 },
				{ skill: "tdd", total: 2, lastUsed: 20 },
			],
			"project",
			testTheme,
			"",
			() => {},
			"skill",
			(name, scale) => {
				requested.push({ name, scale });
				return name === "tdd"
					? [{ bucketStart: day(8), total: 1 }, { bucketStart: day(9), total: 2 }]
					: [];
			},
		);

		expect(requested).toEqual([]);
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		const output = overlay.render(100).join("\n");
		expect(requested).toEqual([{ name: "tdd", scale: "day" }]);
		expect(output).toContain("Skill trend · tdd");
		expect(output).toContain("2026-06-08");
		expect(output).toContain("2026-06-09");
	});

	test("cycles the trend scale with Tab and refetches that scale", () => {
		const requested: Array<{ name: string; scale: string }> = [];
		const overlay = new SkillStatsOverlay(
			[{ skill: "tdd", total: 2, lastUsed: 20 }],
			"project",
			testTheme,
			"",
			() => {},
			"skill",
			(name, scale) => {
				requested.push({ name, scale });
				return [{ bucketStart: new Date(2026, 5, 9, 13).getTime(), total: 2 }];
			},
		);

		overlay.handleInput("\r");
		expect(overlay.render(100).join("\n")).toContain("[day]");

		overlay.handleInput("\t");
		const weekly = overlay.render(100).join("\n");
		expect(requested.map((entry) => entry.scale)).toEqual(["day", "week"]);
		expect(weekly).toContain("[week]");
		expect(weekly).toContain("2026-06-09 ~ 2026-06-15");

		// The cached day bucket is reused instead of refetched.
		overlay.handleInput("\u001b[Z");
		expect(overlay.render(100).join("\n")).toContain("[day]");
		expect(requested.map((entry) => entry.scale)).toEqual(["day", "week"]);
	});

	test("pages the trend window with arrow keys", () => {
		const points = Array.from({ length: 25 }, (_, index) => ({
			bucketStart: new Date(2026, 5, 1 + index).getTime(),
			total: index + 1,
		}));
		const overlay = new SkillStatsOverlay(
			[{ skill: "tdd", total: 2, lastUsed: 20 }],
			"project",
			testTheme,
			"",
			() => {},
			"skill",
			() => points,
		);

		overlay.handleInput("\r");
		const newestPage = overlay.render(100).join("\n");
		expect(newestPage).toContain("2026-06-25");
		expect(newestPage).not.toContain("2026-06-01");

		// A page is 20 rows, so one left press reaches the oldest bucket.
		overlay.handleInput("\x1b[D");
		const oldestPage = overlay.render(100).join("\n");
		expect(oldestPage).toContain("2026-06-01");
		expect(oldestPage).not.toContain("2026-06-25");

		// Right snaps back toward the newest page.
		overlay.handleInput("\x1b[C");
		expect(overlay.render(100).join("\n")).toContain("2026-06-25");
	});

	test("scrolls the list window to keep the selection visible", () => {
		const rows = Array.from({ length: 25 }, (_, index) => ({
			skill: `skill-${String(index).padStart(2, "0")}`,
			total: 25 - index,
			lastUsed: index + 1,
		}));
		const overlay = new SkillStatsOverlay(rows, "project", testTheme, "", () => {});

		expect(overlay.render(90).join("\n")).not.toContain("skill-24");

		for (let presses = 0; presses < 24; presses += 1) {
			overlay.handleInput("\x1b[B");
		}
		const lines = overlay.render(90);
		const output = lines.join("\n");
		expect(output).toContain("skill-24");
		expect(lines.find((line) => line.includes("skill-24"))).toContain("›");
		expect(output).not.toContain("skill-04");
	});
});

describe("formatTimestamp", () => {
	test("formats local time and handles invalid values", () => {
		expect(formatTimestamp(1_700_000_000, "long")).toBe("2023-11-14 22:13");
		expect(formatTimestamp(1_700_000_000, "short")).toBe("2023-11-14");
		expect(formatTimestamp(0)).toBe("-");
	});
});
