import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { SessionInfo } from "@qone/protocol";
import { ProjectSessions } from "../src/components/assistant-ui/project-section";
import { translateCurrent } from "../src/localization";
import { useStore } from "../src/store";

const sessions = (count: number): SessionInfo[] => Array.from({ length: count }, (_, index) => ({
  id: `chat-${index}`, title: `chat-${index}`, workspaceId: "project", createdAt: index, updatedAt: index,
}));
const rows = (html: string) => html.match(/data-sidebar-drag-kind="session"/g)?.length ?? 0;

test("a project shows five chats plus one faded but real row hosting the toggle, and renders nothing beyond it", () => {
  const html = renderToStaticMarkup(<ProjectSessions workspaceId="project" sessions={sessions(40)} />);
  expect(rows(html)).toBe(6);
  expect(html).toContain('data-fade="on"');
  expect(html).toContain("q-sidebar-session-toggle");
  expect(html).toContain(translateCurrent("sidebar.showAllChats"));
  expect(html).not.toContain("chat-6");
});

test("a project with five or fewer chats shows them all without a toggle", () => {
  const html = renderToStaticMarkup(<ProjectSessions workspaceId="project" sessions={sessions(5)} />);
  expect(rows(html)).toBe(5);
  expect(html).not.toContain("q-sidebar-session-toggle");
});

test("the toggle lives in the last visible row, which stays clickable, and an older active chat stays visible", async () => {
  const { window } = new JSDOM("<main></main>", { pretendToBeVisual: true });
  Object.defineProperty(window.document, "fonts", { value: { ready: Promise.resolve() } });
  const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: window.getComputedStyle.bind(window), ResizeObserver: class { observe() {} disconnect() {} },
  };
  const originals = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const previous = useStore.getState().currentSessionId;
  const { createRoot } = await import("react-dom/client");
  const host = document.querySelector("main")!;
  const root = createRoot(host);
  const toggle = () => host.querySelector<HTMLButtonElement>(".q-sidebar-session-toggle")!;
  const rowOf = (element: Element) => element.closest("[data-sidebar-drag-id]")!.getAttribute("data-sidebar-drag-id");
  const interactive = () => [...host.querySelectorAll('[data-sidebar-drag-kind="session"]')].filter((row) => !row.closest("[inert]"));
  try {
    await act(async () => root.render(<ProjectSessions workspaceId="project" sessions={sessions(12)} />));
    expect(host.querySelectorAll(".q-sidebar-session-toggle")).toHaveLength(1);
    expect(rowOf(toggle())).toBe("chat-5");
    expect(interactive()).toHaveLength(6);
    // The faded row opens its chat like any other.
    await act(async () => host.querySelector<HTMLButtonElement>('[data-sidebar-drag-id="chat-5"] .q-sidebar-session-trigger')!.click());
    expect(useStore.getState().currentSessionId).toBe("chat-5");
    await act(async () => toggle().click());
    expect(rows(host.innerHTML)).toBe(12);
    expect(host.querySelectorAll(".q-sidebar-session-toggle")).toHaveLength(1);
    expect(rowOf(toggle())).toBe("chat-11");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe(translateCurrent("sidebar.collapseChats"));
    expect(host.querySelector('[data-sidebar-drag-id="chat-5"]')!.getAttribute("data-fade")).toBe("off");
    // Opening an older chat while expanded leaves every row where it is.
    await act(async () => useStore.setState({ currentSessionId: "chat-11" }));
    expect(rowOf(toggle())).toBe("chat-11");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().getAttribute("aria-label")).toBe(translateCurrent("sidebar.showAllChats"));
    expect(rowOf(toggle())).toBe("chat-4");
    expect(interactive()).toHaveLength(6);
    expect(interactive()[4]?.querySelector('[aria-current="page"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    useStore.setState({ currentSessionId: previous });
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    window.close();
  }
});


