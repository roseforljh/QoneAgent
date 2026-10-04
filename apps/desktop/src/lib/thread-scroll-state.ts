import type { ComponentProps } from "react";
import type { ThreadPrimitive } from "@assistant-ui/react";
import type { ThreadFollowSnapshot } from "./thread-scroll-policy";
import type { ThreadReadingAnchor } from "./thread-scroll-position";

export type ThreadScrollRestoration = NonNullable<ComponentProps<typeof ThreadPrimitive.Viewport>["scrollRestoration"]> & {
  follow?: ThreadFollowSnapshot;
  readingAnchor?: ThreadReadingAnchor;
};

// UI state only: retained across page unmounts, isolated by conversation.
const snapshots = new Map<string, ThreadScrollRestoration>();

export function getThreadScrollState(sessionId: string | undefined): ThreadScrollRestoration | undefined {
  if (!sessionId) return undefined;
  let snapshot = snapshots.get(sessionId);
  if (!snapshot) {
    snapshot = { current: null };
    snapshots.set(sessionId, snapshot);
  }
  return snapshot;
}

export function pruneThreadScrollStates(sessionIds: readonly string[]) {
  const existing = new Set(sessionIds);
  for (const id of snapshots.keys()) if (!existing.has(id)) snapshots.delete(id);
}
