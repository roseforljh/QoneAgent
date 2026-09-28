import { access } from "node:fs/promises";
import path from "node:path";

const desktop = path.resolve(import.meta.dir, "..");
const sidecar = path.join(desktop, "src-tauri", "binaries", "qone-runtime-x86_64-pc-windows-msvc.exe");

try {
  await access(sidecar);
} catch {
  const build = Bun.spawn(["bun", "run", "build:sidecar"], {
    cwd: desktop,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await build.exited;
  if (exitCode !== 0) process.exit(exitCode);
}

const vite = Bun.spawn(["bun", "run", "dev"], {
  cwd: desktop,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await vite.exited);
