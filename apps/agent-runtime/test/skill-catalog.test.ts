import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installCloudSkill, listCloudSkills } from "../src/skill-catalog.js";
import { createResourceLoader } from "../src/skills.js";

const oldAppData = process.env.APPDATA;
const roots: string[] = [];
afterEach(() => {
  if (oldAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = oldAppData;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("cloud catalog reads the skills.sh collection and search", async () => {
  const urls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ skills: [{ source: "owner/repo", skillId: "demo", name: "Demo", installs: 42, isOfficial: true }], hasMore: true });
  }) as typeof fetch;
  expect((await listCloudSkills("popular", 1, "", fetcher)).skills[0]?.skillId).toBe("demo");
  expect((await listCloudSkills("trending", 1, "abc", fetcher)).hasMore).toBe(false);
  expect(urls).toEqual(["https://skills.sh/api/skills/all-time/1", "https://skills.sh/api/search?q=abc&limit=100"]);
});

test("imports only the selected skill into QoneAgent and makes it discoverable", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-cloud-"));
  roots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  const instruction = "---\nname: demo\ndescription: Cloud demo\n---\nUse demo.\n";
  const reference = "Reference content";
  const sha = "a".repeat(40);
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/commits/HEAD")) return Response.json({ sha });
    if (url.includes("/git/trees/")) return Response.json({ tree: [
      { path: "skills/demo/SKILL.md", type: "blob", size: Buffer.byteLength(instruction) },
      { path: "skills/demo/references/info.md", type: "blob", size: Buffer.byteLength(reference) },
      { path: "skills/other/SKILL.md", type: "blob", size: 15 },
    ] });
    if (url.endsWith("skills/demo/SKILL.md")) return new Response(instruction);
    if (url.endsWith("skills/demo/references/info.md")) return new Response(reference);
    throw new Error(`Unexpected download: ${url}`);
  }) as typeof fetch;

  const skill = await installCloudSkill("owner/repo", "demo", fetcher);
  expect(skill.path).toBe(path.join(process.env.APPDATA, "QoneAgent", "pi", "skills", "demo", "SKILL.md"));
  expect(readFileSync(path.join(path.dirname(skill.path), "references", "info.md"), "utf8")).toBe(reference);
  expect(existsSync(path.join(path.dirname(skill.path), "..", "other"))).toBe(false);
  expect((await createResourceLoader(path.join(root, "workspace"))).skills.map((item) => item.name)).toEqual(["demo"]);
  await expect(installCloudSkill("owner/repo", "demo", fetcher)).rejects.toThrow("已安装");
});

test("rejects a changed file without installing a partial skill", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-cloud-"));
  roots.push(root);
  process.env.APPDATA = path.join(root, "appdata");
  const sha = "b".repeat(40);
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/commits/HEAD")) return Response.json({ sha });
    if (url.includes("/git/trees/")) return Response.json({ tree: [{ path: "skills/demo/SKILL.md", type: "blob", size: 1 }] });
    return new Response("changed content");
  }) as typeof fetch;
  await expect(installCloudSkill("owner/repo", "demo", fetcher)).rejects.toThrow("大小与仓库清单不符");
  expect((await createResourceLoader(root)).skills).toEqual([]);
});
