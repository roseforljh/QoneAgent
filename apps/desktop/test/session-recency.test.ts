import { afterAll, expect, mock, test } from "bun:test";
import type { RuntimeEvent, SessionInfo } from "@qone/protocol";
import { createJSONStorage } from "zustand/middleware";
import { createSidebarPreferencesStore, groupProjectSidebarSessions, parseSidebarPreferences, sortSidebarSessions } from "../src/lib/sidebar-preferences";
import { emptySessionState } from "../src/lib/session-execution-state";
import { updateSessionActivity } from "../src/lib/session-recency";

let listener: ((event: { payload: string }) => void) | undefined;
mock.module("@tauri-apps/api/core", () => ({ invoke: async () => {} }));
mock.module("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; } }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

const { useStore, initBridge } = await import("../src/store");
initBridge();
await Promise.resolve();
const emit = (event: RuntimeEvent) => listener!({ payload: JSON.stringify(event) });
const old: SessionInfo = { id: "old", title: "Old", workspaceId: "project", createdAt: 1, updatedAt: 1 };
const newer: SessionInfo = { ...old, id: "newer", createdAt: 2, updatedAt: 2 };

test("live recency moves a background chat to the top in both sidebar layouts without switching chats", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ sessions: [newer, old], currentSessionId: newer.id, running: true, activeRunId: "foreground-run", titleGeneratingSessionIds: [old.id] });
    const messages = useStore.getState().messages;
    const updated = { ...old, updatedAt: 3 };
    emit({ type: "session.updated", session: updated });
    const state = useStore.getState();
    const prefs = parseSidebarPreferences(null);
    expect(sortSidebarSessions(state.sessions, prefs).map((item) => item.id)).toEqual([old.id, newer.id]);
    expect(groupProjectSidebarSessions(state.sessions, ["project"], prefs).byWorkspace.get("project")).toEqual([updated, newer]);
    expect(state.currentSessionId).toBe(newer.id);
    expect(state.activeRunId).toBe("foreground-run");
    expect(state.running).toBe(true);
    expect(state.messages).toBe(messages);
    expect(state.titleGeneratingSessionIds).toEqual([old.id]);
  } finally { useStore.setState(previous, true); }
});

test("the active chat moves to the top without resetting its messages, queue, or run", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ sessions: [newer, old], currentSessionId: old.id, running: true, activeRunId: "active-run" });
    const before = useStore.getState();
    emit({ type: "session.updated", session: { ...old, updatedAt: 5 } });
    const state = useStore.getState();
    expect(sortSidebarSessions(state.sessions, parseSidebarPreferences(null)).map((item) => item.id)).toEqual([old.id, newer.id]);
    expect(state.currentSessionId).toBe(old.id);
    expect(state.running).toBe(true);
    expect(state.activeRunId).toBe("active-run");
    expect(state.messages).toBe(before.messages);
    expect(state.queueItems).toBe(before.queueItems);
    expect(state.streamingParts).toBe(before.streamingParts);
    expect(state.runOptionsBySession).toBe(before.runOptionsBySession);
  } finally { useStore.setState(previous, true); }
});

test("late activity cannot resurrect a deleted chat", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ sessions: [newer], currentSessionId: newer.id });
    emit({ type: "session.updated", session: { ...old, updatedAt: 6 } });
    expect(useStore.getState().sessions).toEqual([newer]);
    expect(useStore.getState().currentSessionId).toBe(newer.id);
  } finally { useStore.setState(previous, true); }
});

test("side chat activity stays out of the main sidebar", () => {
  const previous = useStore.getState();
  try {
    const child = { ...old, id: "child", sideChat: { parentSessionId: old.id, boundaryMessageId: "boundary" } };
    useStore.setState({ sessions: [newer, old], sideChats: { [child.id]: child } });
    const sessions = useStore.getState().sessions;
    emit({ type: "session.updated", session: { ...child, updatedAt: 4 } });
    expect(useStore.getState().sessions).toBe(sessions);
    expect(useStore.getState().sideChats[child.id]?.updatedAt).toBe(4);
  } finally { useStore.setState(previous, true); }
});

