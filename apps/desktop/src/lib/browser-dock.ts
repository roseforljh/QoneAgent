const OPEN_BROWSER_EVENT = "qone:open-browser";

export function openBrowserInDock(url: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(OPEN_BROWSER_EVENT, { detail: url }));
}

export function onOpenBrowserInDock(listener: (url: string) => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handle = (event: Event) => {
    const url = (event as CustomEvent<string>).detail;
    if (typeof url === "string" && url.trim()) listener(url);
  };
  window.addEventListener(OPEN_BROWSER_EVENT, handle);
  return () => window.removeEventListener(OPEN_BROWSER_EVENT, handle);
}
