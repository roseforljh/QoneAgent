import type { SessionInfo } from "@qone/protocol";

export function sessionActivityAt(session: Pick<SessionInfo, "updatedAt" | "lastUserMessageAt">): number {
  return session.lastUserMessageAt ?? session.updatedAt;
}

/** Promote only a known chat; activity must not select or resurrect conversations. */
export function updateSessionActivity(sessions: SessionInfo[], sessionId: string, at: number): SessionInfo[] {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session || at <= sessionActivityAt(session)) return sessions;
  return sessions.map((item) => item.id === sessionId
    ? { ...item, updatedAt: Math.max(item.updatedAt, at), lastUserMessageAt: at }
    : item);
}
