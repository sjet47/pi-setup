import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import initSqlJs, { type SqlJsStatic, type Database } from "sql.js";

// ── Types ──────────────────────────────────────────────────────────

export interface UsageEvent {
	skill: string;
	project: string;
	createdAt?: number;
	originKey?: string;
}

export interface ToolUsageEvent {
	tool: string;
	project: string;
	createdAt?: number;
	originKey?: string;
}

export interface UsageAggregate {
	skill: string;
	total: number;
	lastUsed: number;
}

export interface ToolUsageAggregate {
	tool: string;
	total: number;
	lastUsed: number;
}

export interface UsageTrendPoint {
	bucket: string;
	total: number;
}

export interface SkillStatsStore {
	insert(event: UsageEvent): boolean;
	insertTool(event: ToolUsageEvent): boolean;
	queryTop(options: { project?: string; limit?: number }): UsageAggregate[];
	queryTopTools(options: { project?: string; limit?: number }): ToolUsageAggregate[];
	querySkillTrend(options: { skill: string; project?: string; limit?: number }): UsageTrendPoint[];
	queryToolTrend(options: { tool: string; project?: string; limit?: number }): UsageTrendPoint[];
	close(): void;
}

// ── SQL.js Store ───────────────────────────────────────────────────

const DEFAULT_DATA_DIR = join(homedir(), ".pi", "agent", "pi-skill-stats");
const DB_FILENAME = "stats.sqlite";
let sqlModule: SqlJsStatic | null = null;
let sqlInitPromise: Promise<SqlJsStatic> | null = null;

async function getSqlModule(): Promise<SqlJsStatic> {
	if (sqlModule) return sqlModule;
	if (!sqlInitPromise) {
		sqlInitPromise = initSqlJs();
	}
	sqlModule = await sqlInitPromise;
	return sqlModule;
}

export class SqlJsSkillStatsStore implements SkillStatsStore {
	private db: Database;
	private dbPath: string;
	private savePending = false;

