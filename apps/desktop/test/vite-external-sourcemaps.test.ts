import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { externalSourcemaps } from "../scripts/vite-external-sourcemaps";

test("dev scripts use external maps, keep debugging and invalidate conditional requests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qone-sourcemap-"));
  const source = path.join(root, "entry.ts");
  await writeFile(source, "export const value: number = 1;\n");
  await writeFile(path.join(root, "data.json"), '{"value":1}');
  await writeFile(path.join(root, ".env"), "QONE_TEST_SECRET=not-public");
  await mkdir(path.join(root, "public"));
  await writeFile(path.join(root, "public", "boot.js"), "window.boot = true;");
  const server = await createServer({
    configFile: false, root, plugins: [externalSourcemaps()],
    server: { host: "127.0.0.1", port: 0 }, optimizeDeps: { noDiscovery: true },
  });
  try {
    await server.listen();
    const url = `${server.resolvedUrls!.local[0]}entry.ts?v=test`;
    const headers = { "sec-fetch-dest": "script" };
    const boot = await fetch(new URL("/boot.js", url), { headers });
    expect(boot.status).toBe(200);
    expect(await boot.text()).toBe("window.boot = true;");
    const denied = await fetch(new URL("/.env?import", url), { headers });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("not-public");
    const json = await fetch(new URL("/data.json?import", url), { headers }).then((result) => result.text());
    expect(json).not.toContain("sourceMappingURL=data:");
    const response = await fetch(url, { headers });
    const code = await response.text();
    expect(code).toContain("sourceMappingURL=/entry.ts.map?v=test");
    expect(code).not.toContain("sourceMappingURL=data:");
    const map = await fetch(new URL("/entry.ts.map?v=test", url)).then((result) => result.json());
    expect(map.sourcesContent).toEqual(["export const value: number = 1;\n"]);
    const cached = await fetch(url, { headers: { ...headers, "if-none-match": response.headers.get("etag")! } });
    expect(cached.status).toBe(304);
    await writeFile(source, "export const value: number = 2;\n");
    server.environments.client.moduleGraph.invalidateAll();
    const changed = await fetch(url, { headers: { ...headers, "if-none-match": response.headers.get("etag")! } });
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain("value = 2");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
