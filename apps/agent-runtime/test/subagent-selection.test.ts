import { describe, expect, test } from "bun:test";
import { closeDb, openDb, RunRepo, SessionRepo, SubagentRunRepo, WorkspaceRepo } from "@qone/database";
import { CAPABILITY_IDS } from "@qone/protocol";
import type { PiAdapter } from "../src/pi-adapter";
import { registerSubagentDispatcher } from "../src/subagent-runner";
import { resolveSubagentSelection } from "../src/subagent-selection";
import { normalizeSubagentConfig, subagentCatalog } from "../src/subagents";

function fixture() {
  const db = openDb(":memory:");
  const workspaceRepo = new WorkspaceRepo(db);
  const workspace = workspaceRepo.upsert("test", process.cwd());
  const sessionRepo = new SessionRepo(db);
  const session = sessionRepo.create("selection", workspace.id);
  const runRepo = new RunRepo(db);
  const parent = runRepo.create(session.id);
  const repo = new SubagentRunRepo(db);
  let dispatch!: NonNullable<Parameters<PiAdapter["setSubagentDispatcher"]>[0]>;
  let config = normalizeSubagentConfig({
    runtime: { temporaryModelId: "provider/general" },
    profiles: [
      { id: "reviewer", name: "审查", instructions: "只读检查", modelId: "provider/reviewer", enabled: true },
      ...CAPABILITY_IDS.map(id => ({ id: `builtin:${id}`, name: id, instructions: `media ${id}`, modelId: `provider/${id}`, enabled: true })),
    ],
  });
  const calls: { model?: string; prompt: string; attachments?: unknown[] }[] = [];
  const assistantBuffers = new Map<string, string>();
  const attachment = { type: "image" as const, name: "source.png", mimeType: "image/png", data: "", localPath: "C:\\Media\\source.png" };
  const adapter = {
    setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
    run: async (_sessionId: string, prompt: string, opts: { runId: string; model?: string; attachments?: unknown[] }) => {
      calls.push({ model: opts.model, prompt, attachments: opts.attachments });
      assistantBuffers.set(opts.runId, "done");
    },
    stop: () => true,
    disposeSession: async () => undefined,
  } as unknown as PiAdapter;
  const controller = registerSubagentDispatcher({
    adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
    config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(),
    assistantBuffers, streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(),
    attachmentsProvider: () => [attachment], publish: () => undefined, emit: () => undefined,
  });
  const input = { parentSessionId: session.id, parentRunId: parent.id, task: "审查代码", title: "审查", reason: "需要独立审查结果", expectedResult: "列出审查发现和建议", toolCallId: "call", fallbackModel: "provider/parent", permissionMode: "full" as const };
  return { db, repo, session, parent, config: () => config, setConfig: (value: typeof config) => { config = value; }, calls,
    attachment, dispatch, controller, input };
}

