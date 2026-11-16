import { afterAll, expect, mock, test } from "bun:test";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

const commands: RuntimeCommand[] = [];
let listener: ((event: { payload: unknown }) => void) | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { electronBridge: { invoke: async () => undefined, listen: async () => () => {}, convertFileSrc: (p: string) => p }, localStorage: { getItem: () => null, setItem: () => {} } },
});
const originalBridge = { ...await import("../src/lib/desktop-bridge") };
mock.module("../src/lib/desktop-bridge", () => ({
  ...originalBridge,
  isDesktop: () => true,
  invoke: async (name: string, args?: { cmd?: string }) => {
    if (name === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
  },
  listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; },
}));
const { bridgeDependencies, useStore } = await import("../src/store");
const { initRuntimeBridge } = await import("../src/store-bridge?test=store-performance");
initRuntimeBridge(bridgeDependencies());
await Promise.resolve(); await Promise.resolve();
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

const emit = (event: RuntimeEvent | RuntimeEvent[]) => listener!({ payload: event });
const agentEvent = (sequence: number, type: string, payload: unknown, sessionId = "perf-session", runId = "perf-run") =>
  ({ type: "agent.event", event: { eventId: `event-${sequence}`, sessionId, runId, sequence, type, timestamp: sequence, payload, scope: "conversation" } }) as RuntimeEvent;
const assistantText = (text: string) => ({ message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });

function history(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `saved-${index}`,
    sessionId: "perf-session",
    role: index % 2 === 0 ? "user" : "assistant",
    content: `history ${index}`,
    createdAt: index,
  }));
}

test("a long saved history keeps its array identity across streaming deltas", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "perf-session", messages: [], activeRunId: "perf-run", running: true, streaming: "", streamingParts: [] });
    emit({ type: "session.messages", sessionId: "perf-session", messages: history(400) as never });
    const saved = useStore.getState().messages;
    expect(saved).toHaveLength(400);
    // A streaming delta must not copy the 400 saved rows.
    emit(agentEvent(1, "message.delta", { delta: "token" }));
    expect(useStore.getState().messages).toBe(saved);
  } finally { useStore.setState(previous, true); }
});

test("agent.started leaves an unchanged history array in place", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "perf-session", messages: history(400) as never, running: false, activeRunId: undefined });
    const before = useStore.getState().messages;
    emit(agentEvent(2, "agent.started", {}));
    const after = useStore.getState().messages;
    expect(after).toBe(before);
    expect(useStore.getState().running).toBe(true);
  } finally { useStore.setState(previous, true); }
});

test("a 2000-row snapshot merge stays linear", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "perf-session", messages: [], running: false, activeRunId: undefined });
    const saved = history(2000);
    const begin = performance.now();
    emit({ type: "session.messages", sessionId: "perf-session", messages: saved as never });
    const elapsed = performance.now() - begin;
    expect(useStore.getState().messages).toHaveLength(2000);
    // Quadratic merge on 2000 rows took hundreds of ms; a linear pass stays
    // well inside this bound even on a loaded CI machine.
    expect(elapsed).toBeLessThan(120);
  } finally { useStore.setState(previous, true); }
});

test("agent communication rows survive the snapshot and are not treated as user turns", () => {
  const previous = useStore.getState();
  const communication = { fromId: "main", fromTitle: "Main", toId: "child", toTitle: "Child" };
  try {
    useStore.setState({ connected: true, currentSessionId: "perf-session", messages: [], running: false, activeRunId: undefined });
    emit({ type: "session.messages", sessionId: "perf-session", messages: [
      { id: "u1", sessionId: "perf-session", role: "user", content: "typed", createdAt: 1 },
      { id: "c1", sessionId: "perf-session", role: "user", content: "agent", communication, createdAt: 2 },
    ] as never });
    const messages = useStore.getState().messages;
    expect(messages.map((message) => message.communication)).toEqual([undefined, communication]);
  } finally { useStore.setState(previous, true); }
});

