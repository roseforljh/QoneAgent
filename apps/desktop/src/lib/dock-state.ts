import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { BrowserDockRequest } from "./browser-dock";
import type { RunChangesTarget } from "./run-changes-navigation";
import type { WorkspaceFileLocation, WorkspaceFileTarget } from "./workspace-file-navigation";

export type DockView = "session" | "terminal" | "files" | "file" | "git" | "browser" | "mcp" | "skills" | "subagents" | "servers" | "changes" | "sideChat" | "background";
export type DockFileTarget = WorkspaceFileLocation & Pick<WorkspaceFileTarget, "attachment"> & { path: string; requestId: string };
export type DockTab = { id: string; view: DockView; workspaceId?: string; /** SSH terminal target. */ serverId?: string; browserTarget?: BrowserDockRequest; fileTarget?: DockFileTarget; changesTarget?: RunChangesTarget; refreshNonce?: number };
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
  pruneServers: (liveIds: ReadonlySet<string>) => void;
}
type DockPersistedState = Pick<DockStore, "scopes">;
export function createDockStateStore(storage = createJSONStorage<DockPersistedState>(() => localStorage)) {
  return create<DockStore>()(persist((set) => ({
  scopes: {},
  update: (key, owner, change) => set((state) => ({ scopes: { ...state.scopes, [key]: change(state.scopes[key] ?? { ...EMPTY_DOCK, ...owner }) } })),
  remove: (key) => set((state) => {
    if (!state.scopes[key]) return state;
    const scopes = { ...state.scopes };
    delete scopes[key];
    return { scopes };
  }),
  pruneServers: (liveIds) => set((state) => {
    let changed = false;
    const scopes = Object.fromEntries(Object.entries(state.scopes).map(([key, scope]) => {
      let next = scope;
      for (const tab of scope.openTabs) if (tab.serverId && !liveIds.has(tab.serverId)) next = removeDockTab(next, tab.id);
      changed ||= next !== scope;
      return [key, next];
    }));
    return changed ? { scopes } : state;
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
  }), {
    name: "qone-dock-scopes",
    storage,
    version: 1,
    partialize: ({ scopes }) => ({ scopes }),
  }));
}

export const useDockState = createDockStateStore();

export function removeDockTab(scope: DockScope, id: string): DockScope {
  const index = scope.openTabs.findIndex((tab) => tab.id === id);
  if (index < 0) return scope;
  const openTabs = scope.openTabs.filter((tab) => tab.id !== id);
  return { ...scope, openTabs, activeTabId: scope.activeTabId === id ? openTabs[Math.max(0, index - 1)]?.id : scope.activeTabId, collapsed: !openTabs.length || scope.collapsed };
}

/** Snapshot the targets, then use the single-tab close path until cancellation. */
export async function closeDockTabsToRight(tabs: readonly DockTab[], anchorId: string, close: (id: string) => Promise<boolean>): Promise<void> {
  const index = tabs.findIndex((tab) => tab.id === anchorId);
  if (index < 0) return;
  for (const tab of tabs.slice(index + 1).reverse()) {
    if (!await close(tab.id)) break;
  }
}

/** Snapshot all tabs except the anchor, then use the single-tab close path. */
export async function closeDockTabsExcept(tabs: readonly DockTab[], anchorId: string, close: (id: string) => Promise<boolean>): Promise<void> {
  if (!tabs.some((tab) => tab.id === anchorId)) return;
  for (const tab of [...tabs].reverse()) {
    if (tab.id !== anchorId && !await close(tab.id)) break;
  }
}

export function dockActiveView(scope: DockScope): DockView | undefined {
  return scope.collapsed ? undefined : scope.openTabs.find((tab) => tab.id === scope.activeTabId)?.view;
}

/** The model's browser reuses the session's AI browser tab instead of piling up new ones. */
export function agentBrowserTab(tabs: readonly DockTab[], target: BrowserDockRequest, newId: () => string): DockTab {
  const existing = tabs.find((tab) => tab.view === "browser" && (
    (target.browserId && tab.browserTarget?.browserId === target.browserId) || tab.browserTarget?.agentManaged));
  return { ...existing, id: existing?.id ?? newId(), view: "browser", browserTarget: target };
}

export function withTab(tabs: readonly DockTab[], tab: DockTab): DockTab[] {
  return tabs.some((item) => item.id === tab.id) ? tabs.map((item) => item.id === tab.id ? tab : item) : [...tabs, tab];
}

/**
 * The AI opened a page for a session whose dock is not mounted (the user is in another
 * conversation). Record the tab in that session's dock so the page is there when the user
 * returns; otherwise it lives on offscreen with no tab to find or close it.
 */
export function rememberAgentBrowserTab(sessionId: string, target: BrowserDockRequest): void {
  useDockState.getState().update(dockScopeKey(sessionId), { sessionId }, (scope) => {
    const tab = agentBrowserTab(scope.openTabs, target, () => crypto.randomUUID());
    return { ...scope, openTabs: withTab(scope.openTabs, tab), activeTabId: tab.id, collapsed: false };
  });
}

/** Each selected document has its own reader; reselecting it preserves the tab. */
export function filePreviewTab(tabs: readonly DockTab[], target: WorkspaceFileTarget, newId: () => string): DockTab {
  const existing = tabs.find((tab) => tab.view === "file" && tab.workspaceId === target.workspaceId && tab.fileTarget?.path === target.path
    && tab.fileTarget?.attachment?.data === target.attachment?.data
    && tab.fileTarget?.attachment?.mimeType === target.attachment?.mimeType
    && tab.fileTarget?.attachment?.sourceType === target.attachment?.sourceType);
  return {
    ...existing, id: existing?.id ?? newId(), view: "file", workspaceId: target.workspaceId,
    fileTarget: { path: target.path, attachment: target.attachment, line: target.line, column: target.column, endLine: target.endLine, requestId: newId() },
  };
}
