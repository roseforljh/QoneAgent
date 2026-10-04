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
import { readSystemPrompt } from "./system-prompt.js";
import { qonePiStateDir, qoneSkillsDir, qoneBuiltinSkillsDir, qoneSkillCacheDir } from "@qone/shared";
import { readGlobalInstructions } from "./global-instructions.js";
import { workspaceInstructions } from "./workspace-instructions.js";
import { toolPromptContextExtension } from "./tool-prompt-context.js";
import { assertUserSkillName, isBuiltinSkillName } from "./builtin-skills/identity.js";
import { listBuiltinSkills } from "./builtin-skills/manager.js";
import eccResources from "./builtin-subagents/ecc-resources.json";
import type { SkillInfo } from "@qone/protocol";
export type { SkillInfo } from "@qone/protocol";

export function qoneAgentDir(): string {
  return qonePiStateDir();
}

const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_SKILL_CONTENT_BYTES = 2 * 1024 * 1024;

async function ensureEccReferenceSkills(): Promise<string[]> {
  const root = path.join(qoneBuiltinSkillsDir(), "ecc-reference", eccResources.revision);
  const paths = new Set<string>();
  for (const [relative, content] of Object.entries(eccResources.files)) {
    const destination = path.resolve(root, relative.replaceAll("/", path.sep));
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) throw new Error("Invalid ECC reference path");
    await mkdir(path.dirname(destination), { recursive: true });
    if (!existsSync(destination)) await writeFile(destination, content, "utf8");
    if (relative.startsWith("skills/") && relative.endsWith("/SKILL.md")) paths.add(path.dirname(destination));
  }
  return [...paths];
}

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
    assertUserSkillName(skill.name);
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
export async function createResourceLoader(cwd: string, additionalInstructions?: string, enableCodemode = false, includeEccReferences = false): Promise<{
  loader: ResourceLoader;
  skills: SkillInfo[];
}> {
  const agentDir = qoneAgentDir();
  const ownSkills = qoneSkillsDir();
  const builtinSkills = await listBuiltinSkills();
  const eccReferencePaths = includeEccReferences ? await ensureEccReferenceSkills() : [];
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // Pi's default discovery also includes project and package skills.
    // QoneAgent only loads skills installed in its own data directory.
    noSkills: true,
    noContextFiles: true,
    // Suppress Pi's SYSTEM.md / APPEND_SYSTEM.md discovery. The seven modules
    // supply the fixed preamble, before any variable context sections.
    systemPrompt: "",
    systemPromptOverride: () => readSystemPrompt(),
    appendSystemPrompt: [],
    agentsFilesOverride: () => ({ agentsFiles: workspaceInstructions(cwd) }),
    additionalSkillPaths: [
      ...builtinSkills.filter((skill) => skill.enabled).map((skill) => path.dirname(skill.path)),
      ...(existsSync(ownSkills) ? [ownSkills] : []),
      ...eccReferencePaths,
    ],
    // A manually copied user skill cannot override a reserved built-in name,
    // including while the built-in is disabled.
    skillsOverride: (base) => ({
      ...base,
      skills: base.skills.filter((skill) => !isBuiltinSkillName(skill.name) || builtinSkills.some((builtin) => builtin.enabled && builtin.path === skill.filePath)),
    }),
    noExtensions: true,
    extensionFactories: [toolPromptContextExtension, ...(enableCodemode ? [createCodemodeExtension({ models: false })] : [])],
    // Qone.md is user-level global guidance. It stays separate from Qone's
    // built-in rules so updating the file never replaces product behavior.
    appendSystemPromptOverride: () => {
      const instructions = readGlobalInstructions().trim();
      return [
        ...(instructions ? [`## Qone.md\n\n${instructions}`] : []),
        ...(additionalInstructions ? [additionalInstructions] : []),
        ...builtinSkills.filter((skill) => !skill.enabled).map((skill) => `The built-in skill "${skill.name}" is disabled. Do not apply its instructions, including its section in Qone.md and instructions previously loaded in conversation history.`),
      ];
    },
  });
  await loader.reload();
  return { loader, skills: [...builtinSkills, ...loader.getSkills().skills.filter((skill) => !isBuiltinSkillName(skill.name)).map(toInfo)] };
}

function toInfo(skill: Skill): SkillInfo {
  return {
    id: skill.name,
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
  };
}
