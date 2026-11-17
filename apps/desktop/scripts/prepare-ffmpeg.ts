import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

// FFmpeg is built from pinned official sources by build-ffmpeg.sh (a slim LGPL
// build; see that script). The marker holds the recipe's SHA-256, so editing the
// recipe rebuilds and an unchanged one is reused. CI builds it on Linux and
// restores it here before this check runs.
const desktopRoot = path.resolve(import.meta.dir, "..");
const recipe = path.join(desktopRoot, "scripts", "build-ffmpeg.sh");
const binaries = path.join(desktopRoot, "binaries");
const marker = path.join(binaries, "ffmpeg-build.txt");

const expected = createHash("sha256").update(await readFile(recipe)).digest("hex");
try {
  if ((await readFile(marker, "utf8")).trim() === expected && (await stat(path.join(binaries, "ffmpeg.exe"))).size > 0) process.exit(0);
} catch { /* Build below. */ }

// Windows hosts cross-compile inside the default WSL distribution (Debian/Ubuntu).
const [command, args] = process.platform === "win32"
  ? ["wsl", ["--cd", desktopRoot, "-u", "root", "--", "bash", "scripts/build-ffmpeg.sh", "binaries"]]
  : ["bash", [recipe, binaries]];
await new Promise<void>((resolve, reject) => {
  const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
  child.once("error", (error) => reject(new Error(`FFmpeg 构建需要 ${process.platform === "win32" ? "WSL（Debian/Ubuntu）" : "bash"}：${error.message}`)));
  child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 构建失败，退出码 ${code}`)));
});
if ((await readFile(marker, "utf8")).trim() !== expected) throw new Error("FFmpeg 构建标记与配方不一致");
console.log("已构建 FFmpeg");
