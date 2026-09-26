import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runOpenCli } from "./browser-sync.js";
import { ffmpegExecutable } from "./reach-channels.js";

const MAX_AUDIO_BYTES = 25_000_000;
const MAX_SEGMENTS = 96;
const SUPPORTED = new Map([
  [".mp3", "audio/mpeg"], [".mpga", "audio/mpeg"], [".mpeg", "audio/mpeg"],
  [".m4a", "audio/mp4"], [".mp4", "audio/mp4"], [".wav", "audio/wav"], [".webm", "audio/webm"],
]);

async function splitAudio(file: string, folder: string, ffmpeg: string): Promise<string[]> {
  const pattern = path.join(folder, "part-%04d.mp3");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", "16000",
      "-b:a", "32k", "-f", "segment", "-segment_time", "900", "-reset_timestamps", "1", "-segment_format", "mp3", pattern,
    ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    child.stderr.on("data", (chunk: Buffer) => { errorOutput = (errorOutput + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`音频分段失败：${errorOutput || `FFmpeg 退出码 ${code}`}`));
    });
  });
  const files = (await readdir(folder)).filter((name) => /^part-\d{4}\.mp3$/.test(name)).sort();
  if (!files.length || files.length > MAX_SEGMENTS) throw new Error("音频分段数量超出支持范围");
  return files.map((name) => path.join(folder, name));
}

export async function transcribeAudio(file: string, key: string, ffmpeg?: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw new Error("音频文件无效");
  const extension = path.extname(file).toLowerCase();
  const direct = info.size <= MAX_AUDIO_BYTES && SUPPORTED.has(extension);
  if (!direct && !ffmpeg) throw new Error("音频需要分段或格式转换，但 FFmpeg 不可用");
  const folder = direct ? undefined : await mkdtemp(path.join(os.tmpdir(), "qone-audio-parts-"));
  try {
    const files = direct ? [file] : await splitAudio(file, folder!, ffmpeg!);
    const results: string[] = [];
    for (const part of files) {
      if ((await stat(part)).size > MAX_AUDIO_BYTES) throw new Error("音频片段超过 Groq 的 25 MB 上传上限");
      const form = new FormData();
      form.set("model", "whisper-large-v3-turbo");
      form.set("file", new Blob([await readFile(part)], { type: direct ? SUPPORTED.get(extension)! : "audio/mpeg" }), path.basename(part));
      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw new Error(`Groq 转写失败：HTTP ${response.status}（第 ${results.length + 1}/${files.length} 段）`);
      const result = await response.json() as { text?: unknown };
      if (typeof result.text !== "string" || !result.text.trim()) throw new Error(`Groq 未返回第 ${results.length + 1} 段的转写文本`);
      results.push(result.text.trim());
    }
    return results.join("\n\n");
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}

export function createPodcastTools(apiKey: () => string | undefined): ToolDefinition[] {
  return [{
    name: "qone_podcast_transcribe",
    label: "小宇宙 · 音频转写",
    description: "Download one Xiaoyuzhou episode using configured OpenCLI credentials and transcribe its audio with Groq Whisper. Use when a published transcript is unavailable. Large audio is split locally before upload.",
    parameters: Type.Object({ episodeId: Type.String() }),
    execute: async (_id, { episodeId }: { episodeId: string }) => {
      const key = apiKey();
      if (!key) throw new Error("请先在应用页的小宇宙卡片配置 Groq API Key");
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(episodeId)) throw new Error("小宇宙单集 ID 格式无效");
      const folder = await mkdtemp(path.join(os.tmpdir(), "qone-podcast-"));
      try {
        const { stdout } = await runOpenCli(["xiaoyuzhou", "download", episodeId, "--output", folder, "--format", "json"], 180_000);
        const parsed = JSON.parse(stdout) as unknown;
        const row = Array.isArray(parsed) ? parsed[0] as { file?: unknown; status?: unknown } | undefined : undefined;
        if (row?.status !== "success" || typeof row.file !== "string") throw new Error("OpenCLI 未成功下载音频文件");
        const root = await realpath(folder);
        const file = await realpath(path.resolve(row.file));
        const relative = path.relative(root, file);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("OpenCLI 返回了无效的音频路径");
        const transcript = await transcribeAudio(file, key, ffmpegExecutable());
        return { content: [{ type: "text" as const, text: transcript.length > 80_000 ? `${transcript.slice(0, 80_000)}\n[转写结果已截断]` : transcript }], details: undefined };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  } as ToolDefinition];
}
