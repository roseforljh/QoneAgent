import path from "node:path";
import { existsSync, readdirSync, realpathSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { qoneConfigDir, qonePiStateDir } from "@qone/shared";
import { isBuiltinSkillName } from "../builtin-skills/identity";
import { readObject, readOptional, revisionOf, type ClaudePaths } from "./source";
import type { ClaudeCodeSyncIssue } from "@qone/protocol";

export type SyncedSkill = { name: string; path: string; signature: string; pluginRoot?: string };
export const syncedSkillsFile = () => path.join(qoneConfigDir(), "claude-code-skills.json");
export function syncedSkills(): SyncedSkill[] {
  const data = readObject(syncedSkillsFile());
  if (!Array.isArray(data?.skills)) return [];
  return data.skills.filter((item: unknown): item is SyncedSkill => Boolean(item && typeof item === "object" && typeof (item as SyncedSkill).path === "string" && typeof (item as SyncedSkill).name === "string" && typeof (item as SyncedSkill).signature === "string" && ((item as SyncedSkill).pluginRoot === undefined || typeof (item as SyncedSkill).pluginRoot === "string")));
}
export function saveSyncedSkills(skills: SyncedSkill[]) {
  const file = syncedSkillsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const staging = `${file}.${crypto.randomUUID()}.tmp`;
  writeFileSync(staging, JSON.stringify({ skills }, null, 2));
  renameSync(staging, file);
}
export function readClaudeSkills(paths: ClaudePaths, ownNames: ReadonlySet<string>) {
  const issues: ClaudeCodeSyncIssue[] = [];
  const candidates: { path: string; pluginRoot?: string }[] = [];
  const userRoot = path.join(paths.root, "skills");
  if (existsSync(userRoot)) {
    for (const item of readdirSync(userRoot, { withFileTypes: true })) {
      if (item.isDirectory() || item.isSymbolicLink()) candidates.push({ path: path.join(userRoot, item.name) });
    }
  }
  const enabled = readObject(path.join(paths.root, "settings.json"))?.enabledPlugins ?? {};
  const plugins = readObject(path.join(paths.root, "plugins", "installed_plugins.json"))?.plugins ?? {};
  if (typeof enabled !== "object" || Array.isArray(enabled) || typeof plugins !== "object" || Array.isArray(plugins)) throw new Error("Invalid Claude Code plugin configuration");
  for (const [key, versions] of Object.entries(plugins)) {
    if (enabled[key] !== true || !Array.isArray(versions)) continue;
    const install = versions.find(item => item?.scope === "user" && typeof item.installPath === "string");
    if (!install) continue;
    const root = path.resolve(install.installPath);
    try {
      const manifest = readObject(path.join(root, ".claude-plugin", "plugin.json"));
      const configured = manifest?.skills;
      const roots = new Set<string>([path.join(root, "skills")]);
      for (const relative of typeof configured === "string" ? [configured] : Array.isArray(configured) ? configured : []) {
        if (typeof relative !== "string" || path.isAbsolute(relative)) throw new Error();
        const full = path.resolve(root, relative);
        if (path.relative(root, full).startsWith("..")) throw new Error();
        roots.add(full);
      }
      if (configured === undefined && !existsSync(path.join(root, "skills")) && existsSync(path.join(root, "SKILL.md"))) roots.add(root);
      for (const candidate of roots) if (existsSync(candidate)) candidates.push({ path: candidate, pluginRoot: root });
    } catch { issues.push({ name: key, code: "invalid" }); }
  }
  const skills: SyncedSkill[] = [];
  const seenPaths = new Set<string>();
  const names = new Set(ownNames);
  let found = 0;
  for (const candidate of candidates) {
    try {
      const loaded = loadSkills({ cwd: paths.root, agentDir: qonePiStateDir(), skillPaths: [candidate.path], includeDefaults: false });
      const valid = loaded.skills.filter(skill => path.basename(skill.filePath) === "SKILL.md");
      const rejected = new Set(loaded.diagnostics.filter(diagnostic => diagnostic.path && path.basename(diagnostic.path) === "SKILL.md" && !valid.some(skill => skill.filePath === diagnostic.path)).map(diagnostic => diagnostic.path!));
      for (const file of rejected) { found++; issues.push({ name: path.basename(path.dirname(file)), code: "invalid" }); }
      for (const skill of valid) {
        const real = realpathSync(skill.filePath);
        if (seenPaths.has(real)) continue;
        seenPaths.add(real);
        found++;
        if (isBuiltinSkillName(skill.name)) { issues.push({ name: skill.name, code: "builtin" }); continue; }
        if (names.has(skill.name)) { issues.push({ name: skill.name, code: "conflict" }); continue; }
        names.add(skill.name);
        skills.push({ name: skill.name, path: real, signature: revisionOf(readOptional(real)), ...(candidate.pluginRoot ? { pluginRoot: candidate.pluginRoot } : {}) });
      }
    } catch { issues.push({ name: path.basename(candidate.path), code: "unreadable" }); }
  }
  return { skills, issues, found };
}
