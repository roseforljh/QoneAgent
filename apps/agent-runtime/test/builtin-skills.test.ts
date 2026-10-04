import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openConfigDb, SettingsRepo } from "@qone/database";
import { decodeCommand } from "@qone/protocol";
import { configureBuiltinSkills, listBuiltinSkills, setBuiltinSkillEnabled, updateBuiltinSkill } from "../src/builtin-skills/manager.js";
import { builtinSkillBundles } from "../src/builtin-skills/identity.js";
import { createLocalSkill, createResourceLoader, installLocalSkill } from "../src/skills.js";
import { installCloudSkill } from "../src/skill-catalog.js";
import { ensureGlobalInstructions, readGlobalInstructions, writeGlobalInstructions } from "../src/global-instructions.js";
import { readSystemPrompt } from "../src/system-prompt.js";

const previousRoot = process.env.QONE_DATA_DIR;
const expectedSkills = ["ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help"];
let root: string;
let db: ReturnType<typeof openConfigDb>;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "qone-builtin-skills-"));
  process.env.QONE_DATA_DIR = root;
  db = openConfigDb(path.join(root, "config", "settings.db"));
  configureBuiltinSkills(new SettingsRepo(db));
});
afterEach(() => {
  configureBuiltinSkills();
  // Drizzle prepares transient statements; finalize them before closing SQLite
  // so Windows can release the database and remove the test directory.
  Bun.gc(true);
  db.$client.close(true);
  if (previousRoot === undefined) delete process.env.QONE_DATA_DIR;
  else process.env.QONE_DATA_DIR = previousRoot;
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error("Unsafe test cleanup");
  rmSync(root, { recursive: true, force: true });
});

