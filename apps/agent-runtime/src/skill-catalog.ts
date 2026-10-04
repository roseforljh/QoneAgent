import { runtimeError } from "./runtime-localization";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { SKILL_CATALOG_TIMEOUT } from "@qone/protocol";
import { qoneSkillsDir, qoneSkillCacheDir } from "@qone/shared";
import { type SkillInfo } from "./skills.js";

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
  total: number;
  pageSize: number;
  hasMore: boolean;
}

type GithubTreeEntry = { path: string; type: string; size?: number; mode?: string };
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SKILL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IGNORED_ROOTS = new Set([".git", ".github", "node_modules", "build", "dist", "references", "templates", "assets", "scripts", "examples", "example", "test", "tests"]);
const MAX_FILES = 1_000;
const MAX_BYTES = 100 * 1024 * 1024;
const CATALOG_CACHE_MAX_AGE = 10 * 60 * 1_000;
const CATALOG_REQUEST_TIMEOUT = 20_000;

/** AbortSignal.timeout rejects with a DOMException named TimeoutError; report it as a code the UI can translate. */
function catalogError(error: unknown): Error {
  if ((error as { name?: unknown } | undefined)?.name === "TimeoutError") return new Error(SKILL_CATALOG_TIMEOUT);
  return error instanceof Error ? error : runtimeError("skill-catalog.skill_catalog_request_failed", {});
}

async function getJson(url: string, fetcher: typeof fetch): Promise<unknown> {
  const canCache = fetcher === fetch;
  const cachePath = canCache ? path.join(qoneSkillCacheDir(), "catalog", `${createHash("sha256").update(url).digest("hex")}.json`) : undefined;
  const readCache = async () => {
    if (!cachePath) return undefined;
    try {
      const [metadata, body] = await Promise.all([stat(cachePath), readFile(cachePath, "utf8")]);
      return { body: JSON.parse(body) as unknown, fresh: Date.now() - metadata.mtimeMs < CATALOG_CACHE_MAX_AGE };
    } catch {
      return undefined;
    }
  };
  const cached = await readCache();
  if (cached?.fresh) return cached.body;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetcher(url, { headers: { Accept: "application/json", "User-Agent": "QoneAgent-Skills" }, signal: AbortSignal.timeout(CATALOG_REQUEST_TIMEOUT) });
      if (!response.ok) throw runtimeError("skill-catalog.skill_catalog_request_failed_http", { p0: response.status });
      const body = await response.json() as unknown;
      if (cachePath) {
        await mkdir(path.dirname(cachePath), { recursive: true });
        await writeFile(cachePath, JSON.stringify(body), "utf8");
      }
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (cached) return cached.body;
  throw catalogError(lastError);
}

export async function listCloudSkills(collection: "popular" | "trending" | "official", page: number, query = "", fetcher: typeof fetch = fetch): Promise<CloudSkillPage> {
  const search = query.trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw runtimeError("skill-catalog.invalid_skill_catalog_page_number", {});
  if (search.length > 100) throw runtimeError("skill-catalog.the_search_query_is_too_long", {});
  const url = search
    ? `https://skills.sh/api/search?q=${encodeURIComponent(search)}&limit=100`
    : `https://skills.sh/api/skills/${collection === "trending" ? "trending" : "all-time"}/${page}`;
  const data = await getJson(url, fetcher) as { skills?: unknown; total?: unknown; hasMore?: unknown };
  if (!Array.isArray(data.skills)) throw runtimeError("skill-catalog.the_skill_catalog_returned_invalid_data", {});
  const skills = data.skills.flatMap((raw): CloudSkill[] => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.source !== "string" || !REPOSITORY.test(item.source) || typeof item.skillId !== "string" || !SKILL_ID.test(item.skillId)) return [];
    if (collection === "official" && !search && item.isOfficial !== true) return [];
    return [{ source: item.source, skillId: item.skillId, name: typeof item.name === "string" ? item.name : item.skillId, installs: typeof item.installs === "number" ? item.installs : 0, isOfficial: item.isOfficial === true }];
  });
  const pageSize = data.skills.length;
  return {
    skills,
    page,
    total: typeof data.total === "number" && Number.isSafeInteger(data.total) ? data.total : skills.length,
    pageSize,
    hasMore: !search && data.hasMore === true,
  };
}

function safeRelativeFile(file: string): boolean {
  return file.length > 0 && !file.includes("\\") && file.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !segment.includes(":"));
}

async function readExactFile(response: Response, expectedSize: number): Promise<Buffer> {
  if (!response.body) throw runtimeError("skill-catalog.the_skill_file_response_is_empty", {});
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > expectedSize) throw runtimeError("skill-catalog.the_skill_file_size_does_not_match_the_repository", {});
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (size !== expectedSize) throw runtimeError("skill-catalog.the_skill_file_size_does_not_match_the_repository", {});
  return Buffer.concat(chunks, size);
}

