import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { sessionActivityAt } from "./session-recency";

export type SidebarLayout = "project" | "list";
export type ChatSort = "priority" | "recent" | "manual";
export interface SidebarPreferences {
  collapsed: boolean;
  layout: SidebarLayout;
  sort: ChatSort;
  manualOrder: string[];
  /** Activity captured when the user last arranged chats; newer messages take precedence. */
  manualActivity: Record<string, number>;
  priorityIds: string[];
  workspaceOrder: string[];
  expandedWorkspaceIds: string[];
  expandedSectionIds: string[];
  workspaceExpandedStateInitialized: boolean;
  sectionExpandedStateInitialized: boolean;
}

export const SIDEBAR_STORAGE_KEY = "qone-sidebar-preferences";

export function parseSidebarPreferences(value: unknown): SidebarPreferences {
  const saved = value && typeof value === "object" ? value as Partial<SidebarPreferences> : {};
  const ids = (value: unknown) => Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string"))] : [];
  return {
    collapsed: saved.collapsed === true,
    layout: saved.layout === "list" ? "list" : "project",
    sort: saved.sort === "manual" || saved.sort === "priority" ? saved.sort : "recent",
    manualOrder: ids(saved.manualOrder),
    manualActivity: saved.manualActivity && typeof saved.manualActivity === "object" && !Array.isArray(saved.manualActivity)
      ? Object.fromEntries(Object.entries(saved.manualActivity).filter(([, at]) => typeof at === "number" && Number.isFinite(at))) : {},
    priorityIds: ids(saved.priorityIds),
    workspaceOrder: ids(saved.workspaceOrder),
    expandedWorkspaceIds: ids(saved.expandedWorkspaceIds),
    expandedSectionIds: ids(saved.expandedSectionIds),
    workspaceExpandedStateInitialized: saved.workspaceExpandedStateInitialized === true,
    sectionExpandedStateInitialized: saved.sectionExpandedStateInitialized === true,
  };
}

export function sortSidebarSessions(sessions: readonly SessionInfo[], prefs: SidebarPreferences): SessionInfo[] {
  const priority = new Set(prefs.priorityIds);
  const positions = new Map(prefs.manualOrder.map((id, index) => [id, index]));
  const changed = (session: SessionInfo) => !Object.hasOwn(prefs.manualActivity, session.id)
    || sessionActivityAt(session) > prefs.manualActivity[session.id]!;
  return [...sessions].sort((a, b) => {
    if (prefs.sort === "priority") {
      const rank = Number(priority.has(b.id)) - Number(priority.has(a.id));
      if (rank) return rank;
    }
    if (prefs.sort === "manual") {
      const aChanged = changed(a);
      const bChanged = changed(b);
      // A drag only fixes unchanged chats. New chats and new messages always rise.
      if (aChanged !== bChanged) return Number(bChanged) - Number(aChanged);
      if (!aChanged) {
        const rank = (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER);
        if (rank) return rank;
      }
    }
    return sessionActivityAt(b) - sessionActivityAt(a) || b.createdAt - a.createdAt || a.id.localeCompare(b.id);
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
  setCollapsed: (collapsed: boolean | ((current: boolean) => boolean)) => void;
  setLayout: (layout: SidebarLayout) => void;
  setSort: (sort: ChatSort, sessions: readonly SessionInfo[]) => void;
  togglePriority: (id: string) => void;
  moveSession: (sessions: readonly SessionInfo[], source: string, target: string, after?: boolean) => void;
  moveWorkspace: (workspaces: readonly WorkspaceInfo[], source: string, target: string, after?: boolean) => void;
  setWorkspaceExpanded: (id: string, expanded: boolean, defaultExpandedIds: readonly string[]) => void;
  setSectionExpanded: (id: string, expanded: boolean, defaultExpandedIds: readonly string[]) => void;
}

export const createSidebarPreferencesStore = (storage = createJSONStorage<SidebarPreferences>(() => localStorage)) => create<SidebarState>()(persist((set, get) => ({
  ...parseSidebarPreferences(null),
  setCollapsed: (collapsed) => set((state) => ({ collapsed: typeof collapsed === "function" ? collapsed(state.collapsed) : collapsed })),
  setLayout: (layout) => set({ layout }),
  setSort: (sort, sessions) => {
    const current = get();
    // Capture the visible order on entry, including any chats promoted by activity.
    set({ sort, ...(sort === "manual" && current.sort !== "manual"
      ? { manualOrder: sortSidebarSessions(sessions, current).map((session) => session.id),
          manualActivity: Object.fromEntries(sessions.map((session) => [session.id, sessionActivityAt(session)])) } : {}) });
  },
  togglePriority: (id) => set((state) => ({ priorityIds: state.priorityIds.includes(id)
    ? state.priorityIds.filter((value) => value !== id) : [...state.priorityIds, id] })),
  moveSession: (sessions, source, target, after = false) => {
    const current = get();
    if (source === target || !sessions.some((session) => session.id === source) || !sessions.some((session) => session.id === target)) return;
    set({ sort: "manual", manualOrder: moveSidebarSession(sortSidebarSessions(sessions, current).map((session) => session.id), source, target, after),
      manualActivity: Object.fromEntries(sessions.map((session) => [session.id, sessionActivityAt(session)])) });
  },
  moveWorkspace: (workspaces, source, target, after = false) => {
    const current = get();
    if (source === target || !workspaces.some((workspace) => workspace.id === source) || !workspaces.some((workspace) => workspace.id === target)) return;
    set({ workspaceOrder: moveSidebarSession(sortSidebarWorkspaces(workspaces, current.workspaceOrder).map((workspace) => workspace.id), source, target, after) });
  },
  setWorkspaceExpanded: (id, expanded, defaultExpandedIds) => set((state) => {
    const current = state.workspaceExpandedStateInitialized ? state.expandedWorkspaceIds : [...defaultExpandedIds];
    const next = expanded ? [...new Set([...current, id])] : current.filter((value) => value !== id);
    return { expandedWorkspaceIds: next, workspaceExpandedStateInitialized: true };
  }),
  setSectionExpanded: (id, expanded, defaultExpandedIds) => set((state) => {
    const current = state.sectionExpandedStateInitialized ? state.expandedSectionIds : [...defaultExpandedIds];
    const next = expanded ? [...new Set([...current, id])] : current.filter((value) => value !== id);
    return { expandedSectionIds: next, sectionExpandedStateInitialized: true };
  }),
}), {
  name: SIDEBAR_STORAGE_KEY,
  storage,
  version: 1,
  // Old manual preferences permanently froze chats and appended new ones at the bottom.
  // Retain the saved order/pins, but restore activity sorting for those legacy records.
  migrate: (saved) => {
    const preferences = parseSidebarPreferences(saved);
    return { ...preferences, sort: preferences.sort === "manual" ? "recent" : preferences.sort };
  },
  partialize: ({ collapsed, layout, sort, manualOrder, manualActivity, priorityIds, workspaceOrder, expandedWorkspaceIds, expandedSectionIds, workspaceExpandedStateInitialized, sectionExpandedStateInitialized }) => ({ collapsed, layout, sort, manualOrder, manualActivity, priorityIds, workspaceOrder, expandedWorkspaceIds, expandedSectionIds, workspaceExpandedStateInitialized, sectionExpandedStateInitialized }),
  merge: (saved, current) => ({ ...current, ...parseSidebarPreferences(saved) }),
}));

export const useSidebarPreferences = createSidebarPreferencesStore();
