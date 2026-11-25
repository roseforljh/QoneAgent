import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { BackgroundShellJobInfo, SubagentRunInfo } from "@qone/protocol";

const dom = new JSDOM("<!doctype html><body><main></main></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const globals = {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter, HTMLInputElement: dom.window.HTMLInputElement,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
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

test("the header button shows a badge dot on new tasks, opens the floating card on demand, and closes promptly after selection or any outside interaction", async () => {
  const saved = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const { useStore } = await import("../src/store");
  const { BackgroundTasks } = await import("../src/components/assistant-ui/background-tasks");
  const { OPEN_BACKGROUND_JOB_EVENT } = await import("../src/lib/background-job-links");
  const { useBrowserTasks } = await import("../src/lib/browser-tasks");
  const { onOpenBrowserInDock } = await import("../src/lib/browser-dock");
  const { CLOSE_DOCK_PANEL_EVENT } = await import("../src/lib/dock-state");
  const { OPEN_SUBAGENT_EVENT } = await import("../src/components/assistant-ui/subagent-navigation");
  const { translateCurrent: t } = await import("../src/localization");
  const state = useStore.getState();
  useBrowserTasks.getState().clear();
  const host = document.querySelector("main")!;
  const toggleBtn = () => host.querySelector<HTMLButtonElement>('[data-slot="background-tasks-toggle"]');
  const indicator = () => host.querySelector<HTMLElement>('[data-slot="background-tasks-indicator"]');
  const panel = () => host.querySelector("aside");
  const rows = () => [...host.querySelectorAll<HTMLButtonElement>("aside li button")];
  const root = createRoot(host);
  const opened: unknown[] = [];
  const openedBrowsers: unknown[] = [];
  const open = (event: Event) => opened.push([event.type, (event as CustomEvent).detail]);
  const offBrowser = onOpenBrowserInDock((req) => openedBrowsers.push(req));
  let dockOpen = false;
  const render = () => root.render(<BackgroundTasks dockOpen={dockOpen} renderHeader={(toggle) => <header>{toggle}</header>}>
    <div className="q-chat-content"><input id="composer" /></div>
  </BackgroundTasks>);
  const setDockOpen = (value: boolean) => { dockOpen = value; render(); };
  const closeDock = () => setDockOpen(false);
  window.addEventListener(OPEN_BACKGROUND_JOB_EVENT, open);
  window.addEventListener(OPEN_SUBAGENT_EVENT, open);
  window.addEventListener(CLOSE_DOCK_PANEL_EVENT, closeDock);
  try {
    // 1. 历史已完成任务：只显示按钮，不自动弹出卡片，无未读/活跃小点。
    useStore.setState({ currentSessionId: "main", subagents: [], backgroundJobs: [oldJob, foreignJob] });
    await act(async () => render());
    const composer = host.querySelector<HTMLInputElement>("#composer")!;
    expect(toggleBtn()).not.toBeNull();
    expect(indicator()).toBeNull();
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hasAttribute("inert")).toBe(true);

    // 2. 新任务产生：绝不自动弹出卡片、不抢输入框焦点，仅点亮按钮右上角小点。
    composer.focus();
    await act(async () => useStore.setState({ subagents: [subagent], backgroundJobs: [oldJob, foreignJob, command] }));
    expect(document.activeElement).toBe(composer);
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hasAttribute("inert")).toBe(true);
    expect(indicator()).not.toBeNull();
    expect(indicator()?.hasAttribute("data-active")).toBe(true);

    // 3. 点击按钮展开悬浮卡片，展开时隐藏按钮角标，按活跃优先展示全部任务。
    await act(async () => toggleBtn()!.click());
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.hasAttribute("data-open")).toBe(true);
    expect(panel()?.hasAttribute("inert")).toBe(false);
    expect(indicator()).toBeNull();
    expect(rows().map((row) => row.title)).toEqual([command.command, subagent.title, oldJob.command]);

    // 4. 卡片内滚轮滚动不会误关闭；外部滚轮滚动立即关闭。
    await act(async () => panel()!.dispatchEvent(new dom.window.Event("wheel", { bubbles: true })));
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("true");
    await act(async () => composer.dispatchEvent(new dom.window.Event("wheel", { bubbles: true })));
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");

    // 5. 外部点击、焦点切到输入框、窗口失焦均立即关闭卡片。
    await act(async () => toggleBtn()!.click());
    await act(async () => composer.closest<HTMLElement>(".q-chat-content")!.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true })));
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggleBtn()!.click());
    await act(async () => composer.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })));
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => toggleBtn()!.click());
    await act(async () => window.dispatchEvent(new dom.window.Event("blur")));
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");

    // 6. 选中任意任务项后立即关闭卡片并打开对应右侧栏。
    await act(async () => toggleBtn()!.click());
    await act(async () => rows()[1]!.click());
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");
    expect(opened.at(-1)).toEqual([OPEN_SUBAGENT_EVENT, { runId: subagent.id, sessionId: "main" }]);

    // 7. 按 Escape 关闭并归还焦点给触发按钮。
    await act(async () => toggleBtn()!.click());
    rows()[0]!.focus();
    await act(async () => rows()[0]!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel()?.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(toggleBtn());

    // 8. 右侧栏打开时卡片互斥关闭；点按钮时先关右侧栏再弹出卡片。
    await act(async () => toggleBtn()!.click());
    await act(async () => setDockOpen(true));
    expect(panel()).toBeNull();
    await act(async () => toggleBtn()!.click());
    expect(dockOpen).toBe(false);
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("true");

    // 9. 新产生浏览器任务时仅点亮按钮小点，点开卡片展示「浏览器」标签，单击立即关闭并打开右侧栏浏览器。
    await act(async () => {
      useStore.setState({ currentSessionId: "browser-only", subagents: [], backgroundJobs: [], toolCalls: [] });
      useBrowserTasks.getState().upsert({
        id: "opencli-browser-demo",
        sessionId: "browser-only",
        url: "https://console.zenlayer.com/calculator",
        site: "browser",
        active: true,
      });
    });
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");
    expect(indicator()).not.toBeNull();
    await act(async () => toggleBtn()!.click());
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain(t("backgroundTasks.browser"));
    expect(rows()[0]?.textContent).toContain("console.zenlayer.com/calculator");
    await act(async () => rows()[0]!.click());
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");
    expect(openedBrowsers).toContainEqual(expect.objectContaining({
      url: "https://console.zenlayer.com/calculator",
      sessionId: "browser-only",
    }));

    // 10. 重启/热重载后内存态 backgroundJobs 与 browserTasks 清空时，仍能从会话持久化 toolCalls 完整还原三类任务且不重复。
    useBrowserTasks.getState().clear();
    await act(async () => {
      useStore.setState({
        currentSessionId: "restored-session",
        subagents: [{ ...subagent, id: "sub-restored", parentSessionId: "restored-session", title: "子代理卡片测试", status: "completed", startedAt: 1000 }],
        backgroundJobs: [],
        toolCalls: [
          {
            toolCallId: "call-browser-open",
            runId: "run-1",
            toolName: "qone_browser_open",
            status: "success",
            args: { url: "https://example.com/" },
            result: { content: [{ type: "text", text: "{\"url\":\"https://example.com/\"}" }] },
            startedAt: 1001,
          },
          {
            toolCallId: "call-browser-get",
            runId: "run-1",
            toolName: "qone_browser_get",
            status: "success",
            args: { property: "title" },
            result: { content: [{ type: "text", text: "Example Domain" }] },
            startedAt: 1002,
          },
          {
            toolCallId: "call-bg-shell",
            runId: "run-1",
            toolName: "powershell",
            status: "success",
            args: { command: "Start-Sleep -Seconds 90", background: true },
            result: { details: { jobId: "a987b2e6" } },
            startedAt: 1003,
          },
        ],
      });
    });
    expect(toggleBtn()).not.toBeNull();
    await act(async () => toggleBtn()!.click());
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.getAttribute("data-kind"))).toEqual(["command", "browser", "subagent"]);
    expect(rows()[0]?.title).toBe("Start-Sleep -Seconds 90");
    expect(rows()[1]?.textContent).toContain("example.com");
    expect(rows()[1]?.textContent).toContain(t("backgroundTasks.browser"));
    expect(rows()[2]?.title).toBe("子代理卡片测试");
    // 点击历史恢复的浏览器任务直接打开右侧栏内置浏览器。
    await act(async () => rows()[1]!.click());
    expect(toggleBtn()?.getAttribute("aria-expanded")).toBe("false");
    expect(openedBrowsers.at(-1)).toEqual(expect.objectContaining({
      url: "https://example.com/",
      sessionId: "restored-session",
    }));
  } finally {
    offBrowser();
    useBrowserTasks.getState().clear();
    window.removeEventListener(OPEN_BACKGROUND_JOB_EVENT, open);
    window.removeEventListener(OPEN_SUBAGENT_EVENT, open);
    window.removeEventListener(CLOSE_DOCK_PANEL_EVENT, closeDock);
    await act(async () => root.unmount());
    useStore.setState(state);
    dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
