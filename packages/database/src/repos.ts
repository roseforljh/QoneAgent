import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { sessions, messages, runs, subagentRuns, subagentMessages, turns, toolCalls, workspaces, settings, mcpServers, modelConfigs, events, artifacts, permissionRules, plugins, skills, goals, goalEvents } from "./schema.js";
import type { Db } from "./index.js";
import type { AssistantMessagePart, GoalInfo, GoalStatus, MessageAttachmentInfo, QueueItemInfo, RunPermissionMode, RunThinkingLevel } from "@qone/protocol";

export class SessionRepo {
  constructor(private db: Db) {}

  create(title = "New session", workspaceId?: string) {
    const now = Date.now();
    const row = {
      id: crypto.randomUUID(),
      title,
      workspaceId,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(sessions).values(row).run();
    return row;
  }

  get(id: string) {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  list() {
    return this.db.select().from(sessions).orderBy(desc(sessions.updatedAt)).all();
  }

  touch(id: string) {
    this.db
      .update(sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
  }

  rename(id: string, title: string) {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) throw new Error("session title cannot be empty");
    this.db.update(sessions).set({ title: normalizedTitle, updatedAt: Date.now() }).where(eq(sessions.id, id)).run();
    const session = this.get(id);
    if (!session) throw new Error(`session not found: ${id}`);
    return session;
  }

  delete(id: string) {
    const childIds = this.db.select({ runId: subagentRuns.runId }).from(subagentRuns).where(eq(subagentRuns.parentSessionId, id)).all().map((row) => row.runId);
    if (childIds.length) this.db.delete(runs).where(inArray(runs.id, childIds)).run();
    this.db.delete(sessions).where(eq(sessions.id, id)).run();
  }
}

export class MessageRepo {
  constructor(private db: Db) {}

  add(sessionId: string, role: string, content: string, runId?: string, model?: string, messageId?: string, attachments?: MessageAttachmentInfo[], parts?: AssistantMessagePart[], goalId?: string) {
    const now = Date.now();
    const row = {
      id: messageId ?? crypto.randomUUID(),
      sessionId,
      runId,
      role,
      content,
      parts: parts ? JSON.stringify(parts) : null,
      attachments: attachments?.length ? JSON.stringify(attachments) : null,
      model,
      goalId: goalId ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(messages).values(row).run();
    return row;
  }

  listBySession(sessionId: string) {
    return this.db
      .select()
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt, sql`rowid`)
      .all();
  }

  /** Replace a user turn and everything after it as one database operation. */
  truncateFrom(sessionId: string, messageId: string) {
    return this.db.transaction((tx) => {
      const history = tx.select().from(messages).where(eq(messages.sessionId, sessionId))
        .orderBy(messages.createdAt, sql`rowid`).all();
      const index = history.findIndex((message) => message.id === messageId && message.role === "user");
      if (index < 0) throw new Error("user message not found in session");
      const removed = history.slice(index);
      const runIds = [...new Set(removed.flatMap((message) => message.runId ? [message.runId] : []))];
      tx.delete(messages).where(inArray(messages.id, removed.map((message) => message.id))).run();
      if (runIds.length) {
        const descendants = new Set(runIds);
        const children = tx.select().from(subagentRuns).where(eq(subagentRuns.parentSessionId, sessionId)).all();
        for (let changed = true; changed;) {
          changed = false;
          for (const child of children) if (descendants.has(child.parentRunId) && !descendants.has(child.runId)) {
            descendants.add(child.runId);
            changed = true;
          }
        }
        const childRunIds = [...descendants].filter(id => !runIds.includes(id));
        if (childRunIds.length) {
          tx.delete(events).where(inArray(events.runId, childRunIds)).run();
          tx.delete(runs).where(inArray(runs.id, childRunIds)).run();
        }
        tx.delete(events).where(inArray(events.runId, runIds)).run();
        tx.delete(runs).where(inArray(runs.id, runIds)).run();
      }
      return runIds;
    });
  }

  addAssistant(sessionId: string, content: string, runId?: string, model?: string, parts?: AssistantMessagePart[], goalId?: string) {
    return this.add(sessionId, "assistant", content, runId, model, undefined, undefined, parts, goalId);
  }
}

export class SubagentRunRepo {
  constructor(private db: Db) {}

  create(input: { runId: string; parentSessionId: string; parentRunId: string; parentSubagentId?: string; depth?: number; toolCallId: string; executionSessionId?: string; profileId?: string; title: string; task: string; model?: string; permissionMode?: "ask" | "auto" | "full"; tools?: string[]; workflowId?: string; workflowStepId?: string; dependsOn?: string[]; contextMode?: "task-only" | "snapshot"; contextMessageCount?: number }) {
    this.db.insert(subagentRuns).values({
      runId: input.runId, parentSessionId: input.parentSessionId, parentRunId: input.parentRunId,
      parentSubagentId: input.parentSubagentId ?? null, depth: input.depth ?? 0, toolCallId: input.toolCallId,
      executionSessionId: input.executionSessionId ?? null, profileId: input.profileId ?? null, title: input.title, task: input.task,
      model: input.model ?? null, permissionMode: input.permissionMode ?? null, tools: input.tools ? JSON.stringify(input.tools) : null,
      workflowId: input.workflowId ?? null, workflowStepId: input.workflowStepId ?? null,
      dependsOn: input.dependsOn?.length ? JSON.stringify(input.dependsOn) : null,
      contextMode: input.contextMode ?? "snapshot", contextMessageCount: input.contextMessageCount ?? 0,
    }).run();
  }

  save(runId: string, content: string, parts: AssistantMessagePart[]) {
    this.db.update(subagentRuns).set({ content, parts: JSON.stringify(parts) }).where(eq(subagentRuns.runId, runId)).run();
  }

  incrementTurn(runId: string) {
    this.db.update(subagentRuns).set({ turnCount: sql`${subagentRuns.turnCount} + 1` }).where(eq(subagentRuns.runId, runId)).run();
  }

  incrementRetry(runId: string) {
    this.db.update(subagentRuns).set({ retryCount: sql`${subagentRuns.retryCount} + 1` }).where(eq(subagentRuns.runId, runId)).run();
  }

  updateExecutionSession(runId: string, executionSessionId: string) {
    this.db.update(subagentRuns).set({ executionSessionId }).where(eq(subagentRuns.runId, runId)).run();
  }

  updateUsage(runId: string, usage: unknown) {
    const row = this.get(runId);
    const previous = row?.tokenUsage ? JSON.parse(row.tokenUsage) as Record<string, number> : {};
    const next = usage && typeof usage === "object" ? usage as Record<string, number> : {};
    const merged = {
      input: (previous.input ?? 0) + (next.input ?? 0),
      output: (previous.output ?? 0) + (next.output ?? 0),
      cacheRead: (previous.cacheRead ?? 0) + (next.cacheRead ?? 0),
      cacheWrite: (previous.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
      total: (previous.total ?? 0) + (next.total ?? 0),
      cost: (previous.cost ?? 0) + (next.cost ?? 0),
    };
    this.db.update(subagentRuns).set({ tokenUsage: JSON.stringify(merged) }).where(eq(subagentRuns.runId, runId)).run();
    return merged;
  }

  appendMessage(runId: string, role: string, content: string, parts?: AssistantMessagePart[], rawMessage?: unknown) {
    const last = this.db.select({ sequence: subagentMessages.sequence }).from(subagentMessages)
      .where(eq(subagentMessages.subagentRunId, runId)).orderBy(desc(subagentMessages.sequence)).get();
    this.db.insert(subagentMessages).values({
      id: crypto.randomUUID(), subagentRunId: runId, sequence: (last?.sequence ?? -1) + 1,
      role, content, parts: parts ? JSON.stringify(parts) : null, createdAt: Date.now(),
      rawMessage: rawMessage ? JSON.stringify(rawMessage) : null,
    }).run();
  }

  listMessages(runId: string) {
    return this.db.select().from(subagentMessages).where(eq(subagentMessages.subagentRunId, runId)).orderBy(subagentMessages.sequence).all();
  }

  get(runId: string) {
    return this.db.select().from(subagentRuns).where(eq(subagentRuns.runId, runId)).get();
  }

  getByExecutionSession(executionSessionId: string) {
    return this.db.select().from(subagentRuns).where(eq(subagentRuns.executionSessionId, executionSessionId)).get();
  }

  listBySession(sessionId: string) {
    return this.db.select().from(subagentRuns).where(eq(subagentRuns.parentSessionId, sessionId)).all();
  }
}

export class RunRepo {
  constructor(private db: Db) {}

  create(sessionId: string, input: { origin?: string; goalId?: string; goalEpoch?: number } = {}) {
    const row = {
      id: crypto.randomUUID(),
      sessionId,
      status: "running",
      startedAt: Date.now(),
      completedAt: null as number | null,
      error: null as string | null,
      origin: input.origin ?? "manual",
      goalId: input.goalId ?? null,
      goalEpoch: input.goalEpoch ?? null,
    };
    this.db.insert(runs).values(row).run();
    return row;
  }

  finish(id: string, status: "completed" | "failed" | "cancelled" | "interrupted", error?: string) {
    this.db
      .update(runs)
      .set({ status, completedAt: Date.now(), error: error ?? null })
      .where(eq(runs.id, id))
      .run();
  }

  setStatus(id: string, status: "created" | "running" | "waiting_approval" | "paused") {
    this.db.update(runs).set({ status, completedAt: null, error: null }).where(eq(runs.id, id)).run();
  }

  get(id: string) {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  // On boot: any run still marked running was killed with the process.
  markInterrupted() {
    this.db
      .update(runs)
      .set({ status: "interrupted", completedAt: Date.now() })
      .where(sql`${runs.status} IN ('created', 'running', 'waiting_approval', 'paused')`)
      .run();
  }

  listBySession(sessionId: string) {
    return this.db.select().from(runs).where(eq(runs.sessionId, sessionId)).orderBy(desc(runs.startedAt)).all();
  }
}

export class GoalRepo {
  constructor(private db: Db) {}

  private static parseOptions(value: string | null | undefined): GoalRunOptions {
    if (!value) return {};
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      return {
        model: typeof parsed.model === "string" ? parsed.model : undefined,
        permissionMode: parsed.permissionMode === "ask" || parsed.permissionMode === "auto" || parsed.permissionMode === "full"
          ? parsed.permissionMode
          : undefined,
        thinking: typeof parsed.thinking === "string" ? parsed.thinking as RunThinkingLevel : undefined,
      };
    } catch {
      return {};
    }
  }

  private info(row: typeof goals.$inferSelect): GoalInfo {
    return {
      id: row.id, sessionId: row.sessionId, objective: row.objective,
      status: row.status as GoalStatus, waitingReason: row.waitingReason ?? undefined,
      waitingUntil: row.waitingUntil ?? undefined, stopReason: row.stopReason ?? undefined,
      epoch: row.epoch, createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  getBySession(sessionId: string) {
    const row = this.db.select().from(goals).where(eq(goals.sessionId, sessionId)).orderBy(desc(goals.updatedAt)).get();
    return row ? this.info(row) : undefined;
  }

  create(sessionId: string, objective: string, options: GoalRunOptions = {}) {
    const now = Date.now();
    const row = { id: crypto.randomUUID(), sessionId, objective: objective.trim(), status: "active", waitingReason: null, waitingUntil: null, stopReason: null, runOptions: JSON.stringify(options), epoch: 1, createdAt: now, updatedAt: now };
    this.db.insert(goals).values(row).run();
    this.event(row.id, sessionId, "created", { objective: row.objective });
    return this.info(row);
  }

  update(id: string, patch: { status?: GoalStatus; waitingReason?: string | null; waitingUntil?: number | null; stopReason?: string | null; objective?: string; bumpEpoch?: boolean }) {
    const current = this.db.select().from(goals).where(eq(goals.id, id)).get();
    if (!current) throw new Error(`goal not found: ${id}`);
    const nextEpoch = patch.bumpEpoch ? current.epoch + 1 : current.epoch;
    this.db.update(goals).set({
      status: patch.status ?? current.status,
      waitingReason: patch.waitingReason === undefined ? current.waitingReason : patch.waitingReason,
      waitingUntil: patch.waitingUntil === undefined ? current.waitingUntil : patch.waitingUntil,
      stopReason: patch.stopReason === undefined ? current.stopReason : patch.stopReason,
      objective: patch.objective ?? current.objective, epoch: nextEpoch, updatedAt: Date.now(),
    }).where(eq(goals.id, id)).run();
    return this.get(id)!;
  }

  get(id: string) { const row = this.db.select().from(goals).where(eq(goals.id, id)).get(); return row ? this.info(row) : undefined; }
  getOptions(id: string): GoalRunOptions {
    const row = this.db.select({ runOptions: goals.runOptions }).from(goals).where(eq(goals.id, id)).get();
    return GoalRepo.parseOptions(row?.runOptions);
  }
  delete(id: string) { this.db.delete(goals).where(eq(goals.id, id)).run(); }
  deleteForSession(sessionId: string) { this.db.delete(goals).where(eq(goals.sessionId, sessionId)).run(); }
  event(goalId: string, sessionId: string, type: string, payload: unknown, runId?: string) {
    this.db.insert(goalEvents).values({ id: crypto.randomUUID(), goalId, sessionId, runId: runId ?? null, type, payload: JSON.stringify(payload ?? {}), createdAt: Date.now() }).run();
  }
}

export interface GoalRunOptions {
  model?: string;
  permissionMode?: RunPermissionMode;
  thinking?: RunThinkingLevel;
}

export class TurnRepo {
  constructor(private db: Db) {}

  create(runId: string, sequence = 0) {
    const row = {
      id: crypto.randomUUID(),
      runId,
      sequence,
      status: "running",
      startedAt: Date.now(),
      completedAt: null as number | null,
    };
    this.db.insert(turns).values(row).run();
    return row;
  }

  finish(id: string, status: "completed" | "failed" | "cancelled" | "interrupted") {
    this.db.update(turns).set({ status, completedAt: Date.now() }).where(eq(turns.id, id)).run();
  }

  markInterrupted() {
    this.db.update(turns).set({ status: "interrupted", completedAt: Date.now() }).where(eq(turns.status, "running")).run();
  }

  listByRun(runId: string) {
    return this.db.select().from(turns).where(eq(turns.runId, runId)).orderBy(turns.sequence).all();
  }
}

export class ToolCallRepo {
  constructor(private db: Db) {}

  start(runId: string, toolName: string, args?: unknown, toolCallId?: string) {
    const row = {
      id: toolCallId ? `${runId}:${toolCallId}` : crypto.randomUUID(),
      runId,
      toolName,
      arguments: args === undefined ? null : JSON.stringify(args),
      resultSummary: null,
      status: "running",
      startedAt: Date.now(),
      completedAt: null as number | null,
    };
    this.db.insert(toolCalls).values(row).run();
    return row;
  }

  setStatus(id: string, status: "running" | "waiting_approval") {
    this.db.update(toolCalls).set({ status }).where(eq(toolCalls.id, id)).run();
  }

  finish(id: string, status: "success" | "failed" | "cancelled", result?: unknown) {
    this.db
      .update(toolCalls)
      .set({
        status,
        resultSummary: result === undefined ? null : JSON.stringify(result).slice(0, 20_000),
        completedAt: Date.now(),
      })
      .where(eq(toolCalls.id, id))
      .run();
  }

  markInterrupted() {
    this.db.update(toolCalls).set({ status: "cancelled", completedAt: Date.now() })
      .where(sql`${toolCalls.status} IN ('queued', 'running', 'waiting_approval')`).run();
  }

  listByRun(runId: string) {
    return this.db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(toolCalls.startedAt).all();
  }

  listBySession(sessionId: string) {
    return this.db.select({
      id: toolCalls.id, runId: toolCalls.runId, toolName: toolCalls.toolName,
      arguments: toolCalls.arguments, resultSummary: toolCalls.resultSummary,
      status: toolCalls.status, startedAt: toolCalls.startedAt, completedAt: toolCalls.completedAt,
    }).from(toolCalls).innerJoin(runs, eq(toolCalls.runId, runs.id)).where(eq(runs.sessionId, sessionId)).orderBy(toolCalls.startedAt).all();
  }
}

export class WorkspaceRepo {
  constructor(private db: Db) {}

  upsert(name: string, path: string) {
    const existing = this.db.select().from(workspaces).where(eq(workspaces.path, path)).get();
    const now = Date.now();
    if (existing) {
      this.db.update(workspaces).set({ name, updatedAt: now }).where(eq(workspaces.id, existing.id)).run();
      return { ...existing, name, updatedAt: now };
    }
    const row = { id: crypto.randomUUID(), name, path, createdAt: now, updatedAt: now };
    this.db.insert(workspaces).values(row).run();
    return row;
  }

  list() {
    return this.db.select().from(workspaces).orderBy(desc(workspaces.updatedAt)).all();
  }

  get(id: string) {
    return this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
  }

  rename(id: string, name: string) {
    const now = Date.now();
    this.db.update(workspaces).set({ name, updatedAt: now }).where(eq(workspaces.id, id)).run();
    const workspace = this.get(id);
    if (!workspace) throw new Error(`workspace not found: ${id}`);
    return workspace;
  }

  delete(id: string) {
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
  }
}

export class SettingsRepo {
  constructor(private db: Db) {}

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return row.value as T; }
  }

  set(key: string, value: unknown) {
    const row = { key, value: JSON.stringify(value), updatedAt: Date.now() };
    this.db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: { value: row.value, updatedAt: row.updatedAt } }).run();
  }
}

/** Queue state uses the existing settings store so it follows the runtime's
 * single SQLite persistence path and survives process restarts. */
export class QueueRepo {
  // Removal is terminal (sent, steered in or deleted). A client snapshot taken
  // before it saw the removal must not bring the item back and send it twice.
  // ponytail: in-memory for the runtime lifetime; ids are tiny and stale
  // snapshots only exist for the IPC round-trip.
  private consumed = new Set<string>();

