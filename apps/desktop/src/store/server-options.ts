import type { AgentState } from "../store";
import { pruneRunOptionServers, saveNewSessionRunOptions, saveRunOptions, saveWorkspaceServerIds } from "../lib/run-options";
import { useServerStore } from "../lib/server-state";

export function updateConversationServers(state: AgentState, ids: string[], sessionId?: string): Partial<AgentState> {
  const serverIds = [...new Set(ids)];
  const sid = sessionId ?? state.currentSessionId;
  if (!sid) {
    const draftRunOptions = { ...state.draftRunOptions, serverIds };
    saveNewSessionRunOptions(draftRunOptions);
    return { draftRunOptions };
  }
  const runOptionsBySession = { ...state.runOptionsBySession, [sid]: { ...state.runOptionsBySession[sid], serverIds } };
  saveRunOptions(runOptionsBySession);
  return { runOptionsBySession };
}

export function updateWorkspaceServers(state: AgentState, workspaceId: string, ids: string[]): Partial<AgentState> {
  const { loaded, servers } = useServerStore.getState();
  if (!loaded || !state.workspaces.some((workspace) => workspace.id === workspaceId)) return state;
  const liveIds = new Set(servers.map((server) => server.id));
  const selected = [...new Set(ids.filter((id) => liveIds.has(id)))];
  const workspaceServerIds = { ...state.workspaceServerIds };
  if (selected.length) workspaceServerIds[workspaceId] = selected;
  else delete workspaceServerIds[workspaceId];
  saveWorkspaceServerIds(workspaceServerIds);
  return { workspaceServerIds };
}

export function reconcileServerOptions(state: AgentState, liveIds: ReadonlySet<string>): Partial<AgentState> {
  const draftRunOptions = pruneRunOptionServers(state.draftRunOptions, liveIds);
  const entries = Object.entries(state.runOptionsBySession).map(([id, options]) => [id, pruneRunOptionServers(options, liveIds)] as const);
  const changed = entries.some(([id, options]) => options !== state.runOptionsBySession[id]);
  let workspaceServerIds = state.workspaceServerIds;
  for (const [workspaceId, ids] of Object.entries(state.workspaceServerIds)) {
    const live = ids.filter(id => liveIds.has(id));
    if (live.length === ids.length) continue;
    if (workspaceServerIds === state.workspaceServerIds) workspaceServerIds = { ...workspaceServerIds };
    if (live.length) workspaceServerIds[workspaceId] = live;
    else delete workspaceServerIds[workspaceId];
  }
  if (workspaceServerIds !== state.workspaceServerIds) saveWorkspaceServerIds(workspaceServerIds);
  if (draftRunOptions !== state.draftRunOptions) saveNewSessionRunOptions(draftRunOptions);
  if (!changed && draftRunOptions === state.draftRunOptions && workspaceServerIds === state.workspaceServerIds) return state;
  const runOptionsBySession = changed ? Object.fromEntries(entries) : state.runOptionsBySession;
  if (changed) saveRunOptions(runOptionsBySession);
  return { draftRunOptions, runOptionsBySession, workspaceServerIds };
}
