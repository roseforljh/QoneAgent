import type { RuntimeEvent } from "@qone/protocol";
import { invoke } from "../lib/desktop-bridge";
import { resolveDouyinPage } from "../lib/douyin-page-bridge";
import { resolveDouyinAuthorPage } from "../lib/douyin-author-page";
import { DouyinPageError } from "../lib/douyin-video-page";
import { BACKGROUND_BROWSER_BOUNDS } from "../lib/background-browser";
import { closeAgentBrowserInDock, openAgentBrowserInDock } from "../lib/browser-dock";

type BridgeInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

interface ManagedBrowserEntry {
  browserId: string;
  sessionKey: string;
  site: string;
  url: string;
  /** 正在占用该浏览器 CDP 会话的请求集合。 */
  activeRequests: Set<string>;
  /** 当前是否由右侧 WorkspaceDock 的内置浏览器标签页承载显示。 */
  hosted: boolean;
}

export const douyinRequests = new Map<string, AbortController>();
export const appOpenCliRequests = new Map<string, string>();
const managedBrowsers = new Map<string, ManagedBrowserEntry>();
const sessionPrimaryBrowser = new Map<string, string>();

function sameOriginHost(left: string, right: string): boolean {
  try { return new URL(left).hostname === new URL(right).hostname; }
  catch { return false; }
}

function dropManagedBrowser(browserId: string): void {
  const entry = managedBrowsers.get(browserId);
  managedBrowsers.delete(browserId);
  if (entry && sessionPrimaryBrowser.get(entry.sessionKey) === browserId) {
    sessionPrimaryBrowser.delete(entry.sessionKey);
  }
  for (const [requestId, mappedId] of appOpenCliRequests) {
    if (mappedId === browserId) appOpenCliRequests.delete(requestId);
  }
}

export function isManagedBrowserOpen(browserId: string): boolean {
  return managedBrowsers.has(browserId);
}

export function isManagedBrowserBusy(browserId: string): boolean {
  return (managedBrowsers.get(browserId)?.activeRequests.size ?? 0) > 0;
}

export function updateManagedBrowserUrl(browserId: string, url: string): void {
  const entry = managedBrowsers.get(browserId);
  if (entry) entry.url = url;
}

/** 绑定右侧内置浏览器组件为当前原生视图的宿主，卸载时在空闲态下释放索引。 */
export function attachManagedBrowserHost(browserId: string): () => void {
  const entry = managedBrowsers.get(browserId);
  if (entry) entry.hosted = true;
  return () => {
    const current = managedBrowsers.get(browserId);
    if (!current) return;
    current.hosted = false;
    if (current.activeRequests.size === 0) dropManagedBrowser(browserId);
  };
}

/** 用户手动关闭右侧内置浏览器标签页时清理登记，确保随后销毁原生视图。 */
export function notifyManagedBrowserClosed(browserId: string): void {
  dropManagedBrowser(browserId);
}

export function releaseAppOpenCliRequest(requestId: string, close = false, invokeFn: BridgeInvoke = invoke): void {
  const browserId = appOpenCliRequests.get(requestId);
  appOpenCliRequests.delete(requestId);
  if (!browserId) return;
  const entry = managedBrowsers.get(browserId);
  if (!entry) {
    void invokeFn("browser_close", { browserId }).catch(() => undefined);
    return;
  }
  entry.activeRequests.delete(requestId);
  if (close) {
    dropManagedBrowser(browserId);
    closeAgentBrowserInDock(browserId);
    void invokeFn("browser_close", { browserId }).catch(() => undefined);
    return;
  }
  // 无右侧面板承载（如处于非聊天页或无 DOM 环境）时立即关闭，避免离屏视图泄漏；
  // 已有右侧面板承载时保留页面供用户查看与交互，关闭标签页时再销毁。
  if (!entry.hosted && entry.activeRequests.size === 0) {
    dropManagedBrowser(browserId);
    void invokeFn("browser_close", { browserId }).catch(() => undefined);
  }
}

