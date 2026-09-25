import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DefaultResourceLoader,
  type Skill,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { QONE_SYSTEM_PROMPT } from "./system-prompt.js";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
}

export function qoneAgentDir(): string {
  return path.join(process.env.APPDATA ?? os.homedir(), "QoneAgent", "pi");
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
    appendSystemPromptOverride: (base) => [...base, QONE_SYSTEM_PROMPT],
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
