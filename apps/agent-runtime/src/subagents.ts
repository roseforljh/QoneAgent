import { builtinSubagentId, builtinSubagentLogo, CAPABILITY_IDS, DEFAULT_SUBAGENT_RUNTIME, isBuiltinSubagentId, SUBAGENT_LOGO_IDS, type CapabilityId, type CapabilityRouting, type SubagentConfigInfo, type SubagentProfileInfo, type SubagentRuntimeConfig, type RunPermissionMode } from "@qone/protocol";

export interface ResolvedSubagent {
  id: string;
  name: string;
  instructions: string;
  modelId?: string;
  route?: string;
  mcpServerId?: string;
  tools?: string[];
  permissionMode?: RunPermissionMode;
}

const capabilityInstructions: Record<CapabilityId, string> = {
  webSearch: "你负责联网搜索。先使用可用的搜索工具或已配置的搜索 MCP 获取最新资料，再基于检索结果回答。不要凭记忆冒充实时信息；明确区分事实、推断和未找到的内容。",
  videoRecognition: "你负责视频内容识别。读取用户提供的视频或相关文件，提取时间线、画面、字幕和声音中的关键信息，按用户要求给出结构化结论。无法读取的媒体必须明确说明。",
  imageGeneration: "你负责图像生成。理解用户要生成的画面内容、风格和用途，并调用可用的图像生成能力完成；如果当前模型不能产出图像，要清楚说明限制。",
  stt: "你负责语音转文字。识别用户提供的音频内容，尽量保留说话人、时间顺序和原话；听不清的部分用标记说明，不要臆造。",
  tts: "你负责文字转语音。理解用户要朗读或生成语音的文本和风格要求，并调用可用的语音能力完成；如果当前模型不能产出音频，要清楚说明限制。",
};

const capabilityNames: Record<CapabilityId, string> = {
  webSearch: "联网搜索",
  videoRecognition: "视频识别",
  imageGeneration: "图像生成",
  stt: "语音转文字",
  tts: "文字转语音",
};

function routeTarget(routing: CapabilityRouting, capability: CapabilityId): string | undefined {
  const value = routing[capability]?.trim();
  return value && value !== "auto" ? value : undefined;
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
      logo: typeof profile.logo === "string" ? profile.logo.trim().slice(0, 64) || undefined : undefined,
      tools: Array.isArray(profile.tools) ? profile.tools.filter((tool): tool is string => typeof tool === "string").slice(0, 100) : undefined,
      permissionMode: profile.permissionMode === "auto" || profile.permissionMode === "full" ? profile.permissionMode : "ask",
      enabled: profile.enabled !== false, updatedAt: typeof profile.updatedAt === "number" ? profile.updatedAt : Date.now(),
    } satisfies SubagentProfileInfo];
  }) : [];
  const routing: CapabilityRouting = {};
  if (record.routing && typeof record.routing === "object") {
    for (const capability of CAPABILITY_IDS) {
      const target = (record.routing as Record<string, unknown>)[capability];
      if (typeof target === "string" && target.length <= 512) routing[capability] = target;
    }
  }
  const runtimeRecord = record.runtime && typeof record.runtime === "object" ? record.runtime as Record<string, unknown> : {};
  const runtime: SubagentRuntimeConfig = {
    temporaryModelId: typeof runtimeRecord.temporaryModelId === "string" ? runtimeRecord.temporaryModelId.trim().slice(0, 512) : DEFAULT_SUBAGENT_RUNTIME.temporaryModelId,
    maxConcurrent: clampInteger(runtimeRecord.maxConcurrent, DEFAULT_SUBAGENT_RUNTIME.maxConcurrent, 1, 32),
    timeoutMs: clampInteger(runtimeRecord.timeoutMs, DEFAULT_SUBAGENT_RUNTIME.timeoutMs, 10_000, 86_400_000),
    tokenBudget: clampInteger(runtimeRecord.tokenBudget, DEFAULT_SUBAGENT_RUNTIME.tokenBudget, 0, 10_000_000),
    contextMode: runtimeRecord.contextMode === "task-only" ? "task-only" : "snapshot",
    contextMessages: clampInteger(runtimeRecord.contextMessages, DEFAULT_SUBAGENT_RUNTIME.contextMessages, 0, 100),
    allowNested: runtimeRecord.allowNested !== false,
    maxDepth: clampInteger(runtimeRecord.maxDepth, DEFAULT_SUBAGENT_RUNTIME.maxDepth, 1, 8),
    workflowMaxSteps: clampInteger(runtimeRecord.workflowMaxSteps, DEFAULT_SUBAGENT_RUNTIME.workflowMaxSteps, 1, 128),
    backgroundEnabled: runtimeRecord.backgroundEnabled !== false,
  };
  const builtins = CAPABILITY_IDS.map((capability) => {
    const id = builtinSubagentId(capability);
    const current = profiles.find((profile) => profile.id === id);
    if (current) return { ...current, logo: builtinSubagentLogo(capability) };
    const legacyRoute = routeTarget(routing, capability);
    const legacyProfile = legacyRoute?.startsWith("subagent:")
      ? profiles.find((profile) => profile.id === legacyRoute.slice("subagent:".length))
      : undefined;
    const routeInstructions = legacyRoute?.startsWith("mcp:")
      ? "\n\n本次任务优先使用 MCP " + legacyRoute.slice("mcp:".length) + " 提供的工具。"
      : "";
    return {
      id,
      name: legacyProfile?.name ?? capabilityNames[capability],
      instructions: legacyProfile?.instructions ?? capabilityInstructions[capability] + routeInstructions,
      modelId: legacyProfile?.modelId ?? (legacyRoute?.startsWith("model:") ? legacyRoute.slice("model:".length) : ""),
      logo: builtinSubagentLogo(capability),
      tools: legacyProfile?.tools,
      permissionMode: legacyProfile?.permissionMode ?? "ask",
      enabled: true,
      updatedAt: Date.now(),
    } satisfies SubagentProfileInfo;
  });
  const usedLogos = new Set<string>();
  const builtinLogos = new Set(CAPABILITY_IDS.map((capability) => builtinSubagentLogo(capability)));
  const seenProfileIds = new Set<string>();
  const orderedProfiles = profiles.flatMap((profile) => {
    if (seenProfileIds.has(profile.id)) return [];
    seenProfileIds.add(profile.id);
    return [isBuiltinSubagentId(profile.id)
      ? builtins.find((builtin) => builtin.id === profile.id)!
      : profile];
  });
  const normalizedProfiles = [...orderedProfiles, ...builtins.filter((builtin) => !seenProfileIds.has(builtin.id))].map((profile, index) => {
    const builtin = isBuiltinSubagentId(profile.id);
    const requested = profile.logo && SUBAGENT_LOGO_IDS.includes(profile.logo as typeof SUBAGENT_LOGO_IDS[number])
      && (builtin || !builtinLogos.has(profile.logo as typeof SUBAGENT_LOGO_IDS[number])) ? profile.logo : undefined;
    let logo = requested && !usedLogos.has(requested) ? requested : undefined;
    if (!logo) {
      const seed = [...profile.id].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, index);
      for (let offset = 0; offset < SUBAGENT_LOGO_IDS.length; offset += 1) {
        const candidate = SUBAGENT_LOGO_IDS[(seed + offset) % SUBAGENT_LOGO_IDS.length];
        if (!usedLogos.has(candidate) && (builtin || !builtinLogos.has(candidate))) { logo = candidate; break; }
      }
    }
    usedLogos.add(logo ?? "unknown");
    return { ...profile, logo };
  });
  return { profiles: normalizedProfiles, routing: {}, runtime, updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : Date.now() };
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.trunc(value)))
    : fallback;
}

