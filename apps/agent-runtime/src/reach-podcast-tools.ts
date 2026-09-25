import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runOpenCli } from "./browser-sync.js";

const MAX_AUDIO_BYTES = 25_000_000;

export function createPodcastTools(apiKey: () => string | undefined): ToolDefinition[] {
  return [{
    name: "qone_podcast_transcribe",
    label: "小宇宙 · 音频转写",
    description: "Download one Xiaoyuzhou episode using configured OpenCLI credentials and transcribe its audio with Groq Whisper. Use when a published transcript is unavailable. Audio must be under 25 MB.",
    parameters: Type.Object({ episodeId: Type.String() }),
    execute: async (_id, { episodeId }: { episodeId: string }) => {
      const key = apiKey();
      if (!key) throw new Error("请先在应用页的小宇宙卡片配置 Groq API Key");
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(episodeId)) throw new Error("小宇宙单集 ID 格式无效");
      const folder = await mkdtemp(path.join(os.tmpdir(), "qone-podcast-"));
      try {
        const { stdout } = await runOpenCli(["xiaoyuzhou", "download", episodeId, "--output", folder, "--format", "json"], 180_000);
        const parsed = JSON.parse(stdout) as unknown;
        const row = Array.isArray(parsed) ? parsed[0] as { file?: unknown } | undefined : undefined;
        if (typeof row?.file !== "string") throw new Error("OpenCLI 未返回已下载的音频文件");
        const file = path.resolve(row.file);
        if (!file.startsWith(`${folder}${path.sep}`)) throw new Error("OpenCLI 返回了无效的音频路径");
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_AUDIO_BYTES) throw new Error("音频超过 Groq 的 25 MB 上传上限；请先截取音频片段");
        const bytes = await readFile(file);
        const form = new FormData();
        form.set("model", "whisper-large-v3-turbo");
        form.set("file", new Blob([bytes], { type: "audio/mpeg" }), path.basename(file));
        const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
          method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180_000),
        });
        if (!response.ok) throw new Error(`Groq 转写失败：HTTP ${response.status}`);
        const result = await response.json() as { text?: unknown };
        if (typeof result.text !== "string" || !result.text.trim()) throw new Error("Groq 未返回转写文本");
        return { content: [{ type: "text" as const, text: result.text.slice(0, 80_000) }], details: undefined };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  } as ToolDefinition];
}
