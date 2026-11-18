import { build, context, type BuildOptions } from "esbuild";
import { cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
const runtimeEntry = path.resolve(desktopRoot, "../agent-runtime/src/index.ts");
const codemodePackages = ["@earendil-works/pi-codemode", "quickjs-wasi"];
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
  // Codemode locates its worker relative to its own module and QuickJS through Node package resolution.
  external: ["*.node", "cpu-features", ...codemodePackages],
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

async function runtimeOptions(outfile: string): Promise<BuildOptions> {
  const piEntry = Bun.resolveSync("@earendil-works/pi-coding-agent", path.dirname(runtimeEntry));
  for (const name of codemodePackages) {
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

export async function buildRuntime(outfile = runtimeBundle) {
  await build(await runtimeOptions(outfile));
}

/** Development: rebuild on every source change, so a runtime restart picks up edits. Readable stacks. */
export async function watchRuntime() {
  const ctx = await context({ ...await runtimeOptions(runtimeBundle), minify: false });
  await ctx.rebuild();
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
