import type { ComponentProps } from "react";
import type { ThreadPrimitive } from "@assistant-ui/react";

type ScrollRestoration = NonNullable<ComponentProps<typeof ThreadPrimitive.Viewport>["scrollRestoration"]>;

// UI state only: retained across page unmounts, isolated by conversation.
const snapshots = new Map<string, ScrollRestoration>();

export function getThreadScrollState(sessionId: string | undefined): ScrollRestoration | undefined {
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
