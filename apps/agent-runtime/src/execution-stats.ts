import { randomUUID } from "node:crypto";
import type { ExecutionIncidentRepo, ExecutionLessonRepo, ExecutionUsageRepo, PreferencesRepo } from "@qone/database";
import {
  accumulate, emptyStats, executionModelKey, finishStats, newStats, rangeStart,
  type ExecutionSource, type ExecutionStatsInfo, type ExecutionStatsRange, type ModelUsageStats,
} from "@qone/protocol";
import type { ProviderUsageReport } from "./usage-capture.js";
import type { ExecutionRecorder } from "./execution-recorder.js";

const SOURCES: ExecutionSource[] = ["chat", "memory", "other"];
const RECORD_ERRORS = "execution.incident.record";
// The old global analysis flag was a pause switch, not all-model consent.
const ACCESS_SINCE = "execution.memory.accessSince";
const watermarkKey = (id: string) => `execution.incident.analyzedAt:${id}`;

interface UsageRecord extends ProviderUsageReport {
  source: ExecutionSource;
  sessionId?: string;
  /** Real request time, captured when the provider answered, not when the batch was flushed. */
  at: number;
}

/**
 * Local execution statistics. Telemetry only: it never changes a request, the
 * transcript or cache settings, and it never sends anything anywhere.
 */
export class ExecutionStats {
  private queue: UsageRecord[] = [];
  private flushScheduled = false;
  private closed = false;
  private permissionVersion = 0;
  get consentVersion() { return this.permissionVersion; }

  constructor(private input: {
    usage: ExecutionUsageRepo;
    incidents: ExecutionIncidentRepo;
    lessons: ExecutionLessonRepo;
    prefs: PreferencesRepo;
    /** Configured models are listed for filtering only, including ones without usage yet. */
    models(): ExecutionStatsInfo["models"];
    onChange(): void;
    onError(error: unknown): void;
    recorder: Pick<ExecutionRecorder, "toolFailed" | "runFailed">;
    scheduleFlush?: (flush: () => void) => void;
  }, private now: () => number = Date.now) {}

  // --- error attribution ---

  runFailed(runId: string, at: number, error?: string) {
    try { this.input.recorder.runFailed(runId, at, error); }
    catch (error) { this.input.onError(error); }
  }

  /** Only the tool label and a controlled reason are recorded; never command text or output. */
  toolFailed(runId: string, toolCallId: string, toolName: string, result: unknown, at: number) {
    try { this.input.recorder.toolFailed(runId, toolCallId, toolName, result, at); }
    catch (error) { this.input.onError(error); }
  }

  // --- usage ---

  /**
   * Usage is independent of the local error switch: it always feeds the statistics page.
   */
  observe(sessionId: string | undefined, usage: ProviderUsageReport, source: ExecutionSource = "chat", at = this.now()): void {
    if (this.closed) return;
    try {
      this.queue.push({ ...usage, source, sessionId: sessionId || undefined, at });
      this.schedule();
    } catch (error) { this.input.onError(error); }
  }

