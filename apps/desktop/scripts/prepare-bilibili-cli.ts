import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

const UV_VERSION = "0.12.20";
const UV_ARCHIVE_SHA256 = "95f9bc30fbb3574d276e28ac4a6de932d25153645853d13da8c21eec3bc88d06";
const files = {
  "uv.exe": "a0d2742d49564a32488753b02e76276e7b5ef1b1ea8cf30bcbf06ee28f60cd73",
  "uvx.exe": "16905b670fac1143ef4608aa4b11980287444bfe38f3f34243f86c1cc595cbd4",
} as const;
const licenses = {
  "LICENSE-MIT": "860e3d7a86b84e6a7012c7a635fc64df475cebc6cce34dfeb73a5982ec58176c",
  "LICENSE-APACHE": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4",
} as const;
const binaries = path.resolve(import.meta.dir, "../src-tauri/binaries");

async function digest(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function matches(file: string, expected: string): Promise<boolean> {
  try { return await digest(file) === expected; } catch { return false; }
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)));
  });
}

async function download(url: string, destination: string): Promise<void> {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const command = `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; `
    + `$ProgressPreference = 'SilentlyContinue'; `
    + `Invoke-WebRequest -Uri ${quote(url)} -OutFile ${quote(destination)} -ErrorAction Stop`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
}

await mkdir(binaries, { recursive: true });
const ready = await Promise.all([
  ...Object.entries(files).map(([name, hash]) => matches(path.join(binaries, name), hash)),
  ...Object.entries(licenses).map(([name, hash]) => matches(path.join(binaries, `uv-${name}`), hash)),
]);
if (ready.every(Boolean)) process.exit(0);

const staging = await mkdtemp(path.join(binaries, ".uv-"));
if (path.dirname(await realpath(staging)) !== await realpath(binaries)) throw new Error("无效的 uv 暂存目录");
const archive = path.join(staging, "uv.zip");
try {
  await download(`https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`, archive);
  if (await digest(archive) !== UV_ARCHIVE_SHA256) throw new Error("uv 压缩包 SHA-256 校验失败");
  const entries = new Set(execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split(/\r?\n/));
  if (!Object.keys(files).every((name) => entries.has(name))) throw new Error("uv 压缩包缺少 uv.exe 或 uvx.exe");
  await run("tar", ["-xf", archive, "-C", staging, ...Object.keys(files)]);
  for (const [name, hash] of Object.entries(files)) {
    if (await digest(path.join(staging, name)) !== hash) throw new Error(`${name} SHA-256 校验失败`);
  }
  for (const [name, hash] of Object.entries(licenses)) {
    const destination = path.join(staging, `uv-${name}`);
    await download(`https://raw.githubusercontent.com/astral-sh/uv/${UV_VERSION}/${name}`, destination);
    if (await digest(destination) !== hash) throw new Error(`uv ${name} SHA-256 校验失败`);
  }
  for (const name of [...Object.keys(files), ...Object.keys(licenses).map((name) => `uv-${name}`)]) {
    const destination = path.join(binaries, name);
    await rm(destination, { force: true });
    await rename(path.join(staging, name), destination);
  }
  console.log(`已准备 uv/uvx ${UV_VERSION}，用于运行 bilibili-cli`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
