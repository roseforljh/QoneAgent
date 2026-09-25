import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createResourceLoader } from "../src/skills.js";

const originalAppData = process.env.APPDATA;
const originalPiAgentDir = process.env.PI_AGENT_DIR;
const roots: string[] = [];

function addSkill(dir: string, name: string): string {
  const file = path.join(dir, name, "SKILL.md");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\nname: ${name}\ndescription: ${name} skill\n---\nUse ${name}.\n`);
  return file;
}

afterEach(() => {
  if (originalAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = originalAppData;
  if (originalPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = originalPiAgentDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("loads only QoneAgent skills, excluding workspace and Pi skills", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-skills-"));
  roots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  process.env.PI_AGENT_DIR = path.join(root, "other-agent");
  const cwd = path.join(root, "workspace");
  const ownSkill = addSkill(path.join(process.env.APPDATA, "QoneAgent", "pi", "skills"), "own");
  addSkill(path.join(cwd, "skills"), "workspace");
  addSkill(path.join(cwd, ".pi", "skills"), "project-pi");
  addSkill(path.join(process.env.PI_AGENT_DIR, "skills"), "other-agent");

  const { loader, skills } = await createResourceLoader(cwd);
  expect(skills).toEqual([{ id: "own", name: "own", description: "own skill", path: ownSkill }]);
  expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(["own"]);
});