  /** Coalesced write: a burst of requests costs one scheduled flush, not one per request. */
  private schedule() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    (this.input.scheduleFlush ?? ((flush) => setImmediate(flush)))(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  flush(): void {
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    try {
      for (const record of batch) {
        this.input.usage.add({
          requestKey: randomUUID(),
          sessionId: record.sessionId,
          at: record.at, source: record.source,
          provider: record.provider, model: record.model, cache: record.cache,
          input: record.input, output: record.output, cacheRead: record.cacheRead, cacheWrite: record.cacheWrite,
        });
      }
    } catch (error) { this.input.onError(error); }
  }

  close() {
    this.flush();
    this.closed = true;
  }

  // --- global switches; every incident retains the actual provider and model ---

  recordEnabled(): boolean {
    return this.input.prefs.get<boolean>(RECORD_ERRORS) !== false;
  }

  setRecord(record: boolean) {
    this.input.prefs.set(RECORD_ERRORS, record);
  }

  private grantedAt(): number | undefined {
    const since = this.input.prefs.get<number>(ACCESS_SINCE);
    return typeof since === "number" && Number.isFinite(since) ? since : undefined;
  }

  memoryAccess(): boolean {
    return this.grantedAt() !== undefined;
  }

  setMemoryAccess(enabled: boolean) {
    if (enabled === this.memoryAccess()) return;
    if (enabled) this.input.prefs.set(ACCESS_SINCE, this.now());
    else this.input.prefs.delete(ACCESS_SINCE);
    this.permissionVersion++;
    this.input.onChange();
  }

  recover() {
    if (!this.recordEnabled()) return;
    try { this.input.incidents.recover(this.now()); }
    catch (error) { this.input.onError(error); }
  }

  pendingAnalysis() {
    const grantedAt = this.grantedAt();
    if (grantedAt === undefined) return [];
    const until = this.now();
    return this.input.incidents.analysisModels(grantedAt, until).flatMap(({ provider, model }) => {
      const id = executionModelKey(provider, model);
      const from = Math.max(grantedAt, this.input.prefs.get<number>(watermarkKey(id)) ?? 0);
      const rows = this.input.incidents.analysisGroups(provider, model, from, until);
      return rows.length ? [{ id, provider, model, grantedAt, until, rows }] : [];
    });
  }

  saveAnalysis(batch: ReturnType<ExecutionStats["pendingAnalysis"]>[number], choices: { tool: string; reason: string; advice: string }[]) {
    if (this.grantedAt() !== batch.grantedAt) return;
    for (const choice of choices) this.input.lessons.put({ ...choice, provider: batch.provider, model: batch.model, at: batch.until });
    this.input.prefs.set(watermarkKey(batch.id), batch.until - 1);
  }

  lessons(provider: string, model: string) {
    const since = this.grantedAt();
    return since === undefined ? [] : this.input.lessons.forModel(provider, model, since);
  }

  // --- settings snapshot ---

  period(range: ExecutionStatsRange): ExecutionStatsInfo["period"] {
    const to = this.now();
    const from = rangeStart(range, to);
    let rows: ReturnType<ExecutionUsageRepo["list"]> = [];
    try { rows = this.input.usage.list(from, to + 1); }
    catch (error) { this.input.onError(error); }
    const byKey = new Map<string, ModelUsageStats>();
    const bySource = new Map<ExecutionSource, Map<string, ModelUsageStats>>();
    for (const row of rows) {
      const cache = row.cache === "reported" ? "reported" as const : "unknown" as const;
      const key = `${row.provider}/${row.model}`;
      let target = byKey.get(key);
      if (!target) byKey.set(key, target = newStats(row.provider, row.model));
      accumulate(target, { ...row, cache });
      const source = (SOURCES as string[]).includes(row.source) ? row.source as ExecutionSource : "other";
      let bucket = bySource.get(source);
      if (!bucket) bySource.set(source, bucket = new Map());
      let sourceRow = bucket.get(key);
      if (!sourceRow) bucket.set(key, sourceRow = newStats(row.provider, row.model));
      accumulate(sourceRow, { ...row, cache });
    }
    const order = (a: ModelUsageStats, b: ModelUsageStats) =>
      (b.inputTokens + b.outputTokens + b.cacheReadTokens) - (a.inputTokens + a.outputTokens + a.cacheReadTokens)
      || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
    return {
      from, to,
      total: mergeRows([...byKey.values()]),
      rows: [...byKey.values()].map(finishStats).sort(order),
      sources: SOURCES.flatMap((source) => {
        const bucket = [...(bySource.get(source)?.values() ?? [])];
        return bucket.length ? [{ source, total: mergeRows(bucket), rows: bucket.map(finishStats).sort(order) }] : [];
      }),
    };
  }

  /** Everything the statistics page shows for one range; the same range for usage and incidents. */
  state(range: ExecutionStatsRange): ExecutionStatsInfo {
    this.flush();
    return {
      period: this.period(range),
      incidents: this.input.incidents.counts(rangeStart(range, this.now())),
      models: this.input.models(),
      recording: this.recordEnabled(),
      memoryAccess: this.memoryAccess(),
    };
  }
}

/** Unknown rows contribute totals only; the hit rate comes from the merged counters, never a mean of means. */
function mergeRows(rows: ModelUsageStats[]): ModelUsageStats {
  const total = rows.reduce((sum, row) => {
    sum.requests += row.requests;
    sum.inputTokens += row.inputTokens;
    sum.outputTokens += row.outputTokens;
    sum.cacheReadTokens += row.cacheReadTokens;
    sum.cacheWriteTokens += row.cacheWriteTokens;
    sum.cacheObservedTokens += row.cacheObservedTokens;
    sum.cacheObservedRequests += row.cacheObservedRequests;
    sum.cacheObservedReadTokens += row.cacheObservedReadTokens;
    return sum;
  }, emptyStats("", ""));
  return finishStats(total);
}

