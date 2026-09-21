import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

type BridgeResult = { ok: true; value: unknown } | { ok: false; error: string };

class NodeBrowserBridge {
  private child?: {
    stdin: { write(data: string): unknown; flush(): unknown };
    stdout: ReadableStream<Uint8Array>;
    kill(): void;
    exited: Promise<number>;
  };
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private executable() {
    const bundled = path.resolve(import.meta.dir, "../../desktop/src-tauri/binaries/qone-browser-node-x86_64-pc-windows-msvc.exe");
    return process.env.QONE_BROWSER_NODE ?? (existsSync(bundled) ? bundled : "node");
  }

  private helper() {
    const bundled = path.resolve(import.meta.dir, "../../desktop/src-tauri/binaries/qone-browser-helper.mjs");
    return process.env.QONE_BROWSER_HELPER ?? (existsSync(bundled) ? bundled : path.join(import.meta.dir, "browser-helper.ts"));
  }

  private async start() {
    if (this.child) return;
    const helper = this.helper();
    this.child = Bun.spawn([this.executable(), helper], {
      cwd: path.dirname(helper),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: process.env,
    }) as unknown as NonNullable<NodeBrowserBridge["child"]>;
    const child = this.child;
    void (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          this.buffer += decoder.decode(value, { stream: true });
          let newline = -1;
          while ((newline = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, newline);
            this.buffer = this.buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const response = JSON.parse(line) as { id: number } & BridgeResult;
            const waiter = this.pending.get(response.id);
            if (!waiter) continue;
            clearTimeout(waiter.timer);
            this.pending.delete(response.id);
            if (response.ok) waiter.resolve(response.value);
            else waiter.reject(new Error(response.error));
          }
        }
      } catch (error) {
        this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.rejectPending(new Error("browser helper exited"));
        if (this.child === child) this.child = undefined;
      }
    })();
  }

  private rejectPending(error: Error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  async call<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.start();
    const child = this.child!;
    const id = this.nextId++;
    const timeout = Number(process.env.QONE_BROWSER_TIMEOUT_MS ?? 60_000);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`browser operation timed out: ${op}`));
        child.kill();
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
      await child.stdin.flush();
    } catch (error) {
      const waiter = this.pending.get(id);
      if (waiter) clearTimeout(waiter.timer);
      this.pending.delete(id);
      throw error;
    }
    return await promise as T;
  }

  async close() {
    const child = this.child;
    if (!child) return;
    try { await this.call("close"); } catch {}
    child.kill();
    await child.exited;
    if (this.child === child) this.child = undefined;
    this.buffer = "";
  }
}

const bridges = new Map<string, NodeBrowserBridge>();
const bridgeFor = (scopeId: string) => {
  const existing = bridges.get(scopeId);
  if (existing) return existing;
  const bridge = new NodeBrowserBridge();
  bridges.set(scopeId, bridge);
  return bridge;
};
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });

export function browserUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:", "data:", "about:"].includes(url.protocol)) throw new Error(`browser URL scheme denied: ${url.protocol}`);
  if (url.username || url.password) throw new Error("browser URL credentials are denied");
  return url.toString();
}

function artifactDir(scopeId: string, kind: "screenshots" | "downloads") {
  const root = process.env.QONE_ARTIFACTS_DIR ?? path.join(
    process.env.APPDATA ?? process.env.HOME ?? process.cwd(),
    "QoneAgent",
    "artifacts",
  );
  const safeScope = scopeId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const dir = path.join(root, safeScope, kind);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function createBrowserTools(scopeId: string): ToolDefinition[] {
  const call = <T = unknown>(op: string, params: Record<string, unknown> = {}) => bridgeFor(scopeId).call<T>(op, params);
  return [
    defineTool({
      name: "browser.open",
      label: "Browser open",
      description: "Open a URL in the browser. Returns title and URL.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => {
        const result = await call<{ url: string; title: string }>("open", { url: browserUrl(params.url) });
        return text(`Opened ${result.url} — ${result.title}`);
      },
    }),
    defineTool({
      name: "browser.navigate",
      label: "Browser navigate",
      description: "Navigate the current browser page to a URL.",
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => {
        const result = await call<{ url: string; title: string }>("navigate", { url: browserUrl(params.url) });
        return text(`Navigated to ${result.url} — ${result.title}`);
      },
    }),
    defineTool({
      name: "browser.snapshot",
      label: "Browser snapshot",
      description: "Get URL, title, aria snapshot and interactive elements of the current page.",
      parameters: Type.Object({}),
      execute: async () => text(await call<string>("snapshot")),
    }),
    defineTool({
      name: "browser.click",
      label: "Browser click",
      description: "Click an element by CSS selector, or by role+name.",
      parameters: Type.Object({
        selector: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        name: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        const result = await call<{ url: string }>("click", params);
        return text(`Clicked, now on ${result.url}`);
      },
    }),
    defineTool({
      name: "browser.type",
      label: "Browser type",
      description: "Fill an input by CSS selector.",
      parameters: Type.Object({ selector: Type.String(), text: Type.String(), submit: Type.Optional(Type.Boolean()) }),
      execute: async (_id, params) => {
        await call("type", params);
        return text("Typed.");
      },
    }),
    defineTool({
      name: "browser.extract",
      label: "Browser extract",
      description: "Extract text content from the page or a selector.",
      parameters: Type.Object({ selector: Type.Optional(Type.String()) }),
      execute: async (_id, params) => text(await call<string>("extract", params)),
    }),
    defineTool({
      name: "browser.screenshot",
      label: "Browser screenshot",
      description: "Take a full-page screenshot, saved to a file path.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute: async (_id, params) => {
        const out = params.path ?? path.join(artifactDir(scopeId, "screenshots"), `screenshot-${Date.now()}.png`);
        await call("screenshot", { path: out });
        return text(`Screenshot saved to ${out}`);
      },
    }),
    defineTool({
      name: "browser.download",
      label: "Browser download",
      description: "Click a download link and save the downloaded file.",
      parameters: Type.Object({ selector: Type.String(), path: Type.Optional(Type.String()) }),
      execute: async (_id, params) => {
        const out = params.path ?? path.join(artifactDir(scopeId, "downloads"), `download-${Date.now()}`);
        await call("download", { selector: params.selector, path: out });
        return text(`Download saved to ${out}`);
      },
    }),
    defineTool({
      name: "browser.close",
      label: "Browser close",
      description: "Close the browser.",
      parameters: Type.Object({}),
      execute: async () => {
        await closeBrowser(scopeId);
        return text("Closed.");
      },
    }),
  ];
}

export const browserTools = createBrowserTools("tests");

export async function closeBrowser(scopeId: string): Promise<void> {
  const bridge = bridges.get(scopeId);
  if (!bridge) return;
  bridges.delete(scopeId);
  await bridge.close();
}

export async function closeAllBrowsers(): Promise<void> {
  const active = [...bridges.values()];
  bridges.clear();
  await Promise.all(active.map((bridge) => bridge.close()));
}

export async function closeBrowserForTests(): Promise<void> {
  await closeBrowser("tests");
}