function upstream(revision: string, content?: string, badSize = false, id = "ponytail"): typeof fetch {
  content ??= `---\nname: ${id}\ndescription: Updated ${id}\n---\nNew upstream instructions.\n`;
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/commits/HEAD")) return Response.json({ sha: revision });
    if (url.includes("/git/trees/")) return Response.json({ tree: [
      { path: `skills/${id}/SKILL.md`, type: "blob", size: badSize ? 1 : Buffer.byteLength(content) },
      { path: "LICENSE", type: "blob", size: Buffer.byteLength("MIT License") },
    ] });
    expect(url).toContain(`/${revision}/`);
    if (url.endsWith("/SKILL.md")) return new Response(content);
    if (url.endsWith("/LICENSE")) return new Response("MIT License");
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

test("offline installation loads the bundle and license; disabling survives reopening the database", async () => {
  const builtins = await listBuiltinSkills();
  expect(builtins.map((skill) => skill.id)).toEqual(expectedSkills);
  for (const bundle of builtinSkillBundles) {
    const skill = builtins.find((item) => item.id === bundle.id)!;
    expect(readFileSync(skill.path, "utf8")).toBe(bundle.files["SKILL.md"]);
    expect(readFileSync(path.join(path.dirname(skill.path), "LICENSE"), "utf8")).toBe(bundle.files.LICENSE);
  }
  const [builtin] = builtins;
  expect(builtin).toMatchObject({ id: "ponytail", builtin: true, enabled: true, source: "DietrichGebert/ponytail" });
  expect(readFileSync(builtin!.path, "utf8")).toBe(builtinSkillBundles[0]!.files["SKILL.md"]);
  expect(readFileSync(path.join(path.dirname(builtin!.path), "LICENSE"), "utf8")).toContain("MIT License");
  expect((await createResourceLoader(root)).loader.getSkills().skills.map((skill) => skill.name)).toContain("ponytail");
  await setBuiltinSkillEnabled("ponytail", false);
  Bun.gc(true);
  db.$client.close(true);
  db = openConfigDb(path.join(root, "config", "settings.db"));
  configureBuiltinSkills(new SettingsRepo(db));
  const disabled = await createResourceLoader(root);
  expect(disabled.skills.find((skill) => skill.id === "ponytail")?.enabled).toBe(false);
  expect(disabled.loader.getSkills().skills.map((skill) => skill.name)).toEqual(expectedSkills.slice(1));
  expect(disabled.loader.getAppendSystemPrompt().join("\n")).toContain('skill "ponytail" is disabled');
  await setBuiltinSkillEnabled("ponytail", true);
  expect((await createResourceLoader(root)).loader.getSkills().skills.map((skill) => skill.name)).toEqual(expectedSkills);
});

test("reserved identity blocks creation/import/cloud installs and manually copied overrides", async () => {
  const content = "---\nname: ponytail\ndescription: User override\n---\nOverride.\n";
  await expect(createLocalSkill("ponytail", "User override", "Override.")).rejects.toThrow("是内置技能");
  await expect(installLocalSkill(content)).rejects.toThrow("是内置技能");
  await expect(installCloudSkill("someone/ponytail", "ponytail", upstream("a".repeat(40)))).rejects.toThrow("是内置技能");
  const copied = path.join(root, "skills", "installed", "copied");
  mkdirSync(copied, { recursive: true });
  writeFileSync(path.join(copied, "SKILL.md"), content);
  const enabled = await createResourceLoader(root);
  expect(enabled.loader.getSkills().skills).toHaveLength(expectedSkills.length);
  expect(enabled.loader.getSkills().skills[0]!.filePath).toBe(enabled.skills[0]!.path);
  await setBuiltinSkillEnabled("ponytail", false);
  expect((await createResourceLoader(root)).loader.getSkills().skills.map((skill) => skill.name)).toEqual(expectedSkills.slice(1));
  expect(decodeCommand(JSON.stringify({ type: "skills.delete", requestId: "delete", skillId: "ponytail" }))).toBeNull();
  await expect(setBuiltinSkillEnabled("../outside", false)).rejects.toThrow("未知的内置技能");
});

test("existing main-skill preferences survive adding the rest of the upstream collection", async () => {
  const main = builtinSkillBundles[0]!;
  const directory = path.join(root, "skills", "builtin", main.id, main.revision);
  mkdirSync(directory, { recursive: true });
  for (const [file, content] of Object.entries(main.files)) writeFileSync(path.join(directory, file), content);
  new SettingsRepo(db).set("skills.builtin.ponytail", { enabled: false, revision: main.revision });
  const skills = await listBuiltinSkills();
  expect(skills.map((skill) => skill.id)).toEqual(expectedSkills);
  expect(skills[0]).toMatchObject({ enabled: false, revision: main.revision });
  expect(skills.slice(1).every((skill) => skill.enabled && skill.builtin)).toBe(true);
  expect(readFileSync(path.join(directory, "SKILL.md"), "utf8")).toBe(main.files["SKILL.md"]);
});

test("every companion skill is protected, independently toggleable and updateable", async () => {
  for (const [index, id] of expectedSkills.slice(1).entries()) {
    const content = `---\nname: ${id}\ndescription: User override\n---\nOverride.\n`;
    await expect(createLocalSkill(id, "Override", "Override")).rejects.toThrow("是内置技能");
    await expect(installLocalSkill(content)).rejects.toThrow("是内置技能");
    await expect(installCloudSkill("someone/ponytail", id)).rejects.toThrow("是内置技能");
    await setBuiltinSkillEnabled(id, false);
    const disabled = await createResourceLoader(root);
    expect(disabled.loader.getSkills().skills.some((skill) => skill.name === id)).toBe(false);
    expect(disabled.loader.getSkills().skills.some((skill) => skill.name === "ponytail")).toBe(true);
    const sha = String(index + 1).repeat(40);
    const result = await updateBuiltinSkill(id, upstream(sha, undefined, false, id));
    expect(result).toMatchObject({ updated: true, skill: { id, enabled: false, revision: sha, builtin: true } });
    expect(readFileSync(result.skill.path, "utf8")).toContain(`name: ${id}`);
    await setBuiltinSkillEnabled(id, true);
  }
  expect((await createResourceLoader(root)).loader.getSkills().skills.map((skill) => skill.name)).toEqual(expectedSkills);
});

test("the disable directive covers default global ponytail rules while preserving user content and the fixed preamble", async () => {
  ensureGlobalInstructions();
  writeGlobalInstructions(`${readGlobalInstructions()}\n## My rules\nKEEP_MY_GLOBAL_RULE\n`);
  const original = readGlobalInstructions();
  const fixed = readSystemPrompt();
  const enabled = await createResourceLoader(root);
  expect(enabled.loader.getAppendSystemPrompt().join("\n")).toContain("Before writing any code, stop at the first rung that holds:");
  await setBuiltinSkillEnabled("ponytail", false);
  const disabled = await createResourceLoader(root);
  const appended = disabled.loader.getAppendSystemPrompt();
  expect(appended.join("\n")).toContain("KEEP_MY_GLOBAL_RULE");
  expect(appended.at(-1)).toContain('skill "ponytail" is disabled');
  expect(appended.at(-1)).toContain("including its section in Qone.md");
  expect(disabled.loader.getSystemPrompt()).toBe(fixed);
  expect(readGlobalInstructions()).toBe(original);
  await setBuiltinSkillEnabled("ponytail", true);
  const restored = await createResourceLoader(root);
  expect(restored.loader.getAppendSystemPrompt().join("\n")).not.toContain('skill "ponytail" is disabled');
  expect(restored.loader.getSystemPrompt()).toBe(fixed);
});

test("updates publish validated versions, keep the enabled state and retain old files for running sessions", async () => {
  const [original] = await listBuiltinSkills();
  await setBuiltinSkillEnabled("ponytail", false);
  const sha = "a".repeat(40);
  const result = await updateBuiltinSkill("ponytail", upstream(sha));
  expect(result).toMatchObject({ updated: true, skill: { enabled: false, revision: sha, builtin: true } });
  expect(readFileSync(result.skill.path, "utf8")).toContain("New upstream instructions");
  expect(readFileSync(original!.path, "utf8")).toContain("# Ponytail");
  expect((await updateBuiltinSkill("ponytail", upstream(sha))).updated).toBe(false);
  expect((await listBuiltinSkills())[0]?.revision).toBe(sha);
});

test("failed downloads or changed names leave the old content and revision active without staging debris", async () => {
  const [original] = await listBuiltinSkills();
  const before = readFileSync(original!.path, "utf8");
  await expect(updateBuiltinSkill("ponytail", upstream("b".repeat(40), undefined, true))).rejects.toThrow("大小与仓库清单不符");
  await expect(updateBuiltinSkill("ponytail", upstream("b".repeat(40), "---\nname: changed\ndescription: Changed\n---\nChanged.\n"))).rejects.toThrow("技能名称已改变");
  expect((await listBuiltinSkills())[0]?.revision).toBe(original!.revision);
  expect(readFileSync(original!.path, "utf8")).toBe(before);
  expect(readdirSync(path.join(root, "skills", "cache"))).toEqual([]);
});

test("an update and toggle queued together preserve both state changes", async () => {
  const sha = "c".repeat(40);
  await Promise.all([updateBuiltinSkill("ponytail", upstream(sha)), setBuiltinSkillEnabled("ponytail", false)]);
  expect((await listBuiltinSkills())[0]).toMatchObject({ enabled: false, revision: sha });
});

test("a stalled update does not block catalog reads or resource loading", async () => {
  await listBuiltinSkills();
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const downloading = new Promise<void>((resolve) => { started = resolve; });
  const fetcher = upstream("d".repeat(40));
  const update = updateBuiltinSkill("ponytail", (async (input, init) => {
    started();
    await barrier;
    return fetcher(input, init);
  }) as typeof fetch);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await downloading;
    const resources = await Promise.race([
      createResourceLoader(root),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Catalog blocked by update")), 1000); }),
    ]);
    expect(resources.skills[0]?.revision).toBe(builtinSkillBundles[0]!.revision);
  } finally {
    clearTimeout(timer);
    release();
    await update;
  }
});

test("a removed built-in is restored offline without re-enabling it", async () => {
  const skill = await setBuiltinSkillEnabled("ponytail", false);
  const directory = path.dirname(skill.path);
  if (!directory.startsWith(path.join(root, "skills", "builtin") + path.sep)) throw new Error("Unsafe test cleanup");
  rmSync(directory, { recursive: true });
  expect((await listBuiltinSkills())[0]).toMatchObject({ enabled: false, revision: builtinSkillBundles[0]!.revision });
  expect(readFileSync(skill.path, "utf8")).toContain("# Ponytail");
});
