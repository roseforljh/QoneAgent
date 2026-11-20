import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { BackgroundShellJobInfo, SubagentRunInfo } from "@qone/protocol";

const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter, HTMLInputElement: dom.window.HTMLInputElement,
  CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  ResizeObserver: class { observe() {} disconnect() {} }, IS_REACT_ACT_ENVIRONMENT: true,
};

const subagent: SubagentRunInfo = {
  id: "same-id", parentSessionId: "main", parentRunId: "parent", depth: 1, toolCallId: "call",
  title: "Inspect logs", task: "Inspect logs", status: "running", startedAt: Date.now() - 20,
  content: "", parts: [], turnCount: 0, retryCount: 0, requiredBeforeFinal: false,
  dependencyState: "running", completionAcknowledged: false,
};
const oldJob: BackgroundShellJobInfo = { id: "old", sessionId: "main", command: "old build", status: "exited", startedAt: Date.now() - 1000, output: "done" };
const foreignJob = { ...oldJob, id: "other", sessionId: "other", command: "another chat's build" };
const command: BackgroundShellJobInfo = { id: "same-id", sessionId: "main", command: "bun run build", status: "running", startedAt: subagent.startedAt + 1, output: "" };

test("the header opens for new tasks without stealing focus and routes each row to its dock detail", async () => {
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const { useStore } = await import("../src/store");
  const { BackgroundTasks } = await import("../src/components/assistant-ui/background-tasks");
  const { OPEN_BACKGROUND_JOB_EVENT } = await import("../src/lib/background-job-links");
  const { OPEN_SUBAGENT_EVENT } = await import("../src/components/assistant-ui/subagent-navigation");
  const { translateCurrent: t } = await import("../src/localization");
  const state = useStore.getState();
  const host = document.querySelector("main")!;
  const trigger = () => host.querySelector<HTMLButtonElement>("header button")!;
  const panel = () => host.querySelector("aside");
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>("aside li button")];
  const root = createRoot(host);
  const opened: unknown[] = [];
  const open = (event: Event) => opened.push([event.type, (event as CustomEvent).detail]);
  window.addEventListener(OPEN_BACKGROUND_JOB_EVENT, open);
  window.addEventListener(OPEN_SUBAGENT_EVENT, open);
  try {
    useStore.setState({ currentSessionId: "main", subagents: [], backgroundJobs: [oldJob, foreignJob] });
    await act(async () => root.render(<BackgroundTasks renderHeader={(toggle) => <header>{toggle}</header>}>
      <div className="q-chat-content"><input id="composer" /></div>
    </BackgroundTasks>));
    const composer = host.querySelector<HTMLInputElement>("#composer")!;
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    const taskPanel = panel()!;
    expect(trigger().getAttribute("aria-controls")).toBe(taskPanel.id);
    expect(taskPanel.hasAttribute("inert")).toBe(true);
    composer.focus();
    await act(async () => useStore.setState({ subagents: [subagent], backgroundJobs: [oldJob, foreignJob, command] }));
    expect(document.activeElement).toBe(composer);
    expect(panel()).toBe(taskPanel);
    expect(taskPanel.hasAttribute("data-open")).toBe(true);
    expect(taskPanel.hasAttribute("inert")).toBe(false);
    expect(taskPanel.parentElement).toBe(composer.closest(".q-chat-content")?.parentElement);
    expect(rows().map((row) => row.title)).toEqual([command.command, subagent.title, oldJob.command]);
    expect(rows()[0]?.textContent).toContain(t("backgroundTasks.command"));
    expect(rows()[1]?.textContent).toContain(t("nav.subagents"));
    await act(async () => taskPanel.querySelector("ul")!.click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await act(async () => composer.closest<HTMLElement>(".q-chat-content")!.click());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(composer);
    await act(async () => trigger().click());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await act(async () => rows()[0]!.click());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    // Keep the same panel for the exit transition, but remove it from interaction immediately.
    expect(panel()).toBe(taskPanel);
    expect(taskPanel.hasAttribute("data-open")).toBe(false);
    expect(taskPanel.hasAttribute("inert")).toBe(true);
    expect(host.querySelector("#composer")).toBe(composer);
    await act(async () => useStore.setState({ backgroundJobs: [oldJob, foreignJob, { ...command, output: "new line" }] }));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger().click());
    await act(async () => rows()[1]!.click());
    expect(opened).toEqual([
      [OPEN_BACKGROUND_JOB_EVENT, { jobId: command.id, sessionId: "main" }],
      [OPEN_SUBAGENT_EVENT, { runId: subagent.id, sessionId: "main" }],
    ]);
    await act(async () => useStore.setState({ backgroundJobs: [oldJob, foreignJob, { ...command, status: "exited" }] }));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger().click());
    expect(rows().map((row) => row.title)).toEqual([subagent.title, command.command, oldJob.command]);
    await act(async () => useStore.setState({ currentSessionId: "other" }));
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => trigger().click());
    expect(rows().map((row) => row.title)).toEqual([foreignJob.command]);
    rows()[0]!.focus();
    await act(async () => rows()[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel()?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(trigger());
    await act(async () => useStore.setState({ backgroundJobs: [...useStore.getState().backgroundJobs,
      { ...foreignJob, id: "fast", command: "quick check", startedAt: Date.now() }] }));
    expect(rows()[0]?.title).toBe("quick check");
  } finally {
    window.removeEventListener(OPEN_BACKGROUND_JOB_EVENT, open);
    window.removeEventListener(OPEN_SUBAGENT_EVENT, open);
    await act(async () => root.unmount());
    useStore.setState(state);
    dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
