import { expect, test } from "bun:test";
import { handleSessionCommand } from "../src/session-commands";

test("deleting an ordinary conversation stops and joins its initializing run before disposing resources", async () => {
  const calls: string[] = [];
  const title = new AbortController();
  let settle!: (value: boolean) => void;
  const stopped = new Promise<boolean>(resolve => { settle = resolve; });
  const services = {
    titleControllers: new Map([["session", title]]),
    cancelledRuns: new Set<string>(),
    runRepo: { listBySession: () => [{ id: "run", status: "running" }] },
    adapter: {
      stop: () => { calls.push("stop"); return true; },
      waitForRun: () => { calls.push("join"); return stopped; },
      disposeSession: async () => { calls.push("dispose"); },
    },
    sessionRepo: { list: () => [], get: () => ({ id: "session" }), delete: () => { calls.push("delete"); } },
    sideConversations: { metadata: () => undefined },
    subagentController: { dispose: async () => { calls.push("dispose-children"); } },
    subagentRunRepo: { listBySession: () => [{ runId: "child", executionSessionId: "nested-session" }] },
    subagentPublisher: { forget: (id: string) => { calls.push(`forget:${id}`); } },
    subagentNotificationCoordinator: { dispose: (id: string) => { calls.push(`dispose-notifications:${id}`); } },
    goalContinuationTimers: new Map(),
    artifactRepo: { listBySession: () => [] },
    settingsRepo: { set: () => {} },
    generatedArtifacts: { removeFiles: async () => {} },
    projectResources: { removeSession: () => {} },
    send: () => { calls.push("reply"); },
  };
  const deletion = handleSessionCommand({ type: "session.delete", requestId: "delete", sessionId: "session" }, services as never);
  expect(title.signal.aborted).toBe(true);
  expect(calls).toEqual(["stop", "join"]);
  expect(services.cancelledRuns.has("run")).toBe(true);
  settle(true);
  await deletion;
  expect(calls).toEqual(["stop", "join", "dispose-children", "dispose-notifications:session", "dispose-notifications:nested-session", "forget:child", "dispose", "delete", "reply"]);
});
