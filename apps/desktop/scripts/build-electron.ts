import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(import.meta.url), "../..");

async function buildElectron() {
  await build({
    entryPoints: [path.join(root, "electron/main.ts")],
    bundle: true,
    platform: "node",
    target: "node20",
    outfile: path.join(root, "dist-electron/main.cjs"),
    format: "cjs",
    external: ["electron"],
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
