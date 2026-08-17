import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";

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

// ── SQLite Store ───────────────────────────────────────────────────

const DEFAULT_DATA_DIR = join(homedir(), ".pi", "agent", "pi-skill-stats");
const DB_FILENAME = "stats.sqlite";
// How long a write waits for another process to release its lock before giving
// up. WAL + this timeout give us cross-process safety without any file locking
// of our own: each insert is an atomic autocommit transaction.
const BUSY_TIMEOUT_MS = 5000;

export class SqlJsSkillStatsStore implements SkillStatsStore {
	private db: Database.Database;
	private closed = false;

	private constructor(db: Database.Database) {
		this.db = db;
	}

	/** Opens the on-disk database in place (better-sqlite3 native addon). */
	static create(dataDir?: string): SqlJsSkillStatsStore {
		const dir = dataDir ?? DEFAULT_DATA_DIR;
		mkdirSync(dir, { recursive: true });
		const dbPath = join(dir, DB_FILENAME);

		let db: Database.Database | undefined;
		try {
			db = new Database(dbPath);
			db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
			if (databaseIsHealthy(db)) {
				configureDb(db);
				initializeSchema(db);
				const store = new SqlJsSkillStatsStore(db);
				db = undefined;
				return store;
			}
			db.close();
			db = undefined;
			recoverCorruptDatabase(dbPath);
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
		return new SqlJsSkillStatsStore(db);
	}

	insert(event: UsageEvent): boolean {
		const createdAt = event.createdAt ?? Math.floor(Date.now() / 1000);
		try {
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
		return this.queryTrend("skill_usage_events", "skill", { name: options.skill, project: options.project, limit: options.limit });
	}

	queryToolTrend(options: { tool: string; project?: string; limit?: number }): UsageTrendPoint[] {
		return this.queryTrend("tool_usage_events", "tool", { name: options.tool, project: options.project, limit: options.limit });
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

function configureDb(db: Database.Database): void {
	try {
		// WAL lets readers proceed while a writer commits, and shrinks the write
		// lock to a single autocommit transaction.
		db.pragma("journal_mode = WAL");
	} catch {
		// Read-only filesystems or network mounts may not support WAL; fall back
		// to the default journal mode. busy_timeout below still serializes
		// cross-process writers safely.
	}
	db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
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

	// Migration: old source column with origin key normalization
	const columns = db.prepare("pragma table_info(skill_usage_events)").all() as Array<{ name: string }>;
	const colNames = columns.map((row) => row.name);
	if (colNames.includes("source")) {
		db.exec(`
			alter table skill_usage_events rename to skill_usage_events_v1;
			create table skill_usage_events(
				id integer primary key,
				skill text not null,
				project text not null,
				created_at integer not null,
				origin_key text
			);
		`);
		migrateV1Rows(db);
	} else if (legacyV1TableExists(db)) {
		migrateV1Rows(db);
	}

	db.exec("create index if not exists idx_skill_usage_project on skill_usage_events(project, skill)");
	db.exec("create index if not exists idx_skill_usage_skill on skill_usage_events(skill)");
	db.exec("create index if not exists idx_skill_usage_created_at on skill_usage_events(created_at)");
	db.exec("create unique index if not exists idx_skill_usage_origin_key on skill_usage_events(origin_key) where origin_key is not null");
	db.exec("create index if not exists idx_tool_usage_project on tool_usage_events(project, tool)");
	db.exec("create index if not exists idx_tool_usage_tool on tool_usage_events(tool)");
	db.exec("create index if not exists idx_tool_usage_created_at on tool_usage_events(created_at)");
	db.exec("create unique index if not exists idx_tool_usage_origin_key on tool_usage_events(origin_key) where origin_key is not null");
}

function migrateV1Rows(db: Database.Database): void {
	// Normalize origin keys: migrate :manual:/:agent:/:unknown: segments to the
	// modern format and deduplicate by normalized origin key.
	db.exec(`
		insert or ignore into skill_usage_events(id, skill, project, created_at, origin_key)
		select
		  min(id),
		  min(skill),
		  min(project),
		  max(created_at),
		  case
		    when origin_key like 'scan:%:manual:%' then replace(origin_key, ':manual:', ':')
		    when origin_key like 'scan:%:agent:%'  then replace(origin_key, ':agent:', ':')
		    when origin_key like 'scan:%:unknown:%' then replace(origin_key, ':unknown:', ':')
		    else origin_key
		  end as normalized_origin_key
		from skill_usage_events_v1
		group by case when normalized_origin_key is null then 'row:' || id else normalized_origin_key end;
	`);
	db.exec("drop table skill_usage_events_v1");
}

function legacyV1TableExists(db: Database.Database): boolean {
	const rows = db
		.prepare("select name from sqlite_master where type = 'table' and name = 'skill_usage_events_v1'")
		.all();
	return rows.length > 0;
}

// Re-export under original name for backward compat
export { SqlJsSkillStatsStore as SQLiteSkillStatsStore };
