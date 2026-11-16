import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createServerIdsSelector, createServerCallIdsSelector, createServerCallSummarySelector, createServerSummarySelector, operationRound } from "../src/lib/server-operations";
import { detectToolPresentation } from "../src/components/assistant-ui/tool-presentation";
import type { ToolCall } from "../src/store";
import type { ServerInfo, SubagentRunInfo } from "@qone/protocol";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { useStore, bridgeDependencies } = await import("../src/store");
const { useServerStore } = await import("../src/lib/server-state");
const { ServerOperationsPanel } = await import("../src/components/assistant-ui/server-operations-panel");
const { ConversationProvider } = await import("../src/lib/conversation-context");
const { sessionStore } = await import("../src/lib/session-execution-state");
const { alignToolCallIds } = await import("../src/lib/tool-call-alignment");
const { handleAgentEvent } = await import("../src/store/agent-events");
const initial = useStore.getState();
afterAll(() => {
  useStore.setState(initial); dom.window.close();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});
const server = (id: string): ServerInfo => ({ id, name: `Server ${id}`, host: `${id}.example`, port: 22, username: "root", auth: { kind: "agent" }, status: "ready", createdAt: 0 });
const call = (id: string, target?: string): ToolCall => ({ toolCallId: id, toolName: "server_exec", runId: "run", status: "running", args: { command: "uptime" }, ...(target ? { serverOperation: { serverId: target, serverName: `Server ${target}` } } : {}) });

test("server summaries and ID lists stay stable across output-only updates; unknown targets are not guessed", () => {
  const calls = [call("a1", "a"), call("b1", "b"), call("waiting")];
  const ids = createServerIdsSelector(), summary = createServerSummarySelector(), callIds = createServerCallIdsSelector(), row = createServerCallSummarySelector();
  const firstIds = ids(calls, ["a"]), first = summary(calls, [], "a"), firstCalls = callIds(calls, "a"), firstRow = row(calls, "a1");
  const next = calls.map(item => item.toolCallId === "a1" ? { ...item, serverOperation: { ...item.serverOperation! }, result: { content: [{ type: "text", text: "new output" }] } } : item);
  expect(row(next, "a1")).toBe(firstRow);
  expect(ids(next, ["a"])).toBe(firstIds); expect(summary(next, [], "a")).toBe(first); expect(callIds(next, "a")).toBe(firstCalls);
  expect(firstIds).toEqual(["a", "b", ""]);
  expect(summary(calls, [], "missing").count).toBe(0);
  expect(operationRound([...calls, { ...call("child", "a"), runId: "child" }], [{ id: "child", parentRunId: "run" }] as SubagentRunInfo[], { ...call("child", "a"), runId: "child" })).toBe(1);
});

test("server results use readable terminal/file presentations without merging stderr or hiding failures", () => {
  const result = { content: [{ type: "text", text: JSON.stringify({ stdout: "hello", stderr: "error", exit_code: 4, timed_out: true, truncated: true }) }] };
  expect(detectToolPresentation("server_exec", result, { command: "test" })).toMatchObject({ kind: "terminal", command: "test", output: "hello", stderr: "error", exitCode: 4, timedOut: true, truncated: true });
  expect(detectToolPresentation("server_read_file", { content: [{ type: "text", text: '{"content":"file contents"}' }] }, { path: "/file" })).toMatchObject({ kind: "file", content: "file contents", name: "/file" });
});

