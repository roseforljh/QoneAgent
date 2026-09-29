import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin } from "vite";

export function readDependencyPatches(projectRoot: string) {
  const manifestPath = resolve(projectRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    patchedDependencies?: Record<string, string>;
  };
  const hash = createHash("sha256");
  const files = [manifestPath];
  for (const [name, relativePath] of Object.entries(manifest.patchedDependencies ?? {}).sort()) {
    const path = resolve(projectRoot, relativePath);
    files.push(path);
    hash.update(JSON.stringify([name, relativePath]));
    hash.update(readFileSync(path));
  }
  return { files, fingerprint: hash.digest("hex") };
}

export function dependencyPatches(projectRoot: string): Plugin {
  const { files, fingerprint } = readDependencyPatches(projectRoot);
  const watched = new Set(files);
  return {
    // Vite includes plugin names in its optimizer config hash. Its built-in
    // Bun check only reads the patches directory mtime, which misses file edits.
    name: `qone-dependency-patches-${fingerprint}`,
    apply: "serve",
    configureServer(server) {
      server.watcher.add(files);
      const changed = (path: string) => {
        if (watched.has(resolve(path))) void server.restart(true);
      };
      server.watcher.on("change", changed);
      server.watcher.on("add", changed);
      server.watcher.on("unlink", changed);
      server.httpServer?.once("close", () => {
        server.watcher.off("change", changed);
        server.watcher.off("add", changed);
        server.watcher.off("unlink", changed);
      });
    },
  };
}
