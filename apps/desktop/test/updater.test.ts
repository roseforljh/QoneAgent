import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "qone-updater-"));
const openedPaths: string[] = [];
const openedUrls: string[] = [];

mock.module("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.0.1",
    getPath: (name: string) => (name === "temp" ? tempRoot : tempRoot),
  },
  shell: {
    openPath: async (target: string) => {
      openedPaths.push(target);
      return "";
    },
    openExternal: async (url: string) => {
      openedUrls.push(url);
    },
  },
}));

const { compareVersions, DesktopUpdater, findAvailableUpdate, selectReleaseAsset } = await import("../electron/updater");

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("compareVersions and selectReleaseAsset handle semver tags and platform installers", () => {
  expect(compareVersions("v0.0.2", "0.0.1")).toBe(1);
  expect(compareVersions("v0.0.1", "0.0.1")).toBe(0);
  expect(compareVersions("1.0.0", "1.0.0-beta.1")).toBe(1);
  expect(compareVersions("nightly", "0.0.1")).toBeNull();

  const assets = [
    { name: "QoneAgent-Setup-0.0.2.exe.blockmap", browser_download_url: "https://github.com/a/b.blockmap" },
    { name: "QoneAgent-Setup-0.0.2-arm64.exe", browser_download_url: "https://github.com/a/arm64.exe" },
    { name: "QoneAgent-Setup-0.0.2-x64.exe", browser_download_url: "https://github.com/a/x64.exe" },
    { name: "QoneAgent-0.0.2-arm64.dmg", browser_download_url: "https://github.com/a/arm64.dmg" },
  ];
  expect(selectReleaseAsset(assets, "win32", "x64")?.name).toBe("QoneAgent-Setup-0.0.2-x64.exe");
  expect(selectReleaseAsset(assets, "darwin", "arm64")?.name).toBe("QoneAgent-0.0.2-arm64.dmg");

  const update = findAvailableUpdate([
    { tag_name: "v0.0.3-rc.1", html_url: "https://github.com/r/3", prerelease: true, assets },
    { tag_name: "v0.0.2", html_url: "https://github.com/r/2", assets },
    { tag_name: "v0.0.1", html_url: "https://github.com/r/1", assets },
  ], "0.0.1", "win32", "x64");
  expect(update).toEqual({
    version: "0.0.2",
    releaseUrl: "https://github.com/r/2",
    assetName: "QoneAgent-Setup-0.0.2-x64.exe",
    downloadUrl: "https://github.com/a/x64.exe",
    size: undefined,
  });
});

test("DesktopUpdater checks GitHub releases, downloads installer and opens it", async () => {
  const updater = new DesktopUpdater("roseforljh/QoneAgent");
  expect(await updater.check(5000, async () => new Response("[]", { status: 200 }))).toBeNull();

  const payload = new Uint8Array([77, 90, 1, 2, 3]);
  const releases = [{
    tag_name: "v0.0.2",
    html_url: "https://github.com/roseforljh/QoneAgent/releases/tag/v0.0.2",
    assets: [{
      name: "QoneAgent-Setup-0.0.2-x64.exe",
      browser_download_url: "https://github.com/roseforljh/QoneAgent/releases/download/v0.0.2/QoneAgent-Setup-0.0.2-x64.exe",
      size: payload.byteLength,
    }],
  }];

  const found = await updater.check(5000, async () => new Response(JSON.stringify(releases), { status: 200 }));
  expect(found).toEqual({ version: "0.0.2" });

  // Incomplete downloads clean up .part and reject.
  await expect(updater.downloadAndInstall("0.0.2", async () => new Response(new Uint8Array([77]), { status: 200 }))).rejects.toThrow("incomplete");
  const updateDir = path.join(tempRoot, "qone-updates");
  expect(existsSync(path.join(updateDir, "QoneAgent-Setup-0.0.2-x64.exe.part"))).toBe(false);

  const installed = await updater.downloadAndInstall("0.0.2", async () => new Response(payload, { status: 200 }));
  expect(installed.mode).toBe("installer");
  expect(readFileSync(installed.path!)).toEqual(Buffer.from(payload));
  expect(openedPaths.at(-1)).toBe(installed.path);
});

test("DesktopUpdater opens the GitHub release page when no matching asset exists", async () => {
  const updater = new DesktopUpdater("roseforljh/QoneAgent");
  const releases = [{
    tag_name: "v0.0.2",
    html_url: "https://github.com/roseforljh/QoneAgent/releases/tag/v0.0.2",
    assets: [],
  }];
  await updater.check(5000, async () => new Response(JSON.stringify(releases), { status: 200 }));
  const result = await updater.downloadAndInstall("0.0.2");
  expect(result).toEqual({ mode: "external" });
  expect(openedUrls.at(-1)).toBe("https://github.com/roseforljh/QoneAgent/releases/tag/v0.0.2");
});