  constructor(private settingsRepo: SettingsRepo) {}

  list(sessionId: string): QueueItemInfo[] {
    const items = this.settingsRepo.get<QueueItemInfo[]>(`queue:${sessionId}`);
    return Array.isArray(items)
      ? items.filter((item) => item && item.sessionId === sessionId).sort((a, b) => a.position - b.position)
      : [];
  }

  upsert(item: QueueItemInfo): QueueItemInfo[] {
    const items = this.list(item.sessionId).filter((candidate) => candidate.id !== item.id);
    if (this.consumed.has(item.id)) return items;
    items.push({ ...item, updatedAt: Date.now() });
    const normalized = items.map((candidate, position) => ({ ...candidate, position }));
    this.settingsRepo.set(`queue:${item.sessionId}`, normalized);
    return normalized;
  }

  replace(sessionId: string, next: QueueItemInfo[]): QueueItemInfo[] {
    const normalized = next
      .filter((item) => item.sessionId === sessionId && !this.consumed.has(item.id))
      .sort((a, b) => a.position - b.position)
      .map((item, position) => ({ ...item, position }));
    this.settingsRepo.set(`queue:${sessionId}`, normalized);
    return normalized;
  }

  remove(sessionId: string, itemId: string): QueueItemInfo[] {
    this.consumed.add(itemId);
    const items = this.list(sessionId).filter((item) => item.id !== itemId).map((item, position) => ({ ...item, position }));
    this.settingsRepo.set(`queue:${sessionId}`, items);
    return items;
  }
}

export class McpServerRepo {
  constructor(private db: Db) {}

