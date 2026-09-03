export type TpsScale = "hour" | "4h" | "day" | "week";

export interface TpsRawEvent {
  provider: string;
  model: string;
  project: string;
  createdAt: number;
  thinkingLevel: string;
  ttftMs: number;
  durationMs: number;
  outputTokens: number;
  reasoningTokens: number;
}

export interface TpsSample extends TpsRawEvent {
  originKey?: string;
}

export interface ModelTpsSummary {
  provider: string;
  model: string;
  samples: number;
  lastSeen: number;
  avgTtftMs: number;
  avgTps: number;
  avgThinkingTokens: number;
}

export interface TpsTrendPoint {
  bucketStart: number;
  samples: number;
  avgTtftMs: number;
  avgTps: number;
  avgThinkingTokens: number;
}

export interface ThinkingLevelSummary {
  level: string;
  samples: number;
  avgThinkingTokens: number;
}

export interface TpsTrendResult {
  points: TpsTrendPoint[];
  thinkingLevels: ThinkingLevelSummary[];
}

export interface TpsTrendOptions {
  provider: string;
  model: string;
  scale: TpsScale;
  since?: number;
  limit?: number;
}