	private constructor(db: Database, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	/** Async factory — loads WASM + DB file. */
	static async create(dataDir?: string): Promise<SqlJsSkillStatsStore> {
		const dir = dataDir ?? DEFAULT_DATA_DIR;
		mkdirSync(dir, { recursive: true });
		const dbPath = join(dir, DB_FILENAME);

		const SQL = await getSqlModule();
		let db: Database;
		if (existsSync(dbPath)) {
			const buffer = readFileSync(dbPath);
			db = new SQL.Database(buffer);
		} else {
			db = new SQL.Database();
		}

		// Initialize schema
		db.run(`
			create table if not exists skill_usage_events(
				id integer primary key,
				skill text not null,
				project text not null,
				created_at integer not null,
				origin_key text
			);
		`);
		db.run(`
			create table if not exists tool_usage_events(
				id integer primary key,
				tool text not null,
				project text not null,
				created_at integer not null,
				origin_key text
			);
		`);

		// Migration: old source column
		const columns = db.exec("pragma table_info(skill_usage_events)");
		const colNames = (columns[0]?.values ?? []).map((row) => row[0] as string);
		if (colNames.includes("source")) {
			// Recreate and migrate from old schema
			db.run(`
				alter table skill_usage_events rename to skill_usage_events_v1;
				create table skill_usage_events(
					id integer primary key,
					skill text not null,
					project text not null,
					created_at integer not null,
					origin_key text
				);
				insert or ignore into skill_usage_events(id, skill, project, created_at, origin_key)
				select id, skill, project, created_at, origin_key from skill_usage_events_v1;
				drop table skill_usage_events_v1;
			`);
		}

		// Create indexes
		db.run("create index if not exists idx_skill_usage_project on skill_usage_events(project, skill)");
		db.run("create index if not exists idx_skill_usage_skill on skill_usage_events(skill)");
		db.run("create index if not exists idx_skill_usage_created_at on skill_usage_events(created_at)");
		db.run("create unique index if not exists idx_skill_usage_origin_key on skill_usage_events(origin_key) where origin_key is not null");
		db.run("create index if not exists idx_tool_usage_project on tool_usage_events(project, tool)");
		db.run("create index if not exists idx_tool_usage_tool on tool_usage_events(tool)");
		db.run("create index if not exists idx_tool_usage_created_at on tool_usage_events(created_at)");
		db.run("create unique index if not exists idx_tool_usage_origin_key on tool_usage_events(origin_key) where origin_key is not null");

		const store = new SqlJsSkillStatsStore(db, dbPath);
		store.save();
		return store;
	}

	insert(event: UsageEvent): boolean {
		const createdAt = event.createdAt ?? Math.floor(Date.now() / 1000);
		try {
			this.db.run(
				"insert or ignore into skill_usage_events(skill, project, created_at, origin_key) values (?, ?, ?, ?)",
				[event.skill, event.project, createdAt, event.originKey ?? null],
			);
			const changed = this.db.getRowsModified() > 0;
			if (changed) this.save();
			return changed;
		} catch {
			return false;
		}
	}

	insertTool(event: ToolUsageEvent): boolean {
		const createdAt = event.createdAt ?? Math.floor(Date.now() / 1000);
		try {
			this.db.run(
				"insert or ignore into tool_usage_events(tool, project, created_at, origin_key) values (?, ?, ?, ?)",
				[event.tool, event.project, createdAt, event.originKey ?? null],
			);
			const changed = this.db.getRowsModified() > 0;
			if (changed) this.save();
			return changed;
		} catch {
			return false;
		}
	}

	queryTop(options: { project?: string; limit?: number }): UsageAggregate[] {
		const limit = options.limit ?? 20;
		const where = options.project ? "where project = ?" : "";
		const params: unknown[] = options.project ? [options.project, limit] : [limit];
		const result = this.db.exec(
			`select skill, count(*) as total, max(created_at) as lastUsed
			 from skill_usage_events ${where}
			 group by skill order by total desc, lastUsed desc, skill asc limit ?`,
			params,
		);
		return parseRows<UsageAggregate>(result, (row) => ({
			skill: String(row[0]),
			total: Number(row[1]),
			lastUsed: Number(row[2]),
		}));
	}

	queryTopTools(options: { project?: string; limit?: number }): ToolUsageAggregate[] {
		const limit = options.limit ?? 20;
		const where = options.project ? "where project = ?" : "";
		const params: unknown[] = options.project ? [options.project, limit] : [limit];
		const result = this.db.exec(
			`select tool, count(*) as total, max(created_at) as lastUsed
			 from tool_usage_events ${where}
			 group by tool order by total desc, lastUsed desc, tool asc limit ?`,
			params,
		);
		return parseRows<ToolUsageAggregate>(result, (row) => ({
			tool: String(row[0]),
			total: Number(row[1]),
			lastUsed: Number(row[2]),
		}));
	}

	querySkillTrend(options: { skill: string; project?: string; limit?: number }): UsageTrendPoint[] {
		return this.queryTrend("skill_usage_events", "skill", options);
	}

	queryToolTrend(options: { tool: string; project?: string; limit?: number }): UsageTrendPoint[] {
		return this.queryTrend("tool_usage_events", "tool", options as { name: string; project?: string; limit?: number });
	}

	private queryTrend(
		table: string,
		nameColumn: string,
		options: { name: string; project?: string; limit?: number },
	): UsageTrendPoint[] {
		const limit = options.limit ?? 30;
		const projectClause = options.project ? "and project = ?" : "";
		const params: unknown[] = options.project
			? [options.name, options.project, limit]
			: [options.name, limit];

		const result = this.db.exec(
			`select date(created_at, 'unixepoch', 'localtime') as bucket,
			        count(*) as total,
			        max(created_at) as lastUsed
			 from ${table}
			 where ${nameColumn} = ? ${projectClause}
			 group by bucket
			 order by lastUsed desc
			 limit ?`,
			params,
		);
		return parseRows<UsageTrendPoint>(result, (row) => ({
			bucket: String(row[0]),
			total: Number(row[1]),
		})).reverse();
	}

	close(): void {
		this.save();
		this.db.close();
	}

	private save(): void {
		if (this.savePending) return;
		this.savePending = true;
		// Use microtask to batch concurrent writes
		queueMicrotask(() => {
			this.savePending = false;
			try {
				const data = this.db.export();
				const tmp = this.dbPath + ".tmp";
				writeFileSync(tmp, Buffer.from(data));
				renameSync(tmp, this.dbPath);
			} catch (error) {
				console.error("pi-skill-stats: failed to save database", error);
			}
		});
	}
}

function parseRows<T>(
	results: Array<{ columns: string[]; values: unknown[][] }>,
	map: (row: unknown[]) => T,
): T[] {
	for (const r of results) {
		if (r.values && r.values.length > 0) {
			return r.values.map(map);
		}
	}
	return [];
}

// Re-export under original name for backward compat
export { SqlJsSkillStatsStore as SQLiteSkillStatsStore };
