import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { proxyEnvironmentKey } from "@qone/protocol/proxy-environment";

test("the desktop dispatcher routes native fetch, redirects and WebSocket without replaying failed or cancelled requests", async () => {
  const tunnels: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === "/redirect") response.writeHead(302, { location: "https://redirect.invalid/next" });
    response.end("loopback");
  }).on("connect", (request, socket) => {
    tunnels.push(request.url!);
    socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const directory = mkdtempSync(path.join(os.tmpdir(), "qone-system-proxy-test-"));
  try {
    // Use desktop-style Node; Bun's fetch does not use Undici's global dispatcher.
    const entry = path.join(directory, "entry.ts");
    const source = (name: string) => JSON.stringify(path.resolve(import.meta.dir, `../src/${name}.ts`).replaceAll("\\", "/"));
    writeFileSync(entry, `export { installSystemProxy } from ${source("system-proxy")};\nexport { requestPublicUrl } from ${source("web-fetch-transport")};`);
    const build = await Bun.build({ entrypoints: [entry], outdir: directory, naming: "system-proxy.cjs", target: "node", format: "cjs" });
    expect(build.success).toBe(true);
    const child = Bun.spawn(["node", "-e", `
      const assert = require('node:assert/strict');
      const { installSystemProxy, requestPublicUrl } = require('./system-proxy.cjs');
      const resolved = [];
      const nativeFetch = fetch;
      installSystemProxy(async origin => {
        resolved.push(origin);
        if (origin.includes('cancelled')) await new Promise(r => setTimeout(r, 80));
        return 'PROXY 127.0.0.1:${port}; DIRECT';
      });
      (async () => {
        assert.equal(await (await nativeFetch('http://127.0.0.1:${port}')).text(), 'loopback');
        await assert.rejects(nativeFetch('https://remote.invalid/test?private=ok', { method: 'POST', signal: AbortSignal.timeout(2000) }));
        await assert.rejects(nativeFetch('http://127.0.0.1:${port}/redirect', { signal: AbortSignal.timeout(2000) }));
        await assert.rejects(nativeFetch('https://cancelled.invalid', { method: 'POST', signal: AbortSignal.timeout(20) }), { name: 'TimeoutError' });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('WebSocket did not complete')), 2000);
          const socket = new WebSocket('wss://socket.invalid/test');
          socket.addEventListener('open', () => reject(new Error('Unexpected WebSocket open')));
          socket.addEventListener('error', () => { clearTimeout(timer); resolve(); });
        });
        await assert.rejects(requestPublicUrl(new URL('https://public.invalid'), [{ address: '1.1.1.1', family: 4 }], { headers: {}, signal: AbortSignal.timeout(2000) }));
        assert.deepEqual(resolved, ['https://remote.invalid', 'https://redirect.invalid', 'https://cancelled.invalid', 'https://socket.invalid', 'https://public.invalid']);
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: directory, stderr: "pipe", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !proxyEnvironmentKey.test(key))), QONE_LOG_DIR: directory } });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    expect(tunnels).toEqual(["remote.invalid:443", "redirect.invalid:443", "socket.invalid:443", "1.1.1.1:443"]);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
