import { describe, expect, test } from "bun:test";
import { decodeCommand, type SubagentConfigInfo } from "@qone/protocol";
import { buildSubagentPrompt, normalizeSubagentConfig, resolveSubagent, subagentCatalog } from "../src/subagents";
import { Database } from "bun:sqlite";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, SubagentRunRepo, WorkspaceRepo } from "@qone/database";
import { evaluatePermission } from "../src/permissions";
import { registerSubagentDispatcher } from "../src/subagent-runner";
import { SubagentScheduler } from "../src/subagent-scheduler";
import type { PiAdapter } from "../src/pi-adapter";

const config: SubagentConfigInfo = {
  profiles: [{ id: "researcher", name: "研究员", instructions: "只输出有来源的结论。", modelId: "provider/research", enabled: true, updatedAt: 1 }],
  routing: { webSearch: "subagent:researcher", stt: "model:provider/audio", videoRecognition: "mcp:search" },
  runtime: {
    temporaryModelId: "", maxConcurrent: 4, timeoutMs: 1800000, tokenBudget: 0,
    contextMode: "snapshot", contextMessages: 20, allowNested: true,
    maxDepth: 3, workflowMaxSteps: 32, backgroundEnabled: true,
  },
  updatedAt: 1,
};

describe("capability subagent routing", () => {
  test("normalizes the five capability agents as built-in profiles", () => {
    const normalized = normalizeSubagentConfig({});
    const logos = normalized.profiles.map((profile) => profile.logo).filter(Boolean);
    expect(new Set(logos).size).toBe(logos.length);
    expect(normalized.profiles.map((profile) => profile.id).filter((id) => id.startsWith("builtin:"))).toEqual([
      "builtin:webSearch",
      "builtin:videoRecognition",
      "builtin:imageGeneration",
      "builtin:stt",
      "builtin:tts",
    ]);
    expect(resolveSubagent(normalized, "webSearch")?.name).toBe("联网搜索");
    expect(resolveSubagent(normalized, "imageGeneration")?.instructions).toContain("图像生成");
  });

  test("keeps normalization idempotent and does not duplicate built-ins", () => {
    const first = normalizeSubagentConfig({ profiles: [{ id: "researcher", name: "研究员", instructions: "执行任务", modelId: "provider/research", enabled: true, updatedAt: 1 }] });
    const second = normalizeSubagentConfig(first);
    const recovered = normalizeSubagentConfig({ ...first, profiles: [...first.profiles, ...first.profiles] });
    expect(second.profiles).toHaveLength(6);
    expect(new Set(second.profiles.map((profile) => profile.id)).size).toBe(second.profiles.length);
    expect(new Set(second.profiles.map((profile) => profile.logo).filter(Boolean)).size).toBe(second.profiles.length);
    expect(recovered.profiles).toHaveLength(6);
    expect(new Set(recovered.profiles.map((profile) => profile.id)).size).toBe(recovered.profiles.length);
  });

  test("resolves only what the user configured and reports the rest as unavailable", () => {
    expect(resolveSubagent(config, "webSearch")?.modelId).toBe("provider/research");
    expect(resolveSubagent(config, "stt")?.modelId).toBe("provider/audio");
    expect(resolveSubagent(config, "videoRecognition")?.mcpServerId).toBe("search");
    expect(resolveSubagent(config, "imageGeneration")).toBeUndefined();
    expect(resolveSubagent({ ...config, routing: { tts: "auto" } }, "tts")).toBeUndefined();
    const catalog = subagentCatalog(config);
    expect(catalog.capabilities.map((item) => item.capability)).toEqual(["webSearch", "videoRecognition", "stt"]);
    expect(catalog.unconfiguredCapabilities).toEqual(["imageGeneration", "tts"]);
    expect(catalog.profiles.map((item) => item.id)).toEqual(["researcher"]);
  });

  test("normalizes malformed persisted values and keeps instructions in prompt", () => {
    const normalized = normalizeSubagentConfig({ profiles: [{ id: "x", name: " X ", instructions: " do ", modelId: "p/m", enabled: false }] });
    expect(normalized.profiles[0]).toMatchObject({ name: "X", instructions: "do", enabled: false });
    expect(normalized.runtime.temporaryModelId).toBe("");
    expect(normalizeSubagentConfig({ runtime: { temporaryModelId: " provider/temp " } }).runtime.temporaryModelId).toBe("provider/temp");
    expect(buildSubagentPrompt(resolveSubagent(config, "webSearch")!, "查资料")).toContain("<subagent-task");
  });

  test("accepts atomic settings synchronization over the protocol", () => {
    const sync = decodeCommand(JSON.stringify({ type: "subagent.sync", requestId: "r2", config }));
    expect(sync?.type).toBe("subagent.sync");
  });
});

