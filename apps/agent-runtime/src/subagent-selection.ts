import { Type } from "typebox";
import { CAPABILITY_IDS, type CapabilityId, type SubagentConfigInfo } from "@qone/protocol";
import { resolveSubagent, type ResolvedSubagent } from "./subagents.js";

/** A dispatch target, not a new media capability or a persisted profile. */
export type SubagentTarget = "temporary" | CapabilityId;
export interface SubagentSelection {
  capability?: SubagentTarget | null;
  subagentId?: string | null;
}
export interface SubagentWorkflowStep extends SubagentSelection {
  id: string;
  title: string;
  task: string;
  dependsOn?: string[];
}

export const subagentTargetSchema = Type.Optional(Type.Union([
  Type.Literal("temporary"),
  ...CAPABILITY_IDS.map((id) => Type.Literal(id)),
  Type.Null(),
], {
  description: 'Choose "temporary" for ordinary code review, file analysis or research. Choose a media capability only for that media task. Omitted/null keeps legacy default routing or selects the saved subagentId.',
}));
export const subagentProfileSchema = Type.Optional(Type.Union([
  Type.String({ maxLength: 128 }), Type.Null(),
], {
  description: 'Saved profile ID from list_subagents. Leave omitted/null/empty when capability is "temporary" or a media capability.',
}));

/** Resolve selection before creating a run. Never guess task intent or silently override a conflicting target. */
export function resolveSubagentSelection(config: SubagentConfigInfo, selection: SubagentSelection): ResolvedSubagent | undefined {
  const target = selection.capability;
  const profileId = selection.subagentId?.trim();
  if (target != null && target !== "temporary" && !CAPABILITY_IDS.includes(target)) {
    throw new Error(`Unknown subagent target: ${target}`);
  }
  if (profileId && target != null) {
    throw new Error('Choose exactly one subagent target: capability="temporary", a media capability, or subagentId (with capability omitted/null).');
  }
  if (profileId) {
    const profile = config.profiles.find(item => item.id === profileId && item.enabled);
    if (!profile) throw new Error(`Subagent profile unavailable: ${profileId}`);
    return { ...profile, modelId: profile.modelId || undefined };
  }
  if (target == null || target === "temporary") return undefined;
  const agent = resolveSubagent(config, target);
  if (!agent) {
    throw new Error(`No subagent is configured for ${target}. Tell the user this task cannot be done until one is configured in Settings.`);
  }
  return agent;
}
