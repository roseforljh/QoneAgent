import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { AssistantMessagePart, BackgroundShellJobInfo, RuntimeCommand } from "@qone/protocol";
import type { ChatMessage, ToolCall } from "../src/store";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/store");
const { BackgroundJobPanel } = await import("../src/components/assistant-ui/background-job-view");
const { OPEN_BACKGROUND_JOB_EVENT } = await import("../src/lib/background-job-links");
const { SessionTimeline } = await import("../src/components/assistant-ui/session-timeline");
const { useConversationMessages } = await import("../src/lib/use-conversation-messages");
const { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime } = await import("@assistant-ui/react");
const initial = useStore.getState();
afterAll(() => {
  useStore.setState(initial); dom.window.close();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

const job = (id: string, sessionId: string, patch: Partial<BackgroundShellJobInfo> = {}): BackgroundShellJobInfo =>
  ({ id, sessionId, command: `build ${id}`, status: "running", startedAt: Date.now() - 5000, output: `output of ${id}`, ...patch });

const launch = (id: string, parentToolCallId?: string): ToolCall => ({
  toolCallId: `call-${id}`, toolName: "powershell", runId: "run", status: "success", parentToolCallId,
  args: { background: true, command: `build ${id}` }, result: { details: { jobId: id } },
});

const asPart = ({ toolCallId, toolName, args, result }: ToolCall): AssistantMessagePart => ({
  type: "tool-call", messageSequence: 1, toolCallId, toolName, args, result,
});

const notice = (id: string, jobId: string): ChatMessage => ({
  id, role: "user", content: "legacy background card", runId: "run",
  communication: { fromId: jobId, fromTitle: "Background command", toId: "s", toTitle: "Session", backgroundJobId: jobId },
});

function TimelineMessage() {
  const count = useAuiState((state) => state.message.parts.length);
  return <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={count} /></MessagePrimitive.Root>;
}

function NoticeMessage() {
  return <MessagePrimitive.Root data-notice><MessagePrimitive.Parts /></MessagePrimitive.Root>;
}

const noParts: AssistantMessagePart[] = [];
const noImages = new Map();

function TimelineFixture() {
  const messages = useConversationMessages({
    messages: useStore((state) => state.messages), toolCalls: useStore((state) => state.toolCalls),
    streaming: "", streamingParts: noParts, running: false, currentSessionId: "s", childImagesByRun: noImages,
  }, []);
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (value) => value, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Messages components={{ AssistantMessage: TimelineMessage, UserMessage: NoticeMessage }} />
  </AssistantRuntimeProvider>;
}

test("direct and codemode launches put one link per job at the call, not in a message card", async () => {
  const direct = launch("direct");
  const script: ToolCall = { toolCallId: "script", toolName: "codemode", runId: "run", status: "success", args: { code: "run background commands" }, result: "script result" };
  const messages: ChatMessage[] = [
    notice("old-start", "direct"),
    { id: "direct", role: "assistant", content: "", runId: "run", parts: [asPart(direct)] },
    { id: "script", role: "assistant", content: "", runId: "run", parts: [asPart(script)] },
    notice("idle-wake", "direct"), notice("orphan", "legacy"), notice("orphan-duplicate", "legacy"),
  ];
  const previous = useStore.getState();
  useStore.setState({ currentSessionId: "s", messages, toolCalls: [direct, script, launch("first", "script"), launch("second", "script")], backgroundJobs: [job("direct", "s")] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const opened: unknown[] = [];
  const onOpen = (event: Event) => opened.push((event as CustomEvent).detail);
  window.addEventListener(OPEN_BACKGROUND_JOB_EVENT, onOpen);
  try {
    await act(async () => root.render(<TimelineFixture />));
    const links = [...host.querySelectorAll<HTMLButtonElement>('[data-slot="tool-target-link"]')];
    expect(links.map((link) => link.title)).toEqual(["build direct", "build first", "build second"]);
    expect(links[0]?.closest('[data-slot="tool-call"]')?.getAttribute("data-status")).toBe("running");
    expect(host.querySelectorAll("[data-notice]")).toHaveLength(1);
    expect(host.querySelector('[data-slot="tool-result-panel"]')).toBeNull();
    expect(host.textContent).not.toContain("output of direct");
    await act(async () => links[2]!.click());
    expect(opened).toEqual([{ jobId: "second", sessionId: "s" }]);
    expect(host.querySelector('[data-slot="tool-result-panel"]')).toBeNull();
  } finally {
    window.removeEventListener(OPEN_BACKGROUND_JOB_EVENT, onOpen);
    await act(async () => root.unmount()); host.remove(); useStore.setState(previous);
  }
});

test("the panel lists this conversation's commands, shows live output and stops a running one", async () => {
  const sent: RuntimeCommand[] = [];
  useStore.setState({ currentSessionId: "s", send: (command: RuntimeCommand) => { sent.push(command); },
    backgroundJobs: [job("a", "s"), job("b", "s", { status: "exited", exitCode: 0, endedAt: Date.now() }), job("other", "x")] } as never);
  let selected: string | undefined;
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const render = () => root.render(<BackgroundJobPanel selectedId={selected} onSelect={(id) => { selected = id; render(); }} onClose={() => {}} />);
  try {
    await act(async () => render());
    expect([...host.querySelectorAll(".q-subagent-row")].map((row) => row.textContent)).toEqual([expect.stringContaining("build a"), expect.stringContaining("build b")]);
    await act(async () => host.querySelector<HTMLButtonElement>(".q-subagent-row")!.click());
    expect(host.querySelector(".q-background-job-output")!.textContent).toBe("output of a");
    await act(async () => useStore.setState({ backgroundJobs: [job("a", "s", { output: "output of a\nmore" })] }));
    expect(host.querySelector(".q-background-job-output")!.textContent).toBe("output of a\nmore");
    const stop = [...host.querySelectorAll("button")].find((button) => button.textContent === "停止" || button.textContent === "Stop")!;
    await act(async () => stop.click());
    expect(sent).toEqual([expect.objectContaining({ type: "background-shell.stop", jobId: "a" })]);
    await act(async () => useStore.setState({ backgroundJobs: [job("a", "s", { status: "stopped", endedAt: Date.now() })] }));
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "停止" || button.textContent === "Stop")).toBe(false);
    await act(async () => {
      selected = "gone";
      useStore.setState({ toolCalls: [launch("gone")] });
      render();
    });
    expect(host.querySelector(".q-background-job-command")?.textContent).toBe("build gone");
    expect(host.querySelector(".q-subagent-empty")).not.toBeNull();
  } finally {
    await act(async () => root.unmount()); host.remove();
  }
});
