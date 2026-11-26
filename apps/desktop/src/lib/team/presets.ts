import type { SubagentLogoId } from "@qone/protocol";
import type { TeamAvatarId } from "./avatar";
import type { TeamBot, TeamGroupTemplate } from "./types";

/** 预设机器人配置项，文案通过国际化键值解析以保持通用性。 */
export interface TeamBotPreset {
  presetKey: string;
  nameKey: string;
  roleKey: string;
  descriptionKey: string;
  promptKey: string;
  logo: SubagentLogoId;
  avatar: TeamAvatarId;
  capabilities: string[];
}

/** 可选能力标签清单（用户也可以自由输入任意自定义标签）。 */
export const TEAM_CAPABILITY_KEYS = [
  "planning",
  "coding",
  "review",
  "ops",
  "research",
  "testing",
  "writing",
  "design",
] as const;

/** 默认预置的核心角色，覆盖统筹、工程、运维、审查、调研与设计。 */
export const DEFAULT_TEAM_BOT_PRESETS: readonly TeamBotPreset[] = [
  {
    presetKey: "coordinator",
    nameKey: "team.preset.coordinator.name",
    roleKey: "team.preset.coordinator.role",
    descriptionKey: "team.preset.coordinator.desc",
    promptKey: "team.preset.coordinator.prompt",
    logo: "crown",
    avatar: "orbit",
    capabilities: ["planning", "review"],
  },
  {
    presetKey: "engineer",
    nameKey: "team.preset.engineer.name",
    roleKey: "team.preset.engineer.role",
    descriptionKey: "team.preset.engineer.desc",
    promptKey: "team.preset.engineer.prompt",
    logo: "code",
    avatar: "prism",
    capabilities: ["coding", "testing"],
  },
  {
    presetKey: "devops",
    nameKey: "team.preset.devops.name",
    roleKey: "team.preset.devops.role",
    descriptionKey: "team.preset.devops.desc",
    promptKey: "team.preset.devops.prompt",
    logo: "terminal",
    avatar: "jade",
    capabilities: ["ops", "coding"],
  },
  {
    presetKey: "reviewer",
    nameKey: "team.preset.reviewer.name",
    roleKey: "team.preset.reviewer.role",
    descriptionKey: "team.preset.reviewer.desc",
    promptKey: "team.preset.reviewer.prompt",
    logo: "shield",
    avatar: "ember",
    capabilities: ["review", "testing"],
  },
  {
    presetKey: "researcher",
    nameKey: "team.preset.researcher.name",
    roleKey: "team.preset.researcher.role",
    descriptionKey: "team.preset.researcher.desc",
    promptKey: "team.preset.researcher.prompt",
    logo: "search",
    avatar: "ink",
    capabilities: ["research", "writing"],
  },
  {
    presetKey: "designer",
    nameKey: "team.preset.designer.name",
    roleKey: "team.preset.designer.role",
    descriptionKey: "team.preset.designer.desc",
    promptKey: "team.preset.designer.prompt",
    logo: "palette",
    avatar: "petal",
    capabilities: ["design", "planning"],
  },
] as const;

/** 建群向导可用的群聊组合模板。 */
export const DEFAULT_TEAM_GROUP_TEMPLATES: readonly TeamGroupTemplate[] = [
  {
    id: "fullstack-squad",
    nameKey: "team.template.fullstack.name",
    descriptionKey: "team.template.fullstack.desc",
    botPresetKeys: ["coordinator", "engineer", "reviewer"],
    coordinatorPresetKey: "coordinator",
    defaultStrategy: "smart",
  },
  {
    id: "server-ops-squad",
    nameKey: "team.template.ops.name",
    descriptionKey: "team.template.ops.desc",
    botPresetKeys: ["coordinator", "devops", "reviewer"],
    coordinatorPresetKey: "coordinator",
    defaultStrategy: "smart",
  },
  {
    id: "product-studio",
    nameKey: "team.template.product.name",
    descriptionKey: "team.template.product.desc",
    botPresetKeys: ["coordinator", "designer", "engineer", "researcher"],
    coordinatorPresetKey: "coordinator",
    defaultStrategy: "smart",
  },
  {
    id: "research-desk",
    nameKey: "team.template.research.name",
    descriptionKey: "team.template.research.desc",
    botPresetKeys: ["coordinator", "researcher", "reviewer"],
    coordinatorPresetKey: "coordinator",
    defaultStrategy: "local-only",
  },
] as const;

/** 根据翻译函数生成默认机器人实体，保证初始语言与用户界面一致。 */
export function instantiatePresetBots(translate: (key: string) => string, now = Date.now()): TeamBot[] {
  return DEFAULT_TEAM_BOT_PRESETS.map((preset) => ({
    id: `bot-preset-${preset.presetKey}`,
    name: translate(preset.nameKey),
    roleTitle: translate(preset.roleKey),
    description: translate(preset.descriptionKey),
    systemPrompt: translate(preset.promptKey),
    logo: preset.logo,
    modelId: "",
    capabilities: [...preset.capabilities],
    source: "preset",
    presetKey: preset.presetKey,
    createdAt: now,
    updatedAt: now,
  }));
}
