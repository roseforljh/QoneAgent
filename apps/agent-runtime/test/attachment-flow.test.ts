import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { closeDb, MessageRepo, openDb, SessionRepo } from "@qone/database";
import { decodeCommand, type MessageAttachmentInfo } from "@qone/protocol";
import { createPiSessionEntries, imageContent, promptWithAttachments } from "../src/pi-adapter";
import { googleMediaContent, localMediaMarker, prepareGooglePayload, youtubeUrlsFromText } from "../src/google-media";
import { canProcessMediaAttachment, configuredCapabilities } from "../src/media-capabilities";
import { convertMessages as convertGoogleMessages } from "@earendil-works/pi-ai/api/google-shared";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";

const attachments: MessageAttachmentInfo[] = [
  { type: "file", name: "notes.txt", mimeType: "text/plain", data: "data:text/plain;base64,aGVsbG8=" },
  { type: "image", name: "plot.png", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
];

test("attachment command validation and Pi transcript keep file text and image bytes", () => {
  const command = decodeCommand(JSON.stringify({ type: "agent.run", requestId: "r", sessionId: "s", message: "", attachments }));
  expect(command?.type).toBe("agent.run");
  expect(imageContent(attachments)).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
  expect(promptWithAttachments("read", attachments)).toContain('<attachment name="notes.txt">\nhello\n</attachment>');
  const entries = createPiSessionEntries("C:\\workspace", [{ role: "user", content: "read", attachments, createdAt: 1 }]);
  expect((entries[1] as { message: { content: unknown[] } }).message.content).toEqual([
    { type: "text", text: 'read\n\n<attachment name="notes.txt">\nhello\n</attachment>' },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
});

test("existing SQLite conversations migrate and persist attachments", () => {
  const path = join(tmpdir(), `qone-attachments-${crypto.randomUUID()}.sqlite`);
  const old = new Database(path);
  old.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  old.close();
  try {
    const db = openDb(path);
    const session = new SessionRepo(db).create();
    new MessageRepo(db).add(session.id, "user", "read", undefined, undefined, undefined, attachments);
    const saved = new MessageRepo(db).listBySession(session.id)[0]!;
    expect(JSON.parse(saved.attachments!)).toEqual(attachments);
    closeDb(db);
  } finally {
    try { unlinkSync(path); } catch { /* SQLite may leave WAL files on Windows. */ }
  }
});

test("Gemini converts YouTube links to native fileData parts", async () => {
  expect(youtubeUrlsFromText("看这个 https://youtu.be/abc123?t=20。以及 https://www.youtube.com/watch?v=xyz789")).toEqual([
    "https://youtu.be/abc123?t=20",
    "https://www.youtube.com/watch?v=xyz789",
  ]);
  const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: "分析 https://youtu.be/abc123" }] }] }, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  } as never, "test-key");
  expect(payload.contents?.[0]?.parts?.at(-1)).toEqual({ fileData: { mimeType: "video/*", fileUri: "https://youtu.be/abc123" } });
  const unavailable = await prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: "分析 https://youtu.be/abc123" }] }] }, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  } as never, "test-key", undefined, false);
  expect(unavailable.contents?.[0]?.parts).toEqual([{ text: "分析 https://youtu.be/abc123" }]);
});

test("unconfigured media input remains an attachment reference for delegation", () => {
  const media: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: join(tmpdir(), "clip.mp4") };
  const prompt = promptWithAttachments("分析", [media], true, ["text"]);
  expect(prompt).toContain("需交给能处理该媒体的子代理");
  expect(prompt).not.toContain("QONE_MEDIA");
  expect(googleMediaContent([media], ["text"])).toEqual([]);
});

test("an audio-capable agent can extract a video's sound without claiming its picture", () => {
  const media: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: join(tmpdir(), "clip.mp4") };
  for (const native of [true, "audio"] as const) {
    const prompt = promptWithAttachments("听视频声音", [media], native, ["text", "audio"]);
    expect(prompt).toContain("qone_media_extract_audio");
    expect(prompt).toContain("若任务需要画面，请委派原始附件");
    expect(prompt).not.toContain("QONE_MEDIA");
  }
});

