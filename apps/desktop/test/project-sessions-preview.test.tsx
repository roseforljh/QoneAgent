import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionInfo } from "@qone/protocol";
import { ProjectSessions } from "../src/components/assistant-ui/project-section";
import { translateCurrent } from "../src/localization";

const sessions = (count: number): SessionInfo[] => Array.from({ length: count }, (_, index) => ({
  id: `chat-${index}`, title: `chat-${index}`, workspaceId: "project", createdAt: index, updatedAt: index,
}));
const rows = (html: string) => html.match(/data-sidebar-drag-kind="session"/g)?.length ?? 0;

test("a project shows five chats, fades one more behind a full-load button, and renders nothing beyond it", () => {
  const html = renderToStaticMarkup(<ProjectSessions workspaceId="project" sessions={sessions(40)} />);
  expect(rows(html)).toBe(6);
  expect(html).toContain("q-sidebar-session-more-button");
  expect(html).toContain(translateCurrent("sidebar.showAllChats"));
  expect(html).not.toContain("chat-6");
});

test("a project with five or fewer chats shows them all without a full-load button", () => {
  const html = renderToStaticMarkup(<ProjectSessions workspaceId="project" sessions={sessions(5)} />);
  expect(rows(html)).toBe(5);
  expect(html).not.toContain("q-sidebar-session-more-button");
});
