import { isFileLoadingAllowed, type Plugin } from "vite";
import { existsSync } from "node:fs";
import path from "node:path";

/** Keep debugging maps on the dev server, not embedded in every resident script. */
export function externalSourcemaps(): Plugin {
  return {
    name: "qone-external-sourcemaps",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method !== "GET" || req.headers["sec-fetch-dest"] !== "script" || !req.url) return next();
        try {
          const pathname = decodeURIComponent(req.url.split("?")[0]!);
          const file = pathname.startsWith("/@fs/") ? pathname.slice(5) : path.join(server.config.root, pathname);
          if (!isFileLoadingAllowed(server.config, file.replaceAll("\\", "/"))) return next();
          if (server.config.publicDir && existsSync(path.join(server.config.publicDir, pathname))) return next();
          const result = await server.environments.client.transformRequest(req.url);
          if (!result) return next();
          res.setHeader("Content-Type", "text/javascript");
          res.setHeader("Cache-Control", "no-cache");
          const etag = result.etag.replace(/"$/, '-external-map"');
          res.setHeader("Etag", etag);
          if (req.headers["if-none-match"] === etag) {
            res.statusCode = 304;
            return res.end();
          }
          // Vite already serves the matching transformResult at <module>.map.
          const mapUrl = req.url.replace(/\?|$/, ".map$&");
          const hasMap = result.map && "version" in result.map && result.map.mappings;
          res.end(hasMap ? `${result.code}\n//# sourceMappingURL=${mapUrl}` : result.code);
        } catch (error) { next(error); }
      });
    },
  };
}
