import { expect, test } from "bun:test";
import { AppMediaService } from "../src/app-media-service";
import { createAppMediaTools } from "../src/app-media-tools";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mediaAppContentId, mediaAppFromUrl, mediaAppProfile } from "@qone/protocol";

test("media app URL routing accepts supported work/profile shapes and rejects impostors", () => {
  expect(mediaAppFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube");
  expect(mediaAppContentId("youtube", "https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(mediaAppFromUrl("https://www.bilibili.com/video/BV1xx411c7mD")).toBe("bilibili");
  expect(mediaAppContentId("bilibili", "https://www.bilibili.com/video/BV1xx411c7mD")).toBe("BV1xx411c7mD");
  expect(mediaAppContentId("bilibili", "https://www.bilibili.com/video/av170001")).toBe("170001");
  expect(mediaAppProfile("bilibili", "https://space.bilibili.com/123456/video")).toBe("123456");
  expect(mediaAppProfile("reddit", "https://www.reddit.com/r/videos/new")).toBe("videos");
  expect(mediaAppContentId("x", "https://x.com/user/status/123")).toBe("123");
  expect(mediaAppFromUrl("https://x.com.evil.test/user/status/123")).toBeUndefined();
});

test("Bilibili metadata follows the shared yt-dlp inspection path", async () => {
  const runner = async (_command: string, _args: string[], _signal: AbortSignal) => ({ stdout: JSON.stringify({
    id: "BV1xx411c7mD", webpage_url: "https://www.bilibili.com/video/BV1xx411c7mD", title: "Example Bilibili video", uploader: "Uploader",
  }) });
  const service = new AppMediaService(runner, () => "yt-dlp");
  await expect(service.inspect("bilibili", "https://www.bilibili.com/video/BV1xx411c7mD")).resolves.toMatchObject({ id: "BV1xx411c7mD", author: "Uploader" });
});

test("media service keeps extractor metadata public and rejects mismatched work IDs", async () => {
  const runner = async (_command: string, _args: string[], _signal: AbortSignal) => ({ stdout: JSON.stringify({ id: "dQw4w9WgXcQ", webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Example", uploader: "Channel" }) });
  const service = new AppMediaService(runner, () => "yt-dlp");
  await expect(service.inspect("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).resolves.toMatchObject({ id: "dQw4w9WgXcQ", title: "Example", author: "Channel" });
  const wrong = new AppMediaService(async () => ({ stdout: JSON.stringify({ id: "aaaaaaaaaaa", webpage_url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" }) }), () => "yt-dlp");
  await expect(wrong.inspect("youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ")).rejects.toThrow();
});

test("download publishes validated metadata to the model without another inspect call or private extractor fields", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "qone-media-result-test-"));
  const calls: string[][] = [];
  const service = new AppMediaService(async (_command, args) => {
    calls.push(args);
    if (args.includes("--dump-single-json")) return { stdout: JSON.stringify({
      id: "dQw4w9WgXcQ", webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Example", uploader: "Channel", duration: 194,
      formats: [{ url: "https://media.example.test/private?sig=secret", padding: "x".repeat(2_100_000) }], http_headers: { Cookie: "private-session" },
    }) };
    const file = path.join(path.dirname(args[args.indexOf("--output") + 1]!), "media.mp4");
    await writeFile(file, "test media");
    return { stdout: file };
  }, () => "yt-dlp");
  try {
    const tool = createAppMediaTools(service, workspace).find((tool) => tool.name === "qone_app_download")!;
    const result = await tool.execute("call", { app: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", path: "downloads" }, new AbortController().signal);
    const text = result.content.find((part) => part.type === "text")!;
    const output = JSON.parse(text.text);
    expect(output).toMatchObject({ app: "youtube", id: "dQw4w9WgXcQ", title: "Example", author: "Channel", duration: 194 });
    expect(text.text).not.toContain("secret");
    expect(text.text).not.toContain("private-session");
    expect(calls).toHaveLength(2);
    expect(await readFile(output.files[0], "utf8")).toBe("test media");
  } finally { await rm(workspace, { recursive: true, force: true }); }
});
