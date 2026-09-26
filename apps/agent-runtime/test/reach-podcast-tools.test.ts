import { afterEach, expect, test } from "bun:test";
import { open, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpegExecutable } from "../src/reach-channels";
import { transcribeAudio } from "../src/reach-podcast-tools";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test.skipIf(!ffmpegExecutable())("splits audio over 25 MB locally and uploads ordered pieces", async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "qone-podcast-test-"));
  try {
    const file = path.join(folder, "episode.wav");
    const dataBytes = 32_000_000; // 1000 seconds of 16 kHz mono PCM; crosses a 900 second segment boundary.
    const header = Buffer.alloc(44);
    header.write("RIFF", 0); header.writeUInt32LE(dataBytes + 36, 4); header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36);
    header.writeUInt32LE(dataBytes, 40);
    const handle = await open(file, "w");
    try { await handle.write(header); await handle.truncate(header.length + dataBytes); }
    finally { await handle.close(); }

    const uploads: { url: string; key: string; size: number; type: string }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const part = (init?.body as FormData).get("file") as File;
      uploads.push({ url: String(url), key: String((init?.headers as Record<string, string>).Authorization), size: part.size, type: part.type });
      return Response.json({ text: `第 ${uploads.length} 段` });
    }) as typeof fetch;

    expect(await transcribeAudio(file, "test-key", ffmpegExecutable())).toBe("第 1 段\n\n第 2 段");
    expect(uploads).toHaveLength(2);
    expect(uploads.every((part) => part.url === "https://api.groq.com/openai/v1/audio/transcriptions" && part.key === "Bearer test-key" && part.type === "audio/mpeg" && part.size > 0 && part.size < 25_000_000)).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
