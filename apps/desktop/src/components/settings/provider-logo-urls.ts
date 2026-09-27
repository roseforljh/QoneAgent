const API_SUBDOMAINS = new Set(["api", "gateway", "proxy", "newapi", "llm"]);
const FAVICON_PATHS = ["/favicon.ico", "/favicon.png", "/favicon.svg"];

export function providerLogoUrls(baseUrl: string, logoUrl = ""): string[] {
  const explicit = isHttpUrl(logoUrl) ? [logoUrl.trim()] : [];
  try {
    const url = new URL(/^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`);
    if (!url.hostname.includes(".") || url.hostname === "localhost") return explicit;

    const hostname = url.hostname.toLowerCase();
    const labels = hostname.split(".");
    const siteHost = labels.length > 2 && API_SUBDOMAINS.has(labels[0])
      ? labels.slice(1).join(".")
      : hostname;
    const origins = [url.origin];
    if (siteHost !== hostname) origins.push(`https://${siteHost}`);
    return [...explicit, ...origins.flatMap((origin) => FAVICON_PATHS.map((path) => `${origin}${path}`))];
  } catch {
    return explicit;
  }
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
