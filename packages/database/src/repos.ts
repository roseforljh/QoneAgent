import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { sessions, messages, runs, subagentRuns, subagentNotifications, subagentMessages, turns, toolCalls, workspaces, settings, events, artifacts, plugins, skills, goals, goalEvents } from "./schema.js";
import type { Db } from "./index.js";
import { persistedToolResult, type AgentCommunicationInfo, type CompactionMarkerInfo, type AssistantMessagePart, type GoalInfo, type GoalStatus, type MessageAttachmentInfo, type QueueItemInfo, type RunPermissionMode, type RunThinkingLevel, type SubagentNotificationInfo, type SubagentDependencyState, type SubagentFailureKind } from "@qone/protocol";

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
      lastUserMessageAt: now,
    };
    this.db.insert(sessions).values(row).run();
    return row;
  }

  get(id: string) {
    return this.db.select().from(sessions).where(eq(sessions.id, id)).get();
  }

  list(workspaceId?: string) {
    return this.db.select().from(sessions).where(workspaceId ? eq(sessions.workspaceId, workspaceId) : undefined).orderBy(desc(sessions.updatedAt)).all();
  }

  /** Stream only search text; retain Unicode folding without loading transcripts. */
  search(query: string, limit = 50, scope?: { workspaceId: string; excludeId: string }) {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle || limit <= 0) return [];
    const rows = this.db.select().from(sessions)
      .where(and(
        isNotNull(sessions.workspaceId),
        sql`EXISTS (SELECT 1 FROM ${workspaces} WHERE ${workspaces.id} = ${sessions.workspaceId})`,
        scope ? and(eq(sessions.workspaceId, scope.workspaceId), sql`${sessions.id} != ${scope.excludeId}`) : undefined,
      ))
      .orderBy(desc(sessions.updatedAt), sql`${sessions}.rowid DESC`)
      .all();
    if (!rows.length) return [];
    const ranks = new Map(rows.map((session, index) => [session.id, index]));
    const results: { session: typeof rows[number]; match: "title" | "content"; content?: string }[] = [];
    const matched = new Set<string>();
    for (const session of rows) {
      if (!session.title.toLocaleLowerCase().includes(needle)) continue;
      results.push({ session, match: "title" });
      matched.add(session.id);
      if (results.length >= limit) break;
    }
    let lastRank = results.length >= limit ? ranks.get(results.at(-1)!.session.id)! : rows.length;
    // CROSS JOIN fixes the traversal order: indexed sessions, then indexed
    // messages. SQLite can stream this order without sorting all message text.
    // lower() cannot replace JS folding: even ASCII "k" must match Unicode K.
    const cursor = this.db.$client.prepare(`
      SELECT s.id AS sessionId, m.content
      FROM sessions s
      CROSS JOIN workspaces w ON w.id = s.workspace_id
      CROSS JOIN messages m ON m.session_id = s.id
      ${scope ? "WHERE s.workspace_id = ? AND s.id != ? AND m.communication IS NULL AND m.role IN ('user', 'assistant')" : ""}
      ORDER BY s.updated_at DESC, s.rowid DESC, m.created_at ASC, m.rowid ASC
    `);
    for (const row of cursor.iterate(...(scope ? [scope.workspaceId, scope.excludeId] : [])) as Iterable<{ sessionId: string; content: string }>) {
      const rank = ranks.get(row.sessionId)!;
      if (rank > lastRank) break;
      if (matched.has(row.sessionId) || !row.content.toLocaleLowerCase().includes(needle)) continue;
      const position = results.findIndex((result) => ranks.get(result.session.id)! > rank);
      results.splice(position < 0 ? results.length : position, 0, { session: rows[rank]!, match: "content", content: row.content });
      matched.add(row.sessionId);
      if (results.length > limit) matched.delete(results.pop()!.session.id);
      if (results.length >= limit) lastRank = ranks.get(results.at(-1)!.session.id)!;
    }
    return results;
  }

  touch(id: string) {
    this.db
      .update(sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(sessions.id, id))
      .run();
  }

  touchUserMessage(id: string, at = Date.now()) {
    this.db
      .update(sessions)
      .set({ updatedAt: at, lastUserMessageAt: at })
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

  hasUserMessage(sessionId: string, messageId: string): boolean {
    return Boolean(this.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.sessionId, sessionId), eq(messages.role, "user"))).get());
  }

  add(sessionId: string, role: string, content: string, runId?: string, model?: string, messageId?: string, attachments?: MessageAttachmentInfo[], parts?: AssistantMessagePart[], goalId?: string, quote?: { text: string; messageId: string }, rawMessage?: unknown, communication?: AgentCommunicationInfo) {
    const now = Date.now();
    const row = {
      id: messageId ?? crypto.randomUUID(),
      sessionId,
      runId,
      role,
      content,
      quote: quote ? JSON.stringify(quote) : null,
      communication: communication ? JSON.stringify(communication) : null,
      parts: parts ? JSON.stringify(parts) : null,
      rawMessage: rawMessage === undefined ? null : JSON.stringify(rawMessage),
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

  /** 界面展示消息列表不读取 raw_message 大字段，避免无意义的磁盘 overflow 页读取。 */
  listForDisplay(sessionId: string) {
    return this.db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        runId: messages.runId,
        role: messages.role,
        content: messages.content,
        quote: messages.quote,
        communication: messages.communication,
        parts: messages.parts,
        attachments: messages.attachments,
        model: messages.model,
        goalId: messages.goalId,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
      })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt, sql`rowid`)
      .all();
  }

  /** 仅读取消息轻量元数据（不含 parts 与 raw_message），用于边界定位与去重检查。 */
  listMetaBySession(sessionId: string) {
    return this.db
      .select({
        id: messages.id,
        sessionId: messages.sessionId,
        runId: messages.runId,
        role: messages.role,
        content: messages.content,
        communication: messages.communication,
        attachments: messages.attachments,
        hasRawMessage: sql<number>`CASE WHEN ${messages.rawMessage} IS NOT NULL THEN 1 ELSE 0 END`,
        createdAt: messages.createdAt,
        updatedAt: messages.updatedAt,
      })
      .from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt, sql`rowid`)
      .all();
  }

  /** 仅加载上下文恢复所需的消息列；当压缩检查点仍存在时跳过检查点之前的历史行。 */
  listForContextRestore(sessionId: string, afterMessageId?: string) {
    const boundary = afterMessageId
      ? this.db.select({ createdAt: messages.createdAt, rowid: sql<number>`rowid` })
        .from(messages)
        .where(and(eq(messages.sessionId, sessionId), eq(messages.id, afterMessageId)))
        .get()
      : undefined;
    const where = boundary
      ? and(
        eq(messages.sessionId, sessionId),
        sql`(${messages.createdAt} > ${boundary.createdAt} OR (${messages.createdAt} = ${boundary.createdAt} AND rowid > ${boundary.rowid}))`,
      )
      : eq(messages.sessionId, sessionId);
    const rows = this.db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        runId: messages.runId,
        communication: messages.communication,
        attachments: messages.attachments,
        rawMessage: messages.rawMessage,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(where)
      .orderBy(messages.createdAt, sql`rowid`)
      .all();
    return { rows, slicedAfterBoundary: Boolean(boundary) };
  }

  /** Memory needs only visible conversation text; tool transcripts and UI notices are not input. */
  visibleTextBySession(sessionId: string) {
    return this.db.select({ role: messages.role, content: messages.content }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.role, ["user", "assistant"]), sql`${messages.communication} IS NULL`))
      .orderBy(messages.createdAt, sql`rowid`).all();
  }

  hasPriorNativePrompt(sessionId: string, runId: string): boolean {
    return Boolean(this.db.select({ id: messages.id }).from(messages).where(and(eq(messages.sessionId, sessionId),
      eq(messages.role, "user"), sql`${messages.runId} IS NOT ${runId}`, isNotNull(messages.rawMessage), sql`${messages.communication} IS NULL`)).get());
  }

  setRawMessage(id: string, rawMessage: unknown) {
    this.db.update(messages).set({ rawMessage: JSON.stringify(rawMessage), updatedAt: Date.now() }).where(eq(messages.id, id)).run();
  }

  /** 清空压缩检查点之前（含锚点）的助手消息 raw_message；检查点之后及用户消息保持原样，不影响连续对话缓存。 */
  pruneCompactedRawMessages(sessionId: string, throughMessageId: string) {
    const boundary = this.db.select({ createdAt: messages.createdAt, rowid: sql<number>`rowid` })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.id, throughMessageId)))
      .get();
    if (!boundary) return 0;
    const result = this.db.$client.prepare(`
      UPDATE messages
      SET raw_message = NULL
      WHERE session_id = ? AND role = 'assistant' AND raw_message IS NOT NULL
        AND (created_at < ? OR (created_at = ? AND rowid <= ?))
    `).run(sessionId, boundary.createdAt, boundary.createdAt, boundary.rowid);
    return Number(result.changes);
  }

  /** Replace a user turn and everything after it as one database operation. */
  truncateFrom(sessionId: string, messageId: string) {
    return this.db.transaction((tx) => {
      const history = tx.select({ id: messages.id, role: messages.role, runId: messages.runId }).from(messages).where(eq(messages.sessionId, sessionId))
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

  addAssistant(sessionId: string, content: string, runId?: string, model?: string, parts?: AssistantMessagePart[], goalId?: string, rawMessage?: unknown) {
    return this.add(sessionId, "assistant", content, runId, model, undefined, undefined, parts, goalId, undefined, rawMessage);
  }
}

export class SubagentRunRepo {
  constructor(private db: Db) {}

  create(input: { runId: string; parentSessionId: string; parentRunId: string; parentSubagentId?: string; depth?: number; toolCallId: string; executionSessionId?: string; background?: boolean; profileId?: string; mediaAttachment?: MessageAttachmentInfo & { temporary?: boolean }; title: string; task: string; model?: string; permissionMode?: "ask" | "auto" | "full"; tools?: string[]; serverIds?: string[]; workflowId?: string; workflowStepId?: string; dependsOn?: string[]; contextMode?: "task-only" | "snapshot"; contextMessageCount?: number; requiredBeforeFinal?: boolean }) {
    this.db.insert(subagentRuns).values({
      runId: input.runId, parentSessionId: input.parentSessionId, parentRunId: input.parentRunId,
      mediaAttachment: input.mediaAttachment ? JSON.stringify(input.mediaAttachment) : null,
      serverIds: JSON.stringify(input.serverIds ?? []),
      parentSubagentId: input.parentSubagentId ?? null, depth: input.depth ?? 0, toolCallId: input.toolCallId,
      executionSessionId: input.executionSessionId ?? null, background: input.background ?? false, profileId: input.profileId ?? null, title: input.title, task: input.task,
      model: input.model ?? null, permissionMode: input.permissionMode ?? null, tools: input.tools ? JSON.stringify(input.tools) : null,
      workflowId: input.workflowId ?? null, workflowStepId: input.workflowStepId ?? null,
      dependsOn: input.dependsOn?.length ? JSON.stringify(input.dependsOn) : null,
      contextMode: input.contextMode ?? "snapshot", contextMessageCount: input.contextMessageCount ?? 0,
      requiredBeforeFinal: input.requiredBeforeFinal ?? true,
      dependencyState: "pending", completionAcknowledged: false, failureKind: null,
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

  setDependencyState(runId: string, state: SubagentDependencyState, patch: { failureKind?: SubagentFailureKind | null; completionAcknowledged?: boolean } = {}) {
    this.db.update(subagentRuns).set({
      dependencyState: state,
      ...(patch.failureKind === undefined ? {} : { failureKind: patch.failureKind }),
      ...(patch.completionAcknowledged === undefined ? {} : { completionAcknowledged: patch.completionAcknowledged }),
    }).where(eq(subagentRuns.runId, runId)).run();
  }

  acknowledgeResult(runId: string, state: SubagentDependencyState) {
    this.setDependencyState(runId, state, { completionAcknowledged: true });
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

  appendMessage(runId: string, role: string, content: string, parts?: AssistantMessagePart[], rawMessage?: unknown, communication?: AgentCommunicationInfo) {
    const last = this.db.select({ sequence: subagentMessages.sequence }).from(subagentMessages)
      .where(eq(subagentMessages.subagentRunId, runId)).orderBy(desc(subagentMessages.sequence)).get();
    this.db.insert(subagentMessages).values({
      id: crypto.randomUUID(), subagentRunId: runId, sequence: (last?.sequence ?? -1) + 1,
      role, content, parts: parts ? JSON.stringify(parts) : null, createdAt: Date.now(),
      rawMessage: rawMessage ? JSON.stringify(rawMessage) : null,
      communication: communication ? JSON.stringify(communication) : null,
    }).run();
  }

  setRawMessage(id: string, rawMessage: unknown) {
    this.db.update(subagentMessages).set({ rawMessage: JSON.stringify(rawMessage) }).where(eq(subagentMessages.id, id)).run();
  }

  listMessages(runId: string) {
    return this.db.select().from(subagentMessages).where(eq(subagentMessages.subagentRunId, runId)).orderBy(subagentMessages.sequence).all();
  }

  latestMessage(runId: string) {
    return this.db.select().from(subagentMessages).where(eq(subagentMessages.subagentRunId, runId)).orderBy(desc(subagentMessages.sequence)).limit(1).get();
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

  list() {
    return this.db.select().from(subagentRuns).all();
  }

  listByParentRunId(parentRunId: string) {
    return this.db.select().from(subagentRuns).where(eq(subagentRuns.parentRunId, parentRunId)).all();
  }
}

export class SubagentNotificationRepo {
  constructor(private db: Db) {}

  private toInfo(row: typeof subagentNotifications.$inferSelect): SubagentNotificationInfo {
    return {
      id: row.id,
      sessionId: row.sessionId,
      subagentRunId: row.subagentRunId,
      version: row.version,
      kind: row.kind as SubagentNotificationInfo["kind"],
      status: row.status as SubagentNotificationInfo["status"],
      title: row.title,
      summaryPreview: row.summaryPreview ?? undefined,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt ?? undefined,
      acknowledgedAt: row.acknowledgedAt ?? undefined,
    };
  }

  enqueue(input: {
    sessionId: string;
    subagentRunId: string;
    version: number;
    kind: SubagentNotificationInfo["kind"];
    title: string;
    summaryPreview?: string;
  }): SubagentNotificationInfo {
    const id = `${input.subagentRunId}:${input.version}`;
    // Execution session IDs identify nested agents, not rows in sessions. The
    // foreign key always belongs to the child's root conversation.
    const child = this.db.select().from(subagentRuns).where(eq(subagentRuns.runId, input.subagentRunId)).get();
    this.db.insert(subagentNotifications).values({
      id,
      sessionId: child?.parentSessionId ?? input.sessionId,
      subagentRunId: input.subagentRunId,
      version: input.version,
      kind: input.kind,
      status: "pending",
      title: input.title,
      summaryPreview: input.summaryPreview ?? null,
      createdAt: Date.now(),
      deliveredAt: null,
      acknowledgedAt: null,
    }).onConflictDoNothing().run();
    return this.toInfoForRecipient(this.db.select().from(subagentNotifications).where(eq(subagentNotifications.id, id)).get()!);
  }

  private toInfoForRecipient(row: typeof subagentNotifications.$inferSelect): SubagentNotificationInfo {
    const child = this.db.select().from(subagentRuns).where(eq(subagentRuns.runId, row.subagentRunId)).get();
    const parent = child?.parentSubagentId
      ? this.db.select().from(subagentRuns).where(eq(subagentRuns.runId, child.parentRunId)).get() : undefined;
    return { ...this.toInfo(row), sessionId: parent?.executionSessionId ?? row.sessionId };
  }

  listBySession(sessionId: string, statuses: SubagentNotificationInfo["status"][] = ["pending", "delivered"]) {
    const owner = this.db.select().from(subagentRuns).where(eq(subagentRuns.executionSessionId, sessionId)).get();
    const children = this.db.select({ runId: subagentRuns.runId }).from(subagentRuns)
      .where(owner ? eq(subagentRuns.parentRunId, owner.runId)
        : and(eq(subagentRuns.parentSessionId, sessionId), sql`${subagentRuns.parentSubagentId} IS NULL`)).all();
    if (!children.length) return [];
    return this.db.select().from(subagentNotifications)
      .where(and(inArray(subagentNotifications.subagentRunId, children.map(child => child.runId)), inArray(subagentNotifications.status, statuses)))
      .orderBy(subagentNotifications.createdAt)
      .all()
      .map((row) => ({ ...this.toInfo(row), sessionId }));
  }

  listPending(sessionId: string) {
    return this.listBySession(sessionId, ["pending"]);
  }

  markDelivered(ids: string[]) {
    if (!ids.length) return;
    this.db.update(subagentNotifications)
      .set({ status: "delivered", deliveredAt: Date.now() })
      .where(inArray(subagentNotifications.id, ids)).run();
  }

  markPending(ids: string[]) {
    if (!ids.length) return;
    this.db.update(subagentNotifications)
      .set({ status: "pending", deliveredAt: null })
      .where(inArray(subagentNotifications.id, ids)).run();
  }

  acknowledgeByRunId(subagentRunId: string) {
    const sessionIds = this.db.select().from(subagentNotifications)
      .where(and(eq(subagentNotifications.subagentRunId, subagentRunId), inArray(subagentNotifications.status, ["pending", "delivered"])))
      .all()
      .map((row) => this.toInfoForRecipient(row).sessionId);
    this.db.update(subagentNotifications)
      .set({ status: "acknowledged", acknowledgedAt: Date.now() })
      .where(and(eq(subagentNotifications.subagentRunId, subagentRunId), inArray(subagentNotifications.status, ["pending", "delivered"]))).run();
    return [...new Set(sessionIds)];
  }

  listUnacknowledged(sessionId: string) {
    return this.listBySession(sessionId, ["pending", "delivered"]);
  }
}

export class RunRepo {
  constructor(private db: Db, private onFailure?: (id: string, timestamp: number, error?: string) => void) {}

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
    const timestamp = Date.now();
    const update = () => this.db.update(runs)
      .set({ status, completedAt: timestamp, error: error ?? null }).where(eq(runs.id, id)).run();
    if (status !== "failed" || !this.onFailure) { update(); return; }
    this.db.$client.transaction(() => {
      update();
      this.onFailure!(id, timestamp, error);
    }).immediate();
  }

  setModel(id: string, model: string) {
    this.db.update(runs).set({ model }).where(eq(runs.id, id)).run();
  }

  authorizeFinalization(id: string) {
    this.db.update(runs).set({ finalizationAuthorized: true }).where(eq(runs.id, id)).run();
  }

  revokeFinalization(id: string) {
    this.db.update(runs).set({ finalizationAuthorized: false }).where(eq(runs.id, id)).run();
  }

  isFinalizationAuthorized(id: string) {
    return Boolean(this.db.select({ authorized: runs.finalizationAuthorized }).from(runs).where(eq(runs.id, id)).get()?.authorized);
  }

  setStatus(id: string, status: "created" | "running" | "waiting_approval" | "paused") {
    this.db.update(runs).set({ status, completedAt: null, error: null }).where(eq(runs.id, id)).run();
  }

  get(id: string) {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  /** Runs a killed process left open; read before markInterrupted closes them. */
  listActive() {
    return this.db.select().from(runs).where(inArray(runs.status, ["created", "running", "waiting_approval", "paused"])).all();
  }

  // On boot: any run still marked running was killed with the process.
  markInterrupted() {
    this.db
      .update(runs)
      .set({ status: "interrupted", completedAt: Date.now() })
      .where(sql`${runs.status} IN ('created', 'running', 'waiting_approval', 'paused')`)
      .run();
  }

  activeSessionIds() {
    const active = this.db.selectDistinct({ id: runs.sessionId }).from(runs)
      .where(inArray(runs.status, ["created", "running", "waiting_approval", "paused"])).all();
    return new Set(active.map((row) => row.id));
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
        serverIds: Array.isArray(parsed.serverIds) ? parsed.serverIds.filter((id): id is string => typeof id === "string") : [],
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
  serverIds?: string[];
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

  start(runId: string, toolName: string, args?: unknown, toolCallId?: string, parentToolCallId?: string) {
    const row = {
      parentToolCallId: parentToolCallId ?? null,
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

  setServerOperation(id: string, operation: import("@qone/protocol").ServerOperationInfo) {
    this.db.update(toolCalls).set({ serverOperation: JSON.stringify(operation) })
      .where(and(eq(toolCalls.id, id), sql`${toolCalls.serverOperation} IS NULL`)).run();
  }

  cancelRun(runId: string) {
    this.db.update(toolCalls).set({ status: "cancelled", completedAt: Date.now() })
      .where(and(eq(toolCalls.runId, runId), sql`${toolCalls.status} IN ('queued', 'running', 'waiting_approval')`)).run();
  }

  setStatus(id: string, status: "running" | "waiting_approval") {
    this.db.update(toolCalls).set({ status }).where(eq(toolCalls.id, id)).run();
  }

  finish(id: string, status: "success" | "failed" | "cancelled", result?: unknown, durationMs?: number) {
    this.db
      .update(toolCalls)
      .set({
        status: sql`CASE WHEN ${toolCalls.status} = 'cancelled' THEN 'cancelled' ELSE ${status} END`,
        resultSummary: result === undefined ? null : JSON.stringify(persistedToolResult(result, 16_384)),
        completedAt: Date.now(),
        durationMs: durationMs ?? null,
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
      parentToolCallId: toolCalls.parentToolCallId, serverOperation: toolCalls.serverOperation,
      arguments: toolCalls.arguments, resultSummary: toolCalls.resultSummary,
      status: toolCalls.status, startedAt: toolCalls.startedAt, completedAt: toolCalls.completedAt, durationMs: toolCalls.durationMs,
    }).from(toolCalls).innerJoin(runs, eq(toolCalls.runId, runs.id)).where(eq(runs.sessionId, sessionId)).orderBy(toolCalls.startedAt).all();
  }

  /** 仅查询网页访问记忆相关的工具记录（含直连网页抓取 MCP 工具），避免跨轮重建时丢失 direct_web 记录。 */
  listWebAccessBySession(sessionId: string) {
    return this.db.select({
      toolName: toolCalls.toolName,
      arguments: toolCalls.arguments,
      resultSummary: toolCalls.resultSummary,
      status: toolCalls.status,
      startedAt: toolCalls.startedAt,
      completedAt: toolCalls.completedAt,
    }).from(toolCalls).innerJoin(runs, eq(toolCalls.runId, runs.id))
      .where(and(
        eq(runs.sessionId, sessionId),
        inArray(toolCalls.status, ["success", "failed"]),
        sql`(${toolCalls.toolName} LIKE 'qone_douyin_%' OR ${toolCalls.toolName} IN ('qone_browser_open', 'qone_browser_extract', 'qone_browser_screenshot', 'qone_browser_click', 'qone_browser_get', 'qone_opencli_run') OR (${toolCalls.toolName} LIKE 'mcp:%' AND ${toolCalls.arguments} LIKE '%http%'))`,
      ))
      .orderBy(toolCalls.startedAt).all();
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

  transaction<T>(write: () => T): T {
    return this.db.$client.transaction(write).immediate();
  }

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.select().from(settings).where(eq(settings.key, key)).get();
    if (!row) return undefined;
    try { return JSON.parse(row.value) as T; } catch { return row.value as T; }
  }

  set(key: string, value: unknown) {
    const row = { key, value: JSON.stringify(value), updatedAt: Date.now() };
    this.db.insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: { value: row.value, updatedAt: row.updatedAt } }).run();
  }

  /** Prefixes are internal keys; LIKE wildcards in them are escaped. */
  deletePrefix(prefix: string) {
    this.db.$client.prepare("DELETE FROM settings WHERE key LIKE ? ESCAPE '\\'").run(`${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
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

  private transferred(sessionId: string, itemId: string): boolean {
    return Boolean(this.settingsRepo.get(`queue:transferred:${sessionId}:${itemId}`));
  }

  list(sessionId: string): QueueItemInfo[] {
    const items = this.settingsRepo.get<QueueItemInfo[]>(`queue:${sessionId}`);
    return Array.isArray(items)
      ? items.filter((item) => item && item.sessionId === sessionId && !this.transferred(sessionId, item.id)).sort((a, b) => a.position - b.position)
      : [];
  }

  upsert(item: QueueItemInfo): QueueItemInfo[] {
    const items = this.list(item.sessionId).filter((candidate) => candidate.id !== item.id);
    if (this.consumed.has(item.id) || this.transferred(item.sessionId, item.id)) return items;
    items.push({ ...item, updatedAt: Date.now() });
    const normalized = items.map((candidate, position) => ({ ...candidate, position }));
    this.settingsRepo.set(`queue:${item.sessionId}`, normalized);
    return normalized;
  }

  replace(sessionId: string, next: QueueItemInfo[]): QueueItemInfo[] {
    const normalized = next
      .filter((item) => item.sessionId === sessionId && !this.consumed.has(item.id) && !this.transferred(sessionId, item.id))
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
    const payload = JSON.stringify(event.payload);
    this.db.insert(events).values({
      eventId: event.eventId,
      sessionId: event.sessionId,
      runId: event.runId,
      sequence: event.sequence,
      type: event.type,
      timestamp: event.timestamp,
      payload,
    }).onConflictDoUpdate({
      target: events.eventId,
      set: { sessionId: event.sessionId, runId: event.runId, sequence: event.sequence, type: event.type, timestamp: event.timestamp, payload },
    }).run();
  }

  addMany(items: readonly StoredEvent[]) {
    if (items.length === 0) return;
    this.db.transaction((tx) => {
      for (const event of items) {
        const payload = JSON.stringify(event.payload);
        tx.insert(events).values({
          eventId: event.eventId, sessionId: event.sessionId, runId: event.runId,
          sequence: event.sequence, type: event.type, timestamp: event.timestamp,
          payload,
        }).onConflictDoUpdate({
          target: events.eventId,
          set: { sessionId: event.sessionId, runId: event.runId, sequence: event.sequence, type: event.type, timestamp: event.timestamp, payload },
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

  listCompactions(sessionId: string): CompactionMarkerInfo[] {
    // Older markers only stored a user-message anchor. Recover their position
    // from persisted parts' event sequences, without rewriting chat history.
    let partsByRun: Map<string, AssistantMessagePart[]> | undefined;
    const legacyPartsForRun = (runId: string) => {
      if (!partsByRun) {
        partsByRun = new Map();
        const assistantRows = this.db.select({ runId: messages.runId, parts: messages.parts })
          .from(messages)
          .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant"), isNotNull(messages.parts)))
          .orderBy(messages.createdAt, sql`rowid`).all();
        for (const message of assistantRows) {
          if (!message.runId || !message.parts) continue;
          try {
            const parts = JSON.parse(message.parts);
            if (Array.isArray(parts)) partsByRun.set(message.runId, parts);
          } catch { /* Legacy messages can lack structured content. */ }
        }
      }
      return partsByRun.get(runId);
    };
    // Older positioned markers always named the run's first prompt. The
    // journal records which steers were actually delivered before compaction.
    const latestSteer = new Map<string, string>();
    const steerAtStart = new Map<string, string | undefined>();
    return this.db.select().from(events)
      .where(and(eq(events.sessionId, sessionId), inArray(events.type, ["context.compacted", "context.compaction.interrupted", "context.compaction.started", "agent.steer.delivered"])))
      .orderBy(events.sequence).all().flatMap((row) => {
        try {
          const payload: unknown = JSON.parse(row.payload);
          if (!payload || typeof payload !== "object") return [];
          const { id, throughMessageId, createdAt, source, partIndex, queueItemId } = payload as { id?: unknown; throughMessageId?: unknown; createdAt?: unknown; source?: unknown; partIndex?: unknown; queueItemId?: unknown };
          const steer = row.runId ? latestSteer.get(row.runId) : undefined;
          if (row.type === "agent.steer.delivered") {
            if (row.runId && typeof queueItemId === "string") latestSteer.set(row.runId, queueItemId);
            return [];
          }
          if (row.type === "context.compaction.started") {
            if (typeof id === "string") steerAtStart.set(id, steer);
            return [];
          }
          const anchor = source === "automatic" && typeof id === "string" ?
            (steerAtStart.has(id) ? steerAtStart.get(id) : steer) ?? throughMessageId : throughMessageId;
          if (typeof id === "string") steerAtStart.delete(id);
          const position = typeof partIndex === "number" && Number.isInteger(partIndex) && partIndex >= 0
            ? partIndex
            : row.runId && source === "automatic"
              ? legacyPartsForRun(row.runId)?.filter((part) => part.type !== "reasoning" && part.messageSequence < row.sequence).length : undefined;
          return typeof id === "string" && typeof anchor === "string"
            ? [{ id, throughMessageId: anchor, ...(row.runId ? { runId: row.runId } : {}), ...(position !== undefined ? { partIndex: position } : {}), createdAt: typeof createdAt === "number" ? createdAt : row.timestamp, status: row.type === "context.compacted" ? "completed" as const : "interrupted" as const, source: source === "automatic" ? "automatic" as const : "manual" as const }]
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

  get(sessionId: string, id: string) {
    return this.db.select().from(artifacts).where(and(eq(artifacts.sessionId, sessionId), eq(artifacts.id, id))).get();
  }

  delete(id: string) {
    this.db.delete(artifacts).where(eq(artifacts.id, id)).run();
  }
}

export type PermissionDecision = "allow" | "ask" | "deny";

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

  upsert(skill: { id: string; name: string; path: string; description?: string; enabled?: boolean }) {
    const row = {
      id: skill.id,
      name: skill.name,
      path: skill.path,
      description: skill.description ?? null,
      enabled: skill.enabled !== false,
      updatedAt: Date.now(),
    };
    this.db.insert(skills).values(row).onConflictDoUpdate({
      target: skills.id,
      set: { name: row.name, path: row.path, description: row.description, enabled: row.enabled, updatedAt: row.updatedAt },
    }).run();
    return row;
  }

  delete(id: string) { this.db.delete(skills).where(eq(skills.id, id)).run(); }
  list() { return this.db.select().from(skills).where(eq(skills.enabled, true)).orderBy(skills.name).all(); }
}

/** Raw provider usage; one row per request, never aggregated in place, so time ranges stay exact. */
export class ExecutionUsageRepo {
  constructor(private db: Db) {}

  /** requestKey is unique per recorded request; identical usage in the same millisecond stays distinct. */
  add(row: { requestKey: string; sessionId?: string; at: number; source: string; provider: string; model: string; cache: string; input: number; output: number; cacheRead: number; cacheWrite: number }) {
    this.db.$client.prepare(`INSERT OR IGNORE INTO execution_usage
      (request_key, session_id, at, source, provider, model, cache, input, output, cache_read, cache_write)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.requestKey, row.sessionId ?? null, row.at, row.source, row.provider, row.model, row.cache, row.input, row.output, row.cacheRead, row.cacheWrite);
  }

  /** Deleted chats drop their usage, like every other record derived from them. */
  forgetSession(sessionId: string) { this.db.$client.prepare("DELETE FROM execution_usage WHERE session_id = ?").run(sessionId); }

  list(since: number, until: number) {
    return this.db.$client.prepare(`SELECT at, source, provider, model, cache, input, output,
      cache_read AS cacheRead, cache_write AS cacheWrite FROM execution_usage
      WHERE at >= ? AND at < ? ORDER BY at`).all(since, until) as unknown as {
        at: number; source: string; provider: string; model: string;
        cache: string; input: number; output: number; cacheRead: number; cacheWrite: number;
      }[];
  }
}

/** Normalized execution failures per provider/model; no command text or output is stored. */
export class ExecutionIncidentRepo {
  constructor(private db: Db) {}

  add(row: { id: string; sessionId: string; runId: string; tool: string | null; provider: string; model: string; outcome: "failed" | "interrupted"; reason: string; at: number }) {
    this.db.$client.prepare(`INSERT OR IGNORE INTO execution_incidents
      (id, session_id, run_id, tool, provider, model, outcome, reason, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.sessionId, row.runId, row.tool, row.provider, row.model, row.outcome, row.reason, row.at);
  }

  backgroundOwner(id: string) {
    return this.db.$client.prepare("SELECT provider, model FROM execution_incidents WHERE id = ?").get(id) as { provider: string; model: string } | undefined;
  }

  finishBackground(id: string, at: number, reason?: string) {
    if (reason) this.db.$client.prepare("UPDATE execution_incidents SET outcome = 'failed', reason = ?, at = ? WHERE id = ?").run(reason, at, id);
    else this.db.$client.prepare("DELETE FROM execution_incidents WHERE id = ?").run(id);
  }

  /** Only still-running calls are marked, and only while global recording is enabled. */
  recover(at: number) {
    const rows = this.db.$client.prepare(`SELECT t.id, t.run_id, t.tool_name, r.session_id,
        r.model
      FROM tool_calls t JOIN runs r ON r.id=t.run_id WHERE t.status = 'running'
        AND t.run_id IN (SELECT id FROM runs WHERE status IN ('created', 'running', 'waiting_approval', 'paused'))`).all() as unknown as
      { id: string; run_id: string; tool_name: string; session_id: string; model: string | null }[];
    const insert = this.db.$client.prepare(`INSERT OR IGNORE INTO execution_incidents
      (id, session_id, run_id, tool, provider, model, outcome, reason, at) VALUES (?, ?, ?, ?, ?, ?, 'interrupted', 'outcome-unknown', ?)`);
    for (const row of rows) {
      const slash = (row.model ?? "").indexOf("/");
      if (slash <= 0 || !row.model) continue;
      const provider = row.model.slice(0, slash), model = row.model.slice(slash + 1);
      insert.run(`interrupted-tool:${row.id}`, row.session_id, row.run_id, null, provider, model, at);
    }
    const runs = this.db.$client.prepare(`SELECT id, session_id, model FROM runs WHERE status IN ('created', 'running', 'waiting_approval', 'paused')`).all() as unknown as
      { id: string; session_id: string; model: string | null }[];
    for (const run of runs) {
      const slash = run.model?.indexOf("/") ?? -1;
      if (slash <= 0 || !run.model) continue;
      insert.run(`interrupted-run:${run.id}`, run.session_id, run.id, null, run.model.slice(0, slash), run.model.slice(slash + 1), at);
    }
  }

  counts(since: number) {
    return this.db.$client.prepare(`SELECT provider, model, count(*) AS count, max(at) AS lastAt FROM execution_incidents
      WHERE at >= ? AND outcome = 'failed' GROUP BY provider, model ORDER BY count DESC, lastAt DESC`)
      .all(since) as unknown as { provider: string; model: string; count: number; lastAt: number }[];
  }

  analysisModels(from: number, until: number) {
    return this.db.$client.prepare(`SELECT DISTINCT provider, model FROM execution_incidents
      WHERE at > ? AND at < ? AND outcome = 'failed' AND tool IS NOT NULL`)
      .all(from, until) as unknown as { provider: string; model: string }[];
  }

  analysisGroups(provider: string, model: string, from: number, until: number) {
    return this.db.$client.prepare(`SELECT tool, reason, count(*) AS count
      FROM execution_incidents WHERE provider = ? AND model = ? AND at > ? AND at < ?
      AND outcome = 'failed' AND tool IS NOT NULL
      GROUP BY tool, reason ORDER BY count DESC, tool, reason`)
      .all(provider, model, from, until) as unknown as { tool: string; reason: string; count: number }[];
  }
}

/** Advice per provider/model/tool; replacing a row is how a repeated mistake stops growing. */
export class ExecutionLessonRepo {
  constructor(private db: Db) {}

  put(row: { provider: string; model: string; tool: string; reason: string; advice: string; at: number }) {
    this.db.$client.prepare(`INSERT INTO execution_lessons (id, provider, model, tool, reason, advice, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, advice = excluded.advice, at = excluded.at`)
      .run(`${row.provider}/${row.model}:${row.tool}:${row.reason}`, row.provider, row.model, row.tool, row.reason, row.advice, row.at);
  }

  /** Advice from an earlier grant is not reused after access is revoked and granted again. */
  forModel(provider: string, model: string, since: number, limit = 6) {
    return this.db.$client.prepare(`SELECT tool, reason, advice FROM execution_lessons
      WHERE provider = ? AND model = ? AND at > ? ORDER BY at DESC LIMIT ?`)
      .all(provider, model, since, limit) as unknown as { tool: string; reason: string; advice: string }[];
  }
}
