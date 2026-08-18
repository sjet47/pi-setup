import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { configureDb } from "./sqlite";
import { aggregateThinkingLevels, aggregateTrend } from "./tps/aggregate";
import type {
  ModelTpsSummary,
  TpsRawEvent,
  TpsSample,
  TpsTrendOptions,
  TpsTrendResult,
} from "./tps/types";

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

export interface TpsStatsStore {
	insertSample(sample: TpsSample): boolean;
	listModels(): ModelTpsSummary[];
	queryTrend(options: TpsTrendOptions): TpsTrendResult;
	close(): void;
}

export interface StatsStore extends SkillStatsStore, TpsStatsStore {}

// ── SQLite Store ───────────────────────────────────────────────────

const DEFAULT_DATA_DIR = join(homedir(), ".pi", "agent", "pi-stats");
const DB_FILENAME = "stats.sqlite";
const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_EVENT_LIMIT = 20_000;
// WAL + busy_timeout give us cross-process safety without any file locking of
// our own: each insert is an atomic autocommit transaction.

export class SqlJsStatsStore implements StatsStore {
	private db: Database.Database;
	private dbPath: string;
	private closed = false;
	private checked = false;

	private constructor(db: Database.Database, dbPath: string) {
		this.db = db;
		this.dbPath = dbPath;
	}

	/** Opens the unified on-disk database in place (better-sqlite3 native addon). */
	static create(dataDir?: string): SqlJsStatsStore {
		const dir = dataDir ?? DEFAULT_DATA_DIR;
		mkdirSync(dir, { recursive: true });
		const dbPath = join(dir, DB_FILENAME);

		let db: Database.Database | undefined;
		try {
			db = new Database(dbPath);
			configureDb(db);
			initializeSchema(db);
			const store = new SqlJsStatsStore(db, dbPath);
			db = undefined;
			return store;
		} catch (error) {
			try {
				db?.close();
			} catch {
				// The file is being replaced; ignore close errors from it.
			}
			if (isLockedError(error)) throw error;
			recoverCorruptDatabase(dbPath);
		}

		db = new Database(dbPath);
		configureDb(db);
		initializeSchema(db);
		return new SqlJsStatsStore(db, dbPath);
	}

	private ensureUsable(): void {
		if (this.checked) return;
		if (databaseIsHealthy(this.db)) {
			this.checked = true;
			return;
		}

		try {
			this.db.close();
		} catch {
			// The file is being replaced; ignore close errors from it.
		}
		recoverCorruptDatabase(this.dbPath);
		this.db = new Database(this.dbPath);
		configureDb(this.db);
		initializeSchema(this.db);
		this.checked = true;
	}

	insert(event: UsageEvent): boolean {
		const createdAt = event.createdAt ?? Math.floor(Date.now() / 1000);
		try {
			this.ensureUsable();
			const result = this.db
				.prepare(
					"insert or ignore into skill_usage_events(skill, project, created_at, origin_key) values (?, ?, ?, ?)",
				)
				.run(event.skill, event.project, createdAt, event.originKey ?? null);
			return result.changes > 0;
		} catch {
			return false;
		}
	}

	insertTool(event: ToolUsageEvent): boolean {
		const createdAt = event.createdAt ?? Math.floor(Date.now() / 1000);
		try {
			this.ensureUsable();
			const result = this.db
				.prepare(
					"insert or ignore into tool_usage_events(tool, project, created_at, origin_key) values (?, ?, ?, ?)",
				)
				.run(event.tool, event.project, createdAt, event.originKey ?? null);
			return result.changes > 0;
		} catch {
			return false;
		}
	}

	queryTop(options: { project?: string; limit?: number }): UsageAggregate[] {
		this.ensureUsable();
		const limit = options.limit ?? 20;
		const where = options.project ? "where project = ?" : "";
		const params: unknown[] = options.project ? [options.project, limit] : [limit];
		const rows = this.db
			.prepare(
				`select skill, count(*) as total, max(created_at) as lastUsed
				 from skill_usage_events ${where}
				 group by skill order by total desc, lastUsed desc, skill asc limit ?`,
			)
			.all(...params) as Array<{ skill: string; total: number; lastUsed: number }>;
		return rows.map((row) => ({
			skill: row.skill,
			total: Number(row.total),
			lastUsed: Number(row.lastUsed),
		}));
	}