test("sending a message promotes its chat immediately, before any runtime acknowledgement", () => {
  const previous = useStore.getState();
  const preferences = createSidebarPreferencesStore(createJSONStorage(() => ({ getItem: () => null, setItem: () => {}, removeItem: () => {} })));
  try {
    preferences.getState().moveSession([newer, old], newer.id, old.id);
    useStore.setState({ ...emptySessionState(), sessions: [newer, old], currentSessionId: old.id,
      workspaces: [{ id: "project", name: "Project", path: "/project", createdAt: 1 }],
      messages: [{ id: "previous", role: "user", content: "previous", persisted: true }],
      send: async () => true,
    });
    useStore.getState().runAgent("new message");
    const state = useStore.getState();
    expect(state.sessions.find((session) => session.id === old.id)!.updatedAt).toBeGreaterThan(newer.updatedAt);
    expect(sortSidebarSessions(state.sessions, preferences.getState()).map((session) => session.id)).toEqual([old.id, newer.id]);
    expect(state.currentSessionId).toBe(old.id);
    expect(state.messages.at(-1)?.content).toBe("new message");
  } finally { useStore.setState(previous, true); }
});

test("sending in the background updates global recency without switching or clearing the foreground", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ ...emptySessionState(), sessions: [newer, old], currentSessionId: newer.id,
      workspaces: [{ id: "project", name: "Project", path: "/project", createdAt: 1 }],
      running: true, activeRunId: "foreground-run",
      messages: [{ id: "foreground", role: "user", content: "foreground" }],
      backgroundSessions: { [old.id]: { ...emptySessionState(), messages: [{ id: "previous", role: "user", content: "previous", persisted: true }] } },
      send: async () => true,
    });
    const before = useStore.getState();
    useStore.getState().runAgent("background message", undefined, undefined, undefined, undefined, old.id);
    const state = useStore.getState();
    expect(sortSidebarSessions(state.sessions, parseSidebarPreferences(null)).map((session) => session.id)).toEqual([old.id, newer.id]);
    expect(state.currentSessionId).toBe(newer.id);
    expect(state.messages).toBe(before.messages);
    expect(state.activeRunId).toBe("foreground-run");
    expect(state.backgroundSessions[old.id]?.messages.at(-1)?.content).toBe("background message");
  } finally { useStore.setState(previous, true); }
});

test("stale session updates and title responses cannot roll back a newer message position", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ sessions: [{ ...old, updatedAt: 10 }, newer], currentSessionId: old.id });
    emit({ type: "session.updated", session: { ...old, updatedAt: 3 } });
    expect(useStore.getState().sessions[0]?.updatedAt).toBe(10);
    emit({ type: "session.renamed", session: { ...old, title: "Renamed", updatedAt: 4 } });
    expect(useStore.getState().sessions[0]).toMatchObject({ title: "Renamed", updatedAt: 10 });
    expect(sortSidebarSessions(useStore.getState().sessions, parseSidebarPreferences(null)).map((session) => session.id)).toEqual([old.id, newer.id]);
  } finally { useStore.setState(previous, true); }
});

test("optimistic activity does not mutate, resurrect, or move a chat on older timestamps", () => {
  const sessions = [old, newer];
  expect(updateSessionActivity(sessions, "deleted", 10)).toBe(sessions);
  expect(updateSessionActivity(sessions, old.id, old.updatedAt)).toBe(sessions);
  const updated = updateSessionActivity(sessions, old.id, 10);
  expect(updated[0]?.updatedAt).toBe(10);
  expect(updated[1]).toBe(newer);
  expect(sessions[0]).toBe(old);
  expect(old.updatedAt).toBe(1);
});

test("clicking the active completed chat clears its completion dot", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: old.id, completedSessionIds: [old.id] });
    useStore.getState().selectSession(old.id);
    expect(useStore.getState().completedSessionIds).toEqual([]);
  } finally { useStore.setState(previous, true); }
});
