import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runOpenCli } from "./browser-sync.js";
import { biliLaunch } from "./reach-channels.js";
import { mediaMimeType } from "./video-download.js";

const execFileAsync = promisify(execFile);
const pythonOptions = { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } };
const AUDIO_MIME: Record<string, string> = {
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".flac": "audio/flac",
};

export function bilibiliCliResultText(stdout: string): string {
  const text = stdout.trim();
  if (!text) throw new Error("bilibili-cli 未返回资料");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("bilibili-cli 未返回有效 JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bilibili-cli 返回格式无效");
  const envelope = value as Record<string, unknown>;
  if (envelope.ok === false) {
    throw new Error(`bilibili-cli 获取资料失败：${JSON.stringify(envelope.error ?? envelope)}`);
  }
  return text;
}

export function isBilibiliUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv";
  } catch { return false; }
}

async function firstMediaFile(directory: string, mime: (file: string) => string | undefined): Promise<{ path: string; mimeType: string } | undefined> {
  const pending = [directory];
  for (const current of pending) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const mediaPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(mediaPath);
      if (!entry.isFile()) continue;
      const mimeType = mime(mediaPath);
      if (mimeType) return { path: mediaPath, mimeType };
    }
  }
  return undefined;
}

export interface BilibiliFallbackResult {
  source: "bilibili-cli" | "OpenCLI";
  text: string;
  audio?: { path: string; mimeType: string; directory: string };
}

/** These sources provide partial evidence only; the caller must label the result as degraded. */
export async function readBilibiliFallback(url: string, signal?: AbortSignal): Promise<BilibiliFallbackResult> {
  if (!isBilibiliUrl(url)) throw new Error("不是 B 站视频链接");
  const bvid = /\bBV[A-Za-z0-9]+\b/i.exec(url)?.[0];
  const reference = bvid ?? url;
  const launch = biliLaunch();
  const errors: string[] = [];
  if (launch) {
    try {
      let text: string;
      try {
        ({ stdout: text } = await execFileAsync(launch.command, [...launch.prefix, "video", reference, "--subtitle-timeline", "--json"], {
          ...pythonOptions, signal, maxBuffer: 16 * 1024 * 1024,
        }));
      } catch (error) {
        if (signal?.aborted) throw error;
        ({ stdout: text } = await execFileAsync(launch.command, [...launch.prefix, "video", reference, "--json"], {
          ...pythonOptions, signal, maxBuffer: 16 * 1024 * 1024,
        }));
      }
      text = bilibiliCliResultText(text);
      if (text) {
        const directory = await mkdtemp(path.join(tmpdir(), "qone-bili-audio-"));
        try {
          await execFileAsync(launch.command, [...launch.prefix, "audio", reference, "--no-split", "-o", directory], {
            ...pythonOptions, signal, maxBuffer: 1024 * 1024,
          });
          const audio = await firstMediaFile(directory, (file) => mediaMimeType(file)?.startsWith("audio/") ? AUDIO_MIME[path.extname(file).toLowerCase()] : undefined);
          if (audio) return { source: "bilibili-cli", text: text.trim(), audio: { ...audio, directory } };
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          if (signal?.aborted) throw error;
          // The optional audio extra or source audio may be unavailable.
        }
        await rm(directory, { recursive: true, force: true });
        return { source: "bilibili-cli", text: text.trim() };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`bilibili-cli: ${String(error)}`);
    }
  } else {
    errors.push("bilibili-cli 未安装");
  }
  const parts: string[] = [];
  for (const command of ["subtitle", "summary"] as const) {
    try {
      const result = await runOpenCli(["bilibili", command, url, "-f", "json"], 0, signal);
      if (result.stdout) parts.push(`${command}: ${result.stdout}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`OpenCLI ${command}: ${String(error)}`);
    }
  }
  if (!parts.length) throw new Error(`无法取得 B 站完整视频、字幕、音频或摘要。${errors.join("；")}`);
  return { source: "OpenCLI", text: parts.join("\n\n") };
}