export function releaseAllAppOpenCliRequests(invokeFn: BridgeInvoke = invoke): void {
  for (const requestId of [...appOpenCliRequests.keys()]) {
    releaseAppOpenCliRequest(requestId, false, invokeFn);
  }
}

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
  invokeFn: BridgeInvoke = invoke,
): Promise<void> {
  if (appOpenCliRequests.has(request.requestId)) return;
  const sessionKey = request.sessionId || "__default__";
  if (request.listTabs) {
    const tabs = [...managedBrowsers.values()]
      .filter((entry) => entry.sessionKey === sessionKey)
      .map(({ browserId: id, url }) => ({ id, url }));
    await send({ type: "apps.opencli.response", requestId: request.requestId, ok: true, tabs });
    return;
  }

  // 优先复用当前会话活跃或空闲的右侧内置浏览器视图，避免重复创建并保持页面状态连续。
  const ownerRequestId = request.reuseRequestId ?? request.requestId;
  const handleBrowserId = request.reuseRequestId ? appOpenCliRequests.get(request.reuseRequestId) : undefined;
  const handleEntry = handleBrowserId ? managedBrowsers.get(handleBrowserId) : undefined;
  const primaryId = sessionPrimaryBrowser.get(sessionKey);
  const primaryEntry = primaryId ? managedBrowsers.get(primaryId) : undefined;
  const reusedHandle = handleEntry?.sessionKey === sessionKey;
  const candidateEntry = reusedHandle ? handleEntry : (
    primaryEntry && primaryEntry.hosted && primaryEntry.activeRequests.size === 0 ? primaryEntry : undefined
  );

  if (candidateEntry) {
    const candidateId = candidateEntry.browserId;
    if (!reusedHandle) {
      // 在 await 前先占位，防止同微任务并发请求共享同一 DockCdp 通道。
      appOpenCliRequests.set(ownerRequestId, candidateId);
      candidateEntry.activeRequests.add(ownerRequestId);
    }
    try {
      const endpoint = await invokeFn<string>("opencli_cdp_endpoint", { browserId: candidateId });
      // 标记总是取走清零；只有同一轮 AI 操作（复用句柄）里发生的才算 AI 触发，用户在两轮之间自己点的不算。
      const passkey = await invokeFn<boolean>("browser_take_passkey_request", { browserId: candidateId }).catch(() => false);
      if (appOpenCliRequests.get(ownerRequestId) !== candidateId) return;
      if (request.url && request.site !== "browser" && !sameOriginHost(candidateEntry.url, request.url)) {
        await invokeFn("browser_navigate", { browserId: candidateId, url: request.url }).catch(() => undefined);
        candidateEntry.url = request.url;
      }
      candidateEntry.site = request.site;
      openAgentBrowserInDock({
        browserId: candidateId,
        url: candidateEntry.url,
        sessionId: request.sessionId,
        onClaimed: () => { candidateEntry.hosted = true; },
      });
      await send({ type: "apps.opencli.response", requestId: request.requestId, ok: true, endpoint, url: candidateEntry.url,
        ...(passkey && reusedHandle ? { loginRequired: "passkey" as const } : {}) });
      return;
    } catch {
      dropManagedBrowser(candidateId);
    }
  }

  if (!request.url) {
    await send({ type: "apps.opencli.response", requestId: request.requestId, ok: false,
      message: "No active built-in browser page for this conversation. Use qone_browser_open with the requested URL if a new page is needed." });
    return;
  }
  const browserId = `opencli-${request.site}-${request.requestId}`;
  appOpenCliRequests.set(ownerRequestId, browserId);
  try {
    await invokeFn("browser_open", { browserId, url: request.url, ...BACKGROUND_BROWSER_BOUNDS });
    // A release can arrive while browser_open is still preparing WebView2.
    // Close the late-created child instead of leaving an orphaned hidden browser.
    if (appOpenCliRequests.get(ownerRequestId) !== browserId) {
      await invokeFn("browser_close", { browserId }).catch(() => undefined);
      return;
    }
    const endpoint = await invokeFn<string>("opencli_cdp_endpoint", { browserId });
    if (appOpenCliRequests.get(ownerRequestId) !== browserId) {
      await invokeFn("browser_close", { browserId }).catch(() => undefined);
      return;
    }
    const entry: ManagedBrowserEntry = {
      browserId,
      sessionKey,
      site: request.site,
      url: request.url,
      activeRequests: new Set([ownerRequestId]),
      hosted: false,
    };
    managedBrowsers.set(browserId, entry);
    const currentPrimary = sessionPrimaryBrowser.get(sessionKey);
    const currentPrimaryEntry = currentPrimary ? managedBrowsers.get(currentPrimary) : undefined;
    if (!currentPrimaryEntry || currentPrimaryEntry.activeRequests.size === 0) {
      sessionPrimaryBrowser.set(sessionKey, browserId);
    }
    openAgentBrowserInDock({
      browserId,
      url: request.url,
      sessionId: request.sessionId,
      onClaimed: () => { entry.hosted = true; },
    });
    await send({ type: "apps.opencli.response", requestId: request.requestId, ok: true, endpoint, url: request.url });
  } catch (error) {
    const ownsRequest = appOpenCliRequests.get(ownerRequestId) === browserId;
    if (ownsRequest) appOpenCliRequests.delete(ownerRequestId);
    dropManagedBrowser(browserId);
    await invokeFn("browser_close", { browserId }).catch(() => undefined);
    if (ownsRequest) await send({ type: "apps.opencli.response", requestId: request.requestId, ok: false, message: error instanceof Error ? error.message : String(error) });
  }
}
