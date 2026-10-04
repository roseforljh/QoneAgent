import { describe, expect, test } from "bun:test";
import { decodeCommand, ECC_BUILTIN_SUBAGENTS, isBuiltinSubagentId, isEccBuiltinSubagentId, type SubagentConfigInfo } from "@qone/protocol";
import { buildSubagentPrompt, normalizeSubagentConfig, resolveSubagent, subagentCatalog } from "../src/subagents";
import { Database } from "bun:sqlite";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, SubagentRunRepo, WorkspaceRepo } from "@qone/database";
import { evaluatePermission } from "../src/permissions";
import { registerSubagentDispatcher } from "../src/subagent-runner";
import { SubagentScheduler } from "../src/subagent-scheduler";
import type { PiAdapter } from "../src/pi-adapter";

const config: SubagentConfigInfo = {
  profiles: [{ id: "researcher", name: "研究员", instructions: "只输出有来源的结论。", modelId: "provider/research", enabled: true, updatedAt: 1 }],
  routing: { stt: "model:provider/audio", videoRecognition: "mcp:search" },
  runtime: {
    temporaryModelId: "", maxConcurrent: 4, timeoutMs: 1800000, tokenBudget: 0,
    contextMode: "snapshot", contextMessages: 20, allowNested: true,
    maxDepth: 3, workflowMaxSteps: 32, backgroundEnabled: true,
  },
  updatedAt: 1,
};

