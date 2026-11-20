import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { MemoryStateInfo, RuntimeCommand } from "@qone/protocol";

test("memory settings show active automatic preferences, keep notes separate, and resume the chosen summary", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    NodeFilter: dom.window.NodeFilter, HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { GENERAL_SETTINGS_KEY, initLocale } = await import("../src/localization");
  dom.window.localStorage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ language: "zh-CN" }));
  initLocale();
  const { useStore } = await import("../src/store");
  const { dispatchMemoryState, dispatchMemoryError, resetMemoryRequests, useMemoryStore } = await import("../src/lib/memory-state");
  const { MemorySection } = await import("../src/components/settings/memory/memory-section");
  const initial = useStore.getState();
  const initialMemory = useMemoryStore.getState();
  const at = Date.now();
  const workspaces = ["alpha", "beta"].map((id) => ({ id, name: id, path: `C:/${id}`, createdAt: at, updatedAt: at }));
  const sent: RuntimeCommand[] = [];
  useStore.setState({ connected: true, currentWorkspaceId: "alpha", workspaces, creatingSession: false,
    send: (async (command: RuntimeCommand) => { sent.push(command); return true; }) as typeof initial.send });
  const state: MemoryStateInfo = { enabled: true, notes: [{ id: "plain", origin: "manual", content: "按需查的笔记", createdAt: at, updatedAt: at }],
    summaries: [{ id: "past", title: "以前的任务", content: "完成 A；下一步是 B", workspaceId: "beta", generatedAt: at, sourceUpdatedAt: at }],
    automaticPreferences: [
      { id: "suggested", content: "先跑定向测试", preference: { workspaceId: "beta" }, sources: [{ id: "past", quote: "以后先跑定向测试" }] },
      { id: "ignored", content: "按优先级列结果", preference: {}, sources: [{ id: "past", quote: "以后按优先级列结果" }] },
    ],
    stats: { calls: 0, tokens: 0, lastUpdatedAt: at } };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let resumed = 0;
  let stats = 0;
  const button = (text: string, container: ParentNode = host) => [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;
  const selectTab = (label: string) => {
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) => node.textContent?.startsWith(label))!;
    tab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  const reply = async () => {
    const last = sent.at(-1)!;
    await act(async () => { dispatchMemoryState({ type: "memory.state", requestId: last.requestId, state: { ...state } }); });
  };
  try {
    await act(async () => root.render(<MemorySection onOpenExecution={() => stats++} onResumed={() => resumed++} />));
    expect(sent.at(-1)?.type).toBe("memory.get");
    await reply();
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toStartWith("长期偏好");
    expect(host.querySelector(".memory-stats")).toBeNull();
    expect(host.textContent).not.toContain("按需查的笔记");
    expect(host.querySelector("textarea")).toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
    const type = (draft: HTMLTextAreaElement, value: string) => act(async () => {
      setValue.call(draft, value); draft.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    const [suggested, ignored] = [...host.querySelectorAll<HTMLElement>(".memory-automatic-preference")];
    expect(host.textContent).toContain("自动偏好");
    expect(host.textContent).not.toContain("待确认建议");
    expect(host.textContent).not.toContain("采用");
    expect(suggested?.querySelector(".memory-chip")?.textContent).toBe("beta");
    expect(suggested?.querySelector("blockquote")?.textContent).toBe("以后先跑定向测试");
    await act(async () => suggested!.querySelector("summary")!.click());
    await act(async () => button("以前的任务", suggested!).click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("完成 A");
    await act(async () => document.querySelector<HTMLButtonElement>(".nested-dialog-close")!.click());
    await act(async () => button("移除", ignored!).click());
    expect(sent.at(-1)).toMatchObject({ type: "memory.preference.edit", id: "ignored", value: null });
    state.automaticPreferences!.pop();
    await reply();
    await act(async () => button("编辑", suggested!).click());
    const reviewDraft = suggested!.querySelector("textarea")!;
    expect(reviewDraft.value).toBe("先跑定向测试");
    await type(reviewDraft, "先跑能证明修改有效的定向测试");
    await act(async () => button("保存为手动偏好", suggested!).click());
    expect(sent.at(-1)).toMatchObject({ type: "memory.preference.edit", id: "suggested", value: {
      content: reviewDraft.value, preference: { workspaceId: "beta" },
    } });
    await act(async () => { dispatchMemoryError(sent.at(-1)!.requestId, "暂时不能保存"); });
    expect(reviewDraft.value).toBe("先跑能证明修改有效的定向测试");
    await act(async () => button("保存为手动偏好", suggested!).click());
    state.automaticPreferences = [];
    state.notes.push({ id: "adopted", content: reviewDraft.value, createdAt: at, updatedAt: at, origin: "manual", preference: { workspaceId: "beta" } });
    await reply();
    expect(host.querySelector(".memory-automatic-preference")).toBeNull();
    expect(host.textContent).toContain("手动偏好");
    expect(host.querySelector(".memory-note-card")?.textContent).toContain("先跑能证明修改有效的定向测试");
    await act(async () => button("编辑").click());
    const confirmedDraft = host.querySelector("textarea")!;
    await type(confirmedDraft, "修改手动偏好");
    await act(async () => button("保存").click());
    expect(sent.at(-1)).toMatchObject({ type: "memory.note.save", id: "adopted", content: "修改手动偏好", preference: { workspaceId: "beta" } });
    state.notes.find(({ id }) => id === "adopted")!.content = confirmedDraft.value;
    await reply();

    await act(async () => button("手动新增").click());
    const draft = host.querySelector("textarea")!;
    await type(draft, "先确认根因");
    const scope = host.querySelector<HTMLButtonElement>('button[aria-label="生效范围"]')!;
    expect(scope.textContent).toBe("alpha");
    await act(async () => scope.click());
    expect([...host.querySelectorAll('[role="option"]')].map((node) => node.textContent)).toEqual(["全局", "alpha", "beta"]);
    await act(async () => button("beta").click());
    await act(async () => button("保存").click());
    expect(sent.at(-1)).toMatchObject({ type: "memory.note.save", preference: { workspaceId: "beta" }, content: "先确认根因" });
    await act(async () => { dispatchMemoryError(sent.at(-1)!.requestId, "存储失败"); });
    expect(draft.value).toBe("先确认根因");
    expect(host.textContent).toContain("存储失败");
    await act(async () => button("保存").click());
    state.notes.push({ id: "pref", content: "先确认根因", createdAt: at, updatedAt: at, origin: "manual", preference: { workspaceId: "beta" } });
    await reply();
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(".memory-note-card .memory-chip")?.textContent).toBe("beta");
    await act(async () => selectTab("笔记"));
    expect(host.textContent).toContain("按需查的笔记");
    expect(host.textContent).not.toContain("先确认根因");
    await act(async () => selectTab("会话摘要"));
    await act(async () => host.querySelector<HTMLElement>(".memory-summary-card")!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("在「beta」新建会话");
    await act(async () => button("新建续接会话", document).click());
    expect(sent.at(-1)).toMatchObject({ type: "session.create", workspaceId: "beta", resumeFrom: "past" });
    expect(resumed).toBe(1);
    await act(async () => button("执行统计").click());
    expect(stats).toBe(1);
  } finally {
    await act(async () => root.unmount());
    useStore.setState(initial); resetMemoryRequests(); useMemoryStore.setState(initialMemory);
    dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
