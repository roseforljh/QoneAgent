import { expect, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import { WebSocket } from "ws";
import { DockCdp } from "../electron/dock-cdp";

class DebuggerStub extends EventEmitter {
  attached = false;
  calls: unknown[][] = [];
  isAttached() { return this.attached; }
  attach() { this.attached = true; }
  detach() { this.attached = false; }
  async sendCommand(...args: unknown[]) { this.calls.push(args); return { value: 7 }; }
}

const connect = async (url: string, origin?: string) => {
  const socket = new WebSocket(url, { origin });
  await once(socket, "open");
  return socket;
};

test("OpenCLI can debug only its dock view, not the Qone renderer or other CDP targets", async () => {
  const cdp = new DockCdp();
  const debug = new DebuggerStub();
  const view = { debugger: debug, isDestroyed: () => false } as never;
  try {
    const endpoint = await cdp.endpoint(view);
    await expect(connect(endpoint, "https://example.test")).rejects.toThrow();
    await expect(connect(new URL("/devtools/browser", endpoint).href)).rejects.toThrow();
    const socket = await connect(endpoint);
    const command = async (request: object) => {
      const response = once(socket, "message");
      socket.send(JSON.stringify(request));
      return JSON.parse(String((await response)[0]));
    };
    expect(await command({ id: 1, method: "Runtime.evaluate", params: { expression: "3 + 4" } })).toEqual({ id: 1, result: { value: 7 } });
    for (const request of [
      { id: 2, method: "Target.getTargets" },
      { id: 3, method: "Browser.close" },
      { id: 4, method: "Runtime.evaluate", sessionId: "arbitrary" },
    ]) expect((await command(request)).error).toBeDefined();
    expect(debug.calls).toEqual([["Runtime.evaluate", { expression: "3 + 4" }]]);
    const event = once(socket, "message");
    debug.emit("message", {}, "Page.loadEventFired", { timestamp: 1 });
    expect(JSON.parse(String((await event)[0]))).toEqual({ method: "Page.loadEventFired", params: { timestamp: 1 } });
    const closed = once(socket, "close");
    cdp.close(view);
    await closed;
    await expect(connect(endpoint)).rejects.toThrow();
  } finally { cdp.stop(); }
});
