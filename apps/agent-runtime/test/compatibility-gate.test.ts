import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { safeToolName } from "@qone/mcp";
import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";
import { Type } from "typebox";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAdapter } from "../src/pi-adapter.js";

describe("Pi model tool compatibility", () => {
  test("the actual adapter sends only Pi tools and legal MCP names to the model", async () => {
    const faux = fauxProvider({ provider: "qone-compat", models: [{ id: "test-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    let sentNames: string[] = [];
    faux.setResponses([(context) => {
      sentNames = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage(fauxText("ok"));
    }]);
    const adapter = new PiAdapter(() => {});
    (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-compat/test-model", provider: "qone-compat", model: "test-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-compatible", input: ["text", "image", "video", "audio"], output: ["text"] },
    }];
    const originalName = "mcp:demo:search";
    const mcpTool = defineTool({
      name: safeToolName(originalName),
      label: "Search",
      description: "MCP search",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    }) as ToolDefinition & { qoneToolName?: string };
    mcpTool.qoneToolName = originalName;
    await adapter.setCustomTools([mcpTool]);

    try {
      await adapter.run("compatibility", "ping", {
        cwd: process.cwd(), model: "qone-compat/test-model", permissionMode: "full",
      }, () => {});
      const expected = ["read", "powershell", "edit", "write", "grep", "find", "ls", "mcp_demo_search",
        "qone_video_download", "qone_media_extract_audio", "qone_media_extract_frames", "qone_video_staging_dir", "qone_video_use_file", "qone_set_activity_title", "codemode"];
      expect(adapter.getSessions()[0]?.getActiveToolNames()).toEqual(expected);
      expect(sentNames).toEqual(expected);
      expect(sentNames.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
    } finally {
      await adapter.disposeSession("compatibility");
    }
  });

  test("codemode runs nested Qone tools through the same execution and permission pipeline", async () => {
    const faux = fauxProvider({ provider: "qone-codemode", models: [{ id: "test-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "return await tools.ls({ path: \".\" });" })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const nested: { name: string; parent?: string }[] = [];
    const adapter = new PiAdapter(() => {}, {
      onTool: (_sessionId, _runId, phase, name, _args, _result, _toolCallId, parentToolCallId) => {
        if (phase === "start") nested.push({ name, parent: parentToolCallId });
      },
    });
    Object.assign(adapter, { modelRuntime: runtime });
    try {
      await adapter.run("codemode", "list files", { cwd: process.cwd(), model: "qone-codemode/test-model", permissionMode: "full" }, () => {});
      const ls = nested.find((call) => call.name === "ls");
      expect(ls?.parent).toBeTruthy();
      expect(nested.some((call) => call.name === "codemode")).toBe(true);
    } finally {
      await adapter.disposeSession("codemode");
    }
  });

  test("codemode store state survives rebuilding a Qone session", async () => {
    const first = fauxProvider({ provider: "qone-codemode-store", models: [{ id: "test-model" }] });
    first.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "store(\"cursor\", \"abc\"); return \"saved\";" })),
      fauxAssistantMessage(fauxText("saved")),
    ]);
    const second = fauxProvider({ provider: "qone-codemode-store-reload", models: [{ id: "test-model" }] });
    let restoredRequest = "";
    second.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: "return load(\"cursor\");" })),
      (context) => {
        restoredRequest = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxText("loaded"));
      },
    ]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(first.provider);
    runtime.registerNativeProvider(second.provider);
    let storedEntry: unknown;
    const firstAdapter = new PiAdapter(() => {}, { onCustomEntry: (_sessionId, entry) => { storedEntry = entry; } });
    Object.assign(firstAdapter, { modelRuntime: runtime });
    try {
      await firstAdapter.run("codemode-store", "save state", { cwd: process.cwd(), model: "qone-codemode-store/test-model", permissionMode: "full" }, () => {});
    } finally {
      await firstAdapter.disposeSession("codemode-store");
    }
    expect(storedEntry).toMatchObject({ type: "custom", customType: "codemode-store" });

    const secondAdapter = new PiAdapter(() => {}, {}, undefined, () => [{
      id: "stored-entry", role: "custom", content: "", createdAt: 1, rawMessage: storedEntry,
    }]);
    Object.assign(secondAdapter, { modelRuntime: runtime });
    try {
      await secondAdapter.run("codemode-store-reload", "load state", { cwd: process.cwd(), model: "qone-codemode-store-reload/test-model", permissionMode: "full" }, () => {});
      expect(restoredRequest).toContain("abc");
    } finally {
      await secondAdapter.disposeSession("codemode-store-reload");
    }
  });

  test("rejects malformed custom names before making a model request", async () => {
    const adapter = new PiAdapter(() => {});
    const invalidTool = defineTool({
      name: "invalid.name",
      label: "Invalid",
      description: "Invalid model name",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    });
    await adapter.setCustomTools([invalidTool]);
    await expect(adapter.run("invalid", "ping", { cwd: process.cwd() }, () => {}))
      .rejects.toThrow("Invalid model tool name: invalid.name");
  });

  test("video input without an API picture path exposes subagent descriptions without sending video bytes", async () => {
    const faux = fauxProvider({ provider: "qone-routing", models: [{ id: "text-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    let prompt = "";
    faux.setResponses([(context) => {
      prompt = JSON.stringify(context.messages.find((message) => message.role === "user"));
      return fauxAssistantMessage(fauxText("我会按描述选择子代理"));
    }]);
    const adapter = new PiAdapter(() => {});
    (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-routing/text-model", provider: "qone-routing", model: "text-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-compatible", input: ["text"], output: ["text"], metadataOverrides: { input: true } },
    } as ModelConfigInfo];
    adapter.setSubagentDispatcher(async () => "unused");
    adapter.setSubagentController({ catalog: () => ({ capabilities: [], unconfiguredCapabilities: [],
      profiles: [{ id: "vision", name: "视频代理", instructions: "识别用户视频画面" }] }) } as never);
    const video: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: "C:\\media\\clip.mp4" };
    try {
      await adapter.run("routing", "分析这个视频", { cwd: process.cwd(), model: "qone-routing/text-model", permissionMode: "full", attachments: [video] }, () => {});
      expect(prompt).toContain("media-routing-candidates");
      expect(prompt).toContain("识别用户视频画面");
      expect(prompt).toContain("委派原始附件");
      expect(prompt).not.toContain("QONE_MEDIA");
    } finally {
      await adapter.disposeSession("routing");
    }
  });

  test("routes an unsupported native video to the configured video subagent before the main model", async () => {
    const faux = fauxProvider({ provider: "qone-auto-video-routing", models: [{ id: "text-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    let prompt = "";
    faux.setResponses([(context) => {
      prompt = JSON.stringify(context.messages.find((message) => message.role === "user"));
      return fauxAssistantMessage(fauxText("根据视频代理结果回答"));
    }]);
    const adapter = new PiAdapter(() => {});
    Object.assign(adapter, { modelRuntime: runtime });
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-auto-video-routing/text-model", provider: "qone-auto-video-routing", model: "text-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-compatible", input: ["text", "image"], output: ["text"] },
    }];
    let delegated: any;
    adapter.setSubagentDispatcher(async input => {
      delegated = input;
      return JSON.stringify({ runId: "video-child", status: "completed", result: "视频中出现了一个人在演示产品。" });
    });
    adapter.setSubagentController({ catalog: () => ({
      temporary: { id: "temporary", name: "临时", description: "", selection: { capability: "temporary" }, model: "follow-parent-model" },
      capabilities: [{ capability: "videoRecognition", selection: { capability: "videoRecognition" }, name: "视频识别", description: "读取完整视频并返回识别结果", model: "follow-parent-model", route: "subagent:builtin:videoRecognition" }],
      unconfiguredCapabilities: [], profiles: [],
    }) } as never);
    const video: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: "C:\\media\\clip.mp4" };
    try {
      await adapter.run("auto-video-routing", "分析这个视频", {
        cwd: process.cwd(), model: "qone-auto-video-routing/text-model", permissionMode: "full", attachments: [video],
      }, () => {});
      expect(delegated).toMatchObject({ capability: "videoRecognition", background: false, mediaAttachment: video });
      expect(prompt).toContain("视频中出现了一个人在演示产品");
      expect(prompt).not.toContain("QONE_MEDIA");
    } finally {
      await adapter.disposeSession("auto-video-routing");
    }
  });

  test("Pi receives native video priority from the configured capability result", async () => {
    const faux = fauxProvider({ provider: "qone-native-priority", models: [{ id: "video-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    let prompt = "";
    faux.setResponses([(context) => {
      prompt = JSON.stringify(context.messages.find((message) => message.role === "user"));
      return fauxAssistantMessage(fauxText("已收到视频能力"));
    }]);
    const adapter = new PiAdapter(() => {});
    Object.assign(adapter, { modelRuntime: runtime });
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-native-priority/video-model", provider: "qone-native-priority", model: "video-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-responses", input: ["text", "image", "video"], output: ["text"] },
    } as ModelConfigInfo];
    try {
      await adapter.run("native-priority", "分析视频", { cwd: process.cwd(), model: "qone-native-priority/video-model", permissionMode: "full" }, () => {});
      expect(prompt).toContain('video-native=\\"true\\"');
      expect(prompt).toContain('video-frames=\\"true\\"');
      expect(prompt).toContain('video-preferred=\\"native\\"');
      const session = (adapter as unknown as { sessions: Map<string, { getCallableToolNames: () => string[] }> }).sessions.get("native-priority");
      expect(session?.getCallableToolNames()).toContain("qone_video_download");
    } finally {
      await adapter.disposeSession("native-priority");
    }
  });

  test("a native video attachment does not trigger extraction or shell tools by itself", async () => {
    const directory = await mkdtemp(join(tmpdir(), "qone-native-attachment-"));
    const videoPath = join(directory, "clip.mp4");
    await writeFile(videoPath, new Uint8Array([0, 1, 2]));
    const faux = fauxProvider({ provider: "qone-native-attachment", models: [{ id: "video-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const toolCalls: string[] = [];
    let sentUserMessage = "";
    faux.setResponses([(context) => {
      const user = context.messages.find((message) => message.role === "user");
      sentUserMessage = JSON.stringify(user);
      return fauxAssistantMessage(fauxText("已收到完整视频输入"));
    }]);
    const adapter = new PiAdapter(() => {}, {
      onTool: (_sessionId, _runId, phase, name) => { if (phase === "start") toolCalls.push(name); },
    });
    Object.assign(adapter, { modelRuntime: runtime });
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-native-attachment/video-model", provider: "qone-native-attachment", model: "video-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-responses", input: ["text", "video"], output: ["text"] },
    } as ModelConfigInfo];
    const attachment: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: videoPath };
    try {
      await adapter.run("native-attachment", "分析这个视频", {
        cwd: process.cwd(), model: "qone-native-attachment/video-model", permissionMode: "full", attachments: [attachment],
      }, () => {});
      expect(sentUserMessage).toContain("QONE_MEDIA");
      expect(toolCalls).toEqual([]);
    } finally {
      await adapter.disposeSession("native-attachment");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