  upsert(config: { id: string; name: string; command?: string; url?: string; tokenEnv?: string; args?: string[]; env?: Record<string, string>; authMode?: "oauth" | "github-device"; oauthClientId?: string; oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string; scopes?: string[]; redirectUri?: string; tokenSecretKey?: string } }) {
    const now = Date.now();
    // Environment values may contain API keys. Persist only explicit $ENV
    // references; the live connection may still use the supplied value once.
    const persisted = config.env
      ? { ...config, env: Object.fromEntries(Object.entries(config.env).filter(([, value]) => value.startsWith("$"))) }
      : config;
    const row = { id: config.id, name: config.name, config: JSON.stringify(persisted), enabled: true, updatedAt: now };
    this.db.insert(mcpServers).values(row).onConflictDoUpdate({
      target: mcpServers.id,
      set: { name: row.name, config: row.config, enabled: true, updatedAt: now },
    }).run();
    return row;
  }

  list() {
    return this.db.select().from(mcpServers).where(eq(mcpServers.enabled, true)).all().flatMap((row) => {
      try { return [JSON.parse(row.config) as { id: string; name: string; command?: string; url?: string; tokenEnv?: string; args?: string[]; env?: Record<string, string>; authMode?: "oauth" | "github-device"; oauthClientId?: string; oauth?: { authorizationUrl: string; tokenUrl: string; clientId: string; scopes?: string[]; redirectUri?: string; tokenSecretKey?: string } }]; }
      catch { return []; }
    });
  }

