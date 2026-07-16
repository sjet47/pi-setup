import Database from "better-sqlite3";

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

type DatabaseFactory = (path: string) => Database.Database;

const CREATE_TABLE = `
create table if not exists skill_usage_events(
  id integer primary key,
  skill text not null,
  project text not null,
  created_at integer not null,
  origin_key text
);
`;

const CREATE_INDEXES = `
create index if not exists idx_skill_usage_project on skill_usage_events(project, skill);
create index if not exists idx_skill_usage_skill on skill_usage_events(skill);
create index if not exists idx_skill_usage_created_at on skill_usage_events(created_at);
create unique index if not exists idx_skill_usage_origin_key on skill_usage_events(origin_key) where origin_key is not null;
`;

const CREATE_TOOL_TABLE = `
create table if not exists tool_usage_events(
  id integer primary key,
  tool text not null,
  project text not null,
  created_at integer not null,
  origin_key text
);
`;

const CREATE_TOOL_INDEXES = `
create index if not exists idx_tool_usage_project on tool_usage_events(project, tool);
create index if not exists idx_tool_usage_tool on tool_usage_events(tool);
create index if not exists idx_tool_usage_created_at on tool_usage_events(created_at);
create unique index if not exists idx_tool_usage_origin_key on tool_usage_events(origin_key) where origin_key is not null;
`;

export class SQLiteSkillStatsStore implements SkillStatsStore {
	private db: Database.Database;
	private insertStmt: Database.Statement;
	private insertToolStmt: Database.Statement;

	constructor(dbPath: string, createDatabase: DatabaseFactory = (path) => new Database(path)) {
		this.db = createDatabase(dbPath);
		this.db.pragma("journal_mode = WAL");
		initializeSchema(this.db);
		this.insertStmt = this.db.prepare(
			"insert or ignore into skill_usage_events(skill, project, created_at, origin_key) values (?, ?, ?, ?)",
		);
		this.insertToolStmt = this.db.prepare(
			"insert or ignore into tool_usage_events(tool, project, created_at, origin_key) values (?, ?, ?, ?)",
		);
	}

	insert(event: UsageEvent): boolean {
		const result = this.insertStmt.run(
			event.skill,
			event.project,
			event.createdAt ?? Math.floor(Date.now() / 1000),
			event.originKey ?? null,
		) as { changes?: number } | undefined;
		return result?.changes !== 0;
	}

	insertTool(event: ToolUsageEvent): boolean {
		const result = this.insertToolStmt.run(
			event.tool,
			event.project,
			event.createdAt ?? Math.floor(Date.now() / 1000),
			event.originKey ?? null,
		) as { changes?: number } | undefined;
		return result?.changes !== 0;
	}

	queryTop(options: { project?: string; limit?: number }): UsageAggregate[] {
		const limit = options.limit ?? 20;
		const where = options.project ? "where project = ?" : "";
		const params = options.project ? [options.project, limit] : [limit];
		const rows = this.db
			.prepare(
				`select
				   skill,
				   count(*) as total,
				   max(created_at) as lastUsed
				 from skill_usage_events
				 ${where}
				 group by skill
				 order by total desc, lastUsed desc, skill asc
				 limit ?`,
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
		const params = options.project ? [options.project, limit] : [limit];
		const rows = this.db
			.prepare(
				`select
				   tool,
				   count(*) as total,
				   max(created_at) as lastUsed
				 from tool_usage_events
				 ${where}
				 group by tool
				 order by total desc, lastUsed desc, tool asc
				 limit ?`,
			)
			.all(...params) as Array<{ tool: string; total: number; lastUsed: number }>;

		return rows.map((row) => ({
			tool: row.tool,
			total: Number(row.total),
			lastUsed: Number(row.lastUsed),
		}));
	}

	querySkillTrend(options: { skill: string; project?: string; limit?: number }): UsageTrendPoint[] {
		return queryTrend(this.db, "skill_usage_events", "skill", options.skill, options.project, options.limit);
	}

	queryToolTrend(options: { tool: string; project?: string; limit?: number }): UsageTrendPoint[] {
		return queryTrend(this.db, "tool_usage_events", "tool", options.tool, options.project, options.limit);
	}

	close(): void {
		this.db.close();
	}
}

function queryTrend(
	db: Database.Database,
	table: "skill_usage_events" | "tool_usage_events",
	nameColumn: "skill" | "tool",
	name: string,
	project?: string,
	limit = 30,
): UsageTrendPoint[] {
	const projectClause = project ? "and project = ?" : "";
	const params = project ? [name, project, limit] : [name, limit];
	const rows = db
		.prepare(
			`select
			   date(created_at, 'unixepoch', 'localtime') as bucket,
			   count(*) as total,
			   max(created_at) as lastUsed
			 from ${table}
			 where ${nameColumn} = ? ${projectClause}
			 group by bucket
			 order by lastUsed desc
			 limit ?`,
		)
		.all(...params) as Array<{ bucket: string; total: number }>;

	return rows
		.reverse()
		.map((row) => ({ bucket: row.bucket, total: Number(row.total) }));
}

const MIGRATE_V1_ROWS = `
insert or ignore into skill_usage_events(id, skill, project, created_at, origin_key)
select
  min(id) as id,
  min(skill) as skill,
  min(project) as project,
  max(created_at) as created_at,
  normalized_origin_key as origin_key
from (
  select
    id,
    skill,
    project,
    created_at,
    case
      when origin_key like 'scan:%:manual:%' then replace(origin_key, ':manual:', ':')
      when origin_key like 'scan:%:agent:%' then replace(origin_key, ':agent:', ':')
      when origin_key like 'scan:%:unknown:%' then replace(origin_key, ':unknown:', ':')
      else origin_key
    end as normalized_origin_key
  from skill_usage_events_v1
)
group by case when normalized_origin_key is null then 'row:' || id else normalized_origin_key end;
drop table skill_usage_events_v1;
`;

function initializeSchema(db: Database.Database): void {
	db.exec(CREATE_TABLE);
	db.exec(CREATE_TOOL_TABLE);
	const columns = db.prepare("pragma table_info(skill_usage_events)").all() as Array<{ name: string }>;
	if (columns.some((column) => column.name === "source")) {
		db.exec(`
			begin immediate;
			alter table skill_usage_events rename to skill_usage_events_v1;
			create table skill_usage_events(
			  id integer primary key,
			  skill text not null,
			  project text not null,
			  created_at integer not null,
			  origin_key text
			);
			${MIGRATE_V1_ROWS}
			commit;
		`);
	} else if (legacyV1TableExists(db)) {
		// A previous (pre-transaction) migration was interrupted after the rename:
		// skill_usage_events was recreated empty (or partially filled) by CREATE_TABLE,
		// while the original rows are still in skill_usage_events_v1. Resume the copy.
		db.exec(`
			begin immediate;
			${MIGRATE_V1_ROWS}
			commit;
		`);
	}
	db.exec(CREATE_INDEXES);
	db.exec(CREATE_TOOL_INDEXES);
}

function legacyV1TableExists(db: Database.Database): boolean {
	const rows = db
		.prepare("select name from sqlite_master where type = 'table' and name = 'skill_usage_events_v1'")
		.all() as Array<{ name: string }>;
	return rows.length > 0;
}
