import { app, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

export interface GitHubRelease {
  tag_name: string;
  name?: string;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GitHubReleaseAsset[];
}

export interface PendingUpdate {
  version: string;
  releaseUrl: string;
  assetName?: string;
  downloadUrl?: string;
  size?: number;
}

const DEFAULT_REPO = "roseforljh/QoneAgent";
const CHECK_TIMEOUT_MS = 10_000;
// Resumable, so a slow link continues on the next attempt instead of restarting.
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

interface ParsedVersion {
  core: [number, number, number];
  pre: (number | string)[];
}

export function parseVersion(raw: string): ParsedVersion | null {
  const cleaned = raw.trim().replace(/^[vV]/, "").split("+")[0] ?? "";
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(cleaned);
  if (!match) return null;
  const core: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const pre = match[4]
    ? match[4].split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : [];
  return { core, pre };
}

export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const len = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < len; i++) {
    const l = left.pre[i];
    const r = right.pre[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    if (typeof l === "number" && typeof r === "number") return l > r ? 1 : -1;
    if (typeof l === "number") return -1;
    if (typeof r === "number") return 1;
    return l > r ? 1 : -1;
  }
  return 0;
}

export function selectReleaseAsset(
  assets: readonly GitHubReleaseAsset[] = [],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): GitHubReleaseAsset | undefined {
  const valid = assets.filter((asset) => {
    if (!asset?.name || !asset.browser_download_url) return false;
    try {
      if (new URL(asset.browser_download_url).protocol !== "https:") return false;
    } catch {
      return false;
    }
    const lower = asset.name.toLowerCase();
    return !lower.endsWith(".blockmap") && !lower.endsWith(".yml") && !lower.endsWith(".yaml") && !lower.endsWith(".sha256");
  });

  const extensions =
    platform === "win32"
      ? [".exe", ".msi"]
      : platform === "darwin"
        ? [".dmg", ".pkg", ".zip"]
        : [".appimage", ".deb", ".rpm"];

  for (const ext of extensions) {
    const candidates = valid.filter((asset) => asset.name.toLowerCase().endsWith(ext));
    if (!candidates.length) continue;
    const archMatch = candidates.find((asset) => asset.name.toLowerCase().includes(arch.toLowerCase()));
    return archMatch ?? candidates[0];
  }
  return undefined;
}

export function findAvailableUpdate(
  releases: readonly GitHubRelease[],
  currentVersion: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PendingUpdate | null {
  let best: { release: GitHubRelease; version: string } | undefined;
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.tag_name) continue;
    const cmp = compareVersions(release.tag_name, currentVersion);
    if (cmp === null || cmp <= 0) continue;
    if (!best || (compareVersions(release.tag_name, best.version) ?? 0) > 0) {
      best = { release, version: release.tag_name.replace(/^[vV]/, "") };
    }
  }
  if (!best) return null;
  const asset = selectReleaseAsset(best.release.assets, platform, arch);
  return {
    version: best.version,
    releaseUrl: best.release.html_url,
    assetName: asset?.name,
    downloadUrl: asset?.browser_download_url,
    size: asset?.size,
  };
}

export class DesktopUpdater {
  private pending: PendingUpdate | null = null;
  private readyPath: string | null = null;
  private installOnQuit = false;
  private readonly repo: string;

  constructor(repo = process.env.QONE_UPDATE_REPO || DEFAULT_REPO, private readonly fetchRelease: typeof fetch = (...args) => fetch(...args)) {
    this.repo = repo;
  }

