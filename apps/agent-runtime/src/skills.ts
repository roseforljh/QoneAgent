import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  type Skill,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { QONE_SYSTEM_PROMPT } from "./system-prompt.js";
import { qoneDataDir, readGlobalInstructions } from "./global-instructions.js";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export function qoneAgentDir(): string {
  return path.join(process.env.APPDATA ?? os.homedir(), "QoneAgent", "pi");
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
  if (!SKILL_NAME.test(normalizedName)) throw new Error("Skill 名称只能使用小写字母、数字和连字符");
  if (!normalizedDescription) throw new Error("Skill 描述不能为空");
  if (!normalizedInstructions) throw new Error("Skill 指令不能为空");
  const content = `---\nname: ${normalizedName}\ndescription: ${JSON.stringify(normalizedDescription.replace(/[\r\n]+/g, " "))}\n---\n\n${normalizedInstructions}\n`;
  return writeSkillContent(content, normalizedName);
}

async function writeSkillContent(content: string, expectedName?: string): Promise<SkillInfo> {
  if (!content.trim() || Buffer.byteLength(content, "utf8") > MAX_SKILL_CONTENT_BYTES) throw new Error("Skill 文件为空或超过 2 MB");
  const agentDir = qoneAgentDir();
  const skillsDir = path.join(agentDir, "skills");
  await mkdir(agentDir, { recursive: true });
  const staging = await mkdtemp(path.join(agentDir, ".skill-import-"));
  try {
    const skillFile = path.join(staging, "SKILL.md");
    await writeFile(skillFile, content, "utf8");
    const loaded = new DefaultResourceLoader({
      cwd: staging,
      agentDir,
      noSkills: true,
      additionalSkillPaths: [staging],
      noExtensions: true,
    });
    await loaded.reload();
    const skill = loaded.getSkills().skills[0];
    if (!skill || loaded.getSkills().skills.length !== 1) throw new Error("Skill 文件格式无效");
    if (!SKILL_NAME.test(skill.name)) throw new Error("Skill 名称只能使用小写字母、数字和连字符");
    if (expectedName && skill.name !== expectedName) throw new Error("Skill 名称与创建表单不一致");
    const destination = path.join(skillsDir, skill.name);
    if (existsSync(destination)) throw new Error(`Skill ${skill.name} 已安装`);
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
export async function createResourceLoader(cwd: string): Promise<{
  loader: ResourceLoader;
  skills: SkillInfo[];
}> {
  const agentDir = qoneAgentDir();
  const ownSkills = path.join(agentDir, "skills");
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    // Pi's default discovery also includes project and package skills.
    // QoneAgent only loads skills installed in its own data directory.
    noSkills: true,
    additionalSkillPaths: existsSync(ownSkills) ? [ownSkills] : [],
    noExtensions: true,
    // Qone.md is user-level global guidance. It stays separate from Qone's
    // built-in rules so updating the file never replaces product behavior.
    appendSystemPromptOverride: (base) => {
      const instructions = readGlobalInstructions().trim();
      return instructions
        ? [...base, QONE_SYSTEM_PROMPT, `## Qone.md\n\n${instructions}`]
        : [...base, QONE_SYSTEM_PROMPT];
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
