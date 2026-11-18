import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { WebContents } from "electron";
import { WebSocket, WebSocketServer } from "ws";

// OpenCLI uses a page endpoint. Never expose browser-wide Target/Browser commands
// (or arbitrary debugger sessions) while the desktop can invoke elevated commands.
const methods = new Set([
  "Accessibility.enable", "Accessibility.getFullAXTree", "DOM.enable", "DOM.focus", "DOM.getBoxModel",
  "DOM.getContentQuads", "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.scrollIntoViewIfNeeded",
  "DOM.setFileInputFiles", "Emulation.clearDeviceMetricsOverride", "Emulation.setDeviceMetricsOverride",
  "Input.dispatchKeyEvent", "Input.dispatchMouseEvent", "Input.insertText", "Network.enable", "Network.getCookies",
  "Network.getRequestPostData", "Network.getResponseBody", "Page.addScriptToEvaluateOnNewDocument", "Page.captureScreenshot",
  "Page.enable", "Page.getFrameTree", "Page.getLayoutMetrics", "Page.handleJavaScriptDialog", "Page.navigate",
  "Runtime.enable", "Runtime.evaluate",
]);

export class DockCdp {
  private readonly targets = new Map<string, { view: WebContents; socket?: WebSocket }>();
  private server?: WebSocketServer;

  private listen(): WebSocketServer {
    const verifyClient: WebSocket.VerifyClientCallbackSync = ({ origin, req }) => !origin && this.targets.has(req.url ?? "");
    const server = new WebSocketServer({
      host: "127.0.0.1", port: 0, maxPayload: 1024 * 1024,
      verifyClient,
    });
    server.on("error", error => console.warn("[browser] Dock debugger endpoint failed:", error));
    server.on("connection", (socket, request) => {
      const target = this.targets.get(request.url ?? "");
      const view = target?.view;
      if (!target || !view || target.socket || view.isDestroyed() || view.debugger.isAttached()) {
        socket.terminate();
        return;
      }
      socket.on("error", () => socket.terminate());
      try { view.debugger.attach("1.3"); } catch { socket.terminate(); return; }
      target.socket = socket;
      const send = (value: object) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
      const detached = () => socket.terminate();
      const event = (_event: unknown, method: string, params: unknown, sessionId: string) => {
        if (!sessionId) send({ method, params });
      };
      view.debugger.on("message", event);
      view.debugger.once("detach", detached);
      socket.on("close", () => {
        target.socket = undefined;
        view.debugger.removeListener("message", event);
        view.debugger.removeListener("detach", detached);
        if (!view.isDestroyed() && view.debugger.isAttached()) view.debugger.detach();
      });
      socket.on("message", async data => {
        let id: number | undefined;
        try {
          const request = JSON.parse(data.toString());
          if (!Number.isSafeInteger(request?.id)) return;
          id = request.id;
          if (request.sessionId !== undefined || !methods.has(request.method)) throw new Error("Command unavailable on a dock page endpoint");
          const result = await view.debugger.sendCommand(request.method, request.params);
          send({ id, result });
        } catch (error) {
          if (id !== undefined) send({ id, error: { message: error instanceof Error ? error.message : String(error) } });
        }
      });
    });
    return server;
  }

  async endpoint(view: WebContents): Promise<string> {
    const server = this.server ??= this.listen();
    if (!server.address()) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string" || view.isDestroyed()) throw new Error("Dock debugger endpoint is unavailable");
    let route = [...this.targets].find(([, target]) => target.view === view)?.[0];
    if (!route) {
      route = `/${randomUUID()}`;
      this.targets.set(route, { view });
    }
    return `ws://127.0.0.1:${address.port}${route}`;
  }

  close(view: WebContents): void {
    for (const [route, target] of this.targets) {
      if (target.view !== view) continue;
      this.targets.delete(route);
      target.socket?.terminate();
    }
  }

  stop(): void {
    for (const target of this.targets.values()) target.socket?.terminate();
    this.targets.clear();
    this.server?.close();
    this.server = undefined;
  }
}
