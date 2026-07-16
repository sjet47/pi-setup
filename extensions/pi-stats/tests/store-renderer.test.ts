import { describe, expect, test } from "bun:test";
import { formatTimestamp, SkillStatsOverlay } from "../src/stats-overlay";
import { SQLiteSkillStatsStore, type ToolUsageEvent, type UsageEvent } from "../src/store";

// The trend buckets and timestamp rendering use the local timezone; the test
// expectations below assume UTC (the package.json test script pins TZ=UTC, and
// this makes the suite independent of the machine timezone either way).
process.env.TZ = "UTC";

function localDateBucket(createdAt: number): string {
	const date = new Date(createdAt * 1000);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function createFakeDatabase(columns: Array<{ name: string }> = [
	{ name: "id" },
	{ name: "skill" },
	{ name: "project" },
	{ name: "created_at" },
	{ name: "origin_key" },
]) {
	const events: UsageEvent[] = [];
	const toolEvents: ToolUsageEvent[] = [];
	const executedSql: string[] = [];
	const db = {
		schemaInitialized: false,
		executedSql,
		pragma(_directive: string) {},
		exec(sql: string) {
			this.schemaInitialized = true;
			executedSql.push(sql);
		},
		prepare(sql: string) {
			if (sql.startsWith("pragma table_info")) {
				return { all: () => columns };
			}
			if (sql.includes("sqlite_master")) {
				return { all: () => [] };
			}
			if (sql.startsWith("insert")) {
				return {
					run(name: string, project: string, createdAt: number, originKey?: string | null) {
						if (originKey && events.some((event) => event.originKey === originKey)) return { changes: 0 };
						if (originKey && toolEvents.some((event) => event.originKey === originKey)) return { changes: 0 };
						if (sql.includes("tool_usage_events")) {
							toolEvents.push({ tool: name, project, createdAt, originKey: originKey ?? undefined });
						} else {
							events.push({ skill: name, project, createdAt, originKey: originKey ?? undefined });
						}
						return { changes: 1 };
					},
				};
			}
			return {
				all(...params: unknown[]) {
					const sourceEvents = sql.includes("tool_usage_events") ? toolEvents : events;
					if (sql.includes("date(created_at")) {
						const hasProject = sql.includes("and project = ?");
						const name = String(params[0]);
						const project = hasProject ? String(params[1]) : undefined;
						const limit = Number(params[hasProject ? 2 : 1]);
						const filtered = sourceEvents.filter((event) => {
							const eventName = "tool" in event ? event.tool : event.skill;
							return eventName === name && (!project || event.project === project);
						});
						const byBucket = new Map<string, { bucket: string; total: number; lastUsed: number }>();
						for (const event of filtered) {
							const bucket = localDateBucket(event.createdAt ?? 0);
							const row = byBucket.get(bucket) ?? { bucket, total: 0, lastUsed: 0 };
							row.total += 1;
							row.lastUsed = Math.max(row.lastUsed, event.createdAt ?? 0);
							byBucket.set(bucket, row);
						}
						return [...byBucket.values()].sort((left, right) => right.lastUsed - left.lastUsed).slice(0, limit);
					}

					const hasProject = sql.includes("where project = ?");
					const project = hasProject ? String(params[0]) : undefined;
					const limit = Number(params[hasProject ? 1 : 0]);
					const filtered = project ? sourceEvents.filter((event) => event.project === project) : sourceEvents;
					const byName = new Map<string, { skill?: string; tool?: string; total: number; lastUsed: number }>();
					for (const event of filtered) {
						const name = "tool" in event ? event.tool : event.skill;
						const row = byName.get(name) ?? ("tool" in event
							? { tool: name, total: 0, lastUsed: 0 }
							: { skill: name, total: 0, lastUsed: 0 });
						row.total += 1;
						row.lastUsed = Math.max(row.lastUsed, event.createdAt ?? 0);
						byName.set(name, row);
					}
					return [...byName.values()]
						.sort((left, right) => right.total - left.total || right.lastUsed - left.lastUsed || rowName(left).localeCompare(rowName(right)))
						.slice(0, limit);
				},
			};
		},
		close() {},
	};
	return db;
}

async function createStore() {
	const dir = await Bun.write(Bun.mkdtempSync("pi-stats-test-"), "");
	const store = await SQLiteSkillStatsStore.create(dir);
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

describe("SQLiteSkillStatsStore", () => {
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
			{ bucket: "2023-11-14", total: 2 },
			{ bucket: "2023-11-16", total: 1 },
		]);
	});

	test("aggregates tool usage trend by day", async () => {
		const { store } = await createStore();
		store.insertTool({ tool: "read", project: "/a", createdAt: 1_700_000_000 });
		store.insertTool({ tool: "read", project: "/a", createdAt: 1_700_100_000 });
		store.insertTool({ tool: "bash", project: "/a", createdAt: 1_700_100_000 });

		expect(store.queryToolTrend({ tool: "read", project: "/a" })).toEqual([
			{ bucket: "2023-11-14", total: 1 },
			{ bucket: "2023-11-16", total: 1 },
		]);
	});

	test("migrates legacy source column", async () => {
		const { store } = await createStore();
		// Real store always initializes the modern schema; no mock to inspect
		store.insert({ skill: "tdd", project: "/a", createdAt: 10 });
		expect(store.queryTop({ project: "/a" }).length).toBe(1);
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
		const requested: string[] = [];
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
			(name) => {
				requested.push(name);
				return name === "tdd" ? [{ bucket: "2026-06-08", total: 1 }, { bucket: "2026-06-09", total: 2 }] : [];
			},
		);

		expect(requested).toEqual([]);
		overlay.handleInput("\x1b[B");
		overlay.handleInput("\r");
		const output = overlay.render(100).join("\n");
		expect(requested).toEqual(["tdd"]);
		expect(output).toContain("Skill trend · tdd");
		expect(output).toContain("2026-06-08");
		expect(output).toContain("2026-06-09");
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
