import type { Plugin } from "vite";

export function requestDiagnostics(): Plugin {
  return {
    name: "qone-request-diagnostics",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.once("finish", () => {
          if (res.statusCode >= 400) {
            server.config.logger.error(`[qone:http] ${res.statusCode} ${res.statusMessage} ${req.url}`);
          }
        });
        next();
      });
    },
  };
}
