import { runtimeError } from "./runtime-localization";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DefaultResourceLoader,
  createCodemodeExtension,
  type Skill,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { QONE_SYSTEM_PROMPT } from "./system-prompt.js";
import { qonePiStateDir, qoneSkillsDir, qoneSkillCacheDir } from "@qone/shared";
import { readGlobalInstructions } from "./global-instructions.js";
import { workspaceInstructions } from "./workspace-instructions.js";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export function qoneAgentDir(): string {
  return qonePiStateDir();
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_CONTENT_BYTES = 2 * 1024 * 1024;

export async function installLocalSkill(content: string): Promise<SkillInfo> {
  return writeSkillContent(content);
}

export async function createLocalSkill(name: string, description: string, instructions: string): Promise<SkillInfo> {
  const normalizedName = name.trim().toLowerCase();
  const normalizedDescription = description.trim();
  const normalizedInstructions = instructions.trim();
  if (!SKILL_NAME.test(normalizedName)) throw runtimeError("skills.skill_names_may_only_contain_lowercase_letters_numbers_and", {});
  if (!normalizedDescription) throw runtimeError("skills.the_skill_description_cannot_be_empty", {});
  if (!normalizedInstructions) throw runtimeError("skills.the_skill_instructions_cannot_be_empty", {});
  const content = `---\nname: ${normalizedName}\ndescription: ${JSON.stringify(normalizedDescription.replace(/[\r\n]+/g, " "))}\n---\n\n${normalizedInstructions}\n`;
  return writeSkillContent(content, normalizedName);
}

async function writeSkillContent(content: string, expectedName?: string): Promise<SkillInfo> {
  if (!content.trim() || Buffer.byteLength(content, "utf8") > MAX_SKILL_CONTENT_BYTES) throw runtimeError("skills.the_skill_file_is_empty_or_exceeds_2_mb", {});
  const agentDir = qoneAgentDir();
  const skillsDir = qoneSkillsDir();
  const cacheDir = qoneSkillCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(path.join(cacheDir, ".skill-import-"));
  try {
    const skillFile = path.join(staging, "SKILL.md");
    await writeFile(skillFile, content, "utf8");
    const loaded = new DefaultResourceLoader({
      cwd: staging,
      agentDir,
      noSkills: true,
      noContextFiles: true,
      additionalSkillPaths: [staging],
      noExtensions: true,
    });
    await loaded.reload();
    const skill = loaded.getSkills().skills[0];
    if (!skill || loaded.getSkills().skills.length !== 1) throw runtimeError("skills.invalid_skill_file_format", {});
    if (!SKILL_NAME.test(skill.name)) throw runtimeError("skills.skill_names_may_only_contain_lowercase_letters_numbers_and", {});
    if (expectedName && skill.name !== expectedName) throw runtimeError("skills.the_skill_name_does_not_match_the_creation_form", {});
    const destination = path.join(skillsDir, skill.name);
    if (existsSync(destination)) throw runtimeError("skill-catalog.skill_is_already_installed", { p0: skill.name });
    await mkdir(skillsDir, { recursive: true });
    await rename(staging, destination);
    return { id: skill.name, name: skill.name, description: skill.description, path: path.join(destination, "SKILL.md") };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Keep skill discovery on Pi's ResourceLoader. The wrapper only exposes a
 * product-facing catalog for the GUI and persistence; it does not create a
 * second skill format.
 */
export async function createResourceLoader(cwd: string, additionalInstructions?: string, enableCodemode = false): Promise<{
  loader: ResourceLoader;
  skills: SkillInfo[];
}> {
  const agentDir = qoneAgentDir();
  const ownSkills = qoneSkillsDir();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // Pi's default discovery also includes project and package skills.
    // QoneAgent only loads skills installed in its own data directory.
    noSkills: true,
    noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: workspaceInstructions(cwd) }),
    additionalSkillPaths: existsSync(ownSkills) ? [ownSkills] : [],
    noExtensions: true,
    ...(enableCodemode ? { extensionFactories: [createCodemodeExtension({ models: false })] } : {}),
    // Qone.md is user-level global guidance. It stays separate from Qone's
    // built-in rules so updating the file never replaces product behavior.
    appendSystemPromptOverride: (base) => {
      const instructions = readGlobalInstructions().trim();
      return [
        ...base, QONE_SYSTEM_PROMPT,
        ...(instructions ? [`## Qone.md\n\n${instructions}`] : []),
        ...(additionalInstructions ? [additionalInstructions] : []),
      ];
    },
  });
  await loader.reload();
  return { loader, skills: loader.getSkills().skills.map(toInfo) };
}

function toInfo(skill: Skill): SkillInfo {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
  };
}
