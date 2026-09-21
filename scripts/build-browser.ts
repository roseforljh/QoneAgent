import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "apps", "desktop", "src-tauri", "binaries");
await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [path.join(root, "apps", "agent-runtime", "src", "browser-helper.ts")],
  outdir,
  naming: "qone-browser-helper.mjs",
  target: "node",
  format: "esm",
  minify: true,
});
if (!result.success) throw new AggregateError(result.logs, "browser helper build failed");

const nodeSource = fileURLToPath(import.meta.resolve("node-win-x64/bin/node.exe"));
await copyFile(nodeSource, path.join(outdir, "qone-browser-node-x86_64-pc-windows-msvc.exe"));
