import type { SessionInfo } from "@qone/protocol";
import { sessionActivityAt } from "./session-recency";

export function createSidebarSessionsSelector() {
  let previous: SessionInfo[] = [];
  let source: readonly SessionInfo[] | undefined;
  return (sessions: readonly SessionInfo[]) => {
    if (source === sessions) return previous;
    source = sessions;
    const byId = new Map(previous.map((item) => [item.id, item]));
    const next = sessions.map((session) => {
      const saved = byId.get(session.id);
      const updatedAt = sessionActivityAt(session);
      if (saved && saved.title === session.title && saved.workspaceId === session.workspaceId && saved.createdAt === session.createdAt
        && saved.updatedAt === updatedAt && saved.lastUserMessageAt === session.lastUserMessageAt) return saved;
      return { id: session.id, title: session.title, workspaceId: session.workspaceId, createdAt: session.createdAt, updatedAt, lastUserMessageAt: session.lastUserMessageAt };
    });
    if (next.length !== previous.length || next.some((item, index) => item !== previous[index])) previous = next;
    return previous;
  };
}
