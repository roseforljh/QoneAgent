import { expect, test } from "bun:test";
import type { SessionInfo } from "@qone/protocol";
import { filterSidebarSessions, moveSidebarSession, parseSidebarPreferences, sortSidebarSessions } from "../src/lib/sidebar-preferences";

const session = (id: string, updatedAt: number, workspaceId?: string): SessionInfo => ({
  id, title: id, createdAt: updatedAt - 1, updatedAt, workspaceId,
});

test("sidebar preferences use safe defaults and discard malformed ids", () => {
  expect(parseSidebarPreferences({ layout: "bad", sort: "bad", priorityIds: ["a", 1, "a"] })).toEqual({
    layout: "project", sort: "recent", manualOrder: [], priorityIds: ["a"],
  });
});

test("recent and priority sorting are deterministic", () => {
  const sessions = [session("old", 1), session("new", 3), session("middle", 2)];
  expect(sortSidebarSessions(sessions, { layout: "project", sort: "recent", manualOrder: [], priorityIds: [] }).map((item) => item.id)).toEqual(["new", "middle", "old"]);
  expect(sortSidebarSessions(sessions, { layout: "project", sort: "priority", manualOrder: [], priorityIds: ["old"] }).map((item) => item.id)).toEqual(["old", "new", "middle"]);
});

test("manual order moves one chat and project filtering isolates orphan chats", () => {
  expect(moveSidebarSession(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  const sessions = [session("a", 1, "project-a"), session("b", 2), session("c", 3, "project-b")];
  expect(filterSidebarSessions(sessions, "project-a", ["project-a", "project-b"]).map((item) => item.id)).toEqual(["a"]);
  expect(filterSidebarSessions(sessions, null, ["project-a", "project-b"]).map((item) => item.id)).toEqual(["b"]);
});
