import { expect, test } from "bun:test";
import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";
import { createJSONStorage } from "zustand/middleware";
import { createSidebarPreferencesStore, filterSidebarSessions, groupProjectSidebarSessions, moveSidebarSession, parseSidebarPreferences, SIDEBAR_STORAGE_KEY, sortSidebarSessions, sortSidebarWorkspaces, type SidebarPreferences } from "../src/lib/sidebar-preferences";

const session = (id: string, updatedAt: number, workspaceId?: string): SessionInfo => ({
  id, title: id, createdAt: updatedAt - 1, updatedAt, workspaceId,
});

test("sidebar preferences use safe defaults and discard malformed ids", () => {
  expect(parseSidebarPreferences({ layout: "bad", sort: "bad", priorityIds: ["a", 1, "a"] })).toEqual({
    collapsed: false, layout: "project", sort: "recent", manualOrder: [], manualActivity: {}, priorityIds: ["a"], workspaceOrder: [],
  });
});

test("sidebar visibility survives subscriber remounts and storage restoration in both directions", () => {
  const saved = new Map<string, string>();
  const storage = createJSONStorage<SidebarPreferences>(() => ({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
    removeItem: (key) => { saved.delete(key); },
  }));
  const preferences = createSidebarPreferencesStore(storage);
  const unsubscribe = preferences.subscribe(() => {});
  preferences.getState().setCollapsed(true);
  unsubscribe();
  const resubscribe = preferences.subscribe(() => {});
  expect(preferences.getState().collapsed).toBe(true);
  resubscribe();

  const restored = createSidebarPreferencesStore(storage);
  expect(restored.getState().collapsed).toBe(true);
  restored.getState().setLayout("list");
  expect(createSidebarPreferencesStore(storage).getState().collapsed).toBe(true);
  restored.getState().setCollapsed((current) => !current);
  const expanded = createSidebarPreferencesStore(storage);
  expect(expanded.getState().collapsed).toBe(false);
  expect(expanded.getState().layout).toBe("list");
  expanded.getState().setCollapsed((current) => !current);
  expanded.getState().setCollapsed((current) => !current);
  expect(createSidebarPreferencesStore(storage).getState().collapsed).toBe(false);
});

test("legacy or malformed sidebar visibility falls back to expanded", () => {
  expect(parseSidebarPreferences({ layout: "list", sort: "manual" })).toMatchObject({ collapsed: false, layout: "list", sort: "manual" });
  for (const collapsed of [undefined, null, "true", "false", 1, {}, []]) {
    expect(parseSidebarPreferences({ collapsed }).collapsed).toBe(false);
  }
  expect(parseSidebarPreferences({ collapsed: true }).collapsed).toBe(true);
});

test("recent and priority sorting are deterministic", () => {
  const sessions = [session("old", 1), session("new", 3), session("middle", 2)];
  expect(sortSidebarSessions(sessions, { ...parseSidebarPreferences(null), sort: "recent" }).map((item) => item.id)).toEqual(["new", "middle", "old"]);
  expect(sortSidebarSessions(sessions, { ...parseSidebarPreferences(null), sort: "priority", priorityIds: ["old"] }).map((item) => item.id)).toEqual(["old", "new", "middle"]);
});

test("manual order moves one chat and project filtering isolates orphan chats", () => {
  expect(moveSidebarSession(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  const sessions = [session("a", 1, "project-a"), session("b", 2), session("c", 3, "project-b")];
  expect(filterSidebarSessions(sessions, "project-a", ["project-a", "project-b"]).map((item) => item.id)).toEqual(["a"]);
  expect(filterSidebarSessions(sessions, null, ["project-a", "project-b"]).map((item) => item.id)).toEqual(["b"]);
});

test("project sidebar places each chat in one visible group", () => {
  const sessions = [session("pinned", 4, "project-a"), session("project", 3, "project-a"), session("orphan", 2, "removed-project"), session("unassigned", 1)];
  const groups = groupProjectSidebarSessions(sessions, ["project-a"], { ...parseSidebarPreferences(null), priorityIds: ["pinned"] });
  expect(groups.pinned.map((item) => item.id)).toEqual(["pinned"]);
  expect(groups.byWorkspace.get("project-a")?.map((item) => item.id)).toEqual(["project"]);
  expect(groups.unassigned.map((item) => item.id)).toEqual(["orphan", "unassigned"]);
});

test("workspace ordering tolerates deleted projects, new projects and malformed saved ids", () => {
  const workspaces: WorkspaceInfo[] = [
    { id: "a", name: "A", path: "a", createdAt: 1 },
    { id: "b", name: "B", path: "b", createdAt: 2 },
    { id: "new", name: "New", path: "new", createdAt: 3 },
  ];
  const prefs = parseSidebarPreferences({ workspaceOrder: ["deleted", "b", false, "b", "a"] });
  expect(prefs.workspaceOrder).toEqual(["deleted", "b", "a"]);
  expect(sortSidebarWorkspaces(workspaces, prefs.workspaceOrder).map((item) => item.id)).toEqual(["b", "a", "new"]);
  expect(workspaces.map((item) => item.id)).toEqual(["a", "b", "new"]);
});

test("dragging freezes the current order, saves it, and preserves project membership and pinned chats", async () => {
  const saved = new Map<string, string>();
  const storage = createJSONStorage<SidebarPreferences>(() => ({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
    removeItem: (key) => { saved.delete(key); },
  }));
  const preferences = createSidebarPreferencesStore(storage);
  preferences.setState({ ...parseSidebarPreferences(null), priorityIds: ["pinned"] });
  const sessions = [session("a", 3, "project"), session("b", 2, "project"), session("c", 1, "project"), session("pinned", 4, "other")];
  preferences.getState().moveSession(sessions, "c", "a");
  expect(preferences.getState().sort).toBe("manual");
  expect(sortSidebarSessions(sessions, preferences.getState()).map((item) => item.id)).toEqual(["pinned", "c", "a", "b"]);
  const workspaces: WorkspaceInfo[] = [
    { id: "project", name: "Project", path: "project", createdAt: 1 },
    { id: "other", name: "Other", path: "other", createdAt: 2 },
  ];
  preferences.getState().moveWorkspace(workspaces, "other", "project");
  const restored = createSidebarPreferencesStore(storage);
  await restored.persist.rehydrate();
  expect(restored.getState().manualOrder).toEqual(["pinned", "c", "a", "b"]);
  expect(restored.getState().workspaceOrder).toEqual(["other", "project"]);
  const groups = groupProjectSidebarSessions(sessions, ["project", "other"], restored.getState());
  expect(groups.pinned.map((item) => item.id)).toEqual(["pinned"]);
  expect(groups.byWorkspace.get("project")?.map((item) => item.id)).toEqual(["c", "a", "b"]);
  expect(sessions.map((item) => item.workspaceId)).toEqual(["project", "project", "project", "other"]);
  const before = saved.get(SIDEBAR_STORAGE_KEY);
  restored.getState().moveSession(sessions, "missing", "a");
  restored.getState().moveWorkspace(workspaces, "other", "missing");
  expect(saved.get(SIDEBAR_STORAGE_KEY)).toBe(before);
});
