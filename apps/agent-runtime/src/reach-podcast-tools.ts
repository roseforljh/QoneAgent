import { runtimeText, runtimeError } from "./runtime-localization";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { qoneTemporaryDir } from "@qone/shared";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ffmpegExecutable } from "./reach-channels.js";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";

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
      code === 0 ? resolve() : reject(runtimeError("reach-podcast-tools.audio_segmentation_failed", { p0: errorOutput || runtimeText("reach-podcast-tools.ffmpeg_exit_code", { p0: code }) }));
    });
  });
  const files = (await readdir(folder)).filter((name) => /^part-\d{4}\.mp3$/.test(name)).sort();
  if (!files.length || files.length > MAX_SEGMENTS) throw runtimeError("reach-podcast-tools.the_number_of_audio_segments_is_outside_the_supported", {});
  return files.map((name) => path.join(folder, name));
}

export async function transcribeAudio(file: string, key: string, ffmpeg?: string): Promise<string> {
  const info = await stat(file);
  if (!info.isFile() || info.size === 0) throw runtimeError("reach-podcast-tools.invalid_audio_file", {});
  const extension = path.extname(file).toLowerCase();
  const direct = info.size <= MAX_AUDIO_BYTES && SUPPORTED.has(extension);
  if (!direct && !ffmpeg) throw runtimeError("reach-podcast-tools.audio_requires_segmentation_or_conversion_but_ffmpeg_is_unavailable", {});
  const folder = direct ? undefined : await mkdtemp(path.join(qoneTemporaryDir(), "qone-audio-parts-"));
  try {
    const files = direct ? [file] : await splitAudio(file, folder!, ffmpeg!);
    const results: string[] = [];
    for (const part of files) {
      if ((await stat(part)).size > MAX_AUDIO_BYTES) throw runtimeError("reach-podcast-tools.the_audio_segment_exceeds_groq_s_25_mb_upload", {});
      const form = new FormData();
      form.set("model", "whisper-large-v3-turbo");
      form.set("file", new Blob([await readFile(part)], { type: direct ? SUPPORTED.get(extension)! : "audio/mpeg" }), path.basename(part));
      const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(180_000),
      });
      if (!response.ok) throw runtimeError("reach-podcast-tools.groq_transcription_failed_http_segment", { p0: response.status, p1: results.length + 1, p2: files.length });
      const result = await response.json() as { text?: unknown };
      if (typeof result.text !== "string" || !result.text.trim()) throw runtimeError("reach-podcast-tools.groq_returned_no_transcription_for_segment", { p0: results.length + 1 });
      results.push(result.text.trim());
    }
    return results.join("\n\n");
  } finally {
    if (folder) await rm(folder, { recursive: true, force: true });
  }
}

export function createPodcastTools(apiKey: () => string | undefined, openCli: EmbeddedOpenCliRunner): ToolDefinition[] {
  return [{
    name: "qone_podcast_transcribe",
    label: runtimeText("reach-podcast-tools.xiaoyuzhou_audio_transcription"),
    description: "Download one Xiaoyuzhou episode using configured OpenCLI credentials and transcribe its audio with Groq Whisper. Use when a published transcript is unavailable. Large audio is split locally before upload.",
    parameters: Type.Object({ episodeId: Type.String() }),
    execute: async (_id, { episodeId }: { episodeId: string }) => {
      const key = apiKey();
      if (!key) throw runtimeError("reach-podcast-tools.configure_a_groq_api_key_in_the_xiaoyuzhou_card", {});
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(episodeId)) throw runtimeError("reach-podcast-tools.invalid_xiaoyuzhou_episode_id_format", {});
      const folder = await mkdtemp(path.join(qoneTemporaryDir(), "qone-podcast-"));
      try {
        const { stdout } = await openCli("xiaoyuzhou", ["xiaoyuzhou", "download", episodeId, "--output", folder, "--format", "json"], 180_000);
        const parsed = JSON.parse(stdout) as unknown;
        const row = Array.isArray(parsed) ? parsed[0] as { file?: unknown; status?: unknown } | undefined : undefined;
        if (row?.status !== "success" || typeof row.file !== "string") throw runtimeError("reach-podcast-tools.opencli_did_not_successfully_download_the_audio_file", {});
        const root = await realpath(folder);
        const file = await realpath(path.resolve(row.file));
        const relative = path.relative(root, file);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw runtimeError("reach-podcast-tools.opencli_returned_an_invalid_audio_path", {});
        const transcript = await transcribeAudio(file, key, ffmpegExecutable());
        return { content: [{ type: "text" as const, text: transcript.length > 80_000 ? runtimeText("reach-podcast-tools.transcription_truncated", { p0: transcript.slice(0, 80_000) }) : transcript }], details: undefined };
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
  } as ToolDefinition];
}