  delete(id: string) {
    this.db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
  }
}

export class ModelConfigRepo {
  constructor(private db: Db) {}

  list() {
    return this.db.select().from(modelConfigs).where(eq(modelConfigs.enabled, true)).orderBy(desc(modelConfigs.updatedAt)).all().map((row) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      config: JSON.parse(row.config) as Record<string, unknown>,
      enabled: row.enabled,
      updatedAt: row.updatedAt,
    }));
  }

  upsert(config: { id?: string; provider: string; model: string; config?: Record<string, unknown> }) {
    const id = config.id ?? `${config.provider}/${config.model}`;
    const now = Date.now();
    const row = { id, provider: config.provider, model: config.model, config: JSON.stringify(config.config ?? {}), enabled: true, updatedAt: now };
    this.db.insert(modelConfigs).values(row).onConflictDoUpdate({
      target: modelConfigs.id,
      set: { provider: row.provider, model: row.model, config: row.config, enabled: true, updatedAt: now },
    }).run();
    return { ...row, config: config.config ?? {} };
  }

  delete(id: string) {
    this.db.delete(modelConfigs).where(eq(modelConfigs.id, id)).run();
  }
}

export interface StoredEvent {
  eventId: string;
  sessionId?: string;
  runId?: string;
  sequence: number;
  type: string;
  timestamp: number;
  payload: unknown;
}

