import type { CapabilityId, CapabilityRouting, MessageAttachmentInfo, SubagentConfigInfo, SubagentProfileInfo } from "@qone/protocol";

export interface ResolvedSubagent {
  id: string;
  name: string;
  instructions: string;
  modelId?: string;
  route?: string;
  mcpServerId?: string;
}

const capabilityInstructions: Record<CapabilityId, string> = {
  webSearch: "你负责联网搜索。先使用可用的搜索工具或已配置的搜索 MCP 获取最新资料，再基于检索结果回答。不要凭记忆冒充实时信息；明确区分事实、推断和未找到的内容。",
  videoRecognition: "你负责视频内容识别。读取用户提供的视频或相关文件，提取时间线、画面、字幕和声音中的关键信息，按用户要求给出结构化结论。无法读取的媒体必须明确说明。",
  stt: "你负责语音转文字。识别用户提供的音频内容，尽量保留说话人、时间顺序和原话；听不清的部分用标记说明，不要臆造。",
  tts: "你负责文字转语音。理解用户要朗读或生成语音的文本和风格要求，并调用可用的语音能力完成；如果当前模型不能产出音频，要清楚说明限制。",
};

const capabilityTerms: Record<CapabilityId, RegExp> = {
  videoRecognition: /视频|录像|录屏|mp4|mov|avi|mkv|video|识别画面|分析视频/i,
  stt: /语音转文字|音频转文字|录音转写|听写|转录|transcrib|speech[- ]to[- ]text|stt|音频|录音|语音/i,
  tts: /文字转语音|朗读|读出来|生成语音|配音|播报|text[- ]to[- ]speech|tts|voice/i,
  webSearch: /联网搜索|网上搜|网页搜索|查一下最新|搜一下|搜索|最新消息|实时信息|web search|search the web|browse the web/i,
};

function routeTarget(routing: CapabilityRouting, capability: CapabilityId): string | undefined {
  const value = routing[capability]?.trim();
  return value && value !== "auto" ? value : undefined;
}

export function inferCapability(message: string, attachments: readonly MessageAttachmentInfo[] = []): CapabilityId | undefined {
  if (attachments.some((item) => item.mimeType.toLowerCase().startsWith("video/"))) return "videoRecognition";
  if (attachments.some((item) => item.mimeType.toLowerCase().startsWith("audio/"))) return "stt";
  const value = message.trim();
  if (!value) return undefined;
  // TTS has to win over the generic audio terms in the STT matcher.
  if (capabilityTerms.tts.test(value)) return "tts";
  if (capabilityTerms.videoRecognition.test(value)) return "videoRecognition";
  if (capabilityTerms.stt.test(value)) return "stt";
  if (capabilityTerms.webSearch.test(value)) return "webSearch";
  return undefined;
}

export function normalizeSubagentConfig(value: unknown): SubagentConfigInfo {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const profiles = Array.isArray(record.profiles) ? record.profiles.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const profile = item as Record<string, unknown>;
    if (typeof profile.id !== "string" || typeof profile.name !== "string" || typeof profile.instructions !== "string" || typeof profile.modelId !== "string") return [];
    return [{
      id: profile.id.slice(0, 128), name: profile.name.trim().slice(0, 120),
      instructions: profile.instructions.trim().slice(0, 32_000), modelId: profile.modelId,
      enabled: profile.enabled !== false, updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : Date.now(),
    } satisfies SubagentProfileInfo];
  }) : [];
  const routing: CapabilityRouting = {};
  if (record.routing && typeof record.routing === "object") {
    for (const capability of ["webSearch", "videoRecognition", "stt", "tts"] as const) {
      const target = (record.routing as Record<string, unknown>)[capability];
      if (typeof target === "string" && target.length <= 512) routing[capability] = target;
    }
  }
  return { profiles, routing, updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now() };
}

export function resolveSubagent(
  config: SubagentConfigInfo,
  capability: CapabilityId,
  fallbackModel: string | undefined,
  requestedId?: string,
): ResolvedSubagent {
  const requested = requestedId ? config.profiles.find((profile) => profile.id === requestedId && profile.enabled) : undefined;
  if (requested) return { id: requested.id, name: requested.name, instructions: requested.instructions, modelId: requested.modelId, route: `subagent:${requested.id}` };

  const route = routeTarget(config.routing, capability);
  if (route?.startsWith("subagent:")) {
    const profile = config.profiles.find((item) => item.id === route.slice("subagent:".length) && item.enabled);
    if (profile) return { id: profile.id, name: profile.name, instructions: profile.instructions, modelId: profile.modelId, route };
  }

  const modelId = route?.startsWith("model:") ? route.slice("model:".length) : fallbackModel;
  const mcpHint = route?.startsWith("mcp:") ? `本次联网搜索指定使用 MCP ${route.slice("mcp:".length)}；优先使用该 MCP 提供的工具。` : "";
  return {
    id: `capability:${capability}`,
    name: `${capability} capability agent`,
    instructions: [capabilityInstructions[capability], mcpHint].filter(Boolean).join("\n\n"),
    modelId: modelId || undefined,
    route,
    mcpServerId: route?.startsWith("mcp:") ? route.slice("mcp:".length) : undefined,
  };
}

export function buildSubagentPrompt(subagent: ResolvedSubagent, message: string): string {
  return `<subagent-task name="${subagent.name.replace(/[<>\"]+/g, "")}">\n${subagent.instructions}\n</subagent-task>\n\n${message.trim()}`;
}
