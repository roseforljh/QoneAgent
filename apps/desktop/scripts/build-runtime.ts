import { build, context, type BuildOptions } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
export const runtimeBundle = path.join(desktopRoot, "binaries", "qone-runtime.mjs");

/** The agent runtime runs on Qone's own Electron binary in Node mode; no separate JS runtime ships. */
const options: BuildOptions = {
  entryPoints: [path.resolve(desktopRoot, "../agent-runtime/src/index.ts")],
  outfile: runtimeBundle,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  loader: { ".md": "text" },
  // Optional native accelerators (ssh2 crypto, cpu-features) are compiled for
  // another ABI; their callers already fall back to JavaScript when absent.
  external: ["*.node", "cpu-features"],
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

export async function buildRuntime() {
  await build(options);
}

/** Development: rebuild on every source change, so a runtime restart picks up edits. Readable stacks. */
export async function watchRuntime() {
  const ctx = await context({ ...options, minify: false });
  await ctx.rebuild();
  await ctx.watch();
  return ctx;
}

if (import.meta.main) {
  await buildRuntime();
  console.log(`[build-runtime] ${runtimeBundle}`);
}