describe("explicit temporary subagent selection", () => {
  test("catalog selections are executable for temporary, media and saved targets", () => {
    const f = fixture();
    try {
      const catalog = subagentCatalog(f.config());
      expect(catalog.temporary.selection).toEqual({ capability: "temporary" });
      expect(resolveSubagentSelection(f.config(), catalog.temporary.selection)).toBeUndefined();
      for (const item of catalog.capabilities) expect(resolveSubagentSelection(f.config(), item.selection)?.modelId).toBe(item.model);
      for (const item of catalog.profiles) expect(resolveSubagentSelection(f.config(), item.selection)?.id).toBe(item.id);
    } finally { closeDb(f.db); }
  });

  test("explicit temporary, omitted and null selectors use the configured general model, not a media profile", async () => {
    const f = fixture();
    try {
      for (const selection of [{ capability: "temporary" as const }, {}, { capability: null, subagentId: null }, { capability: "temporary" as const, subagentId: "" }]) {
        const result = JSON.parse(await f.dispatch({ ...f.input, ...selection }));
        expect(result.status).toBe("completed");
        expect(f.repo.get(result.runId)?.profileId).toBeNull();
      }
      expect(f.calls.map(call => call.model)).toEqual(Array(4).fill("provider/general"));
      expect(f.calls.every(call => call.attachments?.[0] === f.attachment)).toBe(true);
      expect(f.calls.every(call => !call.prompt.includes("media imageGeneration"))).toBe(true);
      f.setConfig({ ...f.config(), runtime: { ...f.config().runtime, temporaryModelId: "provider/changed" } });
      await f.dispatch({ ...f.input, capability: "temporary" });
      expect(f.calls.at(-1)?.model).toBe("provider/changed");
      f.setConfig({ ...f.config(), runtime: { ...f.config().runtime, temporaryModelId: "" } });
      await f.dispatch({ ...f.input, capability: "temporary" });
      expect(f.calls.at(-1)?.model).toBe("provider/parent");
    } finally { closeDb(f.db); }
  });

  test("explicit media and saved profile selectors retain their configured routes", async () => {
    const f = fixture();
    try {
      for (const capability of CAPABILITY_IDS) {
        const result = JSON.parse(await f.dispatch({ ...f.input, capability, subagentId: "" }));
        expect(f.repo.get(result.runId)?.profileId).toBe(`builtin:${capability}`);
        expect(f.calls.at(-1)?.model).toBe(`provider/${capability}`);
      }
      await f.dispatch({ ...f.input, capability: null, subagentId: "reviewer" });
      expect(f.calls.at(-1)?.model).toBe("provider/reviewer");
      expect(f.calls.at(-1)?.prompt).toContain("只读检查");
    } finally { closeDb(f.db); }
  });

  test("conflicting and unavailable targets are rejected before creating any child", async () => {
    const f = fixture();
    try {
      for (const capability of ["temporary", ...CAPABILITY_IDS] as const) {
        await expect(f.dispatch({ ...f.input, capability, subagentId: "reviewer" })).rejects.toThrow("Choose exactly one");
      }
      await expect(f.dispatch({ ...f.input, capability: "unknown" as never })).rejects.toThrow("Unknown subagent target");
      await expect(f.dispatch({ ...f.input, subagentId: "missing" })).rejects.toThrow("profile unavailable");
      f.setConfig({ ...f.config(), profiles: f.config().profiles.map(p => ({ ...p, enabled: false })) });
      await expect(f.dispatch({ ...f.input, capability: "imageGeneration" })).rejects.toThrow("No subagent is configured");
      await expect(f.dispatch({ ...f.input, subagentId: "reviewer" })).rejects.toThrow("profile unavailable");
      expect(f.repo.listBySession(f.session.id)).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    } finally { closeDb(f.db); }
  });

  test("dispatch requires structured delegation rationale before creating a child", async () => {
    const f = fixture();
    try {
      await expect(f.dispatch({ ...f.input, reason: "", expectedResult: "返回结果" })).rejects.toThrow("reason and expectedResult are required");
      await expect(f.dispatch({ ...f.input, reason: "需要独立检查", expectedResult: "" })).rejects.toThrow("reason and expectedResult are required");
      expect(f.repo.listBySession(f.session.id)).toHaveLength(0);
    } finally { closeDb(f.db); }
  });

  test("workflows route explicit media selections to each configured capability model", async () => {
    const f = fixture();
    try {
      const results = await f.controller.workflow(f.session.id, f.parent.id, CAPABILITY_IDS.map(capability => ({
        id: capability, title: capability, task: `media ${capability}`, capability, subagentId: null,
      })), { model: "provider/parent" });
      expect(results.map(item => item.status)).toEqual(CAPABILITY_IDS.map(() => "completed"));
      expect(results.map(item => item.profileId)).toEqual(CAPABILITY_IDS.map(id => `builtin:${id}`));
      expect(results.map(item => item.model)).toEqual(CAPABILITY_IDS.map(id => `provider/${id}`));
      expect(f.calls.every(call => call.attachments?.[0] === f.attachment)).toBe(true);
    } finally { closeDb(f.db); }
  });

  test("workflows support explicit temporary and profile selectors and preflight every target", async () => {
    const f = fixture();
    try {
      await expect(f.controller.workflow(f.session.id, f.parent.id, [
        { id: "valid", title: "valid", task: "review", capability: "temporary" },
        { id: "invalid", title: "invalid", task: "review", subagentId: "missing" },
      ], { model: "provider/parent" })).rejects.toThrow("profile unavailable");
      expect(f.calls).toHaveLength(0);
      expect(f.repo.listBySession(f.session.id)).toHaveLength(0);
      const results = await f.controller.workflow(f.session.id, f.parent.id, [
        { id: "general", title: "general", task: "review", capability: "temporary", subagentId: null },
        { id: "saved", title: "saved", task: "review", capability: null, subagentId: "reviewer", dependsOn: ["general"] },
      ], { model: "provider/parent" });
      expect(results.map(item => item.status)).toEqual(["completed", "completed"]);
      expect(f.calls.map(call => call.model)).toEqual(["provider/general", "provider/reviewer"]);
      expect(f.calls[1]?.prompt).toContain("Dependency general:\ndone");
    } finally { closeDb(f.db); }
  });
});
