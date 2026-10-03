import { expect, test } from "bun:test";
import { createDockStateStore, dockScopeKey } from "../src/lib/dock-state";
import { createJSONStorage } from "zustand/middleware";

test("同项目的会话和新草稿拥有不同右侧栏作用域", () => {
  const first = dockScopeKey("session-a", "workspace-1");
  const second = dockScopeKey("session-b", "workspace-1");
  const draft = dockScopeKey(undefined, "workspace-1", "draft-a");
  const nextDraft = dockScopeKey(undefined, "workspace-1", "draft-b");
  expect(new Set([first, second, draft, nextDraft]).size).toBe(4);
  expect(dockScopeKey("session-a", "workspace-2")).toBe(first);
});

test("右侧栏每个会话的展开状态和标签页会持久化", async () => {
  const saved = new Map<string, string>();
  const storage = createJSONStorage(() => ({
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  }));
  const key = dockScopeKey("session-a", "workspace-1");
  const first = createDockStateStore(storage);
  first.getState().update(key, { sessionId: "session-a", workspaceId: "workspace-1" }, (scope) => ({
    ...scope,
    openTabs: [{ id: "tab-a", view: "session" }],
    activeTabId: "tab-a",
    collapsed: false,
  }));

  const restored = createDockStateStore(storage);
  await restored.persist.rehydrate();
  expect(restored.getState().scopes[key]).toMatchObject({ collapsed: false, activeTabId: "tab-a", openTabs: [{ id: "tab-a", view: "session" }] });
});
