import { expect, test } from "bun:test";
import { dockScopeKey } from "../src/lib/dock-state";

test("同项目的会话和新草稿拥有不同右侧栏作用域", () => {
  const first = dockScopeKey("session-a", "workspace-1");
  const second = dockScopeKey("session-b", "workspace-1");
  const draft = dockScopeKey(undefined, "workspace-1", "draft-a");
  const nextDraft = dockScopeKey(undefined, "workspace-1", "draft-b");
  expect(new Set([first, second, draft, nextDraft]).size).toBe(4);
  expect(dockScopeKey("session-a", "workspace-2")).toBe(first);
});
