import { useEffect } from "react";
import type { AssistantRuntime } from "@assistant-ui/react";
import { useStore } from "../store";
import { bindComposerDrafts, composerDrafts } from "./composer-drafts";

/** Call after useExternalStoreRuntime so its adapter effect runs first. */
export function useComposerDrafts(runtime: AssistantRuntime) {
  const sessionId = useStore((state) => state.currentSessionId);
  const sessions = useStore((state) => state.sessions);
  const sessionsLoaded = useStore((state) => state.sessionsLoaded);

  useEffect(() => bindComposerDrafts(
    runtime,
    sessionId,
    () => useStore.getState().currentSessionId === sessionId,
  ), [runtime, sessionId]);

  useEffect(() => {
    if (sessionsLoaded) composerDrafts.prune(sessions.map((session) => session.id));
  }, [sessions, sessionsLoaded]);
}
