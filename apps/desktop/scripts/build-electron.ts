import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePSReadLine } from "./prepare-psreadline";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");

async function buildElectron() {
  if (process.platform === "win32") await preparePSReadLine();
  await build({
    entryPoints: [path.join(root, "electron/main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: path.join(root, "dist-electron/main.cjs"),
    format: "cjs",
    // Native modules load their .node binaries at runtime; the packaged app
    // ships them from node_modules (runtime "dependencies").
    external: ["electron", "node-pty"],
    sourcemap: true,
  });

  await build({
    entryPoints: [path.join(root, "electron/preload.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: path.join(root, "dist-electron/preload.cjs"),
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  });

  console.log("[build-electron] main and preload built successfully.");
}

await buildElectron();
