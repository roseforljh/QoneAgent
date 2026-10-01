import { runtimeText } from "./runtime-localization";
import { isRuntimeMessageKey, builtinSubagentId, builtinSubagentLogo, CAPABILITY_IDS, DEFAULT_SUBAGENT_RUNTIME, isBuiltinSubagentId, REMOVED_BUILTIN_SUBAGENT_IDS, SUBAGENT_LOGO_IDS, type CapabilityId, type CapabilityRouting, type SubagentConfigInfo, type SubagentProfileInfo, type SubagentRuntimeConfig, type RunPermissionMode } from "@qone/protocol";

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

function routeTarget(routing: CapabilityRouting, capability: CapabilityId): string | undefined {
  const value = routing[capability]?.trim();
  return value && value !== "auto" ? value : undefined;
}

export function normalizeSubagentConfig(value: unknown): SubagentConfigInfo {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const profiles = Array.isArray(record.profiles) ? record.profiles.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const profile = item as Record<string, unknown>;
    if (typeof profile.id !== "string" || REMOVED_BUILTIN_SUBAGENT_IDS.includes(profile.id) || typeof profile.name !== "string" || typeof profile.instructions !== "string" || typeof profile.modelId !== "string") return [];
    return [{
      id: profile.id.slice(0, 128), name: profile.name.trim().slice(0, 120),
      instructions: profile.instructions.trim().slice(0, 32_000), modelId: profile.modelId,
      nameKey: isRuntimeMessageKey(profile.nameKey) ? profile.nameKey : undefined,
      instructionsKey: isRuntimeMessageKey(profile.instructionsKey) ? profile.instructionsKey : undefined,
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
      ? "\n\n" + runtimeText("subagent.mcpPriority", { p0: legacyRoute.slice("mcp:".length) })
      : "";
    return {
      id,
      name: legacyProfile?.name ?? runtimeText(`subagent.name.${capability}`),
      nameKey: legacyProfile ? legacyProfile.nameKey : `subagent.name.${capability}`,
      instructions: legacyProfile?.instructions ?? runtimeText(`subagent.instructions.${capability}`) + routeInstructions,
      instructionsKey: legacyProfile ? legacyProfile.instructionsKey : routeInstructions ? undefined : `subagent.instructions.${capability}`,
      modelId: legacyProfile?.modelId ?? (legacyRoute?.startsWith("model:") ? legacyRoute.slice("model:".length) : ""),
      logo: builtinSubagentLogo(capability),
      tools: legacyProfile?.tools,
      permissionMode: legacyProfile?.permissionMode ?? "ask",
      enabled: Boolean(legacyRoute),
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
  if (builtin) return { id: builtin.id, name: builtin.nameKey ? runtimeText(builtin.nameKey) : builtin.name, instructions: builtin.instructionsKey ? runtimeText(builtin.instructionsKey) : builtin.instructions, modelId: builtin.modelId || undefined, tools: builtin.tools, permissionMode: builtin.permissionMode, route: "subagent:" + builtin.id };
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
    instructions: [runtimeText(`subagent.instructions.${capability}`), mcpServerId ? runtimeText("subagent.mcpPriority", { p0: mcpServerId }) : ""].filter(Boolean).join("\n\n"),
    modelId: route.startsWith("model:") ? route.slice("model:".length) : undefined,
    route,
    mcpServerId,
  };
}

/** What the main model can delegate to right now; read at call time so settings changes apply without a new session. */
export function subagentCatalog(config: SubagentConfigInfo) {
  return {
    temporary: {
      id: "temporary",
      name: runtimeText("subagent.temporaryName"),
      description: runtimeText("subagent.temporaryDescription"),
      selection: { capability: "temporary" as const },
      model: config.runtime.temporaryModelId || "follow-parent-model",
    },
    capabilities: CAPABILITY_IDS.flatMap((capability) => {
      const agent = resolveSubagent(config, capability);
      return agent ? [{ capability, selection: { capability }, name: agent.name, description: agent.instructions, model: agent.modelId, route: agent.route }] : [];
    }),
    unconfiguredCapabilities: CAPABILITY_IDS.filter((capability) => !resolveSubagent(config, capability)),
    profiles: config.profiles.filter((profile) => profile.enabled).map((profile) => ({ id: profile.id, selection: { subagentId: profile.id, capability: null }, name: profile.nameKey ? runtimeText(profile.nameKey) : profile.name, instructions: (profile.instructionsKey ? runtimeText(profile.instructionsKey) : profile.instructions).slice(0, 500) })),
  };
}

export function buildSubagentPrompt(subagent: ResolvedSubagent, message: string, context = ""): string {
  const inherited = context.trim() ? `\n<parent-context>\n${context.trim()}\n</parent-context>\n` : "";
  return `<subagent-task name="${subagent.name.replace(/[<>\"]+/g, "")}">\n${subagent.instructions}\n</subagent-task>${inherited}\n${message.trim()}`;
}
