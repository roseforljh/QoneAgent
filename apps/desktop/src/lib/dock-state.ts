import { create } from "zustand";
import type { BrowserDockRequest } from "./browser-dock";

export type DockView = "session" | "terminal" | "files" | "git" | "browser" | "mcp" | "skills" | "subagents";
export type DockTab = { id: string; view: DockView; workspaceId?: string; browserTarget?: BrowserDockRequest; refreshNonce?: number };
export interface DockScope {
  sessionId?: string;
  workspaceId?: string;
  openTabs: DockTab[];
  activeTabId?: string;
  collapsed: boolean;
  maximized: boolean;
}
export const EMPTY_DOCK: DockScope = { openTabs: [], collapsed: true, maximized: false };
export function dockScopeKey(sessionId?: string, workspaceId?: string, draftId?: string): string {
  return JSON.stringify(sessionId ? ["session", sessionId] : ["draft", workspaceId ?? null, draftId ?? null]);
}
interface DockStore {
  scopes: Record<string, DockScope>;
  update: (key: string, owner: Pick<DockScope, "sessionId" | "workspaceId">, change: (scope: DockScope) => DockScope) => void;
  remove: (key: string) => void;
  reconcile: (sessions?: readonly { id: string }[], workspaces?: readonly { id: string }[]) => void;
}
export const useDockState = create<DockStore>((set) => ({
  scopes: {},
  update: (key, owner, change) => set((state) => ({ scopes: { ...state.scopes, [key]: change(state.scopes[key] ?? { ...EMPTY_DOCK, ...owner }) } })),
  remove: (key) => set((state) => {
    if (!state.scopes[key]) return state;
    const scopes = { ...state.scopes };
    delete scopes[key];
    return { scopes };
  }),
  reconcile: (sessions, workspaces) => set((state) => {
    const sessionIds = sessions && new Set(sessions.map((item) => item.id));
    const workspaceIds = workspaces && new Set(workspaces.map((item) => item.id));
    const scopes = Object.fromEntries(Object.entries(state.scopes).filter(([, scope]) =>
      (!scope.sessionId || !sessionIds || sessionIds.has(scope.sessionId)) &&
      (!scope.workspaceId || !workspaceIds || workspaceIds.has(scope.workspaceId)),
    ));
    return Object.keys(scopes).length === Object.keys(state.scopes).length ? state : { scopes };
  }),
}));

export function removeDockTab(scope: DockScope, id: string): DockScope {
  const index = scope.openTabs.findIndex((tab) => tab.id === id);
  if (index < 0) return scope;
  const openTabs = scope.openTabs.filter((tab) => tab.id !== id);
  return { ...scope, openTabs, activeTabId: scope.activeTabId === id ? openTabs[Math.max(0, index - 1)]?.id : scope.activeTabId, collapsed: !openTabs.length || scope.collapsed };
}

export function dockActiveView(scope: DockScope): DockView | undefined {
  return scope.collapsed ? undefined : scope.openTabs.find((tab) => tab.id === scope.activeTabId)?.view;
}