test("multiple servers navigate to operations, no input is mounted, close does not cancel and stop uses the owning session", async () => {
  const stopped: string[] = []; let closed = 0;
  useStore.setState({ currentSessionId: "owner", activeRunId: "run", running: true, stopAgent: id => { stopped.push(id!); useStore.setState({ stoppingRunId: "run" }); }, toolCalls: [call("a1", "a"), call("b1", "b")], runOptionsBySession: { owner: { serverIds: ["a", "b"] } } });
  useServerStore.setState({ servers: [server("a"), server("b")] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ConversationProvider sessionId="owner"><ServerOperationsPanel onClose={() => { closed++; }} /></ConversationProvider>));
    expect(host.querySelectorAll(".q-server-row")).toHaveLength(2);
    expect(host.querySelector("input,textarea,[contenteditable=true]")).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>(".q-server-row")!.click());
    expect(host.textContent).toContain("uptime"); expect(host.querySelectorAll(".q-server-operation")).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>(".q-server-stop")!.click());
    expect(stopped).toEqual(["owner"]);
    expect(host.querySelector<HTMLButtonElement>(".q-server-stop")!.disabled).toBe(false);
    expect(host.querySelector(".q-server-stop")!.textContent).toMatch(/强制|force/i);
    const closeButton = host.querySelectorAll<HTMLButtonElement>(".q-subagent-panel-header button");
    await act(async () => closeButton[closeButton.length - 1]!.click());
    expect(closed).toBe(1); expect(stopped).toHaveLength(1);
    await act(async () => useStore.setState({ activeRunId: undefined, stoppingRunId: null }));
    expect(host.querySelector(".q-server-stop")!.textContent).toMatch(/强制|force/i);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("single-server details show real connection and transfer progress without a second composer", async () => {
  useStore.setState({ currentSessionId: "single", running: false, activeRunId: undefined, stoppingRunId: undefined, subagents: [],
    runOptionsBySession: { single: { serverIds: ["a"] } }, toolCalls: [{ ...call("one", "a"), result: { content: [{ type: "text", text: '{"phase":"connecting"}' }] } }] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ServerOperationsPanel onClose={() => {}} />));
    expect(host.querySelectorAll(".q-server-row")).toHaveLength(0);
    expect(host.querySelectorAll(".q-server-operation")).toHaveLength(1);
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/连接|connecting/i);
    await act(async () => useStore.setState(state => ({ toolCalls: state.toolCalls.map(call => ({ ...call, result: { content: [{ type: "text", text: '{"bytes":512,"total":1024}' }] } })) })));
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/512.*1024/);
    expect(host.querySelector("input,textarea,[contenteditable=true]")).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("child operation snapshots are coalesced in the owning session without changing the main transcript or terminal state", () => {
  useStore.setState({ currentSessionId: "visible", activeRunId: "visible-run", toolCalls: [], streaming: "visible text", backgroundSessions: {} });
  const owner = sessionStore(useStore, "owner"), dependencies = bridgeDependencies();
  owner.setState({ activeRunId: "parent", toolCalls: [], streamingParts: [], running: true });
  let sequence = 0;
  const emit = (type: string, payload: unknown, sourceSubagentId = "child") => handleAgentEvent({ eventId: `${sequence}`, sessionId: "owner", runId: "child", sequence: sequence++, timestamp: 100, type, payload, scope: "subagent", sourceSubagentId }, owner, dependencies);
  emit("tool.started", { toolCallId: "server", toolName: "server_exec", parentToolCallId: "script", args: {} });
  emit("tool.started", { toolCallId: "sibling-call", toolName: "server_exec", parentToolCallId: "script", args: {} });
  emit("approval.requested", { approvalId: "approval", toolCallId: "server", toolName: "server_exec" });
  expect(owner.getState().toolCalls.map(call => call.status)).toEqual(["waiting", "running"]);
  emit("approval.resolved", { approvalId: "approval", toolCallId: "server", approved: true });
  expect(owner.getState().toolCalls[0]!.status).toBe("running"); expect(owner.getState().approvals).toEqual([]);
  for (let index = 0; index < 20; index++) emit("tool.updated", { toolCallId: "server", update: { details: { serverOperation: { serverId: "a", serverName: "Alpha" } }, content: [{ type: "text", text: `${index}` }] } });
  dependencies.flushNow("owner");
  expect(owner.getState().toolCalls[0]).toMatchObject({ parentToolCallId: "script", sourceSubagentId: "child", serverOperation: { serverId: "a", serverName: "Alpha" }, result: { content: [{ type: "text", text: "19" }] } });
  expect(owner.getState().streamingParts).toEqual([]); expect(useStore.getState().toolCalls).toEqual([]);
  emit("tool.completed", { toolCallId: "server", result: { details: { cancelled: true } } });
  emit("tool.updated", { toolCallId: "server", update: "late" }); dependencies.flushNow("owner");
  expect(owner.getState().toolCalls[0]!.status).toBe("cancelled");
  expect(owner.getState().toolCalls[0]!.result).toMatchObject({ content: [{ text: "19" }] });
  const cancelled = owner.getState().toolCalls[0]!.result;
  emit("agent.cancelled", {});
  emit("tool.completed", { toolCallId: "server", result: "late success" });
  expect(owner.getState().toolCalls[0]!.status).toBe("cancelled");
  expect(owner.getState().toolCalls[0]!.result).toBe(cancelled);
  emit("tool.started", { toolCallId: "pending-last-output", toolName: "server_exec", args: {} });
  emit("tool.updated", { toolCallId: "pending-last-output", update: { details: { serverOperation: { serverId: "a", serverName: "Alpha" } }, content: [{ type: "text", text: "last buffered output" }] } });
  emit("agent.cancelled", {});
  expect(owner.getState().toolCalls.find(call => call.toolCallId === "pending-last-output")).toMatchObject({ status: "cancelled", result: { content: [{ text: "last buffered output" }] } });
  expect(owner.getState().activeRunId).toBe("parent"); expect(owner.getState().running).toBe(true); expect(useStore.getState().streaming).toBe("visible text");
});


test("nested history IDs are never aligned to a sibling top-level call", () => {
  const nested = { ...call("nested", "a"), parentToolCallId: "script" };
  const calls = [nested, { ...call("top", "a"), status: "success" as const }];
  const result = alignToolCallIds(calls, [{ id: "m", role: "assistant", content: "", runId: "run", parts: [{ type: "tool-call", toolCallId: "top", toolName: "server_exec", args: {} }] }]);
  expect(result[0]!.toolCallId).toBe("nested"); expect(result[1]!.toolCallId).toBe("top");
});

test("an idle main conversation can still stop all active children in the latest server turn", async () => {
  const sent: any[] = [];
  useStore.setState({ currentSessionId: "background", running: false, activeRunId: undefined, stoppingRunId: undefined,
    toolCalls: [{ ...call("child-op", "a"), runId: "child", sourceSubagentId: "child" }], runOptionsBySession: {},
    subagents: [{ id: "child", parentRunId: "root", status: "running" }, { id: "grandchild", parentRunId: "child", status: "running" }, { id: "sibling", parentRunId: "root", status: "running" }, { id: "other", parentRunId: "other-root", status: "running" }] as SubagentRunInfo[],
    send: async command => { sent.push(command); return true; } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<ServerOperationsPanel onClose={() => {}} />));
    await act(async () => host.querySelector<HTMLButtonElement>(".q-server-stop")!.click());
    expect(sent.map(command => command.runId)).toEqual(["child", "sibling"]);
    expect(host.querySelector<HTMLButtonElement>(".q-server-stop")!.disabled).toBe(false);
    expect(host.querySelector(".q-server-stop")!.textContent).toMatch(/强制|force/i);
    await act(async () => host.querySelector<HTMLButtonElement>(".q-server-stop")!.click());
    expect(sent.map(command => [command.type, command.runId, command.action])).toEqual([["subagent.control", "child", "stop"], ["subagent.control", "sibling", "stop"], ["subagent.control", "child", "stop"], ["subagent.control", "sibling", "stop"]]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