export class EventRepo {
  constructor(private db: Db) {}

  add(event: StoredEvent) {
    this.db.insert(events).values({
      eventId: event.eventId,
      sessionId: event.sessionId,
      runId: event.runId,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      payload: JSON.stringify(event.payload),
    }).onConflictDoUpdate({
      target: events.eventId,
      set: { sessionId: event.sessionId, runId: event.runId, sequence: event.sequence, type: event.type, timestamp: event.timestamp, payload: JSON.stringify(event.payload) },
    }).run();
  }

  addMany(items: readonly StoredEvent[]) {
    if (items.length === 0) return;
    this.db.transaction((tx) => {
      for (const event of items) {
        tx.insert(events).values({
          eventId: event.eventId, sessionId: event.sessionId, runId: event.runId,
          sequence: event.sequence, type: event.type, timestamp: event.timestamp,
          payload: JSON.stringify(event.payload),
        }).onConflictDoUpdate({
          target: events.eventId,
          set: { sessionId: event.sessionId, runId: event.runId, sequence: event.sequence, type: event.type, timestamp: event.timestamp, payload: JSON.stringify(event.payload) },
        }).run();
      }
    });
  }

  list(limit = 2000): StoredEvent[] {
    return this.db.select().from(events).orderBy(desc(events.sequence)).limit(limit).all().reverse().flatMap((row) => {
      try {
        return [{ eventId: row.eventId, sessionId: row.sessionId ?? undefined, runId: row.runId ?? undefined, sequence: row.sequence, type: row.type, timestamp: row.timestamp, payload: JSON.parse(row.payload) }];
      } catch {
        return [];
      }
    });
  }

