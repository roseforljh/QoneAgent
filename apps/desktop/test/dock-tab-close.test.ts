import { expect, test } from "bun:test";
import { closeDockTabsExcept, closeDockTabsToRight, removeDockTab, type DockScope } from "../src/lib/dock-state";

function scope(): DockScope {
  return { openTabs: [{ id: "left", view: "files" }, { id: "anchor", view: "git" }, { id: "side", view: "sideChat" }, { id: "last", view: "terminal" }], activeTabId: "last", collapsed: false, maximized: false };
}

test("close-right uses single-tab removal and leaves the anchor active", async () => {
  let current = scope();
  const closed: string[] = [];
  await closeDockTabsToRight(current.openTabs, "anchor", async (id) => {
    closed.push(id); current = removeDockTab(current, id); return true;
  });
  expect(closed).toEqual(["last", "side"]);
  expect(current.openTabs.map((tab) => tab.id)).toEqual(["left", "anchor"]);
  expect(current.activeTabId).toBe("anchor");
});

test("cancelling a side-chat close stops the batch with completed closes committed", async () => {
  let current = scope();
  const attempted: string[] = [];
  await closeDockTabsToRight(current.openTabs, "left", async (id) => {
    attempted.push(id);
    if (id === "side") return false;
    current = removeDockTab(current, id); return true;
  });
  expect(attempted).toEqual(["last", "side"]);
  expect(current.openTabs.map((tab) => tab.id)).toEqual(["left", "anchor", "side"]);
  expect(current.activeTabId).toBe("side");
});

test("tabs opened while confirmation is pending are outside the batch", async () => {
  let current = scope();
  await closeDockTabsToRight(current.openTabs, "anchor", async (id) => {
    current = removeDockTab(current, id);
    if (id === "last") current = { ...current, openTabs: [...current.openTabs, { id: "new", view: "browser" }], activeTabId: "new" };
    return true;
  });
  expect(current.openTabs.map((tab) => tab.id)).toEqual(["left", "anchor", "new"]);
  expect(current.activeTabId).toBe("new");
});

test("a missing anchor and the last tab perform no closes", async () => {
  const closed: string[] = [];
  const close = async (id: string) => { closed.push(id); return true; };
  await closeDockTabsToRight(scope().openTabs, "missing", close);
  await closeDockTabsToRight(scope().openTabs, "last", close);
  expect(closed).toEqual([]);
});

test("close-other uses the snapshot and preserves the anchor", async () => {
  let current = scope();
  const closed: string[] = [];
  await closeDockTabsExcept(current.openTabs, "anchor", async (id) => {
    closed.push(id);
    current = removeDockTab(current, id);
    return true;
  });
  expect(closed).toEqual(["last", "side", "left"]);
  expect(current.openTabs.map((tab) => tab.id)).toEqual(["anchor"]);
});

test("close-other stops when a side-chat confirmation is cancelled", async () => {
  let current = scope();
  const attempted: string[] = [];
  await closeDockTabsExcept(current.openTabs, "anchor", async (id) => {
    attempted.push(id);
    if (id === "side") return false;
    current = removeDockTab(current, id);
    return true;
  });
  expect(attempted).toEqual(["last", "side"]);
  expect(current.openTabs.map((tab) => tab.id)).toEqual(["left", "anchor", "side"]);
});

test("close-other ignores a removed anchor and preserves tabs opened during confirmation", async () => {
  let current = scope();
  const closed: string[] = [];
  const close = async (id: string) => {
    closed.push(id);
    current = removeDockTab(current, id);
    if (id === "last") current = { ...current, openTabs: [...current.openTabs, { id: "new", view: "browser" }], activeTabId: "new" };
    return true;
  };
  await closeDockTabsExcept(current.openTabs, "missing", close);
  expect(closed).toEqual([]);
  await closeDockTabsExcept(current.openTabs, "anchor", close);
  expect(closed).toEqual(["last", "side", "left"]);
  expect(current.openTabs.map((tab) => tab.id)).toEqual(["anchor", "new"]);
  expect(current.activeTabId).toBe("new");
});
