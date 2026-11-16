import { runtimeText } from "./runtime-localization";
import { detectImageModel, type AgentCommunicationInfo, type AssistantMessagePart, type MessageAttachmentInfo, type SubagentConfigInfo, type SubagentRunInfo, type SubagentDependencyState, type SubagentFailureKind } from "@qone/protocol";
import type { RunRepo, SessionRepo, SubagentRunRepo, WorkspaceRepo } from "@qone/database";
import type { PersistedPiMessage, PiAdapter } from "./pi-adapter.js";
import { buildSubagentPrompt, subagentCatalog } from "./subagents.js";
import { SUBAGENT_AGENT_MESSAGE_MARKER } from "./subagent-notifications.js";
import { resolveSubagentSelection, type SubagentWorkflowStep } from "./subagent-selection.js";
import { SubagentScheduler } from "./subagent-scheduler.js";
import { finalSubagentSummary } from "./subagent-result.js";

export interface SubagentController {
  list(sessionId: string, ownerId?: string): { runId: string; title: string; task: string; status: string; profileId: string | null; model: string | null }[];
  query(runId: string): SubagentRunInfo | undefined;
  acknowledge(runId: string): void;
  dependencyStatus(parentRunId: string): { blocking: SubagentRunInfo[]; unacknowledged: SubagentRunInfo[]; retryRequired: SubagentRunInfo[]; requiresFinalization: boolean; authorized: boolean };
  finalize(parentRunId: string, resolvedSubagentRunIds: string[]): { ok: boolean; missing: { runId: string; title: string; status: string; dependencyState: string; failureKind?: string }[] };
  waitForDependencyChange(parentRunId: string, signal?: AbortSignal): Promise<void>;
  catalog(): ReturnType<typeof subagentCatalog>;
  control(runId: string, action: "stop" | "resume" | "retry" | "steer" | "follow_up", message?: string, signal?: AbortSignal, callerId?: string): Promise<SubagentRunInfo>;
  wait(runId: string, timeoutMs?: number, signal?: AbortSignal, callerId?: string): Promise<SubagentRunInfo>;
  /** Child → parent message. Persisted on both transcripts; delivered live only while the parent is streaming. */
  messageParent(runId: string, message: string): { delivered: boolean; toId: string };
  restoreMessages(runId: string): PersistedPiMessage[];
  recordEvent(id: string, type: string, payload: unknown, sequence: number): void;
  fail(id: string, message: string): void;
  dispose(sessionId: string, parentRunIds?: string[]): Promise<void>;
  workflow(parentSessionId: string, parentRunId: string, steps: SubagentWorkflowStep[], context?: { model?: string; permissionMode?: "ask" | "auto" | "full"; signal?: AbortSignal; background?: boolean }): Promise<SubagentRunInfo[]>;
}

type TextChunkBuffers = Map<string, string[]>;

function classifyFailure(error: unknown): SubagentFailureKind {
  const value = error && typeof error === "object" ? error as {
    failureKind?: unknown; name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; toolFailure?: unknown; cause?: unknown;
  } : {};
  const declared = value.failureKind;
  if (declared === "network" || declared === "provider_unavailable" || declared === "timeout" || declared === "permission"
    || declared === "tool_failure" || declared === "cancelled" || declared === "unknown") return declared;
  if (value.name === "TimeoutError" || value.code === "ETIMEDOUT") return "timeout";
  const status = Number(value.statusCode ?? value.status);
  if (status === 401 || status === 403) return "permission";
  if (status === 408) return "timeout";
  if (status === 429 || status === 502 || status === 503 || status === 504) return "provider_unavailable";
  if (["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EAI_AGAIN", "ENETUNREACH", "ENOTFOUND"].includes(String(value.code))) return "network";
  if (value.toolFailure === true) return "tool_failure";
  if (value.cause && value.cause !== error) return classifyFailure(value.cause);
  return "unknown";
}