	queryTopTools(options: { project?: string; limit?: number }): ToolUsageAggregate[] {
		this.ensureUsable();
		const limit = options.limit ?? 20;
		const where = options.project ? "where project = ?" : "";
		const params: unknown[] = options.project ? [options.project, limit] : [limit];
		const rows = this.db
			.prepare(
				`select tool, count(*) as total, max(created_at) as lastUsed
				 from tool_usage_events ${where}
				 group by tool order by total desc, lastUsed desc, tool asc limit ?`,
			)
			.all(...params) as Array<{ tool: string; total: number; lastUsed: number }>;
		return rows.map((row) => ({
			tool: row.tool,
			total: Number(row.total),
			lastUsed: Number(row.lastUsed),
		}));
	}

	querySkillTrend(options: { skill: string; project?: string; limit?: number }): UsageTrendPoint[] {
		this.ensureUsable();
		return this.queryUsageTrend("skill_usage_events", "skill", { name: options.skill, project: options.project, limit: options.limit });
	}

	queryToolTrend(options: { tool: string; project?: string; limit?: number }): UsageTrendPoint[] {
		this.ensureUsable();
		return this.queryUsageTrend("tool_usage_events", "tool", { name: options.tool, project: options.project, limit: options.limit });
	}

	private queryUsageTrend(
		table: string,
		nameColumn: string,
		options: { name: string; project?: string; limit?: number },
	): UsageTrendPoint[] {
		const limit = options.limit ?? 30;
		const projectClause = options.project ? "and project = ?" : "";
		const params: unknown[] = options.project
			? [options.name, options.project, limit]
			: [options.name, limit];
		const rows = this.db
			.prepare(
				`select date(created_at, 'unixepoch', 'localtime') as bucket,
				        count(*) as total,
				        max(created_at) as lastUsed
				 from ${table}
				 where ${nameColumn} = ? ${projectClause}
				 group by bucket
				 order by lastUsed desc
				 limit ?`,
			)
			.all(...params) as Array<{ bucket: string; total: number }>;
		return rows.map((row) => ({
			bucket: String(row.bucket),
			total: Number(row.total),
		})).reverse();
	}

