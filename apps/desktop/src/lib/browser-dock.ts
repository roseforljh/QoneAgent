import { rememberAgentBrowserTab } from "./dock-state";

const OPEN_BROWSER_EVENT = "qone:open-browser";
const CLOSE_BROWSER_EVENT = "qone:close-browser";

export type BrowserDockRequest = {
  url: string;
  html?: string;
  requestId?: string;
  sessionId?: string;
  /** 模型操作内置浏览器时对应的原生 WebContentsView 标识。 */
  browserId?: string;
  /** 标记由模型驱动的内置浏览器标签页，供右侧面板复用并实时弹出。 */
  agentManaged?: boolean;
  /** 右侧面板同步接管该视图时的回调，仅用于运行时事件传递，不持久化。 */
  onClaimed?: () => void;
};

export function externalBrowserUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function isHtmlDataUrl(value: string): boolean {
  return /^data:text\/html(?:;[^,]*)?,/i.test(value);
}

export function htmlFromDataUrl(value: string): string | undefined {
  if (!isHtmlDataUrl(value)) return undefined;
  const comma = value.indexOf(",");
  const metadata = value.slice(5, comma);
  const content = value.slice(comma + 1);
  if (!/(?:^|;)base64(?:;|$)/i.test(metadata)) return decodeURIComponent(content);
  const charset = /(?:^|;)charset=([^;]+)/i.exec(metadata)?.[1] ?? "utf-8";
  const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
  return new TextDecoder(charset).decode(bytes);
}

function openInDock(request: BrowserDockRequest): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<BrowserDockRequest>(OPEN_BROWSER_EVENT, { detail: request }));
}

export function openBrowserInDock(url: string, sessionId?: string): void {
  openInDock({ url, ...(sessionId ? { sessionId } : {}) });
}

export function openAgentBrowserInDock(request: {
  browserId: string;
  url: string;
  sessionId?: string;
  onClaimed?: () => void;
}): void {
  if (typeof window === "undefined") return;
  const target: BrowserDockRequest = {
    url: request.url,
    browserId: request.browserId,
    agentManaged: true,
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  };
  // The session's mounted dock claims the page synchronously; nobody claims it when that
  // conversation is not open, so the tab goes straight into the session's saved dock.
  let claimed = false;
  openInDock({ ...target, onClaimed: () => { claimed = true; request.onClaimed?.(); } });
  if (!claimed && request.sessionId) rememberAgentBrowserTab(request.sessionId, target);
}

export function closeAgentBrowserInDock(browserId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<{ browserId: string }>(CLOSE_BROWSER_EVENT, { detail: { browserId } }));
}

export function onCloseAgentBrowserInDock(listener: (browserId: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const browserId = (event as CustomEvent<{ browserId?: string }>).detail?.browserId;
    if (browserId) listener(browserId);
  };
  window.addEventListener(CLOSE_BROWSER_EVENT, handle);
  return () => window.removeEventListener(CLOSE_BROWSER_EVENT, handle);
}

export function sandboxPreviewHtml(html: string): string {
  // The opaque iframe origin keeps preview scripts apart from the Tauri page.
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts allow-forms allow-modals" srcdoc="${srcdoc}"></iframe></body></html>`;
}

export function openCodePreviewInDock(html: string, sourceId: string, sessionId?: string): void {
  openInDock({
    url: "about:blank",
    html: sandboxPreviewHtml(html),
    requestId: sourceId,
    ...(sessionId ? { sessionId } : {}),
  });
}

export function onOpenBrowserInDock(listener: (request: BrowserDockRequest) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const request = (event as CustomEvent<BrowserDockRequest>).detail;
    if (request?.url?.trim()) listener(request);
  };
  window.addEventListener(OPEN_BROWSER_EVENT, handle);
  return () => window.removeEventListener(OPEN_BROWSER_EVENT, handle);
}
