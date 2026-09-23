import { existsSync } from "node:fs";
import path from "node:path";
import {
  DefaultResourceLoader,
  type Skill,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  path: string;
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
  const agentDir = process.env.PI_AGENT_DIR ??
    path.join(process.env.APPDATA ?? process.env.HOME ?? process.cwd(), "QoneAgent", "pi");
  const skillPaths = [path.join(cwd, "skills"), path.join(process.cwd(), "skills")]
    .filter((p, i, all) => existsSync(p) && all.indexOf(p) === i);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    additionalSkillPaths: skillPaths,
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
