import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, Element: dom.window.Element, Node: dom.window.Node, NodeFilter: dom.window.NodeFilter,
  Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { useStore } = await import("../src/store");
const { useServerStore } = await import("../src/lib/server-state");
const { ComposerServers } = await import("../src/components/assistant-ui/composer-servers");
const { ProjectSection } = await import("../src/components/assistant-ui/project-section");
const { translateCurrent } = await import("../src/localization");
const { NestedDialog } = await import("../src/components/settings/nested-dialog");
const { PersonalizationSection } = await import("../src/components/settings/personalization-section");
const { withRunOptionDefaults, loadRunOptions } = await import("../src/lib/run-options");
const { createQoneMessageQueue, messageServerIds } = await import("../src/lib/qone-message-queue");
const initial = useStore.getState();
afterAll(() => {
  useStore.setState(initial);
  dom.window.close();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

test("selected servers use one colored capsule with a count and clear all together", async () => {
  useStore.setState({ currentSessionId: "a", runOptionsBySession: { a: { serverIds: ["a", "b"] } } });
  useServerStore.setState({ servers: [] });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ComposerServers open={false} onOpenChange={() => {}} />));
    expect(host.textContent).toMatch(/服务器|Servers/);
    expect(host.textContent).toContain("2");
    expect(host.querySelectorAll("button")).toHaveLength(2);
    expect(host.firstElementChild?.className).toContain("rounded-full");
    await act(async () => host.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
    expect(useStore.getState().runOptionsBySession.a?.serverIds).toEqual([]);
    expect(loadRunOptions().a?.serverIds).toEqual([]);
    expect(withRunOptionDefaults({ serverIds: [] }, { serverIds: ["b"] }).serverIds).toEqual([]);
    await act(async () => useServerStore.setState({ servers: ["a", "b"].map(id => ({ id, name: id, host: `${id}.example`, port: 22, username: "root", auth: { kind: "agent" as const }, status: "ready" as const, createdAt: 0 })) }));
    await act(async () => root.render(<ComposerServers open onOpenChange={() => {}} />));
    const choices = document.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    await act(async () => choices[0]!.click());
    await act(async () => choices[1]!.click());
    expect(useStore.getState().runOptionsBySession.a?.serverIds).toEqual(["a", "b"]);
    await act(async () => choices[0]!.click());
    expect(useStore.getState().runOptionsBySession.a?.serverIds).toEqual(["b"]);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("the project overflow opens the shared picker and saves multiple server bindings", async () => {
  const previous = useStore.getState();
  const previousServers = useServerStore.getState();
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    useStore.setState({ workspaces: [{ id: "project", name: "Project", path: ".", createdAt: 1 }], workspaceServerIds: {}, sessions: [] });
    useServerStore.setState({ loaded: true, servers: ["a", "b"].map(id => ({ id, name: id, host: `${id}.example`, port: 22, username: "root", auth: { kind: "agent" }, status: "ready", createdAt: 0 })) });
    await act(async () => root.render(<ProjectSection />));
    const trigger = host.querySelector<HTMLButtonElement>(".q-sidebar-project-actions .q-sidebar-menu-trigger")!;
    await act(async () => trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const bind = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === translateCurrent("sidebar.bindServers"))!;
    await act(async () => bind.click());
    const dialog = document.querySelector('[role="dialog"]')!;
    const choices = dialog.querySelectorAll<HTMLButtonElement>('[role="checkbox"]');
    expect(choices).toHaveLength(2);
    for (const choice of choices) await act(async () => choice.click());
    expect(useStore.getState().workspaceServerIds).toEqual({});
    await act(async () => dialog.querySelector<HTMLButtonElement>("footer button")!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useStore.getState().workspaceServerIds).toEqual({ project: ["a", "b"] });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    useStore.setState(previous, true);
    useServerStore.setState(previousServers, true);
  }
});

test("detail focus stays on the dialog and personalization keeps only global prompt and profile", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<NestedDialog open focusContent onOpenChange={() => {}} title={<input aria-label="name" defaultValue="server" />}>body</NestedDialog>));
    expect(document.activeElement?.getAttribute("role")).toBe("dialog");
    await act(async () => root.render(<PersonalizationSection />));
    expect(host.querySelector(".settings-memory-section")).toBeNull();
    expect(host.querySelector(".settings-global-prompt-section")).not.toBeNull();
    expect(host.querySelectorAll(".settings-profile-form label")).toHaveLength(3);
  } finally { await act(async () => root.unmount()); host.remove(); }
});

test("queued server scope is frozen at enqueue and survives durable restoration", async () => {
  let ids = ["a"];
  const queue = createQoneMessageQueue({ sessionId: "queue", isRunning: () => true, getServerIds: () => ids,
    send: () => {}, steer: async () => true, sync: () => {} });
  queue.adapter.enqueue({ role: "user", content: [{ type: "text", text: "inspect" }], attachments: [], parentId: null, sourceId: null, runConfig: undefined });
  ids = ["b"];
  await new Promise(resolve => setTimeout(resolve, 0));
  const snapshot = queue.getSnapshot();
  expect(snapshot[0]?.serverIds).toEqual(["a"]);
  const restored = createQoneMessageQueue({ sessionId: "queue", isRunning: () => true, send: () => {}, steer: async () => true, sync: () => {} });
  restored.restore(snapshot);
  const localId = restored.getLocalId(snapshot[0]!.id)!;
  expect(messageServerIds(restored.getMessage(localId)!)).toEqual(["a"]);
});
