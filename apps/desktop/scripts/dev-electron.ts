import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBin = require("electron") as string;
const root = path.resolve(fileURLToPath(import.meta.url), "../..");

// 1. 生成 boot locale
const genLocale = spawn("bun", ["run", "scripts/generate-boot-locale.ts"], {
  cwd: root,
  stdio: "inherit",
});
await new Promise((resolve) => genLocale.on("close", resolve));

// 2. 编译 electron
const buildElec = spawn("bun", ["run", "scripts/build-electron.ts"], {
  cwd: root,
  stdio: "inherit",
});
await new Promise((resolve) => buildElec.on("close", resolve));

// 3. 启动 vite
const vite = spawn("bun", ["run", "vite"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env },
});

// 等待 vite 服务启动就绪
async function waitForServer(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // 正在启动中
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

await waitForServer("http://127.0.0.1:1480");

// 4. 启动 electron
const electron = spawn(electronBin, [path.join(root, "dist-electron/main.cjs")], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "development",
    QONE_AGENT_RUNTIME: process.env.QONE_AGENT_RUNTIME || path.resolve(root, "../agent-runtime/src/index.ts"),
    VITE_DEV_SERVER_URL: "http://127.0.0.1:1480",
  },
});

function cleanup() {
  try {
    electron.kill();
  } catch {}
  try {
    vite.kill();
  } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

electron.on("close", (code) => {
  try {
    vite.kill();
  } catch {}
  process.exit(code ?? 0);
});
