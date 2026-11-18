import { afterAll, expect, mock, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempRoot = mkdtempSync(path.join(tmpdir(), "qone-updater-"));
const openedPaths: string[] = [];
const openedUrls: string[] = [];
const quit = mock(() => {});

mock.module("electron", () => ({
  app: {
    isPackaged: true,
    getVersion: () => "0.0.1",
    getPath: (name: string) => (name === "temp" ? tempRoot : tempRoot),
    quit,
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

test("DesktopUpdater downloads with progress, resumes an interrupted download and installs", async () => {
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
  const updateDir = path.join(tempRoot, "qone-updates");
  const partPath = path.join(updateDir, "QoneAgent-Setup-0.0.2-x64.exe.part");

  // A dropped connection keeps the partial bytes on disk.
  let reads = 0;
  const dropped = new ReadableStream({ pull(controller) { if (reads++ === 0) controller.enqueue(payload.slice(0, 2)); else controller.error(new Error("socket hang up")); } });
  await expect(updater.download("0.0.2", undefined, async () => new Response(dropped, { status: 200 }))).rejects.toThrow("socket hang up");
  expect(readFileSync(partPath)).toEqual(Buffer.from(payload.slice(0, 2)));

  // The retry asks only for the missing range and reports progress up to 100%.
  let range: string | null = null;
  const progress: number[] = [];
  const result = await updater.download("0.0.2", (percent) => progress.push(percent), async (_url, init) => {
    range = new Headers(init?.headers).get("Range");
    return new Response(payload.slice(2), { status: 206 });
  });
  expect(result).toEqual({ mode: "ready" });
  expect(range).toBe("bytes=2-");
  expect(progress.at(-1)).toBe(100);
  expect(readFileSync(path.join(updateDir, "QoneAgent-Setup-0.0.2-x64.exe"))).toEqual(Buffer.from(payload));
  expect(existsSync(partPath)).toBe(false);

  // Restart shows NSIS, and Qone only quits once it has started.
  let child = new childProcess.ChildProcess();
  const launch = spyOn(childProcess, "spawn").mockImplementation(() => child);
  try {
    const failed = updater.install(true);
    child.emit("error", new Error("installer could not start"));
    await expect(failed).rejects.toThrow("installer could not start");
    expect(quit).not.toHaveBeenCalled();

    child = new childProcess.ChildProcess();
    const restart = updater.install(true);
    expect(launch.mock.lastCall?.[1]).toEqual(["--updated"]);
    expect(quit).not.toHaveBeenCalled();
    child.emit("spawn");
    await restart;
    expect(quit).toHaveBeenCalledTimes(1);

    // Later still schedules a silent install without relaunching Qone.
    await updater.install(false);
    expect(launch).toHaveBeenCalledTimes(2);
    updater.installDeferredUpdate();
    expect(launch.mock.lastCall?.[1]).toEqual(["/S", "--updated"]);
    child.emit("spawn");
    expect(quit).toHaveBeenCalledTimes(1);
  } finally {
    launch.mockRestore();
  }

  // A size mismatch is rejected and never left behind for resumption.
  rmSync(path.join(updateDir, "QoneAgent-Setup-0.0.2-x64.exe"));
  await expect(updater.download("0.0.2", undefined, async () => new Response(new Uint8Array([77]), { status: 200 }))).rejects.toThrow("incomplete");
  expect(existsSync(partPath)).toBe(false);
});

test("DesktopUpdater opens the GitHub release page when no matching asset exists", async () => {
  const updater = new DesktopUpdater("roseforljh/QoneAgent");
  const releases = [{
    tag_name: "v0.0.2",
    html_url: "https://github.com/roseforljh/QoneAgent/releases/tag/v0.0.2",
    assets: [],
  }];
  await updater.check(5000, async () => new Response(JSON.stringify(releases), { status: 200 }));
  const result = await updater.download("0.0.2");
  expect(result).toEqual({ mode: "external" });
  expect(openedUrls.at(-1)).toBe("https://github.com/roseforljh/QoneAgent/releases/tag/v0.0.2");
});
