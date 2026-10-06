import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

const QONE_DIRECTORY = ".qone";

/** Resolve Qone's user-level data root. Tests and managed hosts may override it. */
export function qoneDataDir(): string {
  const configured = process.env.QONE_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  const home = process.env.USERPROFILE ?? process.env.HOME ?? os.homedir();
  return path.join(home, QONE_DIRECTORY);
}

export const qoneConfigDir = () => path.join(qoneDataDir(), "config");
export const qoneSystemPromptsDir = () => path.join(qoneDataDir(), "system-prompts");
export const qoneConfigDatabasePath = () => path.join(qoneConfigDir(), "settings.db");
export const qoneRuntimeDir = () => path.join(qoneDataDir(), "runtime");
export const qoneAuthDir = () => path.join(qoneDataDir(), "auth");
export const qoneDatabasePath = () => path.join(qoneRuntimeDir(), "qone.db");
export const qoneWebviewDir = () => path.join(qoneRuntimeDir(), "webview");
export const qonePiStateDir = () => path.join(qoneRuntimeDir(), "pi");
export const qoneSkillsDir = () => path.join(qoneDataDir(), "skills", "installed");
export const qoneBuiltinSkillsDir = () => path.join(qoneDataDir(), "skills", "builtin");
export const qoneSkillCacheDir = () => path.join(qoneDataDir(), "skills", "cache");
export const qonePluginsDir = () => path.join(qoneDataDir(), "plugins", "installed");
export const qonePluginCacheDir = () => path.join(qoneDataDir(), "plugins", "cache");
export const qonePluginDataDir = () => path.join(qoneDataDir(), "plugins", "data");
export const qoneMcpDir = () => path.join(qoneDataDir(), "mcp");
export const qoneMcpDatabasePath = () => path.join(qoneMcpDir(), "servers.db");
export const qoneProjectsDir = () => path.join(qoneDataDir(), "projects");
export const qoneLogsDir = () => path.join(qoneDataDir(), "logs");
export const qoneCacheDir = () => path.join(qoneDataDir(), "cache");

/** Runtime scratch files stay inside Qone's cache and retain their normal cleanup. */
export function qoneTemporaryDir(): string {
  const directory = path.join(qoneCacheDir(), "tmp");
  mkdirSync(directory, { recursive: true });
  return directory;
}

/** Create the stable top-level layout without creating any user content. */
export function ensureQoneLayout(): string {
  const directories = [
    qoneConfigDir(), qoneRuntimeDir(), qoneWebviewDir(), qoneAuthDir(), qoneSkillsDir(), qoneSkillCacheDir(),
    qonePluginsDir(), qonePluginCacheDir(), qonePluginDataDir(), qoneMcpDir(), qoneProjectsDir(), qoneLogsDir(), qoneCacheDir(),
  ];
  for (const directory of directories) mkdirSync(directory, { recursive: true });
  return qoneDataDir();
}

/** IDs are encoded rather than using titles or filesystem paths as directory names. */
export function qoneProjectDir(projectId: string, projectsDir = qoneProjectsDir()): string {
  return path.join(projectsDir, directoryId(projectId));
}

export function qoneSessionDir(projectId: string, sessionId: string, projectsDir = qoneProjectsDir()): string {
  return path.join(qoneProjectDir(projectId, projectsDir), "sessions", directoryId(sessionId));
}

function directoryId(id: string): string {
  if (!id || id === "." || id === "..") throw new Error("Invalid resource ID");
  // Prefix also keeps Windows reserved names (CON, NUL, ...) valid.
  return `id-${encodeURIComponent(id).replace(/\./g, "%2E")}`;
}