describe("capability subagent routing", () => {
  test("ships the complete ECC built-in catalog and accepts its profiles without a dedicated model", () => {
    expect(ECC_BUILTIN_SUBAGENTS).toHaveLength(68);
    expect(ECC_BUILTIN_SUBAGENTS.every((agent) => agent.id.startsWith("builtin:ecc:") && agent.instructions.length > 0)).toBe(true);
    const planner = ECC_BUILTIN_SUBAGENTS.find((agent) => agent.name === "planner")!;
    expect(isEccBuiltinSubagentId(planner.id)).toBe(true);
    expect(isBuiltinSubagentId(planner.id)).toBe(true);
    expect(planner.tools).toEqual(["read", "grep", "find"]);
    expect(normalizeSubagentConfig({ profiles: [{ ...planner, modelId: "", enabled: true, updatedAt: 1 }] }).profiles).toContainEqual(expect.objectContaining({ id: planner.id, instructions: planner.instructions }));
  });

  test("always lists the temporary general agent with its configured or inherited model", () => {
    const empty = normalizeSubagentConfig({});
    expect(subagentCatalog(empty).temporary).toMatchObject({
      id: "temporary", name: "临时通用代理", model: "follow-parent-model",
    });
    expect(subagentCatalog(empty).capabilities).toEqual([]);
    const configured = normalizeSubagentConfig({ runtime: { temporaryModelId: "provider/general" } });
    expect(subagentCatalog(configured).temporary.model).toBe("provider/general");
  });

  test("normalizes the five supported capability agents as built-in profiles", () => {
    const normalized = normalizeSubagentConfig({});
    const logos = normalized.profiles.map((profile) => profile.logo).filter(Boolean);
    expect(new Set(logos).size).toBe(logos.length);
    expect(normalized.profiles.map((profile) => profile.id).filter((id) => id.startsWith("builtin:"))).toEqual([
      "builtin:videoRecognition",
      "builtin:imageGeneration",
      "builtin:videoGeneration",
      "builtin:stt",
      "builtin:tts",
    ]);
    expect(normalized.profiles.find((item) => item.id === "builtin:videoRecognition")?.name).toBe("视频识别");
    expect(normalized.profiles.find((item) => item.id === "builtin:imageGeneration")?.instructions).toContain("图像生成");
    expect(normalized.profiles.find((item) => item.id === "builtin:videoGeneration")?.instructions).toContain("视频生成");
    expect(subagentCatalog(normalized).unconfiguredCapabilities).toContain("videoRecognition");
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

  test("keeps saved profile positions when configuration is synchronized", () => {
    const initial = normalizeSubagentConfig({});
    const custom = { id: "researcher", name: "研究员", instructions: "执行任务", modelId: "provider/research", enabled: true, updatedAt: 1 };
    const saved = { ...initial, profiles: [initial.profiles[0], custom, ...initial.profiles.slice(1)] };
    const normalized = normalizeSubagentConfig(saved);
    expect(normalized.profiles.map((profile) => profile.id)).toEqual(saved.profiles.map((profile) => profile.id));
    expect(normalizeSubagentConfig(normalized).profiles.map((profile) => profile.id)).toEqual(saved.profiles.map((profile) => profile.id));
  });

  test("resolves only what the user configured and reports the rest as unavailable", () => {
    expect(resolveSubagent(config, "stt")?.modelId).toBe("provider/audio");
    expect(resolveSubagent(config, "videoRecognition")?.mcpServerId).toBe("search");
    expect(resolveSubagent(config, "imageGeneration")).toBeUndefined();
    expect(resolveSubagent(config, "videoGeneration")).toBeUndefined();
    const videoGenerator = normalizeSubagentConfig({ routing: { videoGeneration: "model:provider/video-generator" } });
    expect(resolveSubagent(videoGenerator, "videoGeneration")?.modelId).toBe("provider/video-generator");
    expect(subagentCatalog(videoGenerator).capabilities.map((item) => item.capability)).toContain("videoGeneration");
    expect(resolveSubagent({ ...config, routing: { tts: "auto" } }, "tts")).toBeUndefined();
    const catalog = subagentCatalog(config);
    expect(catalog.capabilities.map((item) => item.capability)).toEqual(["videoRecognition", "stt"]);
    expect(catalog.capabilities.find((item) => item.capability === "videoRecognition")?.description).toContain("视频内容识别");
    expect(catalog.unconfiguredCapabilities).toEqual(["imageGeneration", "videoGeneration", "tts"]);
    expect(catalog.temporary).toMatchObject({ id: "temporary", name: "临时通用代理" });
    expect(catalog.profiles.map((item) => item.id)).toEqual(["researcher"]);
  });

  test("normalizes malformed persisted values and keeps instructions in prompt", () => {
    const normalized = normalizeSubagentConfig({ profiles: [{ id: "x", name: " X ", instructions: " do ", modelId: "p/m", enabled: false }] });
    expect(normalized.profiles[0]).toMatchObject({ name: "X", instructions: "do", enabled: false });
    expect(normalized.runtime.temporaryModelId).toBe("");
    expect(normalizeSubagentConfig({ runtime: { temporaryModelId: " provider/temp " } }).runtime.temporaryModelId).toBe("provider/temp");
    expect(buildSubagentPrompt(resolveSubagent(config, "videoRecognition")!, "识别视频")).toContain("<subagent-task");
  });

  test("removes the retired search built-in from saved profiles without deleting custom agents", () => {
    const normalized = normalizeSubagentConfig({
      profiles: [
        { id: "builtin:webSearch", name: "联网搜索", instructions: "旧提示词", modelId: "provider/search", enabled: true },
        { id: "researcher", name: "研究员", instructions: "查资料", modelId: "provider/research", enabled: true },
      ],
      routing: { webSearch: "subagent:researcher" },
    });
    expect(normalized.profiles.some((profile) => profile.id === "builtin:webSearch")).toBe(false);
    expect(isBuiltinSubagentId("builtin:webSearch")).toBe(false);
    expect(normalized.profiles.some((profile) => profile.id === "researcher")).toBe(true);
    expect(normalized.profiles.filter((profile) => profile.id.startsWith("builtin:"))).toHaveLength(5);
    expect(subagentCatalog(normalized).capabilities.some((item) => item.capability === "webSearch")).toBe(false);
    expect(normalizeSubagentConfig(normalized).profiles.some((profile) => profile.id === "builtin:webSearch")).toBe(false);
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
    const input = { parentSessionId: session.id, parentRunId: parent.id, task: "检查", title: "检查", reason: "需要独立检查", expectedResult: "返回检查结论", fallbackModel: "provider/main", permissionMode: "ask" as const };
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
    const executionSessions: string[] = [];
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async (_sessionId: string, _prompt: string, opts: { runId?: string }) => {
        executionSessions.push(_sessionId);
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
    const child = await dispatch({ parentSessionId: session.id, parentRunId: parent.id, task: "首轮任务", title: "任务", reason: "需要独立执行", expectedResult: "返回任务结果", toolCallId: "call", fallbackModel: "provider/main", permissionMode: "ask" });
    const row = repo.listBySession(session.id)[0]!;
    expect(row.background).toBe(false);
    expect(repo.listMessages(row.runId).map((message) => message.role)).toEqual(["user", "assistant"]);
    await controller.control(row.runId, "retry");
    expect(repo.listMessages(row.runId).map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    await controller.control(row.runId, "follow_up", "补充检查");
    expect(repo.listMessages(row.runId).map((message) => message.role)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
    repo.appendMessage(row.runId, "system", "", undefined, { role: "system" });
    repo.appendMessage(row.runId, "user", "expanded runtime input", undefined, { role: "user" });
    expect(controller.query(row.runId)?.messages?.at(-1)?.internal).toBe(true);
    expect(child).toContain(row.runId);
    await controller.control(row.runId, "follow_up", "继续核验");
    expect(new Set(executionSessions).size).toBe(1);
    expect(repo.listBySession(session.id)).toHaveLength(1);
    expect(controller.list(session.id)).toMatchObject([{ runId: row.runId, status: "completed", title: "任务" }]);
    expect(controller.list("another-conversation")).toEqual([]);
    expect(controller.list("another-conversation", row.runId)).toEqual([]);
    expect(controller.query(row.runId)?.messages?.filter(message => message.role === "user").at(-1)?.content).toBe("继续核验");
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
    const audio = { type: "file" as const, name: "voice.mp3", mimeType: "audio/mpeg", data: "", localPath: "C:\\Media\\voice.mp3" };
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
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo: new WorkspaceRepo(db), runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(),
      assistantBuffers, streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(),
      attachmentsProvider: (sessionId, runId) => sessionId === session.id && runId === parent.id ? [audio] : [],
      publish: () => undefined, emit: () => undefined,
    });
    const input = { parentSessionId: session.id, parentRunId: parent.id, task: "转写", title: "转写", reason: "需要专用媒体模型", expectedResult: "返回转写文本", toolCallId: "call", fallbackModel: "provider/main", permissionMode: "ask" as const };
    await dispatch({ ...input, capability: "stt" });
    expect(calls).toEqual([{ model: "provider/audio", attachments: [audio] }]);
    expect(calls[0]?.attachments?.[0]).toBe(audio);
    await dispatch({ ...input, toolCallId: "call-profile", subagentId: "researcher" });
    expect(calls.at(-1)).toEqual({ model: "provider/research", attachments: [audio] });
    const firstChild = repo.listBySession(session.id)[0]!;
    await controller.control(firstChild.runId, "retry");
    expect(calls.at(-1)).toEqual({ model: "provider/audio", attachments: [audio] });
    await dispatch({ ...input, parentSessionId: firstChild.executionSessionId!, parentRunId: firstChild.runId, toolCallId: "call-nested", capability: "stt" });
    expect(calls.at(-1)).toEqual({ model: "provider/audio", attachments: [audio] });
    const downloaded = { type: "file" as const, name: "video.mp4", mimeType: "video/mp4", data: "", localPath: "C:\\temp\\video.mp4" };
    await dispatch({ ...input, parentSessionId: firstChild.executionSessionId!, parentRunId: firstChild.runId,
      toolCallId: "call-nested-video", capability: "stt", mediaAttachment: downloaded });
    expect(calls.at(-1)).toEqual({ model: "provider/audio", attachments: [audio, downloaded] });
    const mediaChild = repo.listBySession(session.id).find((row) => row.toolCallId === "call-nested-video")!;
    expect(JSON.parse(mediaChild.mediaAttachment!)).toEqual(downloaded);
    await controller.control(mediaChild.runId, "retry");
    expect(calls.at(-1)).toEqual({ model: "provider/audio", attachments: [audio, downloaded] });
    await controller.control(mediaChild.runId, "follow_up", "再检查声音");
    expect(calls.at(-1)).toEqual({ model: "provider/audio", attachments: [audio, downloaded] });
    await dispatch({ ...input, parentSessionId: mediaChild.executionSessionId!, parentRunId: mediaChild.runId,
      toolCallId: "call-inherited-media", capability: "stt" });
    expect(calls.at(-1)).toEqual({ model: "provider/audio", attachments: [audio, downloaded] });
    await expect(dispatch({ ...input, toolCallId: "call-2", capability: "imageGeneration" })).rejects.toThrow("No subagent is configured for imageGeneration");
    expect(calls).toHaveLength(8);
    const descendants = controller.list(firstChild.executionSessionId!, firstChild.runId);
    expect(descendants).toHaveLength(3);
    expect(descendants.some(child => child.runId === firstChild.runId)).toBe(false);
    expect(controller.list(mediaChild.executionSessionId!, mediaChild.runId)).toHaveLength(1);
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

test("a background child blocks finalization until its compact result is acknowledged", async () => {
  const db = openDb(":memory:");
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("dependency", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    let release!: () => void;
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async () => new Promise<void>((resolve) => { release = resolve; }),
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    await dispatch({ parentSessionId: session.id, parentRunId: parent.id, title: "检查", task: "执行检查", reason: "需要独立验证", expectedResult: "返回验证总结", toolCallId: "dependency-call", background: true, permissionMode: "full" });
    const child = repo.listBySession(session.id)[0]!;
    expect(controller.dependencyStatus(parent.id).blocking.map((item) => item.id)).toEqual([child.runId]);
    expect(controller.finalize(parent.id, [child.runId]).ok).toBe(false);
    release();
    await controller.wait(child.runId, 1000);
    expect(controller.finalize(parent.id, [child.runId]).ok).toBe(false);
    controller.acknowledge(child.runId);
    expect(controller.query(child.runId)?.dependencyState).toBe("resolved");
    expect(controller.finalize(parent.id, [child.runId])).toEqual({ ok: true, missing: [] });
    expect(runRepo.isFinalizationAuthorized(parent.id)).toBe(true);
  } finally {
    closeDb(db);
  }
});

test("registers every workflow dependency before starting the first step", async () => {
  const db = openDb(":memory:");
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("workflow-dependency", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    let releaseFirst!: () => void;
    const calls: string[] = [];
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async (_sessionId: string, prompt: string) => {
        calls.push(prompt);
        if (calls.length === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      },
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    const workflow = controller.workflow(session.id, parent.id, [
      { id: "scout", title: "侦查", task: "先检查", capability: "temporary" },
      { id: "review", title: "复核", task: "再复核", capability: "temporary", dependsOn: ["scout"] },
    ], { model: "provider/main", permissionMode: "full", background: true });

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const rows = repo.listBySession(session.id).filter((row) => row.workflowId);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.workflowStepId).sort()).toEqual(["review", "scout"]);
    expect(controller.dependencyStatus(parent.id).blocking.map((item) => item.id)).toHaveLength(2);
    expect(calls).toHaveLength(1);

    releaseFirst();
    const results = await workflow;
    expect(results.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("Dependency scout:");
  } finally {
    closeDb(db);
  }
});

test("nested dependencies belong to the nested parent and survive database reopen", async () => {
  const db = openDb(":memory:");
  let snapshot: Uint8Array;
  let sessionId: string;
  let parentId: string;
  let childId: string;
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("nested-dependency", workspace.id);
    sessionId = session.id;
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    parentId = parent.id;
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async () => undefined,
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    const outer = JSON.parse(await dispatch({ parentSessionId: session.id, parentRunId: parent.id, title: "外层", task: "外层任务", reason: "需要外层独立执行", expectedResult: "返回外层总结", toolCallId: "outer", permissionMode: "full" })) as { runId: string };
    const outerInfo = controller.query(outer.runId)!;
    const nested = JSON.parse(await dispatch({ parentSessionId: outerInfo.executionSessionId!, parentRunId: outer.runId, title: "内层", task: "内层任务", reason: "需要内层独立执行", expectedResult: "返回内层总结", toolCallId: "nested", permissionMode: "full" })) as { runId: string };
    childId = nested.runId;
    expect(controller.dependencyStatus(outer.runId).blocking).toEqual([]);
    expect(controller.finalize(outer.runId, [nested.runId])).toEqual({ ok: true, missing: [] });
    expect(controller.dependencyStatus(parent.id).blocking).toEqual([]);
    expect(controller.finalize(parent.id, [outer.runId, nested.runId])).toEqual({ ok: true, missing: [] });
    snapshot = db.$client.serialize();
  } finally {
    closeDb(db);
  }

  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot!) });
  try {
    const sessionRepo = new SessionRepo(reopened);
    const runRepo = new RunRepo(reopened);
    const repo = new SubagentRunRepo(reopened);
    const workspaceRepo = new WorkspaceRepo(reopened);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async () => undefined,
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    expect(controller.query(childId!)).toMatchObject({ id: childId, dependencyState: "resolved", completionAcknowledged: true });
    expect(controller.dependencyStatus(parentId!).authorized).toBe(true);
    expect(controller.list(sessionId!)).toHaveLength(2);
  } finally {
    closeDb(reopened);
  }
});

test("a new parent run still inherits unresolved children from a parent interrupted by restart", () => {
  const db = openDb(":memory:");
  let snapshot: Uint8Array;
  let sessionId: string;
  let childId: string;
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("restart-dependency", workspace.id);
    sessionId = session.id;
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const child = runRepo.create(session.id);
    childId = child.id;
    new SubagentRunRepo(db).create({ runId: child.id, parentSessionId: session.id, parentRunId: parent.id, toolCallId: "restart-child", title: "重启后的子代理", task: "继续任务" });
    snapshot = db.$client.serialize();
  } finally {
    closeDb(db);
  }

  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot!) });
  try {
    const workspaceRepo = new WorkspaceRepo(reopened);
    const sessionRepo = new SessionRepo(reopened);
    const runRepo = new RunRepo(reopened);
    const repo = new SubagentRunRepo(reopened);
    runRepo.markInterrupted();
    const nextParent = runRepo.create(sessionId!);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async () => undefined,
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    expect(controller.dependencyStatus(nextParent.id).blocking.map((item) => item.id)).toEqual([childId!]);
    controller.acknowledge(childId!);
    expect(controller.query(childId!)).toMatchObject({ status: "interrupted", dependencyState: "exhausted", completionAcknowledged: true });
    expect(controller.dependencyStatus(nextParent.id).authorized).toBe(false);
    expect(controller.finalize(nextParent.id, [childId!])).toEqual({ ok: true, missing: [] });
    const laterParent = runRepo.create(sessionId!);
    expect(controller.dependencyStatus(laterParent.id).requiresFinalization).toBe(false);
  } finally {
    closeDb(reopened);
  }
});

