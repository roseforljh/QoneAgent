import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SidebarLayout = "project" | "list";
export type ChatSort = "priority" | "recent" | "manual";
export interface SidebarPreferences {
  layout: SidebarLayout;
  sort: ChatSort;
  manualOrder: string[];
  priorityIds: string[];
  workspaceOrder: string[];
}

export const SIDEBAR_STORAGE_KEY = "qone-sidebar-preferences";

export function parseSidebarPreferences(value: unknown): SidebarPreferences {
  const saved = value && typeof value === "object" ? value as Partial<SidebarPreferences> : {};
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  return {
    layout: saved.layout === "list" ? "list" : "project",
    sort: saved.sort === "manual" || saved.sort === "priority" ? saved.sort : "recent",
    manualOrder: ids(saved.manualOrder),
    priorityIds: ids(saved.priorityIds),
    workspaceOrder: ids(saved.workspaceOrder),
  };
}

export function sortSidebarSessions(sessions: readonly SessionInfo[], prefs: SidebarPreferences): SessionInfo[] {
  const priority = new Set(prefs.priorityIds);
  const positions = new Map(prefs.manualOrder.map((id, index) => [id, index]));
  return [...sessions].sort((a, b) => {
    if (prefs.sort === "priority") {
      const rank = Number(priority.has(b.id)) - Number(priority.has(a.id));
      if (rank) return rank;
    }
    if (prefs.sort === "manual") {
      const rank = (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER);
      if (rank) return rank;
    }
    return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
  });
}

export function groupProjectSidebarSessions(sessions: readonly SessionInfo[], workspaceIds: readonly string[], prefs: SidebarPreferences) {
  const pinnedIds = new Set(prefs.priorityIds);
  const pinned: SessionInfo[] = [];
  const byWorkspace = new Map(workspaceIds.map((id) => [id, [] as SessionInfo[]]));
  const unassigned: SessionInfo[] = [];

  for (const session of sortSidebarSessions(sessions, prefs)) {
    if (pinnedIds.has(session.id)) pinned.push(session);
    else {
      const projectSessions = session.workspaceId ? byWorkspace.get(session.workspaceId) : undefined;
      if (projectSessions) projectSessions.push(session);
      else unassigned.push(session);
    }
  }

  return { pinned, byWorkspace, unassigned };
}

/** An explicit null selects unassigned/orphaned chats; undefined selects all. */
export function filterSidebarSessions(sessions: readonly SessionInfo[], workspaceId: string | null | undefined, workspaceIds: readonly string[]): SessionInfo[] {
  const known = new Set(workspaceIds);
  return sessions.filter((session) => workspaceId === undefined || (workspaceId === null
    ? !session.workspaceId || !known.has(session.workspaceId)
    : session.workspaceId === workspaceId));
}

export function moveSidebarSession(order: readonly string[], source: string, target: string, after = false): string[] {
  if (source === target || !order.includes(source) || !order.includes(target)) return [...order];
  const next = order.filter((id) => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  return next;
}

export function sortSidebarWorkspaces(workspaces: readonly WorkspaceInfo[], order: readonly string[]): WorkspaceInfo[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...workspaces].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
}

interface SidebarState extends SidebarPreferences {
  setLayout: (layout: SidebarLayout) => void;
  setSort: (sort: ChatSort, sessions: readonly SessionInfo[]) => void;
  togglePriority: (id: string) => void;
  moveSession: (sessions: readonly SessionInfo[], source: string, target: string, after?: boolean) => void;
  moveWorkspace: (workspaces: readonly WorkspaceInfo[], source: string, target: string, after?: boolean) => void;
}

export const createSidebarPreferencesStore = (storage = createJSONStorage<SidebarPreferences>(() => localStorage)) => create<SidebarState>()(persist((set, get) => ({
  ...parseSidebarPreferences(null),
  setLayout: (layout) => set({ layout }),
  setSort: (sort, sessions) => {
    const current = get();
    // Freeze the visible order on the first manual sort; retain user order on later switches.
    set({ sort, ...(sort === "manual" && !current.manualOrder.length
      ? { manualOrder: sortSidebarSessions(sessions, current).map((session) => session.id) } : {}) });
  },
  togglePriority: (id) => set((state) => ({ priorityIds: state.priorityIds.includes(id)
    ? state.priorityIds.filter((value) => value !== id) : [...state.priorityIds, id] })),
  moveSession: (sessions, source, target, after = false) => {
    const current = get();
    if (source === target || !sessions.some((session) => session.id === source) || !sessions.some((session) => session.id === target)) return;
    set({ sort: "manual", manualOrder: moveSidebarSession(sortSidebarSessions(sessions, current).map((session) => session.id), source, target, after) });
  },
  moveWorkspace: (workspaces, source, target, after = false) => {
    const current = get();
    if (source === target || !workspaces.some((workspace) => workspace.id === source) || !workspaces.some((workspace) => workspace.id === target)) return;
    set({ workspaceOrder: moveSidebarSession(sortSidebarWorkspaces(workspaces, current.workspaceOrder).map((workspace) => workspace.id), source, target, after) });
  },
}), {
  name: SIDEBAR_STORAGE_KEY,
  storage,
  partialize: ({ layout, sort, manualOrder, priorityIds, workspaceOrder }) => ({ layout, sort, manualOrder, priorityIds, workspaceOrder }),
  merge: (saved, current) => ({ ...current, ...parseSidebarPreferences(saved) }),
}));

export const useSidebarPreferences = createSidebarPreferencesStore();