test("media routing uses the API format and configured inputs together", () => {
  const video: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "" };
  const audio: MessageAttachmentInfo = { type: "file", name: "voice.mp3", mimeType: "audio/mpeg", data: "" };
  expect(canProcessMediaAttachment("google-generative-ai", ["video"], video)).toBe(true);
  expect(canProcessMediaAttachment("openai-responses", ["video"], video)).toBe(false);
  expect(canProcessMediaAttachment("openai-responses", ["video", "image"], video)).toBe(true);
  expect(canProcessMediaAttachment("anthropic-messages", ["audio"], audio)).toBe(false);
  expect(canProcessMediaAttachment("openai-completions", ["audio"], audio)).toBe(true);
});

test("image MIME type routes correctly even when the transport labels it as a file", () => {
  const image: MessageAttachmentInfo = { type: "file", name: "plot.png", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" };
  expect(canProcessMediaAttachment("openai-responses", ["image"], image)).toBe(true);
  expect(canProcessMediaAttachment("openai-responses", ["text"], image)).toBe(false);
  expect(imageContent([image], ["image"])).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
  expect(promptWithAttachments("看图", [image], false, ["image"])).toBe("看图");
  expect(googleMediaContent([image], ["image"])).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
});

test("Gemini automatic input defaults to four capabilities but manual selection wins", () => {
  const base = { id: "provider/gemini", provider: "provider", model: "gemini", enabled: true, updatedAt: 1 };
  expect(configuredCapabilities([{ ...base, config: { apiType: "google", input: ["text"], output: ["text"] } }], "provider/gemini").input)
    .toEqual(["text", "image", "video", "audio"]);
  expect(configuredCapabilities([{ ...base, config: { apiType: "google", input: ["text"], output: ["text"], metadataOverrides: { input: true } } }], "provider/gemini").input)
    .toEqual(["text"]);
  expect(configuredCapabilities([{ ...base, config: { apiType: "google", input: ["text"], output: ["text"], autoMetadata: false } }], "provider/gemini").input)
    .toEqual(["text"]);
});

test("Gemini attaches a downloaded tool video to the next request and ignores it after cleanup", async () => {
  const path = join(tmpdir(), `qone-tool-video-${crypto.randomUUID()}.mp4`);
  writeFileSync(path, Buffer.from([0, 1, 2]));
  const marker = promptWithAttachments("", [{ type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: path }], true);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => String(input).includes("/upload/")
    ? new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://upload.test/video" } })
    : new Response(JSON.stringify({ file: { name: "files/video", uri: "https://files.test/video", state: "ACTIVE" } }), { status: 200 })) as typeof fetch;
  const toolPart = { functionResponse: { name: "qone_video_download", response: { output: `已下载 ${marker}` } } };
  try {
    const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [toolPart] }] }, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as never, "test-key");
    expect(payload.contents?.[0]?.parts?.[1]).toEqual({ fileData: { mimeType: "video/mp4", fileUri: "https://files.test/video" } });
    unlinkSync(path);
    const replay = await prepareGooglePayload({ contents: [{ role: "user", parts: [toolPart] }] }, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as never, "test-key");
    expect(replay.contents?.[0]?.parts).toHaveLength(1);
    expect(replay.contents?.[0]?.parts?.[0]?.functionResponse?.response?.output).toContain("临时文件已清理");
  } finally {
    globalThis.fetch = originalFetch;
    try { unlinkSync(path); } catch { /* already removed */ }
  }
});

