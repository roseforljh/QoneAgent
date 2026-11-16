import { expect, test } from "bun:test";
import { PiAdapter } from "../src/pi-adapter";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";

test("durable sessions release completed transcripts and serialize simultaneous context requests", async () => {
  const faux = fauxProvider({ provider: "resource-lifecycle", models: [{ id: "model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, {}, undefined, () => []);
  Object.assign(adapter, { modelRuntime: runtime });
  const state = adapter as unknown as ReturnType<typeof fixture>["state"];
  try {
    const usage = await Promise.all(Array.from({ length: 16 }, () => adapter.getContextUsage("same-session", process.cwd(), "resource-lifecycle/model")));
    expect(usage).toHaveLength(16);
    expect(state.sessions.size).toBe(0);
    expect(state.resourceLoaders.size).toBe(0);
    expect(state.sessionSettingsManagers.size).toBe(0);
    expect(state.sessionResourceKeys.size).toBe(0);
    faux.setResponses(Array.from({ length: 8 }, () => fauxAssistantMessage(fauxText("done"))));
    await Promise.all(Array.from({ length: 8 }, (_, index) => adapter.run(`session-${index}`, "check", {
      cwd: process.cwd(), model: "resource-lifecycle/model", permissionMode: "full",
    }, () => {})));
    expect(state.sessions.size).toBe(0);
    expect(state.resourceLoaders.size).toBe(0);
    expect(state.resourceLoaderLoads.size).toBe(0);
    expect(state.sessionSettingsManagers.size).toBe(0);
    expect(state.sessionResourceKeys.size).toBe(0);
    await expect(adapter.getContextUsage("failed-context", process.cwd(), "resource-lifecycle/missing")).rejects.toThrow("configured model not found");
    await expect(adapter.run("failed-run", "check", { cwd: process.cwd(), model: "resource-lifecycle/missing" }, () => {})).rejects.toThrow("configured model not found");
    expect(state.sessions.size).toBe(0);
    expect(state.resourceLoaderLoads.size).toBe(0);
    expect(state.sessionResourceKeys.size).toBe(0);
  } finally { await adapter.invalidateSessions(); }
});

test("a closing session remains owned until asynchronous disposal finishes", async () => {
  const faux = fauxProvider({ provider: "resource-disposal", models: [{ id: "model" }] });
  faux.setResponses([fauxAssistantMessage(fauxText("done"))]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, {}, undefined, () => []);
  Object.assign(adapter, { modelRuntime: runtime });
  let disposing!: () => void;
  const entered = new Promise<void>(resolve => { disposing = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const dispose = adapter.disposeSession.bind(adapter);
  adapter.disposeSession = async id => { disposing(); await gate; await dispose(id); };
  const options = { cwd: process.cwd(), model: "resource-disposal/model", runId: "disposing-run" };
  const run = adapter.run("closing", "check", options, () => {});
  try {
    await entered;
    expect(adapter.isRunning("closing")).toBe(true);
    expect(adapter.stop("disposing-run")).toBe(true);
    await expect(adapter.run("closing", "replacement", options, () => {})).rejects.toThrow("already has an active run");
  } finally { release(); await run; }
  expect(adapter.isRunning("closing")).toBe(false);
  expect((adapter as unknown as { stoppedRuns: Set<string> }).stoppedRuns.size).toBe(0);
  expect(adapter.hasSession("closing")).toBe(false);
});

test("cancelling during input preparation does not start a model request", async () => {
  const faux = fauxProvider({ provider: "resource-cancel", models: [{ id: "model" }] });
  let requested = false;
  faux.setResponses([() => { requested = true; return fauxAssistantMessage(fauxText("must not run")); }]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, { memoryContext: () => { adapter.stop("preparing"); return ""; } }, undefined, () => []);
  Object.assign(adapter, { modelRuntime: runtime });
  await expect(adapter.run("cancel", "check", { cwd: process.cwd(), model: "resource-cancel/model", runId: "preparing" }, () => {})).rejects.toMatchObject({ name: "AbortError" });
  expect(requested).toBe(false);
  expect(adapter.isRunning("cancel")).toBe(false);
  expect(adapter.hasSession("cancel")).toBe(false);
});

function fixture() {
  const adapter = new PiAdapter(() => {});
  const state = adapter as unknown as {
    sessions: Map<string, { dispose: () => Promise<void>; isIdle: boolean }>;
    sessionResourceKeys: Map<string, string>;
    resourceLoaders: Map<string, unknown>;
    resourceLoaderLoads: Map<string, Promise<unknown>>;
    sessionSettingsManagers: Map<string, unknown>;
    staleSessions: Set<string>;
  };
  const released: string[] = [];
  const add = (id: string, key: string, isIdle = true) => {
    state.sessions.set(id, { isIdle, dispose: async () => { released.push(id); } });
    state.sessionResourceKeys.set(id, key);
    state.resourceLoaders.set(key, {});
    state.sessionSettingsManagers.set(id, {});
  };
  return { adapter, state, add, released };
}

test("all concurrent model operations share the same initialization", async () => {
  const adapter = new PiAdapter(() => {});
  const state = adapter as unknown as { ensureModelRuntime: () => Promise<unknown>; modelRuntimeLoad?: Promise<unknown> };
  const runtimes = await Promise.all(Array.from({ length: 32 }, () => state.ensureModelRuntime()));
  expect(runtimes.every(runtime => runtime === runtimes[0])).toBe(true);
  expect(state.modelRuntimeLoad).toBeUndefined();
});

test("shared workspace resources survive one child closing and release with the last owner", async () => {
  const f = fixture();
  f.add("child-a", "subagent:workspace");
  f.add("child-b", "subagent:workspace");
  await f.adapter.disposeSession("child-a");
  expect(f.state.resourceLoaders.size).toBe(1);
  expect(f.state.sessionResourceKeys.has("child-a")).toBe(false);
  await f.adapter.disposeSession("child-b");
  expect(f.state.resourceLoaders.size).toBe(0);
  expect(f.state.sessionResourceKeys.size).toBe(0);
  expect(f.state.sessionSettingsManagers.size).toBe(0);
  expect(f.released).toEqual(["child-a", "child-b"]);
});

test("unique side-chat resources and failed initialization owners do not survive disposal", async () => {
  const f = fixture();
  f.add("side", "subagent-side-chat:side");
  f.state.sessionResourceKeys.set("failed", "workspace-that-failed");
  f.state.resourceLoaders.set("workspace-that-failed", {});
  f.state.resourceLoaderLoads.set("workspace-that-failed", Promise.resolve({}));
  await f.adapter.disposeSession("side");
  await f.adapter.disposeSession("failed");
  expect(f.state.resourceLoaders.size).toBe(0);
  expect(f.state.resourceLoaderLoads.size).toBe(0);
  expect(f.state.sessionResourceKeys.size).toBe(0);
});

test("repeated parallel session invalidation releases loaders without interrupting active work", async () => {
  const f = fixture();
  f.add("active", "active-workspace", false);
  for (let round = 0; round < 20; round++) {
    for (let child = 0; child < 32; child++) f.add(`child-${child}`, `workspace-${child % 4}`);
    await f.adapter.invalidateSessions();
    expect(f.state.sessions.size).toBe(1);
    expect(f.state.resourceLoaders.size).toBe(1);
    expect(f.state.sessionSettingsManagers.size).toBe(1);
    expect(f.state.sessionResourceKeys.size).toBe(1);
    expect(f.state.staleSessions.has("active")).toBe(true);
  }
  expect(f.released).toHaveLength(640);
  await f.adapter.disposeSession("active");
  expect(f.state.resourceLoaders.size).toBe(0);
  expect(f.state.staleSessions.size).toBe(0);
});
