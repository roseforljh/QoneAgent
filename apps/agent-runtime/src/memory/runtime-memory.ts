import type { Db, MessageRepo, RunRepo, SessionRepo, SettingsRepo, WorkspaceRepo } from "@qone/database";
import type { AgentEvent } from "@qone/protocol";
import { MemoryService, type MemoryServiceOptions } from "./memory-service.js";
import { MemoryStore } from "./memory-store.js";

/**
 * Conversation memory uses chat text for summaries and automatic preferences.
 * Execution error records have a separate permission path (ExecutionStats).
 */
export function createRuntimeMemory(input: Pick<MemoryServiceOptions, "modelId" | "complete" | "onChange" | "onError"> & {
  db: Db;
  settingsRepo: SettingsRepo;
  sessionRepo: SessionRepo;
  messageRepo: MessageRepo;
  runRepo: RunRepo;
  workspaceRepo: WorkspaceRepo;
  isMemorySource(id: string): boolean;
}) {
  const { db, settingsRepo, sessionRepo, messageRepo, runRepo, workspaceRepo, isMemorySource, modelId, complete, onChange, onError } = input;
  const workspaceOf = (id: string) => {
    const workspace = sessionRepo.get(id)?.workspaceId;
    return workspace && workspaceRepo.get(workspace) && isMemorySource(id) ? workspace : undefined;
  };
  const memory = new MemoryService({
    store: new MemoryStore(settingsRepo), modelId, complete, onChange, onError,
    source: {
      candidates: () => {
        const active = runRepo.activeSessionIds();
        const workspaces = new Set(workspaceRepo.list().map(({ id }) => id));
        return sessionRepo.list().filter(session => isMemorySource(session.id))
          .map(({ id, title, updatedAt, workspaceId }) => ({ id, title, updatedAt, active: active.has(id),
            workspaceId: workspaceId && workspaces.has(workspaceId) ? workspaceId : undefined }));
      },
      exists: id => Boolean(sessionRepo.get(id)),
      transcript: id => messageRepo.visibleTextBySession(id),
    },
    workspaceOf,
    workspaceIndex: (id) => {
      const live = new Set(workspaceRepo.list().map(({ id }) => id));
      return new Map(sessionRepo.list(id).flatMap(session => session.workspaceId && live.has(session.workspaceId) && isMemorySource(session.id)
        ? [[session.id, session.workspaceId] as const] : []));
    },
    searchConversations: (query, excludeId) => {
      const workspaceId = workspaceOf(excludeId);
      return workspaceId ? sessionRepo.search(query, 20, { workspaceId, excludeId })
        .filter(({ session }) => isMemorySource(session.id))
        .map(({ session, content }) => ({ id: session.id, title: session.title, content: content ?? session.title })) : [];
    },
    pendingContinuation: (id, runId) => {
      const selected = settingsRepo.get<string | null>(`memory.resume:${id}`);
      return selected && !messageRepo.hasPriorNativePrompt(id, runId) ? selected : undefined;
    },
  });
  return {
    memory,
    observe(event: AgentEvent) {
      if (event.type === "subagent.finished" || event.scope !== "subagent"
        && ["agent.completed", "agent.cancelled", "agent.failed"].includes(event.type)) {
        void memory.refresh();
      }
    },
    recover(markInterrupted: () => void) {
      try {
        db.$client.transaction(() => {
          markInterrupted();
        }).immediate();
      } catch (error) {
        onError(error);
        markInterrupted();
      }
    },
  };
}
