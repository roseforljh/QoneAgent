import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const NODE_VERSION = "v24.5.0";
const NODE_SHA256 = "56dbd529d1eaa0f59c8f015ea604fe3d505a77ef9592fc4aed8030dc79f1bc14";
const OPENCLI_VERSION = "1.8.8";
const binaries = path.resolve(import.meta.dir, "../src-tauri/binaries");
const nodeExecutable = path.join(binaries, "node.exe");
const opencliDir = path.join(binaries, "opencli");
const opencliEntry = path.join(opencliDir, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

await mkdir(binaries, { recursive: true });
let validNode = false;
try { validNode = hash(await readFile(nodeExecutable)) === NODE_SHA256; } catch { /* Download below. */ }
if (!validNode) {
  const response = await fetch(`https://nodejs.org/dist/${NODE_VERSION}/win-x64/node.exe`, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`Node.js 下载失败：HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (hash(bytes) !== NODE_SHA256) throw new Error("Node.js SHA-256 校验失败");
  await writeFile(nodeExecutable, bytes);
  console.log(`已准备 Node.js ${NODE_VERSION}`);
}

const licensePath = path.join(binaries, "node-LICENSE");
if (!existsSync(licensePath)) {
  const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/LICENSE`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Node.js 许可证下载失败：HTTP ${response.status}`);
  await writeFile(licensePath, await response.text());
}

let validOpenCli = false;
try {
  const manifest = JSON.parse(await readFile(path.join(opencliDir, "node_modules", "@jackwener", "opencli", "package.json"), "utf8")) as { version?: string };
  validOpenCli = existsSync(opencliEntry) && manifest.version === OPENCLI_VERSION;
} catch { /* Install below. */ }
if (!validOpenCli) {
  await mkdir(opencliDir, { recursive: true });
  await writeFile(path.join(opencliDir, "package.json"), JSON.stringify({ private: true, dependencies: { "@jackwener/opencli": OPENCLI_VERSION } }));
  const install = Bun.spawn([process.execPath, "install", "--ignore-scripts", "--production"], {
    cwd: opencliDir, stdin: "ignore", stdout: "inherit", stderr: "inherit", windowsHide: true,
  });
  if (await install.exited !== 0 || !existsSync(opencliEntry)) throw new Error("OpenCLI 发布依赖安装失败");
  console.log(`已准备 OpenCLI ${OPENCLI_VERSION}`);
}
