import type { SessionInfo } from "@qone/protocol";

/** Promote only a known chat; activity must not select or resurrect conversations. */
export function updateSessionActivity(sessions: SessionInfo[], sessionId: string, at: number): SessionInfo[] {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session || at <= session.updatedAt) return sessions;
  return sessions.map((item) => item.id === sessionId ? { ...item, updatedAt: at } : item);
}