export function subagentInfo(runId: string, repo: SubagentRunRepo, runs: RunRepo, streams: TextChunkBuffers, liveParts?: AssistantMessagePart[]): SubagentRunInfo | undefined {
  const row = repo.get(runId);
  const run = runs.get(runId);
  if (!row || !run) return undefined;
  const parts = liveParts ?? JSON.parse(row.parts) as AssistantMessagePart[];
  const tools = new Map(parts.flatMap((part) => part.type === "tool-call" ? [[part.toolCallId, part] as const] : []));
  return {
    id: runId, parentSessionId: row.parentSessionId, parentRunId: row.parentRunId,
    parentSubagentId: row.parentSubagentId ?? undefined, depth: row.depth ?? 0,
    toolCallId: row.toolCallId, executionSessionId: row.executionSessionId ?? undefined,
    profileId: row.profileId ?? undefined,
    background: Boolean(row.background),
    title: row.title, task: row.task,
    model: row.model ?? undefined,
    permissionMode: row.permissionMode as SubagentRunInfo["permissionMode"],
    tools: row.tools ? JSON.parse(row.tools) as string[] : undefined,
    status: run.status as SubagentRunInfo["status"],
    startedAt: run.startedAt ?? 0, completedAt: run.completedAt ?? undefined,
    content: row.content, parts,
    streaming: streams.get(runId)?.join(""), error: run.error ?? undefined,
    turnCount: row.turnCount ?? 1, retryCount: row.retryCount ?? 0,
    requiredBeforeFinal: row.requiredBeforeFinal ?? true,
    failureKind: row.failureKind as SubagentFailureKind | undefined,
    dependencyState: (row.dependencyState ?? "pending") as SubagentDependencyState,
    completionAcknowledged: Boolean(row.completionAcknowledged),
    workflowId: row.workflowId ?? undefined, workflowStepId: row.workflowStepId ?? undefined,
    dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) as string[] : undefined,
    contextMode: row.contextMode as SubagentRunInfo["contextMode"], contextMessageCount: row.contextMessageCount ?? 0,
    tokenUsage: row.tokenUsage ? JSON.parse(row.tokenUsage) : undefined,
    children: repo.listBySession(row.parentSessionId).filter((child) => child.parentSubagentId === runId).map((child) => child.runId),
    messages: repo.listMessages(runId).map((message) => ({
      id: message.id, sequence: message.sequence,
      role: message.role as "user" | "assistant" | "tool" | "system", content: message.content,
      internal: message.sequence !== 0 && message.role === "user" && Boolean(message.rawMessage),
      communication: readCommunication(message),
      parts: message.parts ? (JSON.parse(message.parts) as AssistantMessagePart[]).map(part => part.type === "tool-call"
        ? tools.get(part.toolCallId) ?? part : part) : undefined,
      createdAt: message.createdAt,
    })),
  };
}

/** Persisted communication metadata is optional: older rows and older databases simply have none. */
function readCommunication(row: { communication?: string | null }): AgentCommunicationInfo | undefined {
  if (!row.communication) return undefined;
  try { return JSON.parse(row.communication) as AgentCommunicationInfo; } catch { return undefined; }
}

