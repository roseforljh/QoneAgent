import { expect, test } from "bun:test";
import type { SessionInfo } from "@qone/protocol";
import { createJSONStorage } from "zustand/middleware";
import { createSidebarPreferencesStore, groupProjectSidebarSessions, parseSidebarPreferences, SIDEBAR_STORAGE_KEY, sortSidebarSessions, type SidebarPreferences } from "../src/lib/sidebar-preferences";

const session = (id: string, updatedAt: number, workspaceId = "project"): SessionInfo => ({
  id, title: id, createdAt: 1, updatedAt, workspaceId,
});
const ids = (sessions: SessionInfo[]) => sessions.map((item) => item.id);
const fixture = () => {
  const saved = new Map<string, string>();
  const storage = createJSONStorage<SidebarPreferences>(() => ({
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value); },
    removeItem: (key) => { saved.delete(key); },
  }));
  return { saved, storage };
};

test("legacy persisted manual order migrates to recent without losing layout, pins, or order", () => {
  for (const layout of ["project", "list"] as const) {
    const { saved, storage } = fixture();
    saved.set(SIDEBAR_STORAGE_KEY, JSON.stringify({ version: 0, state: {
      collapsed: true, layout, sort: "manual", manualOrder: ["old", "middle", "latest"],
      priorityIds: ["pin"], workspaceOrder: ["project"],
    } }));
    const store = createSidebarPreferencesStore(storage);
    const preferences = store.getState();
    expect(preferences).toMatchObject({ collapsed: true, layout, sort: "recent",
      manualOrder: ["old", "middle", "latest"], priorityIds: ["pin"], workspaceOrder: ["project"] });
    const sessions = [session("old", 1), session("middle", 2), session("latest", 3)];
    expect(ids(sortSidebarSessions(sessions, preferences))).toEqual(["latest", "middle", "old"]);
    expect(ids(groupProjectSidebarSessions(sessions, ["project"], preferences).byWorkspace.get("project")!))
      .toEqual(["latest", "middle", "old"]);
    expect(JSON.parse(saved.get(SIDEBAR_STORAGE_KEY)!).version).toBe(1);
  }
});

test("legacy priority and recent preferences are not reset", () => {
  for (const sort of ["priority", "recent"] as const) {
    const { saved, storage } = fixture();
    saved.set(SIDEBAR_STORAGE_KEY, JSON.stringify({ version: 0, state: { sort, priorityIds: ["pin"] } }));
    expect(createSidebarPreferencesStore(storage).getState()).toMatchObject({ sort, priorityIds: ["pin"] });
  }
});

test("new messages beat a manual position while unchanged chats keep their order", () => {
  const { storage } = fixture();
  const store = createSidebarPreferencesStore(storage);
  const sessions = [session("a", 3), session("b", 2), session("c", 1)];
  store.getState().moveSession(sessions, "c", "a");
  expect(ids(sortSidebarSessions(sessions, store.getState()))).toEqual(["c", "a", "b"]);
  const updated = sessions.map((item) => item.id === "b" ? { ...item, updatedAt: 4 } : item);
  expect(ids(sortSidebarSessions(updated, store.getState()))).toEqual(["b", "c", "a"]);
  const second = updated.map((item) => item.id === "a" ? { ...item, updatedAt: 5 } : item);
  expect(ids(sortSidebarSessions(second, store.getState()))).toEqual(["a", "b", "c"]);
  expect(ids(sessions)).toEqual(["a", "b", "c"]);
});

test("new chats missing from a manual order go to the top, never to the bottom", () => {
  const { storage } = fixture();
  const store = createSidebarPreferencesStore(storage);
  const sessions = [session("a", 3), session("b", 2), session("c", 1), session("pin", 6, "other")];
  store.getState().togglePriority("pin");
  store.getState().moveSession(sessions, "c", "a");
  const next = [...sessions, session("new", 7)];
  expect(ids(sortSidebarSessions(next, store.getState()))).toEqual(["new", "pin", "c", "a", "b"]);
  const groups = groupProjectSidebarSessions(next, ["project", "other"], store.getState());
  expect(ids(groups.pinned)).toEqual(["pin"]);
  expect(ids(groups.byWorkspace.get("project")!)).toEqual(["new", "c", "a", "b"]);
});

test("manual activity baseline survives restart and detects messages received while closed", () => {
  const { storage } = fixture();
  const store = createSidebarPreferencesStore(storage);
  const sessions = [session("a", 3), session("b", 2), session("c", 1)];
  store.getState().moveSession(sessions, "c", "a");
  const restored = createSidebarPreferencesStore(storage);
  expect(restored.getState()).toMatchObject({ sort: "manual", manualActivity: { a: 3, b: 2, c: 1 } });
  expect(ids(sortSidebarSessions(sessions, restored.getState()))).toEqual(["c", "a", "b"]);
  const updated = sessions.map((item) => item.id === "b" ? { ...item, updatedAt: 4 } : item);
  expect(ids(sortSidebarSessions(updated, restored.getState()))).toEqual(["b", "c", "a"]);
  restored.getState().moveSession(updated, "c", "b");
  expect(ids(sortSidebarSessions(updated, restored.getState()))).toEqual(["c", "b", "a"]);
  expect(ids(sortSidebarSessions(updated.map((item) => item.id === "a" ? { ...item, updatedAt: 5 } : item), restored.getState())))
    .toEqual(["a", "c", "b"]);
});

test("entering manual mode captures the visible order, not a stale frozen sequence", () => {
  const { storage } = fixture();
  const store = createSidebarPreferencesStore(storage);
  const sessions = [session("a", 3), session("b", 2), session("c", 1)];
  store.getState().moveSession(sessions, "c", "a");
  store.getState().setSort("recent", sessions);
  store.getState().setSort("manual", sessions);
  expect(ids(sortSidebarSessions(sessions, store.getState()))).toEqual(["a", "b", "c"]);
});

test("malformed saved activity cannot freeze new messages or inject inherited keys", () => {
  const preferences = parseSidebarPreferences({ sort: "manual", manualOrder: ["old", "new"],
    manualActivity: { old: "999", new: Infinity, valid: 1 } });
  expect(preferences.manualActivity).toEqual({ valid: 1 });
  expect(ids(sortSidebarSessions([session("old", 1), session("new", 2)], preferences))).toEqual(["new", "old"]);
  expect(parseSidebarPreferences({ manualActivity: [] }).manualActivity).toEqual({});
});