/** The subagent the user configured for a capability, or undefined when nothing is configured. */
export function resolveSubagent(config: SubagentConfigInfo, capability: CapabilityId): ResolvedSubagent | undefined {
  const builtin = config.profiles.find((item) => item.id === builtinSubagentId(capability) && item.enabled);
  if (builtin) return { id: builtin.id, name: builtin.name, instructions: builtin.instructions, modelId: builtin.modelId || undefined, tools: builtin.tools, permissionMode: builtin.permissionMode, route: "subagent:" + builtin.id };
  const route = routeTarget(config.routing, capability);
  if (!route) return undefined;
  if (route.startsWith("subagent:")) {
    const profile = config.profiles.find((item) => item.id === route.slice("subagent:".length) && item.enabled);
    return profile && { id: profile.id, name: profile.name, instructions: profile.instructions, modelId: profile.modelId, tools: profile.tools, permissionMode: profile.permissionMode, route };
  }
  const mcpServerId = route.startsWith("mcp:") ? route.slice("mcp:".length) : undefined;
  return {
    id: `capability:${capability}`,
    name: `${capability} capability agent`,
    instructions: [capabilityInstructions[capability], mcpServerId ? `本次联网搜索指定使用 MCP ${mcpServerId}；优先使用该 MCP 提供的工具。` : ""].filter(Boolean).join("\n\n"),
    modelId: route.startsWith("model:") ? route.slice("model:".length) : undefined,
    route,
    mcpServerId,
  };
}

/** What the main model can delegate to right now; read at call time so settings changes apply without a new session. */
export function subagentCatalog(config: SubagentConfigInfo) {
  return {
    capabilities: CAPABILITY_IDS.flatMap((capability) => {
      const agent = resolveSubagent(config, capability);
      return agent ? [{ capability, model: agent.modelId, route: agent.route }] : [];
    }),
    unconfiguredCapabilities: CAPABILITY_IDS.filter((capability) => !resolveSubagent(config, capability)),
    profiles: config.profiles.filter((profile) => profile.enabled).map((profile) => ({ id: profile.id, name: profile.name, instructions: profile.instructions.slice(0, 500) })),
  };
}

export function buildSubagentPrompt(subagent: ResolvedSubagent, message: string, context = ""): string {
  const inherited = context.trim() ? `\n<parent-context>\n${context.trim()}\n</parent-context>\n` : "";
  return `<subagent-task name="${subagent.name.replace(/[<>\"]+/g, "")}">\n${subagent.instructions}\n</subagent-task>${inherited}\n${message.trim()}`;
}
