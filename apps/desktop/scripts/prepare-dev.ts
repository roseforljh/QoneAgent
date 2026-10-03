import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const desktop = path.resolve(import.meta.dir, "..");
const sidecar = path.join(desktop, "src-tauri", "binaries", "qone-runtime-x86_64-pc-windows-msvc.exe");

async function newestSourceMtime(directory: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestSourceMtime(target));
    else if (entry.isFile() && /\.(ts|tsx|js|json)$/.test(entry.name)) newest = Math.max(newest, (await stat(target)).mtimeMs);
  }
  return newest;
}

const sourceMtime = Math.max(
  await newestSourceMtime(path.join(desktop, "..", "agent-runtime", "src")),
  await newestSourceMtime(path.join(desktop, "..", "..", "packages", "protocol", "src")),
  await newestSourceMtime(path.join(desktop, "..", "..", "packages", "database", "src")),
);
let rebuildSidecar = false;
try {
  rebuildSidecar = (await stat(sidecar)).mtimeMs < sourceMtime;
} catch {
  rebuildSidecar = true;
}

if (rebuildSidecar) {
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