  private currentVersion(): string {
    if (app.isPackaged) return app.getVersion();
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // Fallback to Electron's reported version when package.json is unreachable.
    }
    return app.getVersion();
  }

  async check(timeoutMs = CHECK_TIMEOUT_MS, fetchFn: typeof fetch = this.fetchRelease): Promise<{ version: string } | null> {
    const current = this.currentVersion();
    const url = `https://api.github.com/repos/${this.repo}/releases?per_page=10`;
    const response = await fetchFn(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `QoneAgent/${current}`,
      },
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed (${response.status})`);
    }
    const releases = (await response.json()) as GitHubRelease[];
    if (!Array.isArray(releases)) {
      throw new Error("Unexpected GitHub releases response");
    }
    const update = findAvailableUpdate(releases, current);
    this.pending = update;
    return update ? { version: update.version } : null;
  }

  async download(
    expectedVersion?: string,
    onProgress?: (percent: number) => void,
    fetchFn: typeof fetch = this.fetchRelease,
  ): Promise<{ mode: "ready" | "external" }> {
    const target = this.pending;
    if (!target || (expectedVersion && target.version !== expectedVersion)) {
      throw new Error("No pending update matches the requested version");
    }
    if (!target.downloadUrl || !target.assetName) {
      await shell.openExternal(target.releaseUrl);
      return { mode: "external" };
    }

    const parsedUrl = new URL(target.downloadUrl);
    if (parsedUrl.protocol !== "https:") {
      throw new Error("Refusing insecure update download URL");
    }

    const updateDir = path.join(app.getPath("temp"), "qone-updates");
    fs.mkdirSync(updateDir, { recursive: true });
    const destPath = path.join(updateDir, path.basename(target.assetName));
    const partPath = `${destPath}.part`;

    if (!target.size || !fs.existsSync(destPath) || fs.statSync(destPath).size !== target.size) {
      // An interrupted download resumes from the bytes already on disk.
      let offset = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
      if (target.size && offset >= target.size) {
        fs.rmSync(partPath, { force: true });
        offset = 0;
      }
      const response = await fetchFn(target.downloadUrl, {
        headers: { "User-Agent": `QoneAgent/${this.currentVersion()}`, ...(offset ? { Range: `bytes=${offset}-` } : {}) },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Update download failed (${response.status})`);
      }
      const resumed = offset > 0 && response.status === 206;
      const total = target.size ?? (Number(response.headers.get("content-length")) || 0) + (resumed ? offset : 0);
      let received = resumed ? offset : 0;
      let reported = -1;
      // Each chunk is on disk before the next is read, so a dropped connection keeps every byte received.
      const file = await fs.promises.open(partPath, resumed ? "a" : "w");
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          await file.write(chunk);
          received += chunk.length;
          const percent = total ? Math.min(100, Math.floor((received / total) * 100)) : 0;
          if (percent !== reported) onProgress?.(reported = percent);
        }
      } finally { await file.close(); }
      const size = fs.statSync(partPath).size;
      if (size === 0 || (target.size && size !== target.size)) {
        fs.rmSync(partPath, { force: true });
        throw new Error("Downloaded update package is incomplete");
      }
      fs.renameSync(partPath, destPath);
    }
    this.readyPath = destPath;
    return { mode: "ready" };
  }

  /** On Windows, restarting shows the installer; only deferred updates are silent. */
  async install(now: boolean): Promise<void> {
    const installer = this.readyPath;
    if (!installer) throw new Error("No downloaded update to install");
    if (process.platform !== "win32" || !installer.toLowerCase().endsWith(".exe")) {
      const openError = await shell.openPath(installer);
      if (openError) throw new Error(openError);
      return;
    }
    this.installOnQuit = !now;
    if (!now) return;
    await this.launchInstaller(false);
    app.quit();
  }

  /** Called from will-quit: finishes an update the user deferred. */
  installDeferredUpdate(): void {
    if (this.installOnQuit) {
      void this.launchInstaller(true).catch((error) => console.error("[updater] Deferred installer failed to start:", error));
    }
  }

  private launchInstaller(silent: boolean): Promise<void> {
    this.installOnQuit = false;
    // --updated lets the installer wait for this process to exit instead of prompting.
    const args = silent ? ["/S", "--updated"] : ["--updated"];
    return new Promise((resolve, reject) => {
      const child = spawn(this.readyPath!, args, { detached: true, stdio: "ignore" });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
  }
}
