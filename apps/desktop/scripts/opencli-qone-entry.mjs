// Qone entrypoint: keep OpenCLI's generic browser commands on Qone's WebView2.
// The published CLI routes site adapters through CDP, but its generic browser
// command still constructs BrowserBridge directly. Patch that one public seam
// before loading the CLI so it cannot start the external Browser Bridge.
import { BrowserBridge, CDPBridge } from "./node_modules/@jackwener/opencli/dist/src/browser/index.js";

const originalClose = BrowserBridge.prototype.close;

BrowserBridge.prototype.connect = async function (options = {}) {
  const endpoint = process.env.OPENCLI_CDP_ENDPOINT?.trim();
  if (!endpoint) throw new Error("Qone requires the built-in browser target for OpenCLI browser commands");

  const bridge = new CDPBridge();
  const page = await bridge.connect({ ...options, cdpEndpoint: endpoint });
  page.session = options.session;
  page.contextId = options.contextId;
  page.preferredContextId = options.preferredContextId;
  this.__qoneCdpBridge = bridge;
  this._page = page;
  this._state = "connected";
  bridge._ws?._socket?.unref?.();
  return page;
};

BrowserBridge.prototype.close = async function () {
  if (this.__qoneCdpBridge) {
    await this.__qoneCdpBridge.close().catch(() => undefined);
    this.__qoneCdpBridge = undefined;
    this._page = null;
    this._state = "closed";
    return;
  }
  return originalClose.call(this);
};

await import("./node_modules/@jackwener/opencli/dist/src/main.js");
