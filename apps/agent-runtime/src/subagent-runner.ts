import { runtimeText } from "./runtime-localization";
import { detectImageModel, type AssistantMessagePart, type MessageAttachmentInfo, type SubagentConfigInfo, type SubagentRunInfo } from "@qone/protocol";
import type { RunRepo, SessionRepo, SubagentRunRepo, WorkspaceRepo } from "@qone/database";
import type { PiAdapter } from "./pi-adapter.js";
import { buildSubagentPrompt, subagentCatalog } from "./subagents.js";
import { resolveSubagentSelection, type SubagentWorkflowStep } from "./subagent-selection.js";
import { SubagentScheduler } from "./subagent-scheduler.js";

export interface SubagentController {
  list(sessionId: string, ownerId?: string): { runId: string; title: string; task: string; status: string; profileId: string | null; model: string | null }[];
  query(runId: string): SubagentRunInfo | undefined;
  catalog(): ReturnType<typeof subagentCatalog>;
  control(runId: string, action: "stop" | "resume" | "retry" | "steer" | "follow_up", message?: string): Promise<SubagentRunInfo>;
  wait(runId: string, timeoutMs?: number, signal?: AbortSignal, callerId?: string): Promise<SubagentRunInfo>;
  recordEvent(id: string, type: string, payload: unknown, sequence: number): void;
  fail(id: string, message: string): void;
  dispose(sessionId: string, parentRunIds?: string[]): Promise<void>;
  workflow(parentSessionId: string, parentRunId: string, steps: SubagentWorkflowStep[], context?: { model?: string; permissionMode?: "ask" | "auto" | "full"; signal?: AbortSignal }): Promise<SubagentRunInfo[]>;
}

type TextChunkBuffers = Map<string, string[]>;