test("recoverable failures continue the original run at most twice before exhaustion", async () => {
  const db = openDb(":memory:");
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("retry", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    let attempts = 0;
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); },
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    await dispatch({ parentSessionId: session.id, parentRunId: parent.id, title: "网络检查", task: "执行网络检查", reason: "需要独立网络验证", expectedResult: "返回网络检查总结", toolCallId: "retry-call", background: true, permissionMode: "full" });
    const child = repo.listBySession(session.id)[0]!;
    await controller.wait(child.runId, 1000);
    expect(controller.query(child.runId)?.failureKind).toBe("network");
    controller.acknowledge(child.runId);
    expect(controller.query(child.runId)?.dependencyState).toBe("retry_required");
    const continued = await controller.control(child.runId, "follow_up", "请从当前进度继续，先处理上一次失败原因");
    expect(continued.id).toBe(child.runId);
    expect(continued.status).toBe("completed");
    expect(attempts).toBe(2);
    expect(controller.query(child.runId)?.dependencyState).toBe("resolved");
  } finally {
    closeDb(db);
  }
});

test("exhausted recoverable failures can finalize only with the same run's failure fact", async () => {
  const db = openDb(":memory:");
  try {
    const workspaceRepo = new WorkspaceRepo(db);
    const workspace = workspaceRepo.upsert("test", process.cwd());
    const sessionRepo = new SessionRepo(db);
    const session = sessionRepo.create("retry-exhausted", workspace.id);
    const runRepo = new RunRepo(db);
    const parent = runRepo.create(session.id);
    const repo = new SubagentRunRepo(db);
    let dispatch!: Parameters<PiAdapter["setSubagentDispatcher"]>[0];
    let attempts = 0;
    const adapter = {
      setSubagentDispatcher: (callback: typeof dispatch) => { dispatch = callback; },
      run: async () => { attempts++; throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" }); },
      stop: () => true,
      disposeSession: async () => undefined,
    } as unknown as PiAdapter;
    const controller = registerSubagentDispatcher({
      adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo: repo,
      config: () => config, partsByRun: new Map(), messageSequenceByRun: new Map(), assistantBuffers: new Map(),
      streamBuffers: new Map(), subagentStreams: new Map(), activeSubagents: new Set(), publish: () => undefined, emit: () => undefined,
    });
    await dispatch({ parentSessionId: session.id, parentRunId: parent.id, title: "重试检查", task: "执行检查", reason: "需要独立网络检查", expectedResult: "返回检查总结", toolCallId: "retry-exhausted", background: true, permissionMode: "full" });
    const child = repo.listBySession(session.id)[0]!;
    for (const message of ["第一次继续", "第二次继续"]) {
      await controller.wait(child.runId, 1000);
      controller.acknowledge(child.runId);
      expect(controller.query(child.runId)?.dependencyState).toBe("retry_required");
      await controller.control(child.runId, "follow_up", message);
    }
    await controller.wait(child.runId, 1000);
    controller.acknowledge(child.runId);
    expect(attempts).toBe(3);
    expect(controller.query(child.runId)).toMatchObject({ id: child.runId, failureKind: "network", dependencyState: "exhausted", completionAcknowledged: true });
    expect(controller.finalize(parent.id, [child.runId])).toEqual({ ok: true, missing: [] });
  } finally {
    closeDb(db);
  }
});