test("keeps parallel subagent transcripts separate across restart and removes them with a rewritten parent turn", () => {
  const db = openDb(":memory:");
  const session = new SessionRepo(db).create("delegation");
  const runs = new RunRepo(db);
  const messages = new MessageRepo(db);
  const parent = runs.create(session.id);
  messages.add(session.id, "user", "同时检查两件事", parent.id);
  const repo = new SubagentRunRepo(db);
  const first = runs.create(session.id);
  const second = runs.create(session.id);
  repo.create({ runId: first.id, parentSessionId: session.id, parentRunId: parent.id, toolCallId: "call-a", title: "检查启动", task: "检查启动流程", model: "provider/fast" });
  repo.create({ runId: second.id, parentSessionId: session.id, parentRunId: parent.id, toolCallId: "call-b", title: "运行测试", task: "运行回归测试", model: "provider/fast" });
  repo.save(first.id, "启动正常", [{ type: "text", text: "读取配置", messageSequence: 1 }, { type: "tool-call", toolCallId: "tool-a", toolName: "read", args: { path: "config" }, result: "ok", messageSequence: 2 }, { type: "text", text: "启动正常", messageSequence: 3 }]);
  repo.save(second.id, "测试通过", [{ type: "text", text: "测试通过", messageSequence: 4 }]);
  runs.finish(first.id, "completed");
  runs.finish(second.id, "completed");
  const snapshot = db.$client.serialize();
  closeDb(db);

  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
  try {
    const saved = new SubagentRunRepo(reopened).listBySession(session.id);
    expect(saved).toHaveLength(2);
    expect(saved.map((item) => item.toolCallId).sort()).toEqual(["call-a", "call-b"]);
    expect(JSON.parse(saved.find((item) => item.runId === first.id)!.parts)[1]).toMatchObject({ toolName: "read", result: "ok" });
    new MessageRepo(reopened).truncateFrom(session.id, new MessageRepo(reopened).listBySession(session.id)[0]!.id);
    expect(new SubagentRunRepo(reopened).listBySession(session.id)).toHaveLength(0);
    expect(new RunRepo(reopened).get(first.id)).toBeUndefined();
  } finally {
    closeDb(reopened);
  }
});

test("delegation has its own permission while child tools retain their normal gate", () => {
  const rules = { get: (_subject: string, permission: string) => permission === "agent.delegate" ? "allow" as const : "ask" as const };
  expect(evaluatePermission({ toolName: "dispatch_subagent" }, "ask", rules).decision).toBe("allow");
  expect(evaluatePermission({ toolName: "write", args: { path: "file.txt" } }, "ask", rules).decision).toBe("ask");
  expect(evaluatePermission({ toolName: "dispatch_subagent" }, "ask", { get: () => "deny" }).decision).toBe("deny");
});