test("Gemini rewrites the actual Pi tool-result payload into a native file part", async () => {
  const file = join(tmpdir(), `qone-real-tool-video-${crypto.randomUUID()}.mp4`);
  writeFileSync(file, Buffer.from([0, 1, 2]));
  const marker = localMediaMarker(file, "video/mp4", true);
  const model = { id: "gemini-3-pro", provider: "google", api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    name: "Gemini", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1024 } as Model<"google-generative-ai">;
  const context = normalizeContext({ messages: [
    { role: "user", content: "看视频", timestamp: 1 },
    { role: "assistant", api: "google-generative-ai", provider: "google", model: model.id,
      content: [{ type: "toolCall", id: "call-1", name: "qone_video_download", arguments: { url: "https://example.test/clip.mp4" } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 },
    { role: "toolResult", toolCallId: "call-1", toolName: "qone_video_download", content: [{ type: "text", text: `下载完成 ${marker}` }], isError: false, timestamp: 3 },
  ] as never });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => String(input).includes("/upload/")
    ? new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://upload.test/actual" } })
    : new Response(JSON.stringify({ file: { name: "files/actual", uri: "https://files.test/actual", state: "ACTIVE" } }), { status: 200 })) as typeof fetch;
  try {
    const payload = { contents: convertGoogleMessages(model, context) };
    expect(payload.contents.at(-1)?.parts?.[0]?.functionResponse?.response).toEqual({ output: `下载完成 ${marker}` });
    const prepared = await prepareGooglePayload(payload, model, "test-key", undefined, false, ["text", "video"]);
    const parts = prepared.contents?.at(-1)?.parts;
    expect(parts?.[0]?.functionResponse?.response?.output).toContain("媒体文件已附在工具结果后");
    expect(parts?.[1]).toEqual({ fileData: { mimeType: "video/mp4", fileUri: "https://files.test/actual" } });
  } finally {
    globalThis.fetch = originalFetch;
    unlinkSync(file);
  }
});

test("Gemini replay skips a cleaned temporary audio attachment", async () => {
  const missing = join(tmpdir(), `qone-deleted-${crypto.randomUUID()}.m4a`);
  const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: localMediaMarker(missing, "audio/mp4", true) }] }] }, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  } as never, "test-key");
  expect(payload.contents?.[0]?.parts).toEqual([{ text: "[先前处理的媒体临时文件已清理；如需再次分析，请重新获取]" }]);
});

test("Gemini replay ignores an invalid media marker instead of reading its path", async () => {
  const marker = localMediaMarker(join(tmpdir(), "old-session.mp4"), "video/mp4");
  const tampered = marker.replace(/([a-f0-9])\]\]$/, (match, digit: string) => `${digit === "a" ? "b" : "a"}]]`);
  const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: tampered }] }] }, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  } as never, "test-key");
  expect(payload.contents?.[0]?.parts).toEqual([{ text: "[先前会话的媒体引用已失效；如需分析，请重新提供]" }]);
});

test("Gemini payload rejects historical media when the current model lacks that input", async () => {
  const path = join(tmpdir(), `qone-history-${crypto.randomUUID()}.mp4`);
  writeFileSync(path, Buffer.from([0, 1, 2]));
  try {
    const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [
      { text: localMediaMarker(path, "video/mp4") },
      { inlineData: { mimeType: "audio/mpeg", data: "AAAA" } },
    ] }] }, { baseUrl: "https://generativelanguage.googleapis.com/v1beta" } as never, "test-key", undefined, false, ["text"]);
    expect(payload.contents?.[0]?.parts).toEqual([
      { text: "[当前模型未配置对应媒体输入能力；请委派子代理]" },
      { text: "[当前模型未配置对应媒体输入能力；请委派子代理]" },
    ]);
  } finally {
    unlinkSync(path);
  }
});

test("Gemini keeps audio and video attachments as native media parts", () => {
  const media = googleMediaContent([
    { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "data:video/mp4;base64,AAAA" },
    { type: "file", name: "voice.mp3", mimeType: "audio/mpeg", data: "data:audio/mpeg;base64,BBBB" },
  ]);
  expect(media).toEqual([
    { type: "image", data: "AAAA", mimeType: "video/mp4" },
    { type: "image", data: "BBBB", mimeType: "audio/mpeg" },
  ]);
});

