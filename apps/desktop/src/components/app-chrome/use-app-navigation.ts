import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useStore } from "../../store";

type Destination = { path: string; sessionId?: string };

const sameDestination = (a: Destination, b: Destination) => a.path === b.path && a.sessionId === b.sessionId;

export function useAppNavigation(path: string) {
  const navigate = useNavigate();
  const currentSessionId = useStore((state) => state.currentSessionId);
  const selectSession = useStore((state) => state.selectSession);
  const [history, setHistory] = useState(() => ({ entries: [{ path, sessionId: currentSessionId }] as Destination[], index: 0 }));
  const pending = useRef<Destination | null>(null);

  useEffect(() => {
    const current = { path, sessionId: currentSessionId };
    if (pending.current && sameDestination(pending.current, current)) {
      pending.current = null;
      return;
    }
    if (pending.current) return;
    setHistory((previous) => {
      if (sameDestination(previous.entries[previous.index], current)) return previous;
      // The app boots on a blank shell before the first session is selected.
      // Replace that bootstrap entry so Back does not land on an identical
      // looking chat that cannot clear the store's current session.
      if (
        previous.entries.length === 1 &&
        previous.index === 0 &&
        previous.entries[0].path === current.path &&
        previous.entries[0].sessionId === undefined &&
        current.sessionId !== undefined
      ) {
        return { entries: [current], index: 0 };
      }
      return { entries: [...previous.entries.slice(0, previous.index + 1), current], index: previous.index + 1 };
    });
  }, [path, currentSessionId]);

  const go = useCallback((offset: number) => {
    const nextIndex = history.index + offset;
    const target = history.entries[nextIndex];
    if (!target) return;
    pending.current = target;
    setHistory((previous) => ({ ...previous, index: nextIndex }));
    if (target.path !== path) {
      void navigate({ to: target.path as "/" });
    }
    if (target.sessionId && target.sessionId !== currentSessionId) selectSession(target.sessionId);
    if (target.path === path && (!target.sessionId || target.sessionId === currentSessionId)) pending.current = null;
  }, [history, path, currentSessionId, navigate, selectSession]);

  return { canGoBack: history.index > 0, canGoForward: history.index < history.entries.length - 1, goBack: () => go(-1), goForward: () => go(1) };
}
