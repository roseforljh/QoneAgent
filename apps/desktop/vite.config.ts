import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { requestDiagnostics } from "./scripts/vite-request-diagnostics";

export default defineConfig({
  plugins: [react(), tailwindcss(), requestDiagnostics()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
});
