import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SettingsRepo } from "@qone/database";
import type { SkillInfo } from "@qone/protocol";
import { qoneBuiltinSkillsDir, qoneSkillCacheDir } from "@qone/shared";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { downloadGithubSkill } from "../skill-catalog.js";
import { syncPonytailProjectInstructions } from "../project-instructions.js";
import { builtinSkillBundles } from "./identity.js";
import { runtimeError } from "../runtime-localization.js";

type BuiltinState = { enabled: boolean; revision: string };
let preferences: Pick<SettingsRepo, "get" | "set"> | undefined;
let pending: Promise<unknown> = Promise.resolve();
const installations = new Map<string, Promise<SkillInfo>>();

export function configureBuiltinSkills(repo?: Pick<SettingsRepo, "get" | "set">): void {
  preferences = repo;
}

function serial<T>(action: () => Promise<T>): Promise<T> {
  const result = pending.then(action);
  pending = result.catch(() => undefined);
  return result;
}

function bundleFor(id: string) {
  const bundle = builtinSkillBundles.find((entry) => entry.id === id);
  if (!bundle) throw runtimeError("skills.builtin.unknown");
  return bundle;
}

function stateFor(id: string): BuiltinState {
  const bundle = bundleFor(id);
  const stored = preferences?.get<BuiltinState>(`skills.builtin.${id}`);
  return {
    enabled: stored?.enabled !== false,
    revision: typeof stored?.revision === "string" && /^[a-f0-9]{40}$/.test(stored.revision) ? stored.revision : bundle.revision,
  };
}

function versionDirectory(id: string, revision: string): string {
  return path.join(qoneBuiltinSkillsDir(), id, revision);
}

function describe(id: string, state: BuiltinState): SkillInfo {
  const directory = versionDirectory(id, state.revision);
  const skills = loadSkillsFromDir({ dir: directory, source: "path" }).skills;
  if (skills.length !== 1 || skills[0]?.name !== id || skills[0].filePath !== path.join(directory, "SKILL.md")) {
    throw runtimeError("skills.builtin.invalid");
  }
  const skill = skills[0];
  return { id, name: skill.name, description: skill.description, path: skill.filePath, builtin: true, enabled: state.enabled, source: bundleFor(id).source, revision: state.revision };
}

function ensureSkill(id: string): Promise<SkillInfo> {
  const key = path.join(qoneBuiltinSkillsDir(), bundleFor(id).id);
  const existing = installations.get(key);
  if (existing) return existing;
  const installation = restoreSkill(id);
  installations.set(key, installation);
  void installation.then(() => installations.delete(key), () => installations.delete(key));
  return installation;
}

async function restoreSkill(id: string): Promise<SkillInfo> {
  const state = stateFor(id);
  const bundle = bundleFor(id);
  if (existsSync(path.join(versionDirectory(id, state.revision), "SKILL.md"))) return describe(id, state);
  // Restore the bundled copy offline if an external file operation removed it.
  const directory = versionDirectory(id, bundle.revision);
  await mkdir(qoneSkillCacheDir(), { recursive: true });
  const staging = await mkdtemp(path.join(qoneSkillCacheDir(), ".builtin-install-"));
  try {
    for (const [file, content] of Object.entries(bundle.files)) await writeFile(path.join(staging, file), content, "utf8");
    await mkdir(path.dirname(directory), { recursive: true });
    if (!existsSync(directory)) {
      await rename(staging, directory);
    } else {
      // Restore individual files atomically if the directory survived deletion.
      for (const file of Object.keys(bundle.files)) await rename(path.join(staging, file), path.join(directory, file));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  state.revision = bundle.revision;
  const skill = describe(id, state);
  preferences?.set(`skills.builtin.${id}`, state);
  return skill;
}

export function listBuiltinSkills(): Promise<SkillInfo[]> {
  // Updates download in the mutation queue; catalog reads and new sessions can
  // continue using the active immutable version while the network is busy.
  return Promise.all(builtinSkillBundles.map((bundle) => ensureSkill(bundle.id)));
}

export function setBuiltinSkillEnabled(id: string, enabled: boolean): Promise<SkillInfo> {
  return serial(async () => {
    const skill = await ensureSkill(id);
    if (!preferences) throw runtimeError("skills.builtin.unavailable");
    preferences.set(`skills.builtin.${id}`, { enabled, revision: skill.revision! });
    return { ...skill, enabled };
  });
}

export async function syncPonytailProject(cwd: string, enabled: boolean = stateFor("ponytail").enabled): Promise<void> {
  const skill = await ensureSkill("ponytail");
  await syncPonytailProjectInstructions(cwd, enabled, skill.path);
}

export function updateBuiltinSkill(id: string, fetcher: typeof fetch = fetch): Promise<{ skill: SkillInfo; updated: boolean }> {
  return serial(async () => {
    const current = await ensureSkill(id);
    if (!preferences) throw runtimeError("skills.builtin.unavailable");
    const bundle = bundleFor(id);
    const downloaded = await downloadGithubSkill(bundle.source, id, fetcher, { fresh: true, license: true });
    try {
      if (downloaded.skill.name !== id) throw runtimeError("skills.builtin.nameChanged");
      const destination = versionDirectory(id, downloaded.revision);
      if (!existsSync(destination)) {
        await mkdir(path.dirname(destination), { recursive: true });
        await rename(downloaded.directory, destination);
      }
      const state = { enabled: current.enabled !== false, revision: downloaded.revision };
      const skill = describe(id, state);
      // Activate only after a complete download and validation. Older versions stay
      // available to in-flight sessions; refreshSkills rebuilds them when idle.
      preferences.set(`skills.builtin.${id}`, state);
      return { skill, updated: current.revision !== downloaded.revision };
    } finally {
      await rm(downloaded.directory, { recursive: true, force: true });
    }
  });
}