test("two delegation calls launch independent Pi runs before either finishes", async () => {
  const db = openDb(":memory:");
  try {
    const workspace = new WorkspaceRepo(db).upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("parallel", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const subagentRunRepo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    const releases: (() => void)[] = [];
    const models: string[] = [];
    const temporaryConfig = { ...config, runtime: { ...config.runtime, temporaryModelId: "provider/temp" } };
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async (_sessionId: string, _prompt: string, options: { model?: string }) => {
        models.push(options.model ?? "");
        return new Promise<void>((resolve) => { releases.push(resolve); });
      },
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const partsByRun = new Map();
    registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo: new WorkspaceRepo(db), runRepo, subagentRunRepo,
      config: () => temporaryConfig, partsByRun, messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(),
      publish: () => undefined, emit: () => undefined,
    });
    const input = { parentSessionId: session.id, parentRunId: parent.id, task: "检查", title: "检查", fallbackModel: "provider/main", permissionMode: "ask" as const };
    const first = dispatch({ ...input, toolCallId: "call-a" });
    const second = dispatch({ ...input, toolCallId: "call-b" });
    expect(releases).toHaveLength(2);
    expect(models).toEqual(["provider/temp", "provider/temp"]);
    expect(subagentRunRepo.listBySession(session.id)).toHaveLength(2);
    for (const release of releases) release();
    await Promise.all([first, second]);
    expect(subagentRunRepo.listBySession(session.id).map((row) => runRepo.get(row.runId)?.status)).toEqual(["completed", "completed"]);
  } finally {
    closeDb(db);
  }
});

test("persists the initial child turn exactly once", async () => {
  const db = openDb(":memory:");
  try {
    const workspace = new WorkspaceRepo(db).upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("turns", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    const assistantBuffers = new Map<string, string>();
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async (_sessionId: string, _prompt: string, opts: { runId?: string }) => {
        if (opts.runId) assistantBuffers.set(opts.runId, "完成");
      },
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo: new WorkspaceRepo(db), runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(),
      assistantBuffers, streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(),
      publish: () => undefined, emit: () => undefined,
    });
    const child = await dispatch({ parentSessionId: session.id, parentRunId: parent.id, task: "首轮任务", title: "任务", toolCallId: "call", fallbackModel: "provider/main", permissionMode: "ask" });
    const row = repo.listBySession(session.id)[0]!;
    expect(repo.listMessages(row.runId).map((message) => message.role)).toEqual(["user", "assistant"]);
    await controller.control(row.runId, "retry");
    expect(repo.listMessages(row.runId).map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    await controller.control(row.runId, "follow_up", "补充检查");
    expect(repo.listMessages(row.runId).map((message) => message.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    expect(child).toContain(row.runId);
  } finally {
    closeDb(db);
  }
});

test("capability dispatch uses the configured model with the parent's attachments and refuses unconfigured capabilities", async () => {
  const db = openDb(":memory:");
  try {
    const workspace = new WorkspaceRepo(db).upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("capability", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const audio = { type: "file" as const, name: "voice.mp3", mimeType: "audio/mpeg", data: "data:audio/mpeg;base64,AA==" };
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    const calls: { model?: string; attachments?: unknown[] }[] = [];
    const assistantBuffers = new Map<string, string>();
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async (_sessionId: string, _prompt: string, opts: { runId?: string; model?: string; attachments?: unknown[] }) => {
        calls.push({ model: opts.model, attachments: opts.attachments });
        if (opts.runId) assistantBuffers.set(opts.runId, "转写完成");
      },
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo: new WorkspaceRepo(db), runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(),
      assistantBuffers, streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(),
      attachmentsProvider: (sessionId, runId) => sessionId === session.id && runId === parent.id ? [audio] : [],
      publish: () => undefined, emit: () => undefined,
    });
    const input = { parentSessionId: session.id, parentRunId: parent.id, task: "转写", title: "转写", toolCallId: "call", fallbackModel: "provider/main", permissionMode: "ask" as const };
    await dispatch({ ...input, capability: "stt" });
    expect(calls).toEqual([{ model: "provider/audio", attachments: [audio] }]);
    await expect(dispatch({ ...input, toolCallId: "call-2", capability: "imageGeneration" })).rejects.toThrow("No subagent is configured for imageGeneration");
    expect(calls).toHaveLength(1);
  } finally {
    closeDb(db);
  }
});

test("scheduler admits queued children in FIFO order", async () => {
  const scheduler = new SubagentScheduler(() => 1);
  const first = new AbortController();
  const second = new AbortController();
  expect(scheduler.tryAcquire("a")).toBe(true);
  const queued = scheduler.acquire("b", second.signal);
  expect(scheduler.activeCount).toBe(1);
  scheduler.release("a");
  await queued;
  expect(scheduler.activeCount).toBe(1);
  scheduler.release("b");
  first.abort();
});
