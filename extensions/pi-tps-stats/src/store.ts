import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { aggregateThinkingLevels, aggregateTrend } from "./aggregate";
import type {
  ModelTpsSummary,
  TpsRawEvent,
  TpsSample,
  TpsScale,
  TpsTrendOptions,
  TpsTrendResult,
} from "./types";

export interface TpsStatsStore {
  insertSample(sample: TpsSample): boolean;
  listModels(): ModelTpsSummary[];
  queryTrend(options: TpsTrendOptions): TpsTrendResult;
  close(): void;
}

const DEFAULT_DATA_DIR = join(homedir(), ".pi", "agent", "pi-tps-stats");
const DB_FILENAME = "stats.sqlite";
const BUSY_TIMEOUT_MS = 5000;
const DEFAULT_SINCE_DAYS = 90;
const DEFAULT_EVENT_LIMIT = 20_000;

export class SqlJsTpsStatsStore implements TpsStatsStore {
  private db: Database.Database;
  private closed = false;

  private constructor(db: Database.Database) {
    this.db = db;
  }

  static create(dataDir?: string): SqlJsTpsStatsStore {
    const dir = dataDir ?? DEFAULT_DATA_DIR;
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, DB_FILENAME));
    configureDb(db);
    initializeSchema(db);
    return new SqlJsTpsStatsStore(db);
  }

  insertSample(sample: TpsSample): boolean {
    try {
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
      // Already closed or unusable.
    }
  }
}

export { SqlJsTpsStatsStore as SQLiteTpsStatsStore };

function configureDb(db: Database.Database): void {
  try {
    db.pragma("journal_mode = WAL");
  } catch {
    // Fall back to the default journal mode on filesystems without WAL support.
  }
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function initializeSchema(db: Database.Database): void {
  // Historical/schema-v1 tables measured end-to-end duration and tps, which the
  // new live-only flow replaces. Drop old rows so statistics start fresh.
  const columns = db.prepare("pragma table_info(tps_samples)").all() as Array<{ name: string }>;
  if (columns.length > 0 && !columns.some((column) => column.name === "thinking_level")) {
    db.exec("drop table tps_samples");
  }

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
  db.exec("create index if not exists idx_tps_provider_model_time on tps_samples(provider, model, created_at)");
  db.exec("create index if not exists idx_tps_created_at on tps_samples(created_at)");
  db.exec("create unique index if not exists idx_tps_origin_key on tps_samples(origin_key) where origin_key is not null");
}
