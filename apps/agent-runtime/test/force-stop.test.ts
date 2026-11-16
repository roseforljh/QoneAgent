import { expect, test } from "bun:test";
import { PiAdapter } from "../src/pi-adapter";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createResourceLoader } from "../src/skills";
import { subscribeSessionEvents } from "../src/pi-session-events";
import { ApprovalQueue, withPermission } from "../src/permissions";
import { Type } from "typebox";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";

test("force stop releases a blocked session initializer without letting its late result replace the new session", async () => {
  const faux = fauxProvider({ provider: "force-init", models: [{ id: "model" }] });
  let nextStarted!: () => void, nextDone!: () => void, releaseLoader!: (loader: unknown) => void;
  const entered = new Promise<void>(resolve => { nextStarted = resolve; });
  const finish = new Promise<void>(resolve => { nextDone = resolve; });
  faux.setResponses([async () => { nextStarted(); await finish; return fauxAssistantMessage(fauxText("new answer")); }]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, {}, undefined, () => []);
  Object.assign(adapter, { modelRuntime: runtime });
  const state = adapter as unknown as {
    resourceLoaderLoads: Map<string, Promise<unknown>>; runModes: Map<string, string>;
    sessions: Map<string, unknown>; mediaRunControllers: Map<string, AbortController>;
  };
  state.resourceLoaderLoads.set(process.cwd(), new Promise(resolve => { releaseLoader = resolve; }));
  const options = { cwd: process.cwd(), model: "force-init/model", runId: "same-child-id" };
  const old = adapter.run("initializing", "old", options, () => {});
  await new Promise(resolve => setImmediate(resolve));
  expect(adapter.forceStop(options.runId)).toBe(true);
  await expect(old).rejects.toThrow("run aborted");
  const next = adapter.run("initializing", "next", { ...options, permissionMode: "full" }, () => {});
  await entered;
  const replacement = state.sessions.get("initializing");
  releaseLoader((await createResourceLoader(process.cwd(), undefined, true)).loader);
  await new Promise(resolve => setImmediate(resolve));
  expect(state.sessions.get("initializing")).toBe(replacement);
  expect(adapter.activeRunId("initializing")).toBe(options.runId);
  expect(state.runModes.get("initializing")).toBe("full");
  expect(state.mediaRunControllers.get(options.runId)?.signal.aborted).toBe(false);
  nextDone();
  await next;
});

test("retired session events cannot emit or persist into the replacement conversation", () => {
  let listener!: (event: Record<string, unknown>) => void;
  let current = true;
  const pushed: string[] = [], saved: string[] = [];
  const session = { subscribe: (callback: typeof listener) => { listener = callback; } };
  subscribeSessionEvents({ sessionId: "s", eventSessionId: "s", session,
    runs: new Map([["run", session]]), activeRunIds: new Map([["s", "run"]]), toolNameByModelName: new Map(),
    isCurrent: () => current, push: type => { pushed.push(type); },
    hooks: { onCustomEntry: () => { saved.push("entry"); }, onMessage: () => { saved.push("text"); } },
  });
  current = false;
  listener({ type: "entry_appended", entry: { type: "custom" } });
  listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "old text" } });
  expect(pushed).toEqual([]);
  expect(saved).toEqual([]);
});

test("late media cleanup cannot remove a resumed run's cancellation controller", () => {
  const adapter = new PiAdapter(() => {});
  const state = adapter as unknown as { generationContext(): { trackController(id: string, controller: AbortController): void; releaseController(id: string, controller: AbortController): void }; generationRunControllers: Map<string, AbortController> };
  const context = state.generationContext(), old = new AbortController(), resumed = new AbortController();
  context.trackController("same", old);
  context.trackController("same", resumed);
  context.releaseController("same", old);
  expect(state.generationRunControllers.get("same")).toBe(resumed);
  context.releaseController("same", resumed);
  expect(state.generationRunControllers.has("same")).toBe(false);
});

test("a retired tool wrapper rejects before executing even internal tools", async () => {
  let calls = 0;
  const tool = withPermission({ name: "local", label: "local", description: "test", parameters: Type.Object({}),
    execute: async () => { calls++; return { content: [{ type: "text" as const, text: "done" }], details: {} }; },
  }, { internal: true, isActive: () => false, queue: new ApprovalQueue(), emitApproval: () => {} });
  await expect(tool.execute("call", {}, undefined, undefined, {} as never)).rejects.toThrow("run aborted");
  expect(calls).toBe(0);
});

test("a forced stop releases a run whose work ignores the abort, and the conversation runs again", async () => {
  const faux = fauxProvider({ provider: "force-stop", models: [{ id: "model" }] });
  let started!: () => void;
  const hanging = new Promise<void>((resolve) => { started = resolve; });
  // The first request never settles and ignores abort, like a stuck tool.
  faux.setResponses([async () => { started(); return new Promise<never>(() => {}); }, () => fauxAssistantMessage(fauxText("second answer"))]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, {}, undefined, () => []);
  Object.assign(adapter, { modelRuntime: runtime });
  const options = { cwd: process.cwd(), model: "force-stop/model" };

  const first = adapter.run("force", "hang", { ...options, runId: "hung" }, () => {});
  await hanging;
  expect(adapter.isRunning("force")).toBe(true);
  expect(adapter.forceStop("hung")).toBe(true);
  await expect(first).rejects.toThrow("run aborted");
  expect(adapter.isRunning("force")).toBe(false);
  expect(adapter.hasSession("force")).toBe(false);

  await adapter.run("force", "next", { ...options, runId: "next" }, () => {});
  expect(adapter.isRunning("force")).toBe(false);
  // The finished run cannot be force-stopped twice.
  expect(adapter.forceStop("hung")).toBe(false);
});
