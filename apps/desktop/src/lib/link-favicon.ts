/** Codex pLc: favicon requests carry the origin, never private paths or query data. */
export function linkFaviconUrl(href: string): string | undefined {
  try {
    const url = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `https://t0.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&url=${encodeURIComponent(url.origin)}&size=32&drop_404_icon=true`;
  } catch { return undefined; }
}