test("deleting sessions through the authoritative list leaves no cached background state", () => {
  const previous = useStore.getState();
  try {
    const backgroundSessions = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
      `gone-${index}`,
      { messages: [{ id: `m-${index}`, role: "user", content: "x" }], streaming: "", streamingParts: [], toolCalls: [], runs: [], subagents: [], artifacts: [], approvals: [] },
    ]));
    const runOptionsBySession = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`gone-${index}`, { modelId: "m" }]));
    useStore.setState({
      connected: true, currentSessionId: "keep", backgroundSessions, runOptionsBySession,
      sessions: [{ id: "keep", title: "keep", createdAt: 1, updatedAt: 1 }] as never, sideChats: {},
    });
    // The runtime reports the surviving conversation only; every deleted
    // conversation must leave the cache with its run options.
    emit({ type: "session.list", sessions: [{ id: "keep", title: "keep", createdAt: 1, updatedAt: 1 }] } as never);
    expect(Object.keys(useStore.getState().backgroundSessions)).toEqual([]);
    expect(Object.keys(useStore.getState().runOptionsBySession)).not.toContain("gone-0");
    expect(useStore.getState().currentSessionId).toBe("keep");
  } finally { useStore.setState(previous, true); }
});

test("deleting the selected session prunes the snapshot created during switching and orphaned options", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      connected: true, currentSessionId: "deleted-current", messages: history(2) as never,
      backgroundSessions: {}, sideChats: {},
      runOptionsBySession: { "deleted-current": { modelId: "m" }, "options-only": { modelId: "m" } },
      sessions: [{ id: "deleted-current", title: "gone", createdAt: 1, updatedAt: 1 }] as never,
    });
    emit({ type: "session.list", sessions: [{ id: "surviving", title: "keep", createdAt: 1, updatedAt: 1 }] } as never);
    const state = useStore.getState();
    expect(state.currentSessionId).toBe("surviving");
    expect(state.backgroundSessions["deleted-current"]).toBeUndefined();
    expect(state.runOptionsBySession["deleted-current"]).toBeUndefined();
    expect(state.runOptionsBySession["options-only"]).toBeUndefined();
  } finally { useStore.setState(previous, true); }
});

test("server history restores nested child identity and cancellation without polluting the selected conversation", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "perf-session", toolCalls: [], activeRunId: undefined, backgroundSessions: {}, messages: [] });
    const result = { content: [{ type: "text", text: "saved output" }], details: { cancelled: true, serverOperation: { serverId: "a", serverName: "Alpha" } } };
    emit({ type: "session.toolCalls", sessionId: "history-owner", toolCalls: [{ id: "child:nested", runId: "child", toolName: "server_exec", parentToolCallId: "script", sourceSubagentId: "child", serverOperation: result.details.serverOperation, status: "cancelled", resultSummary: JSON.stringify(result) }] });
    expect(useStore.getState().toolCalls).toEqual([]);
    expect(useStore.getState().backgroundSessions["history-owner"]!.toolCalls[0]).toMatchObject({ toolCallId: "nested", parentToolCallId: "script", sourceSubagentId: "child", status: "cancelled", serverOperation: result.details.serverOperation, result });
  } finally { useStore.setState(previous, true); }
});

test("tool call alignment keeps its array when nothing needs renaming", () => {  const previous = useStore.getState();
  try {
    const calls = Array.from({ length: 500 }, (_, index) => ({ toolCallId: `call-${index}`, runId: "run-a", toolName: "read", status: "success" as const }));
    const messages = [{ id: "m", role: "assistant", content: "", runId: "run-a", parts: calls.map((call) => ({ type: "tool-call" as const, toolCallId: call.toolCallId, toolName: "read", args: {}, messageSequence: 1 })) }];
    useStore.setState({ connected: true, currentSessionId: "perf-session", messages, running: false, activeRunId: undefined });
    emit({ type: "session.toolCalls", sessionId: "perf-session", toolCalls: calls.map((call) => ({ id: call.toolCallId, runId: "run-a", toolName: "read", status: "completed" })) } as never);
    const aligned = useStore.getState().toolCalls;
    expect(aligned).toHaveLength(500);
    expect(aligned.every((call, index) => call.toolCallId === `call-${index}`)).toBe(true);
  } finally { useStore.setState(previous, true); }
});