	insertSample(sample: TpsSample): boolean {
		try {
			this.ensureUsable();
			const result = this.db
				.prepare(
					`insert or ignore into tps_samples(
            provider, model, thinking_level, project, created_at,
            ttft_ms, duration_ms, output_tokens, reasoning_tokens, origin_key
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					sample.provider,
					sample.model,
					sample.thinkingLevel || "unknown",
					sample.project,
					sample.createdAt,
					sample.ttftMs,
					sample.durationMs,
					sample.outputTokens,
					sample.reasoningTokens,
					sample.originKey ?? null,
				);
			return result.changes > 0;
		} catch {
			return false;
		}
	}

	listModels(): ModelTpsSummary[] {
		this.ensureUsable();
		const rows = this.db
			.prepare(
				`select
           provider,
           model,
           count(*) as samples,
           max(created_at) as lastSeen,
           avg(ttft_ms) as avgTtftMs,
           sum(output_tokens) * 1000.0 / nullif(sum(duration_ms), 0) as avgTps,
           avg(reasoning_tokens) as avgThinkingTokens
         from tps_samples
         group by provider, model
         order by lastSeen desc, samples desc`,
			)
			.all() as Array<{
			provider: string;
			model: string;
			samples: number;
			lastSeen: number;
			avgTtftMs: number;
			avgTps: number;
			avgThinkingTokens: number;
		}>;
		return rows.map((row) => ({
			provider: row.provider,
			model: row.model,
			samples: Number(row.samples),
			lastSeen: Number(row.lastSeen),
			avgTtftMs: Number(row.avgTtftMs),
			avgTps: Number(row.avgTps),
			avgThinkingTokens: Number(row.avgThinkingTokens),
		}));
	}

	queryTrend(options: TpsTrendOptions): TpsTrendResult {
		this.ensureUsable();
		const sinceSeconds = options.since ?? Math.floor((Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1000) / 1000);
		const limit = options.limit ?? DEFAULT_EVENT_LIMIT;
		const rows = this.db
			.prepare(
				`select
           created_at,
           ttft_ms,
           duration_ms,
           output_tokens,
           reasoning_tokens,
           thinking_level
         from tps_samples
         where provider = ? and model = ? and created_at >= ?
         order by created_at asc
         limit ?`,
			)
			.all(options.provider, options.model, sinceSeconds, limit) as Array<{
			created_at: number;
			ttft_ms: number;
			duration_ms: number;
			output_tokens: number;
			reasoning_tokens: number;
			thinking_level: string;
		}>;

		const events: TpsRawEvent[] = rows.map((row) => ({
			provider: options.provider,
			model: options.model,
			project: "",
			createdAt: Number(row.created_at) * 1000,
			thinkingLevel: row.thinking_level,
			ttftMs: Number(row.ttft_ms),
			durationMs: Number(row.duration_ms),
			outputTokens: Number(row.output_tokens),
			reasoningTokens: Number(row.reasoning_tokens),
		}));

		return {
			points: aggregateTrend(events, options.scale),
			thinkingLevels: aggregateThinkingLevels(events),
		};
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.db.close();
		} catch {
			// Already closed or in an unusable state; nothing to do.
		}
	}
}

function databaseIsHealthy(db: Database.Database): boolean {
	try {
		return db.pragma("quick_check", { simple: true }) === "ok";
	} catch (error) {
		if (isLockedError(error)) throw error;
		return false;
	}
}

function isLockedError(error: unknown): boolean {
	return error instanceof Error
		&& "code" in error
		&& ["SQLITE_BUSY", "SQLITE_LOCKED"].includes((error as { code?: string }).code ?? "");
}

function recoverCorruptDatabase(dbPath: string): void {
	const backupPath = backupDatabaseFile(dbPath);
	removeStaleSidecars(dbPath);
	rmSync(dbPath, { force: true });

	const target = new Database(dbPath);
	try {
		configureDb(target);
		initializeSchema(target);
		if (existsSync(backupPath)) {
			try {
				const source = new Database(backupPath, { readonly: true });
				try {
					copyRecoverableRows(source, target);
				} finally {
					source.close();
				}
			} catch {
				// The backup may be too damaged to open; keep the fresh database.
			}
		}
	} finally {
		try {
			target.pragma("wal_checkpoint(TRUNCATE)");
		} catch {
			// Non-WAL or read-only fallback; close without checkpointing.
		}
		target.close();
	}
	removeStaleSidecars(dbPath);
}

function backupDatabaseFile(dbPath: string): string {
	const backupPath = `${dbPath}.corrupt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	if (existsSync(dbPath)) copyFileSync(dbPath, backupPath);
	const walPath = `${dbPath}-wal`;
	if (existsSync(walPath)) copyFileSync(walPath, `${backupPath}-wal`);
	return backupPath;
}

function removeStaleSidecars(dbPath: string): void {
	for (const suffix of ["-wal", "-shm"]) {
		try {
			rmSync(`${dbPath}${suffix}`, { force: true });
		} catch {
			// Best effort cleanup; the database itself is still usable.
		}
	}
}

function copyRecoverableRows(source: Database.Database, target: Database.Database): void {
	copyTableRows(source, target, "skill_usage_events", "skill");
	copyTableRows(source, target, "tool_usage_events", "tool");
	copyTpsRows(source, target);
}

function copyTableRows(
	source: Database.Database,
	target: Database.Database,
	table: string,
	nameColumn: string,
): void {
	let columns: string[] = [];
	try {
		columns = (source.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>)
			.map((row) => row.name);
	} catch {
		return;
	}

	const idColumn = columns.includes("id") ? "id" : undefined;
	const name = columns.includes(nameColumn) ? nameColumn : undefined;
	const project = columns.includes("project") ? "project" : undefined;
	const createdAt = columns.includes("created_at") ? "created_at" : undefined;
	const originKey = columns.includes("origin_key") ? "origin_key" : undefined;
	if (!name || !project || !createdAt) return;

	const columnsToCopy = [idColumn, name, project, createdAt, originKey]
		.filter((column): column is string => Boolean(column));
	const placeholders = columnsToCopy.map(() => "?").join(", ");

	try {
		const select = source.prepare(`select ${columnsToCopy.join(", ")} from ${table}`);
		const insert = target.prepare(
			`insert or ignore into ${table}(${columnsToCopy.join(", ")}) values (${placeholders})`,
		);
		for (const row of select.iterate() as IterableIterator<Record<string, unknown>>) {
			try {
				insert.run(...columnsToCopy.map((column) => row[column] ?? null));
			} catch {
				// Skip individual unreadable or invalid rows.
			}
		}
	} catch {
		// Keep whatever rows were copied before the malformed section.
	}
}

function copyTpsRows(source: Database.Database, target: Database.Database): void {
	let columns: string[] = [];
	try {
		columns = (source.prepare("pragma table_info(tps_samples)").all() as Array<{ name: string }>)
			.map((row) => row.name);
	} catch {
		return;
	}

	const idColumn = columns.includes("id") ? "id" : undefined;
	const required = [
		"provider",
		"model",
		"thinking_level",
		"project",
		"created_at",
		"ttft_ms",
		"duration_ms",
		"output_tokens",
		"reasoning_tokens",
	];
	const originKey = columns.includes("origin_key") ? "origin_key" : undefined;
	if (required.some((column) => !columns.includes(column))) return;

	const columnsToCopy = [idColumn, ...required, originKey]
		.filter((column): column is string => Boolean(column));
	const placeholders = columnsToCopy.map(() => "?").join(", ");

	try {
		const select = source.prepare(`select ${columnsToCopy.join(", ")} from tps_samples`);
		const insert = target.prepare(
			`insert or ignore into tps_samples(${columnsToCopy.join(", ")}) values (${placeholders})`,
		);
		for (const row of select.iterate() as IterableIterator<Record<string, unknown>>) {
			try {
				insert.run(...columnsToCopy.map((column) => row[column] ?? null));
			} catch {
				// Skip individual unreadable or invalid rows.
			}
		}
	} catch {
		// Keep whatever rows were copied before the malformed section.
	}
}

function initializeSchema(db: Database.Database): void {
	db.exec(`
		create table if not exists skill_usage_events(
			id integer primary key,
			skill text not null,
			project text not null,
			created_at integer not null,
			origin_key text
		);
	`);
	db.exec(`
		create table if not exists tool_usage_events(
			id integer primary key,
			tool text not null,
			project text not null,
			created_at integer not null,
			origin_key text
		);
	`);

	db.exec(`
		create table if not exists tps_samples(
			id integer primary key,
			provider text not null,
			model text not null,
			thinking_level text not null,
			project text not null,
			created_at integer not null,
			ttft_ms integer not null,
			duration_ms integer not null,
			output_tokens integer not null,
			reasoning_tokens integer not null,
			origin_key text
		);
	`);

	db.exec("create index if not exists idx_skill_usage_project on skill_usage_events(project, skill)");
	db.exec("create index if not exists idx_skill_usage_skill on skill_usage_events(skill)");
	db.exec("create index if not exists idx_skill_usage_created_at on skill_usage_events(created_at)");
	db.exec("create unique index if not exists idx_skill_usage_origin_key on skill_usage_events(origin_key) where origin_key is not null");
	db.exec("create index if not exists idx_tool_usage_project on tool_usage_events(project, tool)");
	db.exec("create index if not exists idx_tool_usage_tool on tool_usage_events(tool)");
	db.exec("create index if not exists idx_tool_usage_created_at on tool_usage_events(created_at)");
	db.exec("create unique index if not exists idx_tool_usage_origin_key on tool_usage_events(origin_key) where origin_key is not null");
	db.exec("create index if not exists idx_tps_provider_model_time on tps_samples(provider, model, created_at)");
	db.exec("create index if not exists idx_tps_created_at on tps_samples(created_at)");
	db.exec("create unique index if not exists idx_tps_origin_key on tps_samples(origin_key) where origin_key is not null");
}

	// Re-export under the canonical name
	export { SqlJsStatsStore as SQLiteStatsStore };
