import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "2026.08.19";
const ASSET_ID = "521488854";
const SHA256 = "66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a";
const destination = path.resolve(import.meta.dir, "../src-tauri/binaries/yt-dlp.exe");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

try {
  if (digest(await readFile(destination)) === SHA256) process.exit(0);
} catch { /* First build: download the pinned official release. */ }

const response = await fetch(`https://api.github.com/repos/yt-dlp/yt-dlp/releases/assets/${ASSET_ID}`, {
  signal: AbortSignal.timeout(120_000),
  headers: { Accept: "application/octet-stream", "User-Agent": "QoneAgent-build", "X-GitHub-Api-Version": "2022-11-28" },
});
if (!response.ok) throw new Error(`yt-dlp 下载失败：HTTP ${response.status}`);
const bytes = new Uint8Array(await response.arrayBuffer());
if (digest(bytes) !== SHA256) throw new Error("yt-dlp SHA-256 校验失败");
await mkdir(path.dirname(destination), { recursive: true });
const staging = `${destination}.${process.pid}.tmp`;
try {
  await writeFile(staging, bytes);
  await rm(destination, { force: true });
  await rename(staging, destination);
} finally {
  await rm(staging, { force: true });
}
console.log(`已准备 yt-dlp ${VERSION}`);