export async function installCloudSkill(source: string, skillId: string, fetcher: typeof fetch = fetch): Promise<SkillInfo> {
  if (!REPOSITORY.test(source) || source.split("/").some((part) => part === "." || part === "..") || !SKILL_ID.test(skillId)) throw runtimeError("skill-catalog.invalid_skill_source", {});
  const commit = await getJson(`https://api.github.com/repos/${source}/commits/HEAD`, fetcher) as { sha?: unknown };
  if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha)) throw runtimeError("skill-catalog.could_not_determine_the_skill_repository_revision", {});
  const tree = await getJson(`https://api.github.com/repos/${source}/git/trees/${commit.sha}?recursive=1`, fetcher) as { tree?: unknown; truncated?: unknown };
  if (tree.truncated || !Array.isArray(tree.tree)) throw runtimeError("skill-catalog.the_skill_repository_file_tree_is_incomplete", {});
  const blobs = tree.tree.filter((entry): entry is GithubTreeEntry => Boolean(entry && typeof entry === "object" && typeof entry.path === "string" && entry.type === "blob" && entry.mode !== "120000"));
  const allRoots = blobs.filter((entry) => entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md"))
    .map((entry) => entry.path === "SKILL.md" ? "" : entry.path.slice(0, -"/SKILL.md".length));
  const validRoots = allRoots.filter((root) => root.split("/").every((segment) => !IGNORED_ROOTS.has(segment.toLowerCase())));
  const roots = validRoots
    .filter((root) => (root.split("/").at(-1) || source.split("/")[1]) === skillId)
    .sort((a, b) => Number(!a.startsWith("skills/")) - Number(!b.startsWith("skills/")) || a.length - b.length);
  const root = roots[0] ?? (validRoots.length === 1 ? validRoots[0] : undefined);
  if (root === undefined) throw runtimeError("skill-catalog.the_skill_was_not_found_in_the_repository", {});
  const prefix = root ? `${root}/` : "";
  const files = blobs.filter((entry) => {
    if (!entry.path.startsWith(prefix)) return false;
    const relative = entry.path.slice(prefix.length);
    if (!safeRelativeFile(relative)) return false;
    if (!root && relative !== "SKILL.md" && !["scripts", "references", "templates", "assets"].includes(relative.split("/")[0]!)) return false;
    return !allRoots.some((nested) => nested !== root && nested.startsWith(prefix) && entry.path.startsWith(`${nested}/`));
  });
  const total = files.reduce((sum, entry) => sum + (entry.size ?? MAX_BYTES + 1), 0);
  if (files.length > MAX_FILES || total > MAX_BYTES || files.some((entry) => !Number.isSafeInteger(entry.size) || entry.size! < 0)) throw runtimeError("skill-catalog.the_skill_file_count_or_size_exceeds_the_limit", {});
  if (!files.some((entry) => entry.path === `${prefix}SKILL.md`)) throw runtimeError("skill-catalog.the_skill_is_missing_skill_md", {});

  const skillDir = qoneSkillsDir();
  const cacheDir = qoneSkillCacheDir();
  await mkdir(cacheDir, { recursive: true });
  const staging = await mkdtemp(path.join(cacheDir, ".skill-install-"));
  try {
    let downloaded = 0;
    for (let start = 0; start < files.length; start += 6) {
      await Promise.all(files.slice(start, start + 6).map(async (entry) => {
        const relative = entry.path.slice(prefix.length);
        const url = `https://raw.githubusercontent.com/${source}/${commit.sha}/${entry.path.split("/").map(encodeURIComponent).join("/")}`;
        const response = await fetcher(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw runtimeError("skill-catalog.skill_file_download_failed_http", { p0: response.status });
        const bytes = await readExactFile(response, entry.size!);
        downloaded += bytes.byteLength;
        if (downloaded > MAX_BYTES) throw runtimeError("skill-catalog.the_skill_file_size_does_not_match_the_repository", {});
        const target = path.join(staging, ...relative.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, bytes);
      })).catch((error) => { throw catalogError(error); });
    }
    const loaded = loadSkillsFromDir({ dir: staging, source: "path" }).skills;
    if (loaded.length !== 1 || loaded[0]!.filePath !== path.join(staging, "SKILL.md")) throw runtimeError("skill-catalog.invalid_downloaded_skill_format", {});
    const skill = loaded[0]!;
    if (!SKILL_ID.test(skill.name)) throw runtimeError("skill-catalog.invalid_skill_name", {});
    const destination = path.join(skillDir, skill.name);
    if (existsSync(destination)) throw runtimeError("skill-catalog.skill_is_already_installed", { p0: skill.name });
    await mkdir(skillDir, { recursive: true });
    await rename(staging, destination);
    return { id: skill.name, name: skill.name, description: skill.description, path: path.join(destination, "SKILL.md") };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
