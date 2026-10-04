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

const previousRoot = process.env.QONE_DATA_DIR;
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

function upstream(revision: string, content = "---\nname: ponytail\ndescription: Updated ponytail\n---\nNew upstream instructions.\n", badSize = false): typeof fetch {
  return (async (input) => {
    const url = String(input);
    if (url.endsWith("/commits/HEAD")) return Response.json({ sha: revision });
    if (url.includes("/git/trees/")) return Response.json({ tree: [
      { path: "skills/ponytail/SKILL.md", type: "blob", size: badSize ? 1 : Buffer.byteLength(content) },
      { path: "LICENSE", type: "blob", size: Buffer.byteLength("MIT License") },
    ] });
    expect(url).toContain(`/${revision}/`);
    if (url.endsWith("/SKILL.md")) return new Response(content);
    if (url.endsWith("/LICENSE")) return new Response("MIT License");
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

test("offline installation loads the bundle and license; disabling survives reopening the database", async () => {
  const [builtin] = await listBuiltinSkills();
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
  expect(disabled.loader.getSkills().skills).toEqual([]);
  expect(disabled.loader.getAppendSystemPrompt().join("\n")).toContain('skill "ponytail" is disabled');
  await setBuiltinSkillEnabled("ponytail", true);
  expect((await createResourceLoader(root)).loader.getSkills().skills.map((skill) => skill.name)).toEqual(["ponytail"]);
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
  expect(enabled.loader.getSkills().skills).toHaveLength(1);
  expect(enabled.loader.getSkills().skills[0]!.filePath).toBe(enabled.skills[0]!.path);
  await setBuiltinSkillEnabled("ponytail", false);
  expect((await createResourceLoader(root)).loader.getSkills().skills).toEqual([]);
  expect(decodeCommand(JSON.stringify({ type: "skills.delete", requestId: "delete", skillId: "ponytail" }))).toBeNull();
  await expect(setBuiltinSkillEnabled("../outside", false)).rejects.toThrow("未知的内置技能");
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
