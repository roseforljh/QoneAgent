import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";

const VERSION = "n8.1.3-win64-lgpl-8.1";
const ASSET_ID = "586106604";
const SHA256 = "feac41635cd2018d9c7f7f37c3837bec89a7507a3dabfa08664725aba3cda535";
const binaries = path.resolve(import.meta.dir, "../src-tauri/binaries");
const destination = path.join(binaries, "ffmpeg.exe");
const marker = path.join(binaries, "ffmpeg-build.txt");

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

try {
  if ((await readFile(marker, "utf8")).trim() === `${VERSION} ${SHA256}` && (await stat(destination)).size > 0) process.exit(0);
} catch { /* Prepare the pinned binary on the first build. */ }

const staging = path.join(binaries, `.ffmpeg-${process.pid}`);
const archive = path.join(staging, "ffmpeg.zip");
const root = `ffmpeg-${VERSION}`;
await mkdir(staging, { recursive: true });
try {
  const response = await fetch(`https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/assets/${ASSET_ID}`, {
    signal: AbortSignal.timeout(180_000),
    headers: { Accept: "application/octet-stream", "User-Agent": "QoneAgent-build", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok || !response.body) throw new Error(`FFmpeg 下载失败：HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(archive));
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (hash.digest("hex") !== SHA256) throw new Error("FFmpeg SHA-256 校验失败");
  const entries = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).split(/\r?\n/);
  const license = entries.find((entry) => entry.startsWith(`${root}/`) && /(?:^|\/)(?:LICENSE|COPYING)(?:\.[^/]*)?$/i.test(entry));
  if (!license) throw new Error("FFmpeg 压缩包缺少许可证文件");
  await run("tar", ["-xf", archive, "-C", staging, `${root}/bin/ffmpeg.exe`, license]);
  await rm(destination, { force: true });
  await rename(path.join(staging, root, "bin", "ffmpeg.exe"), destination);
  await writeFile(path.join(binaries, "ffmpeg-LICENSE"), await readFile(path.join(staging, license)));
  await writeFile(marker, `${VERSION} ${SHA256}\n`);
  console.log(`已准备 FFmpeg ${VERSION}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