/** Persisted child identity; each invocation owns one cancellable execution and one permit. */
export function registerSubagentDispatcher(options: {
  adapter: PiAdapter;
  sessionRepo: SessionRepo;
  workspaceRepo: WorkspaceRepo;
  runRepo: RunRepo;
  subagentRunRepo: SubagentRunRepo;
  config: () => SubagentConfigInfo;
  partsByRun: Map<string, AssistantMessagePart[]>;
  messageSequenceByRun: Map<string, number>;
  assistantBuffers: Map<string, string>;
  streamBuffers: TextChunkBuffers;
  subagentStreams: TextChunkBuffers;
  activeSubagents: Set<string>;
  contextProvider?: (sessionId: string, limit: number) => string;
  subagentContextProvider?: (runId: string, limit: number) => string;
  /** Original attachments from the root user run, shared by reference with delegated agents. */
  attachmentsProvider?: (sessionId: string, runId: string) => MessageAttachmentInfo[];
  runtime?: () => SubagentConfigInfo["runtime"];
  acknowledge?: (runId: string) => void;
  /** Persist a child → parent message on the parent conversation transcript. */
  appendParentMessage?: (sessionId: string, runId: string, content: string, communication: AgentCommunicationInfo, rawMessage?: unknown) => void;
  publish: (runId: string) => void;
  emit: (type: string, payload: unknown, sessionId?: string, runId?: string) => void;
}): SubagentController {
  const { adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
    partsByRun, messageSequenceByRun, assistantBuffers, streamBuffers, subagentStreams,
    activeSubagents, publish, emit } = options;
  const policy = () => options.runtime?.() ?? options.config().runtime;
  type Job = { abort: AbortController; done: Promise<void>; state: "queued" | "running"; failure?: Error; cancelled: boolean; initialMessageId?: string; listeners: Set<() => void> };
  const jobs = new Map<string, Job>();
  const scheduler = new SubagentScheduler(() => policy().maxConcurrent);
  const yielding = new Map<string, { count: number; held: boolean }>();
  const dependencyWaiters = new Map<string, Set<() => void>>();
  const maxContinuations = 2;

  const query = (id: string) => subagentInfo(id, repo, runRepo, subagentStreams, partsByRun.get(id));
  const requireInfo = (id: string) => {
    const info = query(id);
    if (!info) throw new Error(`Unknown subagent ${id}`);
    return info;
  };
  const descendants = (parentRunId: string) => {
    const rows = repo.list();
    const children = new Map<string, typeof rows>();
    for (const row of rows) children.set(row.parentRunId, [...(children.get(row.parentRunId) ?? []), row]);
    const result: typeof rows = [];
    const visit = (id: string) => { for (const child of children.get(id) ?? []) { result.push(child); visit(child.runId); } };
    visit(parentRunId);
    return result;
  };
  const recoveredRootRows = (parentRunId: string) => {
    const parentRun = runRepo.get(parentRunId);
    if (!parentRun || repo.get(parentRunId)) return [] as ReturnType<typeof repo.listBySession>;
    return repo.listBySession(parentRun.sessionId).filter((row) =>
      !row.parentSubagentId && row.parentRunId !== parentRunId && row.requiredBeforeFinal
      && runRepo.get(row.parentRunId)?.status === "interrupted"
      && !runRepo.isFinalizationAuthorized(row.parentRunId));
  };
  const notifyDependencyChange = (runId: string) => {
    let current = repo.get(runId);
    while (current) {
      for (const resolve of dependencyWaiters.get(current.parentRunId) ?? []) resolve();
      dependencyWaiters.delete(current.parentRunId);
      current = repo.get(current.parentRunId);
    }
  };
  const dependencyStatus = (parentRunId: string) => {
    const ownRows = descendants(parentRunId);
    const recoveredRoots = recoveredRootRows(parentRunId);
    const rows = [...new Map([...ownRows, ...recoveredRoots, ...recoveredRoots.flatMap((row) => descendants(row.runId))]
      .map((row) => [row.runId, row])).values()];
    const infos = rows.map((row) => query(row.runId)).filter((info): info is SubagentRunInfo => Boolean(info && info.requiredBeforeFinal));
    return {
      blocking: infos.filter((info) => !["resolved", "exhausted"].includes(info.dependencyState)),
      unacknowledged: infos.filter((info) => !info.completionAcknowledged && ["completed", "failed", "cancelled", "interrupted"].includes(info.status)),
      retryRequired: infos.filter((info) => info.dependencyState === "retry_required"),
      requiresFinalization: infos.length > 0,
      authorized: infos.length === 0 || runRepo.isFinalizationAuthorized(parentRunId),
    };
  };
  const awaitDependencyChange = (parentRunId: string, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const cleanup = () => {
      const waiters = dependencyWaiters.get(parentRunId);
      waiters?.delete(finish);
      if (waiters && !waiters.size) dependencyWaiters.delete(parentRunId);
      signal?.removeEventListener("abort", abort);
    };
    const finish = () => { cleanup(); resolve(); };
    const abort = () => { cleanup(); reject(signal?.reason ?? new Error("aborted")); };
    const waiters = dependencyWaiters.get(parentRunId) ?? new Set<() => void>();
    waiters.add(finish); dependencyWaiters.set(parentRunId, waiters);
    signal?.addEventListener("abort", abort, { once: true });
    if (!dependencyStatus(parentRunId).blocking.length) finish();
  });
  // A nested parent waiting on its children must not keep its scheduler permit:
  // with maxConcurrent saturated that is a parent-waits-child/child-waits-permit deadlock.
  const waitForDependencyChange = (parentRunId: string, signal?: AbortSignal) =>
    withoutPermit(parentRunId, () => awaitDependencyChange(parentRunId, signal));
  const finalize = (parentRunId: string, resolvedSubagentRunIds: string[]) => {
    const status = dependencyStatus(parentRunId);
    const listed = new Set(resolvedSubagentRunIds);
    const missing = [...status.blocking, ...status.unacknowledged.filter((info) => !["resolved", "exhausted"].includes(info.dependencyState))]
      .filter((info, index, all) => all.findIndex((candidate) => candidate.id === info.id) === index)
      .map((info) => ({ runId: info.id, title: info.title, status: info.status, dependencyState: info.dependencyState, failureKind: info.failureKind }));
    for (const row of descendants(parentRunId)) {
      const info = query(row.runId);
      if (info?.requiredBeforeFinal && info.completionAcknowledged && !listed.has(info.id)) {
        missing.push({ runId: info.id, title: info.title, status: info.status, dependencyState: info.dependencyState, failureKind: info.failureKind });
      }
    }
    if (missing.length) return { ok: false, missing };
    runRepo.authorizeFinalization(parentRunId);
    for (const root of recoveredRootRows(parentRunId)) {
      const group = [root, ...descendants(root.runId)].filter((row) => row.requiredBeforeFinal);
      if (group.every((row) => ["resolved", "exhausted"].includes(row.dependencyState))) {
        runRepo.authorizeFinalization(root.parentRunId);
      }
    }
    return { ok: true, missing: [] };
  };
  const acknowledge = (id: string) => {
    const info = query(id);
    if (info && ["completed", "failed", "cancelled", "interrupted"].includes(info.status)) {
      const retryable = ["network", "provider_unavailable", "timeout"].includes(info.failureKind ?? "");
      const state = info.status === "completed" ? "resolved" : retryable && info.retryCount < maxContinuations ? "retry_required" : "exhausted";
      repo.acknowledgeResult(id, state as SubagentDependencyState);
      notifyDependencyChange(id);
    }
    options.acknowledge?.(id);
  };
  const sourceRunId = (runId: string): string => {
    let source = runId;
    for (let current = repo.get(runId); current; current = repo.get(current.parentRunId)) {
      source = current.parentRunId;
    }
    return source;
  };
  const originalAttachments = (sessionId: string, runId: string): MessageAttachmentInfo[] => {
    const attachments = [...(options.attachmentsProvider?.(sessionId, sourceRunId(runId)) ?? [])];
    for (let current = repo.get(runId); current; current = repo.get(current.parentRunId)) {
      if (!current.mediaAttachment) continue;
      const media = JSON.parse(current.mediaAttachment) as MessageAttachmentInfo;
      if (!attachments.some((item) => item.localPath === media.localPath)) attachments.push(media);
    }
    return attachments;
  };
  const interrupt = (id: string, failure?: Error) => {
    const job = jobs.get(id);
    if (!job) return;
    job.failure ??= failure;
    job.cancelled = !job.failure;
    job.abort.abort(failure ?? new Error("Subagent cancelled"));
    adapter.stop(id);
    for (const child of repo.listBySession(requireInfo(id).parentSessionId)) {
      if (child.parentSubagentId === id) interrupt(child.runId, failure);
    }
  };
  const withoutPermit = async <T>(parentId: string | undefined, work: () => Promise<T>): Promise<T> => {
    const parent = parentId ? jobs.get(parentId) : undefined;
    if (!parent || !parentId) return work();
    const entry = yielding.get(parentId) ?? { count: 0, held: scheduler.release(parentId) };
    entry.count++;
    yielding.set(parentId, entry);
    try { return await work(); }
    finally {
      entry.count--;
      if (!entry.count) {
        yielding.delete(parentId);
        if (entry.held && !parent.abort.signal.aborted) {
          await scheduler.acquire(parentId, parent.abort.signal);
          // The parent may have finished while this wait was pending; a permit
          // re-acquired for a dead job would never be released.
          if (!jobs.has(parentId)) scheduler.release(parentId);
        }
      }
    }
  };
  /** Parent → child direction for a follow-up or steer message. */
  const parentCommunication = (row: NonNullable<ReturnType<typeof repo.get>>): AgentCommunicationInfo => {
    const parent = repo.get(row.parentRunId);
    return parent
      ? { fromId: parent.runId, fromTitle: parent.title, toId: row.runId, toTitle: row.title }
      : { fromId: row.parentRunId, fromTitle: sessionRepo.get(row.parentSessionId)?.title ?? "main", toId: row.runId, toTitle: row.title };
  };

  const start = (id: string, prompt: string, newTurn: boolean, persistUserMessage: boolean, signal?: AbortSignal, attachments?: MessageAttachmentInfo[], communication?: AgentCommunicationInfo): Job => {
    if (jobs.has(id)) throw new Error("Subagent already has an active turn");
    const row = repo.get(id)!;
    const parent = sessionRepo.get(row.parentSessionId);
    const cwd = parent?.workspaceId ? workspaceRepo.get(parent.workspaceId)?.path : undefined;
    if (!cwd) throw new Error("Subagent workspace is unavailable");
    const executionSessionId = row.executionSessionId ?? `${row.parentSessionId}::subagent::${id}`;
    if (!row.executionSessionId) repo.updateExecutionSession(id, executionSessionId);
    const job: Job = { abort: new AbortController(), done: Promise.resolve(), state: "queued", cancelled: false, listeners: new Set() };
    jobs.set(id, job);
    activeSubagents.add(id);
    partsByRun.set(id, JSON.parse(row.parts));
    runRepo.setStatus(id, "created");
    runRepo.revokeFinalization(row.parentRunId);
    repo.setDependencyState(id, "running", { completionAcknowledged: false });
    if (!newTurn) repo.incrementTurn(id);
    if (persistUserMessage) {
      repo.appendMessage(id, "user", prompt, undefined, undefined, communication);
      job.initialMessageId = repo.latestMessage(id)!.id;
    }
    const onAbort = () => interrupt(id);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    publish(id);
    const execute = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!scheduler.tryAcquire(id)) await scheduler.acquire(id, job.abort.signal);
        if (job.abort.signal.aborted) throw job.abort.signal.reason;
        const budget = policy().tokenBudget;
        if (budget > 0 && (requireInfo(id).tokenUsage?.total ?? 0) >= budget) throw new Error("Subagent token budget exceeded");
        job.state = "running";
        runRepo.setStatus(id, "running");
        publish(id);
        timer = setTimeout(() => interrupt(id, Object.assign(new Error("Subagent timed out"), { name: "TimeoutError" })), policy().timeoutMs);
        const messagesBefore = repo.listMessages(id).length;
        const partCount = (partsByRun.get(id) ?? []).length;
        assistantBuffers.delete(id);
        streamBuffers.delete(id);
        subagentStreams.delete(id);
        // No automatic retry: a failure is returned to the parent model with its
        // error, and the parent decides whether to retry via control_subagent.
        try {
          await adapter.run(executionSessionId, prompt, {
            runId: id, model: row.model ?? undefined, cwd, eventSessionId: executionSessionId,
            permissionMode: (row.permissionMode as "ask" | "auto" | "full" | null) ?? "ask",
            subagentDepth: row.depth, subagentRunId: id,
            attachments,
          }, (type, payload) => emit(type, payload, executionSessionId, id));
          if (job.abort.signal.aborted) throw job.abort.signal.reason;
        } finally {
          // Real Pi messages are persisted by recordEvent; test/legacy adapters may only expose parts.
          if (repo.listMessages(id).length === messagesBefore) {
            const parts = (partsByRun.get(id) ?? []).slice(partCount);
            const text = assistantBuffers.get(id) ?? parts.filter(p => p.type === "text").map(p => p.text).join("\n");
            if (parts.length || text) repo.appendMessage(id, "assistant", text, parts);
          }
        }
        runRepo.finish(id, "completed");
        repo.setDependencyState(id, "pending", { failureKind: null, completionAcknowledged: false });
      } catch (error) {
        const status = job.cancelled ? "cancelled" : "failed";
        const failure = String(job.failure ?? error);
        runRepo.finish(id, status, failure);
        const kind = status === "cancelled" ? "cancelled" : classifyFailure(job.failure ?? error);
        const retryable = ["network", "provider_unavailable", "timeout"].includes(kind);
        repo.setDependencyState(id, retryable && requireInfo(id).retryCount < maxContinuations ? "retry_required" : "pending", {
          failureKind: kind, completionAcknowledged: false,
        });
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const parts = partsByRun.get(id) ?? [];
        const content = finalSubagentSummary({
          content: assistantBuffers.get(id) ?? row.content,
          parts,
          messages: repo.listMessages(id),
          streaming: subagentStreams.get(id)?.join(""),
          status: runRepo.get(id)?.status,
        });
        repo.save(id, content, parts);
        activeSubagents.delete(id);
        jobs.delete(id);
        for (const resolve of job.listeners) resolve();
        job.listeners.clear();
        scheduler.release(id);
        subagentStreams.delete(id);
        partsByRun.delete(id);
        messageSequenceByRun.delete(id);
        assistantBuffers.delete(id);
        streamBuffers.delete(id);
        publish(id);
        emit("subagent.finished", { id, status: runRepo.get(id)?.status }, row.executionSessionId ?? undefined, id);
        notifyDependencyChange(id);
      }
    };
    job.done = execute();
    return job;
  };

  type Dispatch = Parameters<NonNullable<Parameters<PiAdapter["setSubagentDispatcher"]>[0]>>[0] &
    { workflowId?: string; workflowStepId?: string; dependsOn?: string[]; deferStart?: boolean };
  const deferredStarts = new Map<string, (taskOverride?: string) => Promise<string>>();
  const waitForCompletion = async (id: string, timeoutMs = policy().timeoutMs, signal?: AbortSignal): Promise<SubagentRunInfo> => {
    requireInfo(id);
    const job = jobs.get(id);
    if (job) await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        job.listeners.delete(finish);
        resolve();
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        job.listeners.delete(finish);
        reject(signal?.reason ?? new Error("aborted"));
      };
      // The job settles this promise; the timer only bounds the caller's wait.
      // Listeners are removed on settle, so repeated waits cannot accumulate.
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      job.listeners.add(finish);
    });
    return requireInfo(id);
  };

  const dispatch = async (input: Dispatch) => {
    if (!input.reason?.trim() || !input.expectedResult?.trim()) throw new Error("Subagent reason and expectedResult are required");
    const inherited = repo.get(input.parentRunId) ?? repo.getByExecutionSession(input.parentSessionId);
    const parentSessionId = inherited?.parentSessionId ?? input.parentSessionId;
    const parent = sessionRepo.get(parentSessionId);
    if (!parent?.workspaceId || !workspaceRepo.get(parent.workspaceId)) throw new Error("Subagent workspace is unavailable");
    const depth = (inherited?.depth ?? 0) + 1;
    if (inherited && !policy().allowNested) throw new Error("Nested subagents are disabled in settings");
    if (depth > policy().maxDepth) throw new Error("Subagent nesting depth limit reached");
    if (input.background && !policy().backgroundEnabled) throw new Error("Background subagents are disabled in settings");
    const agent = resolveSubagentSelection(options.config(), input);
    const count = policy().contextMode === "snapshot" ? policy().contextMessages : 0;
    const context = count ? inherited
      ? options.subagentContextProvider?.(inherited.runId, count) ?? ""
      : options.contextProvider?.(parentSessionId, count) ?? "" : "";
    const promptForTask = (task: string) => buildSubagentPrompt(agent
      ? { id: agent.id, name: agent.name, instructions: agent.instructions }
      : { id: "delegate", name: input.title, instructions: runtimeText("subagent-runner.complete_the_delegated_task_parent_context_is_provided_for") },
      `${task}\n\n父模型委派原因：${input.reason}\n必须返回的具体结果：${input.expectedResult}`,
      context);
    const prompt = promptForTask(input.task);
    const inheritedAttachments = originalAttachments(parentSessionId, input.parentRunId);
    const attachments = input.mediaAttachment && !inheritedAttachments.some((item) => item.localPath === input.mediaAttachment?.localPath)
      ? [...inheritedAttachments, input.mediaAttachment] : inheritedAttachments;
    const child = runRepo.create(parentSessionId);
    const model = agent
      ? agent.modelId || inherited?.model || input.fallbackModel || undefined
      : policy().temporaryModelId || input.fallbackModel || inherited?.model || undefined;
    repo.create({
      ...input, runId: child.id, parentSessionId, parentSubagentId: inherited?.runId, depth,
      executionSessionId: `${parentSessionId}::subagent::${child.id}`,
      background: input.background ?? false,
      profileId: agent?.id, model,
      permissionMode: input.permissionMode, contextMode: policy().contextMode, contextMessageCount: count,
    });
    if (input.deferStart) {
      runRepo.setStatus(child.id, "created");
      publish(child.id);
    }
    const work = async (taskOverride = input.task) => {
      const directGeneration = model && (adapter.isDirectGenerationModel?.(model) ?? detectImageModel({ model }).isImageModel);
      let job: Job;
      try {
        job = start(child.id, directGeneration ? taskOverride : promptForTask(taskOverride), true, true, input.signal, attachments);
      } catch (error) {
        const failure = String(error);
        runRepo.finish(child.id, "failed", failure);
        repo.setDependencyState(child.id, "pending", { failureKind: "tool_failure", completionAcknowledged: false });
        repo.save(child.id, failure, []);
        publish(child.id);
        emit("subagent.finished", { id: child.id, status: "failed" }, undefined, child.id);
        notifyDependencyChange(child.id);
        throw error;
      }
      if (input.background) return `Subagent started in background. runId=${child.id}`;
      await job.done;
      // A foreground delegation already returned its terminal result directly
      // to the parent model. Do not leave a duplicate "unread" notification
      // behind for a result the parent has already consumed.
      if (!input.background) acknowledge(child.id);
      const info = requireInfo(child.id);
      return JSON.stringify({ runId: child.id, status: info.status, result: finalSubagentSummary(info), error: info.error });
    };
    if (input.deferStart) {
      deferredStarts.set(child.id, work);
      return JSON.stringify({ runId: child.id, status: "created" });
    }
    return input.background ? work() : withoutPermit(inherited?.runId, work);
  };
  adapter.setSubagentDispatcher(dispatch);
  adapter.setSubagentPolicy?.(() => ({
    allowNested: policy().allowNested,
    maxDepth: policy().maxDepth,
    maxConcurrent: policy().maxConcurrent,
  }));

  /** A Pi-shaped user message for an agent-to-agent row, so restarts replay it. */
  const agentUserMessage = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });

  const messageParent = (id: string, message: string): { delivered: boolean; toId: string } => {
    const text = message.trim();
    if (!text) throw new Error("Message text is required");
    const row = repo.get(id);
    if (!row) throw new Error(`Unknown subagent ${id}`);
    const parent = repo.get(row.parentRunId);
    const communication: AgentCommunicationInfo = {
      fromId: id, fromTitle: row.title,
      toId: row.parentRunId,
      toTitle: parent?.title ?? sessionRepo.get(row.parentSessionId)?.title ?? "main",
    };
    // Both transcripts keep the same structured source so neither UI side needs
    // to infer the direction from text.
    const prompt = `${SUBAGENT_AGENT_MESSAGE_MARKER}\n${text}`;
    const raw = agentUserMessage(prompt);
    // The sender's bubble is a UI projection, not another user prompt to itself.
    repo.appendMessage(id, "user", text, undefined, undefined, communication);
    const delivered = adapter.queueSubagentUpdateNow(
      parent?.executionSessionId ?? row.parentSessionId,
      prompt,
      row.parentRunId,
    );
    // A live recipient records its actual Pi input in order; its bubble is only
    // a projection. An idle recipient needs the replayable input on this row.
    if (parent) repo.appendMessage(parent.runId, "user", text, undefined, delivered ? undefined : raw, communication);
    else options.appendParentMessage?.(row.parentSessionId, row.parentRunId, text, communication, delivered ? undefined : raw);
    publish(id);
    if (parent) publish(parent.runId);
    // A parent blocked in the finalization gate must wake to answer a child's
    // question; otherwise parent-waits-child and child-waits-answer deadlock.
    for (const resolve of dependencyWaiters.get(row.parentRunId) ?? []) resolve();
    dependencyWaiters.delete(row.parentRunId);
    return { delivered, toId: row.parentRunId };
  };

  const controller: SubagentController = {
    query,
    acknowledge,
    dependencyStatus,
    finalize,
    waitForDependencyChange,
    messageParent,
    restoreMessages: (id) => repo.listMessages(id)
      .filter(message => message.id !== jobs.get(id)?.initialMessageId && (!message.communication || Boolean(message.rawMessage)))
      .map(message => ({ role: message.role, content: message.content, createdAt: message.createdAt,
        rawMessage: message.rawMessage ? JSON.parse(message.rawMessage) : undefined })),
    list: (sessionId, ownerId) => {
      const owner = ownerId ? repo.get(ownerId) : undefined;
      if (ownerId && owner?.executionSessionId !== sessionId) return [];
      const rows = repo.listBySession(owner?.parentSessionId ?? sessionId);
      const visible = new Set(ownerId ? [ownerId] : rows.map(row => row.runId));
      if (ownerId) {
        for (let changed = true; changed;) {
          changed = false;
          for (const row of rows) if (row.parentSubagentId && visible.has(row.parentSubagentId) && !visible.has(row.runId)) {
            visible.add(row.runId);
            changed = true;
          }
        }
        visible.delete(ownerId);
      }
      return rows.filter(row => visible.has(row.runId)).map(row => ({
        runId: row.runId, title: row.title, task: row.task,
        status: runRepo.get(row.runId)?.status ?? "failed", profileId: row.profileId, model: row.model,
      }));
    },
    catalog: () => subagentCatalog(options.config()),
    recordEvent: (id, type, payload, sequence) => {
      const job = jobs.get(id);
      if (!job) return;
      const raw = (payload as { message?: { role?: string; content?: unknown; usage?: unknown } })?.message;
      if (type === "message.completed" && raw?.role) {
        const text = typeof raw.content === "string" ? raw.content
          : Array.isArray(raw.content) ? raw.content.filter(p => p?.type === "text").map(p => p.text).join("") : "";
        if (raw.role === "user" && job.initialMessageId) {
          // Replace the pre-run UI placeholder with the expanded native prompt;
          // all later user messages are distinct, even consecutive steers.
          repo.setRawMessage(job.initialMessageId, raw);
          job.initialMessageId = undefined;
          return;
        }
        const parts = raw.role === "assistant" ? (partsByRun.get(id) ?? []).filter(p => p.messageSequence === sequence) : undefined;
        repo.appendMessage(id, raw.role === "toolResult" ? "tool" : raw.role, text, parts, raw);
      }
    },
    fail: (id, message) => interrupt(id, new Error(message)),
    dispose: async (sessionId, parentRunIds) => {
      const rows = repo.listBySession(sessionId);
      const selected = new Set(parentRunIds ?? rows.map(row => row.runId));
      for (let changed = true; changed;) {
        changed = false;
        for (const row of rows) if (selected.has(row.parentRunId) && !selected.has(row.runId)) { selected.add(row.runId); changed = true; }
      }
      const children = rows.filter(row => selected.has(row.runId));
      const waiting = children.flatMap(row => jobs.get(row.runId)?.done ?? []);
      for (const row of children) interrupt(row.runId);
      await Promise.all(waiting);
      for (const row of children) if (row.executionSessionId) await adapter.disposeSession(row.executionSessionId);
      // Terminal children keep no live waiter or deferred start; nothing can
      // resolve them once their run rows are gone.
      for (const row of children) {
        dependencyWaiters.delete(row.runId);
        deferredStarts.delete(row.runId);
      }
    },
    control: async (id, action, message, signal?: AbortSignal, callerId?: string) => {
      // A parent tool call can already be cancelled when control is invoked;
      // starting a child turn first would leave a cancelled run behind.
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      const row = repo.get(id);
      if (!row) throw new Error(`Unknown subagent ${id}`);
      const job = jobs.get(id);
      if (action === "stop") {
        if (!job) throw new Error("Subagent is not active");
        interrupt(id);
        await job.done;
      } else if (job) {
        if (action !== "steer" && action !== "follow_up") throw new Error("Subagent already has an active turn");
        if (!message?.trim()) throw new Error(`${action} requires a message`);
        if (job.state !== "running" || !row.executionSessionId ||
            !await adapter.sendToSession(row.executionSessionId, message.trim(), action)) throw new Error("Subagent is not ready for input");
        repo.appendMessage(id, "user", message.trim(), undefined, undefined, parentCommunication(row));
        repo.incrementTurn(id);
      } else {
        if ((action === "steer" || action === "follow_up") && !message?.trim()) throw new Error(`${action} requires a message`);
        const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(runRepo.get(id)?.status ?? "");
        if ((action === "retry" || action === "resume") && terminal && !row.completionAcknowledged) {
          throw new Error("Inspect the finished subagent result before continuing it");
        }
        if (action === "retry") {
          const retryable = ["network", "provider_unavailable", "timeout"].includes(row.failureKind ?? "");
          if (retryable && row.retryCount >= maxContinuations) throw new Error("This subagent has reached its continuation limit");
          repo.incrementRetry(id);
        }
        if (action === "follow_up" && runRepo.get(id)?.status !== "completed") {
          const retryable = ["network", "provider_unavailable", "timeout"].includes(row.failureKind ?? "");
          if (!retryable || row.retryCount >= maxContinuations) throw new Error("This subagent failure cannot be continued; inspect the result and handle the failure before finalizing");
          if (!row.completionAcknowledged) throw new Error("Inspect the failed subagent result before continuing it");
          repo.incrementRetry(id);
        }
        const attachments = originalAttachments(row.parentSessionId, id);
        await withoutPermit(callerId, () => start(id, message?.trim() || (action === "retry" ? row.task : runtimeText("subagent-runner.continue_the_previous_task_and_describe_the_new_results")), false, action !== "retry", signal, attachments,
          action === "retry" ? undefined : parentCommunication(row)).done);
      }
      const result = requireInfo(id);
      if (["completed", "failed", "cancelled", "interrupted"].includes(result.status)) acknowledge(id);
      return requireInfo(id);
    },
    wait: async (id, timeoutMs = policy().timeoutMs, signal, callerId) => withoutPermit(callerId, () => waitForCompletion(id, timeoutMs, signal)),
    workflow: async (sessionId, parentRunId, steps, context) => {
      validateWorkflow(steps, policy().workflowMaxSteps);
      // Fail invalid selections before any independent step creates a child run.
      for (const step of steps) resolveSubagentSelection(options.config(), step);
      const parent = repo.get(parentRunId);
      if (parent && !policy().allowNested) throw new Error("Nested subagents are disabled in settings");
      const workflowId = crypto.randomUUID();
      const results = new Map<string, SubagentRunInfo>();
      const pending = new Map(steps.map(step => [step.id, step]));
      // Register the entire workflow synchronously before starting any step.
      // This closes the gap where a dependent step did not exist yet and the
      // parent could incorrectly finalize between two workflow rounds.
      const prepared = new Map<string, string>();
      const registrations = steps.map((step) => dispatch({
        parentSessionId: sessionId, parentRunId, title: step.title, task: step.task,
        capability: step.capability, subagentId: step.subagentId, toolCallId: `workflow:${workflowId}:${step.id}`,
        workflowId, workflowStepId: step.id, dependsOn: step.dependsOn ?? [],
        reason: `工作流步骤「${step.id}」是当前任务的必要环节`,
        expectedResult: `完成工作流步骤「${step.id}」并返回可供后续步骤使用的紧凑总结`,
        fallbackModel: context?.model, permissionMode: context?.permissionMode ?? "ask", signal: context?.signal,
        background: context?.background, deferStart: true,
      }).then((value) => {
        const runId = JSON.parse(value).runId as string;
        prepared.set(step.id, runId);
        return runId;
      }));
      return withoutPermit(parent?.runId, async () => {
        try {
          await Promise.all(registrations);
          while (pending.size) {
            if (context?.signal?.aborted) throw context.signal.reason;
            const ready = [...pending.values()].filter(step => (step.dependsOn ?? []).every(id => results.has(id)));
            if (!ready.length) throw new Error("Workflow has no runnable step");
            await Promise.all(ready.map(async step => {
              const dependencies = step.dependsOn ?? [];
              const runId = prepared.get(step.id)!;
              if (dependencies.some(id => results.get(id)?.status !== "completed")) {
                const failure = `Workflow dependency failed for ${step.id}`;
                deferredStarts.delete(runId);
                runRepo.finish(runId, "failed", failure);
                repo.setDependencyState(runId, "exhausted", { failureKind: "tool_failure", completionAcknowledged: false });
                publish(runId);
                emit("subagent.finished", { id: runId, status: "failed" }, undefined, runId);
                notifyDependencyChange(runId);
              } else {
                const start = deferredStarts.get(runId);
                if (!start) throw new Error(`Workflow step ${step.id} was not prepared`);
                deferredStarts.delete(runId);
                await start(step.task + dependencies.map(id => `\nDependency ${id}:\n${finalSubagentSummary(results.get(id)!)}`).join("\n"));
                const info = requireInfo(runId);
                results.set(step.id, context?.background
                  ? await waitForCompletion(runId, policy().timeoutMs, context.signal)
                  : info);
                pending.delete(step.id);
                return;
              }
              results.set(step.id, requireInfo(runId));
              pending.delete(step.id);
            }));
          }
          return steps.map(step => results.get(step.id)!);
        } finally {
          // Any step left unstarted by cancellation or an orchestration error
          // is a durable terminal failure, so it remains visible to the
          // finalization gate instead of disappearing from the ledger.
          for (const step of pending.values()) {
            const runId = prepared.get(step.id);
            if (!runId) continue;
            const info = query(runId);
            if (!info || ["completed", "failed", "cancelled", "interrupted"].includes(info.status)) continue;
            runRepo.finish(runId, "cancelled", "Workflow did not start this step");
            repo.setDependencyState(runId, "exhausted", { failureKind: "cancelled", completionAcknowledged: false });
            deferredStarts.delete(runId);
            publish(runId);
            emit("subagent.finished", { id: runId, status: "cancelled" }, undefined, runId);
            notifyDependencyChange(runId);
          }
        }
      });
    },
  };
  return controller;
}

export function validateWorkflow(steps: { id: string; dependsOn?: string[] }[], max: number) {
  if (!steps.length || steps.length > max) throw new Error("Workflow step limit exceeded");
  const pending = new Map(steps.map(step => [step.id, step]));
  if (pending.size !== steps.length) throw new Error("Workflow contains duplicate step IDs");
  const complete = new Set<string>();
  while (pending.size) {
    const ready = [...pending.values()].filter(step => (step.dependsOn ?? []).every(id => complete.has(id)));
    if (!ready.length) throw new Error("Workflow has a missing dependency or cycle");
    for (const step of ready) { pending.delete(step.id); complete.add(step.id); }
  }
}