export function subagentInfo(runId: string, repo: SubagentRunRepo, runs: RunRepo, streams: TextChunkBuffers, liveParts?: AssistantMessagePart[]): SubagentRunInfo | undefined {
  const row = repo.get(runId);
  const run = runs.get(runId);
  if (!row || !run) return undefined;
  const parts = liveParts ?? JSON.parse(row.parts) as AssistantMessagePart[];
  return {
    id: runId, parentSessionId: row.parentSessionId, parentRunId: row.parentRunId,
    parentSubagentId: row.parentSubagentId ?? undefined, depth: row.depth ?? 0,
    toolCallId: row.toolCallId, executionSessionId: row.executionSessionId ?? undefined,
    profileId: row.profileId ?? undefined,
    title: row.title, task: row.task,
    model: row.model ?? undefined,
    permissionMode: row.permissionMode as SubagentRunInfo["permissionMode"],
    tools: row.tools ? JSON.parse(row.tools) as string[] : undefined,
    status: run.status as SubagentRunInfo["status"],
    startedAt: run.startedAt ?? 0, completedAt: run.completedAt ?? undefined,
    content: row.content, parts,
    streaming: streams.get(runId)?.join(""), error: run.error ?? undefined,
    turnCount: row.turnCount ?? 1, retryCount: row.retryCount ?? 0,
    workflowId: row.workflowId ?? undefined, workflowStepId: row.workflowStepId ?? undefined,
    dependsOn: row.dependsOn ? JSON.parse(row.dependsOn) as string[] : undefined,
    contextMode: row.contextMode as SubagentRunInfo["contextMode"], contextMessageCount: row.contextMessageCount ?? 0,
    tokenUsage: row.tokenUsage ? JSON.parse(row.tokenUsage) : undefined,
    children: repo.listBySession(row.parentSessionId).filter((child) => child.parentSubagentId === runId).map((child) => child.runId),
    messages: repo.listMessages(runId).map((message) => ({
      id: message.id, sequence: message.sequence,
      role: message.role as "user" | "assistant" | "tool" | "system", content: message.content,
      internal: message.role === "user" && Boolean(message.rawMessage),
      parts: message.parts ? (JSON.parse(message.parts) as AssistantMessagePart[]).map(part => part.type === "tool-call"
        ? parts.find(current => current.type === "tool-call" && current.toolCallId === part.toolCallId) ?? part : part) : undefined,
      createdAt: message.createdAt,
    })),
  };
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
  publish: (runId: string) => void;
  emit: (type: string, payload: unknown, sessionId?: string, runId?: string) => void;
}): SubagentController {
  const { adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
    partsByRun, messageSequenceByRun, assistantBuffers, streamBuffers, subagentStreams,
    activeSubagents, publish, emit } = options;
  const policy = () => options.runtime?.() ?? options.config().runtime;
  type Job = { abort: AbortController; done: Promise<void>; state: "queued" | "running"; failure?: Error; cancelled: boolean };
  const jobs = new Map<string, Job>();
  const scheduler = new SubagentScheduler(() => policy().maxConcurrent);
  const yielding = new Map<string, { count: number; held: boolean }>();

  const query = (id: string) => subagentInfo(id, repo, runRepo, subagentStreams, partsByRun.get(id));
  const requireInfo = (id: string) => {
    const info = query(id);
    if (!info) throw new Error(`Unknown subagent ${id}`);
    return info;
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
        if (entry.held && !parent.abort.signal.aborted) await scheduler.acquire(parentId, parent.abort.signal);
      }
    }
  };

  const start = (id: string, prompt: string, newTurn: boolean, persistUserMessage: boolean, signal?: AbortSignal, attachments?: MessageAttachmentInfo[]): Job => {
    if (jobs.has(id)) throw new Error("Subagent already has an active turn");
    const row = repo.get(id)!;
    const parent = sessionRepo.get(row.parentSessionId);
    const cwd = parent?.workspaceId ? workspaceRepo.get(parent.workspaceId)?.path : undefined;
    if (!cwd) throw new Error("Subagent workspace is unavailable");
    const executionSessionId = row.executionSessionId ?? `${row.parentSessionId}::subagent::${id}`;
    if (!row.executionSessionId) repo.updateExecutionSession(id, executionSessionId);
    const job: Job = { abort: new AbortController(), done: Promise.resolve(), state: "queued", cancelled: false };
    jobs.set(id, job);
    activeSubagents.add(id);
    partsByRun.set(id, JSON.parse(row.parts));
    runRepo.setStatus(id, "created");
    if (!newTurn) repo.incrementTurn(id);
    if (persistUserMessage) repo.appendMessage(id, "user", prompt);
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
        timer = setTimeout(() => interrupt(id, new Error("Subagent timed out")), policy().timeoutMs);
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
            toolAllowList: row.tools ? JSON.parse(row.tools) : undefined, attachments,
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
      } catch (error) {
        runRepo.finish(id, job.cancelled ? "cancelled" : "failed", String(job.failure ?? error));
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        const parts = partsByRun.get(id) ?? [];
        const content = assistantBuffers.get(id) ?? [...parts].reverse().find(p => p.type === "text")?.text ?? row.content;
        repo.save(id, content, parts);
        activeSubagents.delete(id);
        jobs.delete(id);
        scheduler.release(id);
        subagentStreams.delete(id);
        partsByRun.delete(id);
        messageSequenceByRun.delete(id);
        assistantBuffers.delete(id);
        streamBuffers.delete(id);
        publish(id);
        emit("subagent.finished", { id, status: runRepo.get(id)?.status }, row.executionSessionId ?? undefined, id);
      }
    };
    job.done = execute();
    return job;
  };

  type Dispatch = Parameters<NonNullable<Parameters<PiAdapter["setSubagentDispatcher"]>[0]>>[0] &
    { workflowId?: string; workflowStepId?: string; dependsOn?: string[] };
  const dispatch = async (input: Dispatch) => {
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
    const prompt = buildSubagentPrompt(agent
      ? { id: agent.id, name: agent.name, instructions: agent.instructions }
      : { id: "delegate", name: input.title, instructions: runtimeText("subagent-runner.complete_the_delegated_task_parent_context_is_provided_for") }, input.task, context);
    const inheritedAttachments = originalAttachments(parentSessionId, input.parentRunId);
    const attachments = input.mediaAttachment && !inheritedAttachments.some((item) => item.localPath === input.mediaAttachment?.localPath)
      ? [...inheritedAttachments, input.mediaAttachment] : inheritedAttachments;
    const child = runRepo.create(parentSessionId);
    const rank = { ask: 0, auto: 1, full: 2 };
    const ceiling = (inherited?.permissionMode as "ask" | "auto" | "full" | null) ?? input.permissionMode;
    const requested = agent?.permissionMode ?? ceiling;
    const permissionMode = rank[requested] > rank[ceiling] ? ceiling : requested;
    const inheritedTools: string[] | undefined = inherited?.tools ? JSON.parse(inherited.tools) : undefined;
    const tools = inheritedTools ? (agent?.tools?.length ? agent.tools.filter(t => inheritedTools.includes(t)) : inheritedTools) : agent?.tools?.length ? agent.tools : undefined;
    const model = agent?.modelId || policy().temporaryModelId || input.fallbackModel || inherited?.model || undefined;
    repo.create({
      ...input, runId: child.id, parentSessionId, parentSubagentId: inherited?.runId, depth,
      executionSessionId: `${parentSessionId}::subagent::${child.id}`,
      profileId: agent?.id, model,
      permissionMode, tools, contextMode: policy().contextMode, contextMessageCount: count,
    });
    const work = async () => {
      const directGeneration = model && (adapter.isDirectGenerationModel?.(model) ?? detectImageModel({ model }).isImageModel);
      const job = start(child.id, directGeneration ? input.task : prompt, true, true, input.signal, attachments);
      if (input.background) return `Subagent started in background. runId=${child.id}`;
      await job.done;
      const info = requireInfo(child.id);
      return JSON.stringify({ runId: child.id, status: info.status, result: info.content, error: info.error });
    };
    return input.background ? work() : withoutPermit(inherited?.runId, work);
  };
  adapter.setSubagentDispatcher(dispatch);
  adapter.setSubagentPolicy?.(() => ({
    allowNested: policy().allowNested,
    maxDepth: policy().maxDepth,
    maxConcurrent: policy().maxConcurrent,
  }));

  const controller: SubagentController = {
    query,
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
      if (!jobs.has(id)) return;
      const raw = (payload as { message?: { role?: string; content?: unknown; usage?: unknown } })?.message;
      if (type === "message.completed" && raw?.role) {
        const text = typeof raw.content === "string" ? raw.content
          : Array.isArray(raw.content) ? raw.content.filter(p => p?.type === "text").map(p => p.text).join("") : "";
        const last = repo.listMessages(id).reverse().find(message => message.role !== "system");
        if (raw.role === "user" && last?.role === "user") return;
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
    },
    control: async (id, action, message) => {
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
        repo.appendMessage(id, "user", message.trim());
        repo.incrementTurn(id);
      } else {
        if ((action === "steer" || action === "follow_up") && !message?.trim()) throw new Error(`${action} requires a message`);
        if (action === "retry") repo.incrementRetry(id);
        const attachments = originalAttachments(row.parentSessionId, id);
        await start(id, message?.trim() || (action === "retry" ? row.task : runtimeText("subagent-runner.continue_the_previous_task_and_describe_the_new_results")), false, action !== "retry", undefined, attachments).done;
      }
      return requireInfo(id);
    },
    wait: async (id, timeoutMs = policy().timeoutMs, signal, callerId) => withoutPermit(callerId, async () => {
      requireInfo(id);
      const deadline = Date.now() + timeoutMs;
      while (jobs.has(id) && Date.now() < deadline) {
        if (signal?.aborted) throw signal.reason;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return requireInfo(id);
    }),
    workflow: async (sessionId, parentRunId, steps, context) => {
      validateWorkflow(steps, policy().workflowMaxSteps);
      // Fail invalid selections before any independent step creates a child run.
      for (const step of steps) resolveSubagentSelection(options.config(), step);
      const parent = repo.get(parentRunId);
      if (parent && !policy().allowNested) throw new Error("Nested subagents are disabled in settings");
      const root = parent?.parentSessionId ?? sessionId;
      const workflowId = crypto.randomUUID();
      const results = new Map<string, SubagentRunInfo>();
      const pending = new Map(steps.map(step => [step.id, step]));
      return withoutPermit(parent?.runId, async () => {
        while (pending.size) {
          if (context?.signal?.aborted) throw context.signal.reason;
          const ready = [...pending.values()].filter(step => (step.dependsOn ?? []).every(id => results.has(id)));
          await Promise.all(ready.map(async step => {
            const dependencies = step.dependsOn ?? [];
            if (dependencies.some(id => results.get(id)?.status !== "completed")) throw new Error(`Workflow dependency failed for ${step.id}`);
            await dispatch({
              parentSessionId: sessionId, parentRunId, title: step.title,
              task: step.task + dependencies.map(id => `\nDependency ${id}:\n${results.get(id)!.content}`).join("\n"),
              capability: step.capability, subagentId: step.subagentId, toolCallId: `workflow:${workflowId}:${step.id}`,
              workflowId, workflowStepId: step.id, dependsOn: dependencies,
              fallbackModel: context?.model, permissionMode: context?.permissionMode ?? "ask", signal: context?.signal,
            });
            const created = repo.listBySession(root).find(row => row.workflowId === workflowId && row.workflowStepId === step.id)!;
            results.set(step.id, requireInfo(created.runId));
            pending.delete(step.id);
          }));
        }
        return steps.map(step => results.get(step.id)!);
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
