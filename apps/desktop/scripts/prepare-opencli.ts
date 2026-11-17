import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const OPENCLI_VERSION = "1.8.8";
const binaries = path.resolve(import.meta.dir, "../binaries");
const opencliDir = path.join(binaries, "opencli");
const opencliEntry = path.join(opencliDir, "node_modules", "@jackwener", "opencli", "dist", "src", "main.js");
const qoneEntry = path.join(opencliDir, "qone-entry.mjs");

await mkdir(binaries, { recursive: true });
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
await writeFile(qoneEntry, await readFile(path.join(import.meta.dir, "opencli-qone-entry.mjs")));
