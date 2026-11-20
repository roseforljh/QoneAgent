/** Execution statistics grouped by provider/model, with global recording and memory controls. */

export type ExecutionSource = "chat" | "memory" | "other";

export type CacheObservation = "reported" | "unknown";

export interface ExecutionUsageInput {
  source: ExecutionSource;
  provider: string;
  model: string;
  /** Whether the provider actually returned cache-read data for this request. */
  cache: CacheObservation;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsageStats {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Uncached and cache-write input tokens of requests that reported cache reads. */
  cacheObservedTokens: number;
  cacheObservedRequests: number;
  /** Cache-read tokens of those same requests, summed separately from unknown ones. */
  cacheObservedReadTokens: number;
  /** Weighted by tokens; undefined when nothing reported cache data or the denominator is 0. */
  cacheHitRate?: number;
}

export interface ExecutionStatsPeriod {
  from: number;
  to: number;
  total: ModelUsageStats;
  rows: ModelUsageStats[];
  /** Same models split by origin, so background memory calls never hide inside chat numbers. */
  sources: { source: ExecutionSource; total: ModelUsageStats; rows: ModelUsageStats[] }[];
}

export interface ExecutionIncidentStats {
  provider: string;
  model: string;
  count: number;
  lastAt: number;
}

export interface ExecutionStatsInfo {
  period: ExecutionStatsPeriod;
  incidents: ExecutionIncidentStats[];
  models: Pick<ModelUsageStats, "provider" | "model">[];
  /** Global switch for recording local execution errors. */
  recording: boolean;
  /** Global permission for memory to analyze errors recorded after the grant. */
  memoryAccess: boolean;
}

export type ExecutionStatsRange = "today" | "7d" | "30d";

export const EXECUTION_STATS_RANGES: ExecutionStatsRange[] = ["today", "7d", "30d"];

/** Normalized provider usage; `cache` must come from the raw provider payload, not Pi's default 0. */
export function normalizeUsage(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cache?: CacheObservation }): {
  input: number; output: number; cacheRead: number; cacheWrite: number; cache: CacheObservation;
} {
  const count = (value: number | undefined) => Number.isFinite(value) && (value ?? 0) > 0 ? Math.round(value!) : 0;
  return {
    input: count(usage.input), output: count(usage.output),
    cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite),
    cache: usage.cache === "reported" ? "reported" : "unknown",
  };
}

export const emptyStats = (provider: string, model: string): ModelUsageStats => ({
  provider, model, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, cacheObservedTokens: 0, cacheObservedRequests: 0, cacheObservedReadTokens: 0,
});

/**
 * Weighted hit rate over reported requests only; unknown rows never enter the ratio.
 * `input` excludes cache reads in every API Pi supports, so the denominator is
 * uncached input + cache read + cache write of the same requests.
 */
export function finishStats(row: ModelUsageStats): ModelUsageStats {
  const denominator = row.cacheObservedTokens + row.cacheObservedReadTokens;
  if (!row.cacheObservedRequests || denominator <= 0) return { ...row, cacheHitRate: undefined };
  return { ...row, cacheHitRate: Math.round((row.cacheObservedReadTokens / denominator) * 1000) / 10 };
}

export function accumulate(target: ModelUsageStats, row: Pick<ExecutionUsageInput, "input" | "output" | "cacheRead" | "cacheWrite" | "cache">) {
  target.requests += 1;
  target.inputTokens += row.input;
  target.outputTokens += row.output;
  target.cacheReadTokens += row.cacheRead;
  target.cacheWriteTokens += row.cacheWrite;
  if (row.cache === "reported") {
    target.cacheObservedTokens += row.input + row.cacheWrite;
    target.cacheObservedReadTokens += row.cacheRead;
    target.cacheObservedRequests += 1;
  }
  return target;
}

export const newStats = (provider: string, model: string) => emptyStats(provider, model);

/** Stable key: the same model id under two providers is two rows. */
export const executionModelKey = (provider: string, model: string) => `${provider}/${model}`;

/** Local midnight for "today"; the last N days including today otherwise. */
export function rangeStart(range: ExecutionStatsRange, now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  if (range === "today") return date.getTime();
  date.setDate(date.getDate() - ((range === "7d" ? 7 : 30) - 1));
  return date.getTime();
}
