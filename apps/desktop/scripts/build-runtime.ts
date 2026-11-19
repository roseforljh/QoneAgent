import { build, context, type BuildOptions } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const runtimeEntry = path.resolve(desktopRoot, "../agent-runtime/src/index.ts");
// Packages that load files beside their own module (Codemode worker, QuickJS and
// Photon WASM) ship unbundled so those files resolve next to them.
const unbundledPackages = ["@earendil-works/pi-codemode", "quickjs-wasi", "@silvia-odwyer/photon-node"];
export const runtimeBundle = path.join(desktopRoot, "binaries", "qone-runtime.mjs");
const terminalWorkerEntry = path.join(desktopRoot, "electron", "terminal-worker.ts");
export const terminalWorkerBundle = path.join(desktopRoot, "binaries", "qone-terminal-worker.mjs");

/** The agent runtime runs on Qone's own Electron binary in Node mode; no separate JS runtime ships. */
const options: BuildOptions = {
  entryPoints: [runtimeEntry],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  loader: { ".md": "text" },
  // Optional native accelerators (ssh2 crypto, cpu-features) are compiled for
  // another ABI; their callers already fall back to JavaScript when absent.
  external: ["*.node", "cpu-features", ...unbundledPackages],
  // CommonJS dependencies inside an ES module bundle still expect these.
  banner: { js: [
    'import { createRequire as __qoneCreateRequire } from "node:module";',
    'import { fileURLToPath as __qoneFileURLToPath } from "node:url";',
    'import { dirname as __qoneDirname } from "node:path";',
    "const require = __qoneCreateRequire(import.meta.url);",
    "const __filename = __qoneFileURLToPath(import.meta.url);",
    "const __dirname = __qoneDirname(__filename);",
  ].join("\n") },
  // V8 keeps the whole source text resident; minified it is ~13 MB instead of ~22 MB.
  minify: true,
  keepNames: true,
  legalComments: "none",
  logLevel: "warning",
};

const piEntry = Bun.resolveSync("@earendil-works/pi-coding-agent", path.dirname(runtimeEntry));

async function runtimeOptions(outfile: string): Promise<BuildOptions> {
  for (const name of unbundledPackages) {
    const entry = Bun.resolveSync(name, path.dirname(piEntry));
    for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
      const manifest = Bun.file(path.join(dir, "package.json"));
      if (await manifest.exists() && (await manifest.json()).name === name) {
        await cp(dir, path.join(path.dirname(outfile), "node_modules", name), { recursive: true });
        break;
      }
      if (dir === path.dirname(dir)) throw new Error(`Could not find package root for ${name} from ${entry}`);
    }
  }
  return { ...options, outfile };
}

/** Pi spawns its image resize worker from beside the bundle; without it every
 * resize falls back to running on the runtime's own event loop. Pi fixes the
 * `.js` name, so the folder declares ES modules instead of relying on Node's
 * syntax detection (which warns and depends on unrelated parent package.json files). */
async function buildImageResizeWorker(runtimeOutfile: string) {
  const directory = path.dirname(runtimeOutfile);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  await build({
    ...options,
    entryPoints: [path.join(path.dirname(piEntry), "utils", "image-resize-worker.js")],
    outfile: path.join(directory, "image-resize-worker.js"),
  });
}

export async function buildRuntime(outfile = runtimeBundle) {
  await Promise.all([build(await runtimeOptions(outfile)), buildImageResizeWorker(outfile)]);
}

/** Development: rebuild on every source change, so a runtime restart picks up edits. Readable stacks. */
export async function watchRuntime() {
  const ctx = await context({ ...await runtimeOptions(runtimeBundle), minify: false });
  await Promise.all([ctx.rebuild(), buildImageResizeWorker(runtimeBundle)]);
  await ctx.watch();
  return ctx;
}

export async function buildTerminalWorker(outfile = terminalWorkerBundle) {
  await build({ ...options, entryPoints: [terminalWorkerEntry], outfile });
}

if (import.meta.main) {
  await Promise.all([buildRuntime(), ...(process.platform === "win32" ? [buildTerminalWorker()] : [])]);
  console.log(`[build-runtime] ${runtimeBundle}`);
}
