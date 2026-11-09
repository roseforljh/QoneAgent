import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const repoRoot = path.resolve(desktopRoot, "../..");

function runCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n> [${path.basename(cwd)}] ${command} ${args.join(" ")}`);
    const proc = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
      env: { ...process.env },
    });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed with exit code ${code}`));
    });
    proc.on("error", reject);
  });
}

async function buildRelease() {
  console.log("=== 开始编译 QoneAgent Release 版本 ===");

  // 1. 确保 binaries 目录存在
  const binariesDir = path.join(desktopRoot, "binaries");
  fs.mkdirSync(binariesDir, { recursive: true });

  // 2. 编译 agent-runtime 独立可执行程序
  console.log("\n[1/5] 编译 agent-runtime 独立进程...");
  const runtimeEntry = path.join(repoRoot, "apps/agent-runtime/src/index.ts");
  const runtimeOut = path.join(binariesDir, "qone-runtime.exe");
  await runCommand("bun", ["build", runtimeEntry, "--compile", "--outfile", runtimeOut], desktopRoot);

  // 3. 生成 boot locale
  console.log("\n[2/5] 生成初始国际化语言包...");
  await runCommand("bun", ["run", "scripts/generate-boot-locale.ts"], desktopRoot);

  // 4. 类型检查与前端 Vite 构建
  console.log("\n[3/5] 执行前端 TypeScript 校验与 Vite 生产构建...");
  await runCommand("bun", ["run", "tsc", "--noEmit"], desktopRoot);
  await runCommand("bun", ["run", "vite", "build"], desktopRoot);

  // 5. 编译 Electron 主进程与预加载脚本
  console.log("\n[4/5] 编译 Electron 主进程...");
  await runCommand("bun", ["run", "scripts/build-electron.ts"], desktopRoot);

  // 6. 执行 Electron Builder 打包 Windows exe
  console.log("\n[5/5] 执行 Electron Builder 打包 Windows 独立 exe...");
  await runCommand("bun", ["x", "electron-builder", "--config", "electron-builder.json"], desktopRoot);

  console.log("\n=== 编译成功！===");
  console.log(`产物位于: ${path.join(desktopRoot, "release")}`);
}

buildRelease().catch((err) => {
  console.error("\n❌ Release 编译失败:", err);
  process.exit(1);
});