  listCompactions(sessionId: string): { id: string; throughMessageId: string; createdAt: number; status: "completed" | "interrupted"; source: "manual" | "automatic" }[] {
    return this.db.select().from(events)
      .where(and(eq(events.sessionId, sessionId), inArray(events.type, ["context.compacted", "context.compaction.interrupted"])))
      .orderBy(events.sequence).all().flatMap((row) => {
        try {
          const payload: unknown = JSON.parse(row.payload);
          if (!payload || typeof payload !== "object") return [];
          const { id, throughMessageId, createdAt, source } = payload as { id?: unknown; throughMessageId?: unknown; createdAt?: unknown; source?: unknown };
          return typeof id === "string" && typeof throughMessageId === "string"
            ? [{ id, throughMessageId, createdAt: typeof createdAt === "number" ? createdAt : row.timestamp, status: row.type === "context.compacted" ? "completed" as const : "interrupted" as const, source: source === "automatic" ? "automatic" as const : "manual" as const }]
            : [];
        } catch { return []; }
      });
  }
}

export class ArtifactRepo {
  constructor(private db: Db) {}

  add(input: { id?: string; sessionId: string; runId?: string; type: string; name: string; path: string; mimeType?: string; size?: number }) {
    const row = { ...input, id: input.id ?? crypto.randomUUID(), runId: input.runId ?? null, mimeType: input.mimeType ?? null, size: input.size ?? null, createdAt: Date.now() };
    this.db.insert(artifacts).values(row).run();
    return row;
  }

