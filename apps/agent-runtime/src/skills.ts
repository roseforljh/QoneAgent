import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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

export interface PluginSkillInput {
  pluginId: string;
  name: string;
  description?: string;
  content: string;
}

/**
 * Keep skill discovery on Pi's ResourceLoader. The wrapper only exposes a
 * product-facing catalog for the GUI and persistence; it does not create a
 * second skill format.
 */
export async function createResourceLoader(cwd: string, pluginSkills: PluginSkillInput[] = []): Promise<{
  loader: ResourceLoader;
  skills: SkillInfo[];
}> {
  const agentDir = process.env.PI_AGENT_DIR ??
    path.join(process.env.APPDATA ?? process.env.HOME ?? process.cwd(), "QoneAgent", "pi");
  const pluginSkillRoot = path.join(agentDir, "plugin-skills");
  const pluginSkillPaths: string[] = [];
  for (const skill of pluginSkills) {
    const segment = (value: string) => {
      const safe = value.replace(/[^a-zA-Z0-9._-]/g, "_");
      return safe === "." || safe === ".." || !safe ? "_" : safe;
    };
    const dir = path.join(pluginSkillRoot, segment(skill.pluginId), segment(skill.name));
    await mkdir(dir, { recursive: true });
    const frontmatter = `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description ?? "")}\n---\n`;
    await writeFile(path.join(dir, "SKILL.md"), frontmatter + skill.content, "utf8");
    pluginSkillPaths.push(dir);
  }
  const skillPaths = [path.join(cwd, "skills"), path.join(process.cwd(), "skills"), ...pluginSkillPaths]
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
