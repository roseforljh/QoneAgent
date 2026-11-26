import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalSkill, createResourceLoader, installLocalSkill, readLocalSkill, updateLocalSkill } from "../src/skills.js";
import { builtinSkillBundles } from "../src/builtin-skills/identity.js";

const originalAppData = process.env.APPDATA;
const originalDataDir = process.env.QONE_DATA_DIR;
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
  if (originalDataDir === undefined) delete process.env.QONE_DATA_DIR;
  else process.env.QONE_DATA_DIR = originalDataDir;
  if (originalPiAgentDir === undefined) delete process.env.PI_AGENT_DIR;
  else process.env.PI_AGENT_DIR = originalPiAgentDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("loads only QoneAgent skills, excluding workspace and Pi skills", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-skills-"));
  roots.push(root);
  process.env.QONE_DATA_DIR = path.join(root, "qone");
  process.env.PI_AGENT_DIR = path.join(root, "other-agent");
  const cwd = path.join(root, "workspace");
  const ownSkill = addSkill(path.join(process.env.QONE_DATA_DIR, "skills", "installed"), "own");
  addSkill(path.join(cwd, "skills"), "workspace");
  addSkill(path.join(cwd, ".pi", "skills"), "project-pi");
  addSkill(path.join(process.env.PI_AGENT_DIR, "skills"), "other-agent");
  writeFileSync(path.join(root, "AGENTS.md"), "Ancestor guidance must not be loaded.");

  const claudeFile = path.join(cwd, "CLAUDE.md");
  writeFileSync(claudeFile, "Project Claude guidance.");
  const { loader, skills } = await createResourceLoader(cwd);
  expect(skills.filter((skill) => !skill.builtin)).toEqual([{ id: "own", name: "own", description: "own skill", path: ownSkill }]);
  expect(skills.find((skill) => skill.id === "ponytail")).toMatchObject({ builtin: true, enabled: true });
  expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual([...builtinSkillBundles.map((skill) => skill.id), "own"]);
  const projectFile = path.join(cwd, "AGENTS.md");
  // 加载工作区不得偷偷创建 AGENTS.md，且原有 CLAUDE.md 必须正常生效
  expect(loader.getAgentsFiles().agentsFiles).toEqual([{ path: claudeFile, content: "Project Claude guidance." }]);
  writeFileSync(projectFile, "Workspace guidance.");
  await loader.reload();
  expect(loader.getAgentsFiles().agentsFiles).toEqual([
    { path: projectFile, content: "Workspace guidance." },
    { path: claudeFile, content: "Project Claude guidance." },
  ]);
});

test("creates a skill in the QoneAgent skill directory", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-skill-create-"));
  roots.push(root);
  process.env.QONE_DATA_DIR = path.join(root, "qone");

  const skill = await createLocalSkill("daily-helper", "A daily helper", "Follow these steps carefully.");

  expect(skill.name).toBe("daily-helper");
  expect(readFileSync(skill.path, "utf8")).toContain("name: daily-helper");
  expect(readFileSync(skill.path, "utf8")).toContain("Follow these steps carefully.");
});

test("imports a valid SKILL.md and rejects invalid or duplicate skills", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-skill-import-"));
  roots.push(root);
  process.env.QONE_DATA_DIR = path.join(root, "qone");
  const content = "---\nname: imported-helper\ndescription: Imported helper\n---\n\nUse the helper.\n";

  const skill = await installLocalSkill(content);

  expect(skill.name).toBe("imported-helper");
  await expect(installLocalSkill(content)).rejects.toThrow("已安装");
  await expect(installLocalSkill("# Missing frontmatter")).rejects.toThrow("格式无效");
});

test("reads, updates, and renames a locally installed skill while preserving extra files and frontmatter", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-skill-edit-"));
  roots.push(root);
  process.env.QONE_DATA_DIR = path.join(root, "qone");

  const imported = await installLocalSkill("---\nname: gitpush\ndescription: Push commits\ndisable-model-invocation: true\n---\n\nRun git push.\n");
  const helperFile = path.join(path.dirname(imported.path), "notes.txt");
  writeFileSync(helperFile, "keep me", "utf8");

  const detail = await readLocalSkill("gitpush");
  expect(detail.editable).toBe(true);
  expect(detail.skill.description).toBe("Push commits");
  expect(detail.instructions).toBe("Run git push.");

  const updated = await updateLocalSkill("gitpush", "gitpush", "Push commits safely", "Check status before git push.");
  expect(updated.id).toBe("gitpush");
  expect(updated.description).toBe("Push commits safely");
  expect(readFileSync(updated.path, "utf8")).toContain("disable-model-invocation: true");
  expect(readFileSync(updated.path, "utf8")).toContain("Check status before git push.");
  expect(readFileSync(helperFile, "utf8")).toBe("keep me");

  const renamed = await updateLocalSkill("gitpush", "git-push", "Push commits cleanly", "Verify branch then push.");
  expect(renamed.id).toBe("git-push");
  expect(existsSync(path.dirname(imported.path))).toBe(false);
  expect(readFileSync(renamed.path, "utf8")).toContain("Verify branch then push.");
  expect(readFileSync(path.join(path.dirname(renamed.path), "notes.txt"), "utf8")).toBe("keep me");

  await createLocalSkill("other-skill", "Other", "Other instructions.");
  await expect(updateLocalSkill("git-push", "other-skill", "Dup", "Dup")).rejects.toThrow("已安装");
  await expect(updateLocalSkill("git-push", "ponytail", "Reserved", "Reserved")).rejects.toThrow("内置技能");
  await expect(updateLocalSkill("ponytail", "ponytail", "Reserved", "Reserved")).rejects.toThrow("内置技能");
});