  listBySession(sessionId: string) {
    return this.db.select().from(artifacts).where(eq(artifacts.sessionId, sessionId)).orderBy(desc(artifacts.createdAt)).all();
  }

  deleteByRunIds(sessionId: string, runIds: string[]) {
    if (!runIds.length) return [];
    const where = and(eq(artifacts.sessionId, sessionId), inArray(artifacts.runId, runIds));
    const removed = this.db.select().from(artifacts).where(where).all();
    this.db.delete(artifacts).where(where).run();
    return removed;
  }

  delete(id: string) {
    this.db.delete(artifacts).where(eq(artifacts.id, id)).run();
  }
}

export type PermissionDecision = "allow" | "ask" | "deny";

export class PermissionRepo {
  constructor(private db: Db) {}

  list() {
    return this.db.select().from(permissionRules).orderBy(permissionRules.subjectId, permissionRules.permission).all();
  }

  get(subjectId: string, permission: string): PermissionDecision | undefined {
    return this.db.select().from(permissionRules)
      .where(eq(permissionRules.subjectId, subjectId))
      .all()
      .find((row) => row.permission === permission)?.decision as PermissionDecision | undefined;
  }

  set(subjectId: string, permission: string, decision: PermissionDecision) {
    const row = { subjectId, permission, decision, updatedAt: Date.now() };
    this.db.insert(permissionRules).values(row).onConflictDoUpdate({
      target: [permissionRules.subjectId, permissionRules.permission],
      set: { decision, updatedAt: row.updatedAt },
    }).run();
    return row;
  }

  ensure(subjectId: string, permission: string, decision: PermissionDecision) {
    if (this.get(subjectId, permission) === undefined) return this.set(subjectId, permission, decision);
    return undefined;
  }
}

export class PluginRepo {
  constructor(private db: Db) {}

  upsert(manifest: { id: string; name: string; version: string; description?: string; entry?: string; permissions?: string[] }) {
    const now = Date.now();
    const row = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      manifest: JSON.stringify(manifest),
      enabled: true,
      updatedAt: now,
    };
    this.db.insert(plugins).values(row).onConflictDoUpdate({
      target: plugins.id,
      set: { name: row.name, version: row.version, manifest: row.manifest, enabled: true, updatedAt: now },
    }).run();
    return row;
  }

  list() { return this.db.select().from(plugins).orderBy(desc(plugins.updatedAt)).all(); }
}

export class SkillRepo {
  constructor(private db: Db) {}

  upsert(skill: { id: string; name: string; path: string; description?: string }) {
    const row = {
      id: skill.id,
      name: skill.name,
      path: skill.path,
      description: skill.description ?? null,
      enabled: true,
      updatedAt: Date.now(),
    };
    this.db.insert(skills).values(row).onConflictDoUpdate({
      target: skills.id,
      set: { name: row.name, path: row.path, description: row.description, enabled: true, updatedAt: row.updatedAt },
    }).run();
    return row;
  }

  list() { return this.db.select().from(skills).where(eq(skills.enabled, true)).orderBy(skills.name).all(); }
}
