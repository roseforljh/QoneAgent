import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { requestDiagnostics } from "./scripts/vite-request-diagnostics";
import { dependencyPatches } from "./scripts/vite-dependency-patches";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const previewRuntimeId = "virtual:qone-react-preview-runtime";
const resolvedPreviewRuntimeId = `\0${previewRuntimeId}`;

function reactPreviewRuntime() {
  return {
    name: "react-preview-runtime",
    resolveId(id: string) { return id === previewRuntimeId ? resolvedPreviewRuntimeId : undefined; },
    async load(id: string) {
      if (id !== resolvedPreviewRuntimeId) return undefined;
      const result = await build({
        entryPoints: [fileURLToPath(new URL("./src/lib/code-preview-react-runtime.ts", import.meta.url))],
        bundle: true,
        format: "iife",
        platform: "browser",
        minify: true,
        write: false,
      });
      return `export default ${JSON.stringify(result.outputFiles[0]!.text)}`;
    },
  };
}

export default defineConfig({
  // Keep the repository-level .env available to the desktop client. Only
  // VITE_* values are exposed to the renderer; the GitHub client ID is public.
  envDir: "../..",
  plugins: [react(), tailwindcss(), requestDiagnostics(), reactPreviewRuntime(), dependencyPatches(fileURLToPath(new URL("../../", import.meta.url)))],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1480,
    strictPort: true,
  },
});
