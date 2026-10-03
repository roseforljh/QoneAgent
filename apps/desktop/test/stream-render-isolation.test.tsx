import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, memo, Profiler, useCallback, useMemo } from "react";
import { createMessageStructureSelector } from "../src/lib/thread-message-structure";
import { createPartToolsSelector, createRunMessagesSelector, createRunToolsSelector, createSubagentIdsSelector, createSubagentSummarySelector } from "../src/lib/store-indexes";
import type { ToolCall, ChatMessage } from "../src/store";
import type { SubagentRunInfo } from "@qone/protocol";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
afterAll(() => { dom.window.close(); for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });

const { createRoot } = await import("react-dom/client");
const { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, useAuiState, useExternalStoreRuntime } = await import("@assistant-ui/react");
type ThreadMessage = import("@assistant-ui/react").ThreadMessage;
const commits = new Map<string, number>();
let structures = 0;
const textComponents = { Text: ({ text }: { text: string }) => <span>{text}</span> };
const Row = memo(function Row() {
  const id = useAuiState((state) => state.message.id);
  return <Profiler id={id} onRender={() => commits.set(id, (commits.get(id) ?? 0) + 1)}><MessagePrimitive.Root><MessagePrimitive.Parts components={textComponents} /></MessagePrimitive.Root></Profiler>;
});
function Messages() {
  const select = useMemo(createMessageStructureSelector, []);
  const structure = useAuiState((state) => select(state.thread.messages));
  structures++;
  const render = useCallback(({ message }: { message: ThreadMessage }) => <div data-id={message.id}><Row /></div>, [structure]);
  return <ThreadPrimitive.Messages>{render}</ThreadPrimitive.Messages>;
}
const StableRegion = memo(function StableRegion() { return <Profiler id="sidebar" onRender={() => commits.set("sidebar", (commits.get("sidebar") ?? 0) + 1)}><aside>sidebar</aside></Profiler>; });
const fixedChildren = <><StableRegion /><Messages /></>;
function Runtime({ messages }: { messages: ThreadMessage[] }) {
  const runtime = useExternalStoreRuntime({ messages, isRunning: true, convertMessage: (message: ThreadMessage) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}>{fixedChildren}</AssistantRuntimeProvider>;
}
function assistant(id: string, content: string, running = false): ThreadMessage {
  return { id, role: "assistant", createdAt: new Date(1), content: [{ type: "text", text: content }],
    status: running ? { type: "running" } : { type: "complete", reason: "stop" },
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} } };
}

test("real assistant-ui renders the live row on 100 deltas with zero history/sidebar commits", async () => {
  const container = dom.window.document.createElement("div"); dom.window.document.body.append(container);
  const root = createRoot(container);
  const history = Array.from({ length: 60 }, (_, index) => assistant(`saved-${index}`, `history-${index}`));
  try {
    await act(async () => root.render(<Runtime messages={[...history, assistant("live", "", true)]} />));
    expect(container.querySelectorAll("[data-id]")).toHaveLength(61);
    expect(container.textContent).toContain("history-59");
    commits.clear(); structures = 0;
    for (let index = 1; index <= 100; index++) await act(async () => root.render(<Runtime messages={[...history, assistant("live", `delta-${index}`, true)]} />));
    expect(container.textContent).toContain("delta-100");
    expect(commits.get("live")).toBe(100);
    expect(commits.get("sidebar") ?? 0).toBe(0);
    for (const message of history) expect(commits.get(message.id) ?? 0).toBe(0);
    expect(structures).toBe(0);
    await act(async () => root.render(<Runtime messages={[...history, assistant("live", "final")]} />));
    expect(container.textContent).toContain("final");
    expect(structures).toBeGreaterThan(0);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("message/tool selectors retain history references while another run changes", () => {
  const history: ChatMessage[] = [{ id: "saved", role: "assistant", content: "saved", runId: "old" }];
  const call: ToolCall = { toolCallId: "tool", toolName: "read", runId: "old", status: "success", result: "saved" };
  const ownMessages = createRunMessagesSelector(), ownTools = createRunToolsSelector(), partTools = createPartToolsSelector();
  const parts = [{ type: "tool-call", toolCallId: "tool" }];
  const firstMessages = ownMessages(history, "old"), firstTools = ownTools([call], "old"), firstParts = partTools([call], parts);
  for (let index = 0; index < 200; index++) {
    const calls: ToolCall[] = [call, { toolCallId: "other", toolName: "read", runId: "new", status: "running", args: index }];
    expect(ownMessages([...history, { id: "new", role: "assistant", content: `${index}`, runId: "new" }], "old")).toBe(firstMessages);
    expect(ownTools(calls, "old")).toBe(firstTools);
    expect(partTools(calls, parts)).toBe(firstParts);
  }
  expect(ownTools([{ ...call, result: "changed" }], "old")).not.toBe(firstTools);
});

test("child list and row summaries ignore text but reflect status/title/order/deletion", () => {
  const child = { id: "a", title: "worker", status: "running", startedAt: 1, parts: [] } as unknown as SubagentRunInfo;
  const ids = createSubagentIdsSelector(), summary = createSubagentSummarySelector();
  const firstIds = ids([child]), firstSummary = summary([child], "a");
  for (let index = 0; index < 200; index++) {
    const next = [{ ...child, streaming: `${index}` }];
    expect(ids(next)).toBe(firstIds); expect(summary(next, "a")).toBe(firstSummary);
  }
  expect(summary([{ ...child, status: "completed" }], "a")!.status).toBe("completed");
  expect(summary([{ ...child, title: "renamed" }], "a")!.title).toBe("renamed");
  expect(ids([{ ...child, id: "b" }, child])).toEqual(["b", "a"]);
  expect(summary([], "a")).toBeUndefined(); expect(ids([])).toEqual([]);
});
