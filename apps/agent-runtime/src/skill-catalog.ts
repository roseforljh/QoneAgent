import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { qoneAgentDir, type SkillInfo } from "./skills.js";

export interface CloudSkill {
  source: string;
  skillId: string;
  name: string;
  installs: number;
  isOfficial: boolean;
}

export interface CloudSkillPage {
  skills: CloudSkill[];
  page: number;
  hasMore: boolean;
}

type GithubTreeEntry = { path: string; type: string; size?: number; mode?: string };
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IGNORED_ROOTS = new Set([".git", ".github", "node_modules", "build", "dist", "references", "templates", "assets", "scripts", "examples", "example", "test", "tests"]);
const MAX_FILES = 1_000;
const MAX_BYTES = 100 * 1024 * 1024;

async function getJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": "QoneAgent-Skills" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`云库请求失败：HTTP ${response.status}`);
  return response.json();
}

export async function listCloudSkills(collection: "popular" | "trending" | "official", page: number, query = "", fetcher: typeof fetch = fetch): Promise<CloudSkillPage> {
  const search = query.trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new Error("云库页码无效");
  if (search.length > 100) throw new Error("搜索内容过长");
  const url = search
    ? `https://skills.sh/api/search?q=${encodeURIComponent(search)}&limit=100`
    : `https://skills.sh/api/skills/${collection === "trending" ? "trending" : "all-time"}/${page}`;
  const data = await getJson(url, fetcher) as { skills?: unknown; hasMore?: unknown };
  if (!Array.isArray(data.skills)) throw new Error("云库返回了无效数据");
  const skills = data.skills.flatMap((raw): CloudSkill[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.source !== "string" || !REPOSITORY.test(item.source) || typeof item.skillId !== "string" || !SKILL_ID.test(item.skillId)) return [];
    if (collection === "official" && !search && item.isOfficial !== true) return [];
    return [{ source: item.source, skillId: item.skillId, name: typeof item.name === "string" ? item.name : item.skillId, installs: typeof item.installs === "number" ? item.installs : 0, isOfficial: item.isOfficial === true }];
  });
  return { skills, page, hasMore: !search && data.hasMore === true };
}

function safeRelativeFile(file: string): boolean {
  return file.length > 0 && !file.includes("\\") && file.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes(":"));
}

async function readExactFile(response: Response, expectedSize: number): Promise<Buffer> {
  if (!response.body) throw new Error("Skill 文件响应为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedSize) throw new Error("Skill 文件大小与仓库清单不符");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size !== expectedSize) throw new Error("Skill 文件大小与仓库清单不符");
  return Buffer.concat(chunks, size);
}

export async function installCloudSkill(source: string, skillId: string, fetcher: typeof fetch = fetch): Promise<SkillInfo> {
  if (!REPOSITORY.test(source) || source.split("/").some((part) => part === "." || part === "..") || !SKILL_ID.test(skillId)) throw new Error("Skill 来源无效");
  const commit = await getJson(`https://api.github.com/repos/${source}/commits/HEAD`, fetcher) as { sha?: unknown };
  if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error("无法确定 Skill 仓库版本");
  const tree = await getJson(`https://api.github.com/repos/${source}/git/trees/${commit.sha}?recursive=1`, fetcher) as { tree?: unknown; truncated?: unknown };
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("Skill 仓库文件树不完整");
  const blobs = tree.tree.filter((entry): entry is GithubTreeEntry => Boolean(entry && typeof entry === "object" && typeof entry.path === "string" && entry.type === "blob" && entry.mode !== "120000"));
  const allRoots = blobs.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
    .map((entry) => entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length));
  const validRoots = allRoots.filter((root) => root.split("/").every((segment) => !IGNORED_ROOTS.has(segment.toLowerCase())));
  const roots = validRoots
    .filter((root) => (root.split("/").at(-1) || source.split("/")[1]) === skillId)
    .sort((a, b) => Number(!a.startsWith("skills/")) - Number(!b.startsWith("skills/")) || a.length - b.length);
  const root = roots[0] ?? (validRoots.length === 1 ? validRoots[0] : undefined);
  if (root === undefined) throw new Error("仓库中找不到该 Skill");
  const prefix = root ? `${root}/` : "";
  const files = blobs.filter((entry) => {
    if (!entry.path.startsWith(prefix)) return false;
    const relative = entry.path.slice(prefix.length);
    if (!safeRelativeFile(relative)) return false;
    if (!root && relative !== "SKILL.md" && !["scripts", "references", "templates", "assets"].includes(relative.split("/")[0]!)) return false;
    return !allRoots.some((nested) => nested !== root && nested.startsWith(prefix) && entry.path.startsWith(`${nested}/`));
  });
  const total = files.reduce((sum, entry) => sum + (entry.size ?? MAX_BYTES + 1), 0);
  if (files.length > MAX_FILES || total > MAX_BYTES || files.some((entry) => !Number.isSafeInteger(entry.size) || entry.size! < 0)) throw new Error("Skill 文件数量或大小超限");
  if (!files.some((entry) => entry.path === `${prefix}SKILL.md`)) throw new Error("Skill 缺少 SKILL.md");

  const agentDir = qoneAgentDir();
  const skillDir = path.join(agentDir, "skills");
  await mkdir(agentDir, { recursive: true });
  const staging = await mkdtemp(path.join(agentDir, ".skill-install-"));
  try {
    let downloaded = 0;
    for (let start = 0; start < files.length; start += 6) {
      await Promise.all(files.slice(start, start + 6).map(async (entry) => {
        const relative = entry.path.slice(prefix.length);
        const url = `https://raw.githubusercontent.com/${source}/${commit.sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
        const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Skill 文件下载失败：HTTP ${response.status}`);
        const bytes = await readExactFile(response, entry.size!);
        downloaded += bytes.byteLength;
        if (downloaded > MAX_BYTES) throw new Error("Skill 文件大小与仓库清单不符");
        const target = path.join(staging, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      }));
    }
    const loaded = loadSkillsFromDir({ dir: staging, source: "path" }).skills;
    if (loaded.length !== 1 || loaded[0]!.filePath !== path.join(staging, "SKILL.md")) throw new Error("下载的 Skill 格式无效");
    const skill = loaded[0]!;
    if (!SKILL_ID.test(skill.name)) throw new Error("Skill 名称无效");
    const destination = path.join(skillDir, skill.name);
    if (existsSync(destination)) throw new Error(`Skill ${skill.name} 已安装`);
    await mkdir(skillDir, { recursive: true });
    await rename(staging, destination);
    return { id: skill.name, name: skill.name, description: skill.description, path: path.join(destination, "SKILL.md") };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
