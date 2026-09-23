import type { SessionInfo } from "@qone/protocol";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type SidebarLayout = "project" | "list";
export type ChatSort = "priority" | "recent" | "manual";
export interface SidebarPreferences {
  layout: SidebarLayout;
  sort: ChatSort;
  manualOrder: string[];
  priorityIds: string[];
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

interface SidebarState extends SidebarPreferences {
  setLayout: (layout: SidebarLayout) => void;
  setSort: (sort: ChatSort, sessions: readonly SessionInfo[]) => void;
  togglePriority: (id: string) => void;
  moveSession: (sessions: readonly SessionInfo[], source: string, target: string, after?: boolean) => void;
}

export const useSidebarPreferences = create<SidebarState>()(persist((set, get) => ({
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
    if (current.sort !== "manual") return;
    set({ manualOrder: moveSidebarSession(sortSidebarSessions(sessions, current).map((session) => session.id), source, target, after) });
  },
}), {
  name: SIDEBAR_STORAGE_KEY,
  storage: createJSONStorage(() => localStorage),
  partialize: ({ layout, sort, manualOrder, priorityIds }) => ({ layout, sort, manualOrder, priorityIds }),
  merge: (saved, current) => ({ ...current, ...parseSidebarPreferences(saved) }),
}));
