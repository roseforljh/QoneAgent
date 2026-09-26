import { describe, expect, test } from "bun:test";
import { decodeCommand, type SubagentConfigInfo } from "@qone/protocol";
import { buildSubagentPrompt, inferCapability, normalizeSubagentConfig, resolveSubagent } from "../src/subagents";

const config: SubagentConfigInfo = {
  profiles: [{ id: "researcher", name: "研究员", instructions: "只输出有来源的结论。", modelId: "provider/research", enabled: true, updatedAt: 1 }],
  routing: { webSearch: "subagent:researcher", stt: "model:provider/audio", videoRecognition: "mcp:search" },
  updatedAt: 1,
};

describe("capability subagent routing", () => {
  test("infers media and search capabilities from attachments and intent", () => {
    expect(inferCapability("请分析", [{ type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "data:video/mp4;base64,AA==" }])).toBe("videoRecognition");
    expect(inferCapability("请转成文字", [{ type: "file", name: "voice.mp3", mimeType: "audio/mpeg", data: "data:audio/mpeg;base64,AA==" }])).toBe("stt");
    expect(inferCapability("帮我搜索今天的新闻")).toBe("webSearch");
    expect(inferCapability("把这段文字朗读出来")).toBe("tts");
  });

  test("prefers enabled profile and otherwise uses capability model route", () => {
    expect(resolveSubagent(config, "webSearch", "provider/main").modelId).toBe("provider/research");
    expect(resolveSubagent(config, "stt", "provider/main").modelId).toBe("provider/audio");
    expect(resolveSubagent(config, "videoRecognition", "provider/main").mcpServerId).toBe("search");
  });

  test("normalizes malformed persisted values and keeps instructions in prompt", () => {
    const normalized = normalizeSubagentConfig({ profiles: [{ id: "x", name: " X ", instructions: " do ", modelId: "p/m", enabled: false }] });
    expect(normalized.profiles[0]).toMatchObject({ name: "X", instructions: "do", enabled: false });
    expect(buildSubagentPrompt(resolveSubagent(config, "webSearch", "provider/main"), "查资料")).toContain("<subagent-task");
  });

  test("accepts capability dispatch and atomic settings synchronization over the protocol", () => {
    const run = decodeCommand(JSON.stringify({ type: "agent.run", requestId: "r1", sessionId: "s1", message: "分析", capability: "videoRecognition", subagentId: "researcher" }));
    expect(run?.type).toBe("agent.run");
    expect(run && run.type === "agent.run" ? run.capability : undefined).toBe("videoRecognition");
    const sync = decodeCommand(JSON.stringify({ type: "subagent.sync", requestId: "r2", config }));
    expect(sync?.type).toBe("subagent.sync");
  });
});
