// Transpile patched assistant-ui sources into their dist modules.
// Usage: bun transpile-aui.ts <packageRoot> <src-relative-file>...
import path from "node:path";
import { transformSync } from "esbuild";

const [root, ...files] = process.argv.slice(2);
for (const file of files) {
  const source = await Bun.file(path.join(root!, file)).text();
  let { code } = transformSync(source, { loader: file.endsWith(".tsx") ? "tsx" : "ts", jsx: "automatic", format: "esm", target: "es2022" });
  // dist modules import siblings with explicit .js extensions.
  code = code.replace(/(from\s+["'])(\.{1,2}\/[^"']+?)(["'])/g, (_m, a, spec, b) => a + (spec.endsWith(".js") ? spec : spec + ".js") + b);
  const out = path.join(root!, "dist", file.replace(/^src[\\/]/, "").replace(/\.tsx?$/, ".js"));
  await Bun.write(out, code);
  console.log("wrote", out);
}
