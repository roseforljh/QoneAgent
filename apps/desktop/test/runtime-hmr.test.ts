import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("replacing the conversation store reloads the renderer instead of retaining old IPC and queue closures", async () => {
  // Isolate the loader and Tauri mocks from the other store tests. Inject the
  // same hot context Vite supplies and execute the real module's HMR callback.
  const child = Bun.spawn([process.execPath, "--eval", String.raw`
    import { plugin } from "bun";
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const accepts = [];
    let reloads = 0;
    globalThis.__hot = { accept: callback => accepts.push(callback) };
    globalThis.window = {
      __TAURI_INTERNALS__: {},
      location: { reload: () => reloads++ },
      localStorage: { getItem: () => null, setItem: () => {} },
    };
    mock.module("@tauri-apps/api/core", () => ({ invoke: async () => {} }));
    mock.module("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
    mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
    plugin({ name: "vite-hot-context", setup(build) {
      build.onLoad({ filter: /[/\\]store\.ts$/ }, async ({ path }) => ({
        contents: (await Bun.file(path).text()).replaceAll("import.meta.hot", "globalThis.__hot"),
        loader: "ts",
      }));
    } });
    await import("./src/store.ts");
    assert.equal(reloads, 0, "ordinary startup must not reload");
    assert.equal(accepts.length, 1, "the store must own an HMR boundary");
    accepts[0]();
    assert.equal(reloads, 1, "a replacement must discard stale module closures");
  `], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdout: "pipe", stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
});