test("Gemini uploads large video data through the Files API", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("/upload/")) return new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://upload.test/session" } });
    return new Response(JSON.stringify({ file: { name: "files/qone-test", uri: "https://generativelanguage.googleapis.com/v1beta/files/qone-test", state: "ACTIVE" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const data = Buffer.alloc(4 * 1024 * 1024 + 1, 7).toString("base64");
    const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [{ inlineData: { mimeType: "video/mp4", data } }] }] }, {
      baseUrl: `https://generativelanguage.googleapis.com/v1beta?case=${crypto.randomUUID()}`,
    } as never, "test-key");
    expect(requests).toHaveLength(2);
    expect(payload.contents?.[0]?.parts?.[0]).toEqual({
      fileData: { mimeType: "video/mp4", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/qone-test" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("local Gemini media is referenced without base64 and uploaded from disk", async () => {
  const path = join(tmpdir(), `qone-media-${crypto.randomUUID()}.mp4`);
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  const media: MessageAttachmentInfo = { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: path };
  const command = decodeCommand(JSON.stringify({ type: "agent.run", requestId: "r", sessionId: "s", message: "分析", attachments: [media] }));
  expect(command?.type).toBe("agent.run");
  expect(googleMediaContent([media])).toEqual([]);
  const prompt = promptWithAttachments("分析", [media], true);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    requests.push(String(input));
    if (String(input).includes("/upload/")) {
      expect(init?.headers).toMatchObject({ "X-Goog-Upload-Header-Content-Length": "4" });
      return new Response(null, { status: 200, headers: { "x-goog-upload-url": "https://upload.test/local" } });
    }
    expect(init?.body).toBeInstanceOf(Blob);
    expect(Buffer.from(await (init!.body as Blob).arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 3]));
    return new Response(JSON.stringify({ file: { name: "files/local", uri: "https://generativelanguage.googleapis.com/v1beta/files/local", state: "ACTIVE" } }), { status: 200 });
  }) as typeof fetch;
  try {
    const payload = await prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: prompt }] }] }, { baseUrl: "https://generativelanguage.googleapis.com/v1beta" } as never, "test-key");
    expect(requests).toHaveLength(2);
    expect(payload.contents?.[0]?.parts).toEqual([
      { text: "分析\n\n" },
      { fileData: { mimeType: "video/mp4", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/local" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    unlinkSync(path);
  }
});

test("Gemini file upload surfaces the provider response", async () => {
  const path = join(tmpdir(), `qone-media-${crypto.randomUUID()}.mp4`);
  writeFileSync(path, Buffer.from([0, 1, 2, 3]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("provider rejected the file", { status: 413 })) as typeof fetch;
  try {
    const prompt = promptWithAttachments("分析", [{ type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: path }], true);
    await expect(prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: prompt }] }] }, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as never, "test-key")).rejects.toThrow("Gemini 文件接口 HTTP 413: provider rejected the file");
  } finally {
    globalThis.fetch = originalFetch;
    unlinkSync(path);
  }
});

test("Gemini rejects an HTML gateway page instead of claiming video upload succeeded", async () => {
  const file = join(tmpdir(), `qone-gateway-${crypto.randomUUID()}.mp4`);
  writeFileSync(file, Buffer.from([0, 1, 2, 3]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("<!doctype html><html>Gateway</html>", { headers: { "Content-Type": "text/html" } });
  }) as typeof fetch;
  try {
    await expect(prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: localMediaMarker(file, "video/mp4") }] }] }, {
      baseUrl: "https://gateway.test/v1beta",
    } as never, "test-key")).rejects.toThrow("HTTP 200 HTML");
    expect(requests).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
    unlinkSync(file);
  }
});

test("Gemini reports the provider body when upload initialization has no URL", async () => {
  const file = join(tmpdir(), `qone-no-upload-url-${crypto.randomUUID()}.mp4`);
  writeFileSync(file, Buffer.from([0, 1]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("proxy did not enable resumable uploads", { status: 200 })) as typeof fetch;
  try {
    await expect(prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: localMediaMarker(file, "video/mp4") }] }] }, {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    } as never, "test-key")).rejects.toThrow("proxy did not enable resumable uploads");
  } finally {
    globalThis.fetch = originalFetch;
    unlinkSync(file);
  }
});

test("Gemini stops immediately when upload already reports processing failure", async () => {
  const file = join(tmpdir(), `qone-failed-${crypto.randomUUID()}.mp4`);
  writeFileSync(file, Buffer.from([0, 1]));
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return requests === 1
      ? new Response(null, { headers: { "x-goog-upload-url": "https://upload.test/failed" } })
      : new Response(JSON.stringify({ file: { name: "files/failed", uri: "https://files.test/failed", state: "FAILED", error: { message: "unsupported codec" } } }));
  }) as typeof fetch;
  try {
    await expect(prepareGooglePayload({ contents: [{ role: "user", parts: [{ text: localMediaMarker(file, "video/mp4") }] }] },
      { baseUrl: "https://generativelanguage.googleapis.com/v1beta" } as never, "test-key")).rejects.toThrow("unsupported codec");
    expect(requests).toBe(2);
  } finally {
    globalThis.fetch = originalFetch;
    unlinkSync(file);
  }
});
