const OPEN_BROWSER_EVENT = "qone:open-browser";

export type BrowserDockRequest = { url: string; html?: string; requestId?: string };

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

export function openBrowserInDock(url: string): void {
  openInDock({ url });
}

export function sandboxPreviewHtml(html: string): string {
  // The opaque iframe origin keeps preview scripts apart from the Tauri page.
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe sandbox="allow-scripts allow-forms allow-modals" srcdoc="${srcdoc}"></iframe></body></html>`;
}

export function openCodePreviewInDock(html: string, sourceId: string): void {
  openInDock({ url: "about:blank", html: sandboxPreviewHtml(html), requestId: sourceId });
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
