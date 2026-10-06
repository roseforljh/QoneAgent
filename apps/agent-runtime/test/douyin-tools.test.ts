import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDouyinTools } from "../src/douyin-tools";
import { evaluatePermission } from "../src/permissions";
import { DouyinBridgeError } from "../src/douyin-bridge";

const bridge = {
  resolveAuthor: async () => ({ videoPageUrl: "https://www.douyin.com/video/123", contentId: "123", authorId: "MS4w-test", profileUrl: "https://www.douyin.com/user/MS4w-test", nickname: "Creator" }),
  request: async () => ({ pageUrl: "", videoUrl: "" }),
  listAuthor: async () => ({ pageUrl: "https://www.douyin.com/user/MS4w-test", authorId: "MS4w-test", nickname: "Creator",
    videos: [], completion: "exhausted" as const }),
};

test("a share link has a dedicated embedded creator lookup before listing works", async () => {
  const tools = createDouyinTools(bridge, process.cwd());
  const lookup = tools.find((tool) => tool.name === "qone_douyin_resolve_author")!;
  const result = await lookup.execute("lookup", { url: "https://v.douyin.com/share/" }, new AbortController().signal, undefined, undefined as never);
  expect(result.details).toMatchObject({ profileUrl: "https://www.douyin.com/user/MS4w-test", contentId: "123" });
  expect(tools[0]?.promptSnippet).toContain("Old OpenCLI/browser successes");
});

test("creator tools save a deduplicated batch persistently without media capabilities or overwriting existing files", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "qone-douyin-tools-"));
  const temporary: string[] = [];
  const download = async (url: string) => {
    if (url.endsWith("/3")) throw Object.assign(new Error("failure with private CDN URL"), { code: "HTTP_FAILED" });
    const directory = await mkdtemp(path.join(tmpdir(), "qone-douyin-source-"));
    temporary.push(directory);
    const filePath = path.join(directory, "media.mp4");
    await writeFile(filePath, `video-${url.at(-1)}`);
    return { path: filePath, directory, mimeType: "video/mp4" };
  };
  const tools = createDouyinTools(bridge, workspace, download);
  const save = tools.find((tool) => tool.name === "qone_douyin_download")!;
  const list = tools.find((tool) => tool.name === "qone_douyin_list_videos")!;
  try {
    const listed = await list.execute("list", { url: "https://www.douyin.com/user/MS4w-test", limit: 10 }, new AbortController().signal, undefined, undefined as never);
    expect(listed.details).toMatchObject({ completion: "exhausted" });
    const input = { urls: ["1", "1", "2", "3"].map((id) => `https://www.douyin.com/video/${id}`), path: "saved" };
    const result = await save.execute("batch", input, new AbortController().signal, undefined, undefined as never);
    expect(result.details).toMatchObject({ requested: 3, saved: 2, failed: 1, cancelled: false });
    expect(result.isError).toBe(true);
    expect(await readFile(path.join(workspace, "saved", "1.mp4"), "utf8")).toBe("video-1");
    expect(await readdir(path.join(workspace, "saved"))).toEqual(["1.mp4", "2.mp4"]);
    expect(JSON.stringify(result)).not.toContain("private CDN");
    await writeFile(path.join(workspace, "saved", "1.mp4"), "existing-user-file");
    const repeat = await save.execute("repeat", { urls: [input.urls[0]], path: "saved" }, new AbortController().signal, undefined, undefined as never);
    expect(repeat.details).toMatchObject({ saved: 0, existing: 1 });
    expect(await readFile(path.join(workspace, "saved", "1.mp4"), "utf8")).toBe("existing-user-file");
    for (const directory of temporary) await expect(readdir(directory)).rejects.toThrow();
  } finally {
    await rm(workspace, { recursive: true, force: true });
    for (const directory of temporary) await rm(directory, { recursive: true, force: true });
  }
});

test("cancelled batches keep committed videos, remove staging files and stop later downloads", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "qone-douyin-cancel-"));
  const controller = new AbortController();
  let calls = 0;
  const download = async () => {
    calls++;
    const directory = await mkdtemp(path.join(tmpdir(), "qone-douyin-source-"));
    const filePath = path.join(directory, "media.mp4");
    await writeFile(filePath, "video");
    return { path: filePath, directory, mimeType: "video/mp4" };
  };
  const save = createDouyinTools(bridge, workspace, download)[1]!;
  try {
    const result = await save.execute("cancel", { urls: ["1", "2"].map((id) => `https://www.douyin.com/video/${id}`) },
      controller.signal, (progress) => { if ((progress.details as { phase?: string }).phase === "completed") controller.abort(); }, undefined as never);
    expect(result.details).toMatchObject({ saved: 1, cancelled: true });
    expect(calls).toBe(1);
    expect(await readdir(path.join(workspace, "downloads", "douyin"))).toEqual(["1.mp4"]);
    await expect(save.execute("invalid", { urls: ["https://www.douyin.com/user/other"] }, new AbortController().signal, undefined, undefined as never)).rejects.toThrow();
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("bridge-wide failure stops the batch, while unavailable works remain per-file failures", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "qone-douyin-stop-"));
  try {
    for (const failure of ["metadata_timeout", "page_unavailable", "work_unavailable"] as const) {
      let calls = 0;
      const save = createDouyinTools(bridge, workspace, async () => {
        calls++;
        throw new DouyinBridgeError(failure, "douyin-bridge.page_bridge_failed", { p0: "metadata unavailable" });
      })[1]!;
      const phases: string[] = [];
      const result = await save.execute("failed", { urls: ["1", "2", "3"].map((id) => `https://www.douyin.com/video/${id}`) },
        new AbortController().signal, (progress) => phases.push((progress.details as { phase: string }).phase), undefined as never);
      const stops = failure !== "work_unavailable";
      expect(calls).toBe(stops ? 1 : 3);
      expect(result.details).toMatchObject({ requested: 3, failed: stops ? 1 : 3, remaining: stops ? 2 : 0, stopped: stops, cancelled: false });
      expect(phases[0]).toBe("downloading");
      expect(phases.at(-1)).toBe(stops ? "stopped" : "completed");
      expect(result.isError).toBe(true);
    }
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test("persistent download permissions respect destination boundaries and explicit denials", () => {
  const context = { toolName: "qone_douyin_download", workspacePath: "C:/work/project", args: { path: "C:/other" } };
  expect(evaluatePermission(context, "auto", { get: () => "allow" }).decision).toBe("ask");
  expect(evaluatePermission(context, "full").permissions).toEqual(["filesystem.write", "network.access"]);
  expect(evaluatePermission(context, "full", { get: (_subject, permission) => permission === "filesystem.write" ? "deny" : undefined }).decision).toBe("deny");
  expect(evaluatePermission({ ...context, args: { path: "C:/work/project/.ssh" } }, "full").decision).toBe("deny");
});
