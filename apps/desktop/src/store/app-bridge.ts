import type { RuntimeEvent } from "@qone/protocol";
import { invoke } from "../lib/desktop-bridge";
import { resolveDouyinPage } from "../lib/douyin-page-bridge";
import { resolveDouyinAuthorPage } from "../lib/douyin-author-page";
import { DouyinPageError } from "../lib/douyin-video-page";
import { BACKGROUND_BROWSER_BOUNDS } from "../lib/background-browser";

export const douyinRequests = new Map<string, AbortController>();
export const appOpenCliRequests = new Map<string, string>();

export async function serveDouyinBridgeRequest(
  request: Extract<RuntimeEvent, { type: "douyin.bridge.request" }>,
  send: (command: Extract<import("@qone/protocol").RuntimeCommand, { type: "douyin.bridge.response" }>) => Promise<boolean>,
): Promise<void> {
  if (douyinRequests.has(request.requestId)) return;
  const controller = new AbortController();
  douyinRequests.set(request.requestId, controller);
  try {
    const result = await (request.operation === "author" ? resolveDouyinAuthorPage : resolveDouyinPage)(invoke, request, controller.signal);
    if (!controller.signal.aborted) await send({ type: "douyin.bridge.response", requestId: request.requestId, ok: true, result });
  } catch (error) {
    if (!controller.signal.aborted) await send({ type: "douyin.bridge.response", requestId: request.requestId, ok: false,
      failure: error instanceof DouyinPageError ? error.failure : "page_unavailable",
      message: error instanceof Error ? error.message : String(error) });
  } finally {
    douyinRequests.delete(request.requestId);
  }
}

export async function serveAppOpenCliRequest(
  request: Extract<RuntimeEvent, { type: "apps.opencli.request" }>,
  send: (command: Extract<import("@qone/protocol").RuntimeCommand, { type: "apps.opencli.response" }>) => Promise<boolean>,
): Promise<void> {
  if (appOpenCliRequests.has(request.requestId)) return;
  const browserId = `opencli-${request.site}-${request.requestId}`;
  appOpenCliRequests.set(request.requestId, browserId);
  try {
    await invoke("browser_open", { browserId, url: request.url, ...BACKGROUND_BROWSER_BOUNDS });
    // A release can arrive while browser_open is still preparing WebView2.
    // Close the late-created child instead of leaving an orphaned hidden browser.
    if (appOpenCliRequests.get(request.requestId) !== browserId) {
      await invoke("browser_close", { browserId }).catch(() => undefined);
      return;
    }
    const endpoint = await invoke<string>("opencli_cdp_endpoint", { browserId });
    await send({ type: "apps.opencli.response", requestId: request.requestId, ok: true, endpoint });
  } catch (error) {
    const ownsRequest = appOpenCliRequests.get(request.requestId) === browserId;
    if (ownsRequest) appOpenCliRequests.delete(request.requestId);
    await invoke("browser_close", { browserId }).catch(() => undefined);
    if (ownsRequest) await send({ type: "apps.opencli.response", requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}
