import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localMediaMarker } from "../src/google-media";
import { prepareOpenAIResponsesPayload } from "../src/openai-responses-media";
import { prepareAnthropicPayload } from "../src/anthropic-media";

test("Responses and Codex transport complete video files as input_file parts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-native-responses-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, Buffer.from([1, 2, 3]));
  try {
    const marker = localMediaMarker(file, "video/mp4", true);
    const payload = await prepareOpenAIResponsesPayload({ input: [{ role: "user", content: [{ type: "input_text", text: `分析 ${marker}` }] }] }, ["text", "video"]);
    const content = (payload.input as Array<{ content: unknown[] }>)[0]!.content;
    expect(content[1]).toMatchObject({ type: "input_file", filename: "clip.mp4", file_data: "data:video/mp4;base64,AQID" });
    expect(JSON.stringify(payload)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude transport uses a native document block for configured audio", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-native-claude-"));
  const file = path.join(directory, "sound.mp3");
  await writeFile(file, Buffer.from([4, 5, 6]));
  try {
    const marker = localMediaMarker(file, "audio/mpeg", true);
    const payload = await prepareAnthropicPayload({ messages: [{ role: "user", content: `听 ${marker}` }] }, ["text", "audio"]);
    const content = (payload.messages as Array<{ content: unknown[] }>)[0]!.content;
    expect(content[1]).toMatchObject({ type: "document", source: { type: "base64", media_type: "audio/mpeg", data: "BAUG" } });
    expect(JSON.stringify(payload)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude transport uses the configured native video input instead of a frame representation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-native-claude-video-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, Buffer.from([7, 8, 9]));
  try {
    const marker = localMediaMarker(file, "video/mp4", true);
    const payload = await prepareAnthropicPayload({ messages: [{ role: "user", content: `分析 ${marker}` }] }, ["text", "video"]);
    const content = (payload.messages as Array<{ content: unknown[] }>)[0]!.content;
    expect(content[1]).toMatchObject({ type: "document", source: { type: "base64", media_type: "video/mp4", data: "BwgJ" } });
    expect(JSON.stringify(payload)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media marker key persists under QONE_DATA_DIR so historical media references survive restart", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-media-key-"));
  const file = path.join(directory, "voice.mp3");
  await writeFile(file, Buffer.from([9, 8, 7]));
  const previousDir = process.env.QONE_DATA_DIR;
  try {
    process.env.QONE_DATA_DIR = directory;
    const marker = localMediaMarker(file, "audio/mpeg", false);
    const child = Bun.spawn([Bun.which("bun")!, "-e",
      `import { MEDIA_MARKER, verifiedLocalMedia } from "./src/google-media"; const m = [...${JSON.stringify(marker)}.matchAll(MEDIA_MARKER)][0]!; console.log(JSON.stringify(verifiedLocalMedia(m[1]!, m[2]!)));`],
      { cwd: path.resolve(import.meta.dir, ".."), env: { ...Bun.env, QONE_DATA_DIR: directory }, stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({ path: file, mimeType: "audio/mpeg", temporary: false });
  } finally {
    if (previousDir === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = previousDir;
    await rm(directory, { recursive: true, force: true });
  }
});
