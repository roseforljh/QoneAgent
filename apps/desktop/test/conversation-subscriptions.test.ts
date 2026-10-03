import { expect, test } from "bun:test";
import { createStore } from "zustand/vanilla";
import type { AgentState } from "../src/store";
import { createConversationStore } from "../src/lib/conversation-store";
import { emptySessionState, sessionStore, switchSessionState } from "../src/lib/session-execution-state";
import { isolateBackgroundSubscriptions } from "../src/lib/store-subscriptions";

function fixture() {
  const initial = {
    ...emptySessionState(), currentSessionId: "main", connected: true, creatingSession: false,
    sessions: ["main", "side", "other"].map((id) => ({ id, title: id, workspaceId: "workspace", createdAt: 1, updatedAt: 1 })),
    currentWorkspaceId: "workspace", sideChats: {}, runOptionsBySession: {}, backgroundSessions: {},
  } as AgentState;
  const source = createStore<AgentState>(() => initial);
  isolateBackgroundSubscriptions(source);
  return { source, main: createConversationStore(source, "main"), side: createConversationStore(source, "side"), other: createConversationStore(source, "other") };
}

test("background stream updates notify only the owning conversation and preserve other snapshots", () => {
  const { source, main, side, other } = fixture();
  const originalMain = main.getState();
  const originalOther = other.getState();
  let rootCalls = 0, mainCalls = 0, sideCalls = 0, otherCalls = 0;
  const subscriptions = [source.subscribe(() => rootCalls++), main.subscribe(() => mainCalls++),
    side.subscribe(() => sideCalls++), other.subscribe(() => otherCalls++)];
  try {
    const owner = sessionStore(source, "side");
    for (let index = 1; index <= 200; index++) {
      owner.setState({ streaming: `chunk-${index}`, activeRunId: "side-run", running: true });
      expect(main.getState()).toBe(originalMain);
      expect(other.getState()).toBe(originalOther);
      expect(side.getState().streaming).toBe(`chunk-${index}`);
    }
    expect([rootCalls, mainCalls, sideCalls, otherCalls]).toEqual([0, 0, 200, 0]);
    expect(source.getState().currentSessionId).toBe("main");
    expect(source.getState().streaming).toBe("");
    expect(source.getState().backgroundSessions["side"]?.streaming).toBe("chunk-200");
  } finally { subscriptions.forEach((unsubscribe) => unsubscribe()); }
});

test("foreground updates do not wake empty side conversations, while shared state changes reach all views", () => {
  const { source, main, side, other } = fixture();
  const sideSnapshot = side.getState(), otherSnapshot = other.getState();
  let mainCalls = 0, sideCalls = 0, otherCalls = 0;
  const subscriptions = [main.subscribe(() => mainCalls++), side.subscribe(() => sideCalls++), other.subscribe(() => otherCalls++)];
  try {
    for (let index = 0; index < 200; index++) source.setState({ streaming: `main-${index}` });
    expect([mainCalls, sideCalls, otherCalls]).toEqual([200, 0, 0]);
    expect(side.getState()).toBe(sideSnapshot);
    expect(other.getState()).toBe(otherSnapshot);
    source.setState({ connected: false });
    expect([mainCalls, sideCalls, otherCalls]).toEqual([201, 1, 1]);
    expect([main.getState().connected, side.getState().connected, other.getState().connected]).toEqual([false, false, false]);
  } finally { subscriptions.forEach((unsubscribe) => unsubscribe()); }
});

test("switching selection restores cached streams without transferring ownership or losing side listeners", () => {
  const { source, main, side } = fixture();
  source.setState({ messages: [{ id: "main-user", role: "user", content: "main input" }], streaming: "main output", activeRunId: "main-run" });
  side.setState({ messages: [{ id: "side-user", role: "user", content: "side input" }], streaming: "side output", activeRunId: "side-run" });
  const mainMessages = main.getState().messages, sideMessages = side.getState().messages;
  source.setState({ ...switchSessionState(source.getState(), "side"), currentSessionId: "side" });
  expect(source.getState().messages).toBe(sideMessages);
  expect(source.getState().streaming).toBe("side output");
  expect(main.getState().messages).toBe(mainMessages);
  let sideCalls = 0;
  const unsubscribe = side.subscribe(() => sideCalls++);
  try {
    side.setState({ streaming: "side continued" });
    expect(sideCalls).toBe(1);
    source.setState({ ...switchSessionState(source.getState(), "main"), currentSessionId: "main" });
    expect(source.getState().messages).toBe(mainMessages);
    expect(source.getState().streaming).toBe("main output");
    const before = sideCalls;
    side.setState({ streaming: "side in background" });
    expect(sideCalls).toBe(before + 1);
    expect(source.getState().streaming).toBe("main output");
    expect(side.getState().streaming).toBe("side in background");
  } finally { unsubscribe(); }
});

test("routed state readers return stable snapshots until their source changes", () => {
  const { source } = fixture();
  const owner = sessionStore(source, "side");
  const first = owner.getState();
  for (let index = 0; index < 100; index++) expect(owner.getState()).toBe(first);
  owner.setState({ streaming: "next" });
  const second = owner.getState();
  expect(second).not.toBe(first);
  for (let index = 0; index < 100; index++) expect(owner.getState()).toBe(second);
  expect(first.streaming).toBe("");
  expect(second.streaming).toBe("next");
});
