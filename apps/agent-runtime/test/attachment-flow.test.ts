import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync, writeFileSync } from "node:fs";
import { closeDb, MessageRepo, openDb, SessionRepo } from "@qone/database";
import { decodeCommand, type MessageAttachmentInfo } from "@qone/protocol";
import { createPiSessionEntries, imageContent, promptWithAttachments } from "../src/pi-adapter";
import { googleMediaContent, prepareGooglePayload, youtubeUrlsFromText } from "../src/google-media";

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
