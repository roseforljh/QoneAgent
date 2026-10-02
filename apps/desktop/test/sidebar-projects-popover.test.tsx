import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeCommand, SessionInfo } from "@qone/protocol";
import { ProjectSessionList } from "../src/components/assistant-ui/sidebar-projects-popover";
import { filterSidebarSessions, parseSidebarPreferences, sortSidebarSessions } from "../src/lib/sidebar-preferences";
import { useStore } from "../src/store";
import { translateCurrent } from "../src/localization";

const session = (id: string, workspaceId: string, updatedAt: number): SessionInfo => ({
  id, title: id, workspaceId, createdAt: updatedAt, updatedAt,
});

test("project card includes pinned and older chats, excludes other projects, and keeps manual order", () => {
  const sessions = [session("older-chat", "project", 1), session("other-chat", "other", 3), session("pinned-chat", "project", 2)];
  const prefs = { ...parseSidebarPreferences(null), sort: "manual" as const, priorityIds: ["pinned-chat"], manualOrder: ["pinned-chat", "older-chat"] };
  const selected = sortSidebarSessions(filterSidebarSessions(sessions, "project", []), prefs);
  const html = renderToStaticMarkup(<ProjectSessionList sessions={selected} currentSessionId="pinned-chat"
    runningIds={["older-chat"]} onSelect={() => {}} />);
  expect(html).toContain("older-chat");
  expect(html).toContain("pinned-chat");
  expect(html).not.toContain("other-chat");
  expect(html.indexOf("pinned-chat")).toBeLessThan(html.indexOf("older-chat"));
  expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  expect(html).toContain("q-morphing-spinner");
});

test("project card shows all chats without a recent-item limit and handles empty or untitled chats", () => {
  const sessions = Array.from({ length: 50 }, (_, index) => session(`chat-${index}`, "project", index));
  sessions[0] = { ...sessions[0]!, title: "" };
  const html = renderToStaticMarkup(<ProjectSessionList sessions={sessions} runningIds={[]} onSelect={() => {}} />);
  expect(html.match(/<button /g)).toHaveLength(sessions.length);
  expect(html).toContain(translateCurrent("sidebar.newChat"));
  const empty = renderToStaticMarkup(<ProjectSessionList sessions={[]} runningIds={[]} onSelect={() => {}} />);
  expect(empty).toContain(translateCurrent("sidebar.noChatsInProject"));
  expect(empty).not.toContain("<button");
});

test("the card's shared session selection action switches project and loads the chosen conversation", () => {
  const previous = useStore.getState();
  const commands: RuntimeCommand[] = [];
  const refreshed: string[] = [];
  try {
    useStore.setState({
      currentSessionId: "source", currentWorkspaceId: "source-project", backgroundSessions: {},
      sessions: [session("source", "source-project", 1), session("target", "target-project", 2)],
      workspaces: [{ id: "target-project", name: "Target", path: "/target", createdAt: 1 }],
      send: async (command) => { commands.push(command); return true; },
      refreshWorkspace: (id) => { refreshed.push(id); },
    });
    useStore.getState().selectSession("target");
    expect(useStore.getState().currentSessionId).toBe("target");
    expect(useStore.getState().currentWorkspaceId).toBe("target-project");
    expect(commands).toContainEqual(expect.objectContaining({ type: "session.messages", sessionId: "target" }));
    expect(commands).toContainEqual(expect.objectContaining({ type: "session.queue.list", sessionId: "target" }));
    expect(refreshed).toEqual(["target-project"]);
    const commandCount = commands.length;
    useStore.getState().selectSession("target");
    expect(commands).toHaveLength(commandCount);
  } finally { useStore.setState(previous, true); }
});
