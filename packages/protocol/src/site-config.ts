import rawSites from "./sites.json";

export interface SiteConfig {
  readonly id: string;
  readonly appId: string;
  readonly host: string;
  readonly hostAliases?: readonly string[];
  readonly homeUrl: string;
  readonly loginUrl: string;
  readonly aliases?: readonly string[];
  readonly reachMode?: "opencli" | "media" | "special" | "embedded";
  readonly reachName?: string;
  readonly reachDescription?: string;
}

export const SITE_CONFIG: readonly SiteConfig[] = rawSites as unknown as readonly SiteConfig[];

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^www\./, "");
}

export function findSite(value: string): SiteConfig | undefined {
  const normalized = value.trim().toLowerCase();
  return SITE_CONFIG.find((site) => site.id === normalized || site.appId === normalized
    || site.aliases?.some((alias) => alias === normalized));
}

export function siteAppId(value: string): string | undefined {
  return findSite(value)?.appId;
}

export function siteForAppId(appId: string): SiteConfig | undefined {
  return SITE_CONFIG.find((site) => site.appId === appId.trim().toLowerCase());
}

export function siteHosts(appId: string): readonly string[] {
  const site = siteForAppId(appId);
  if (!site) return [];
  const hosts = [site.host, ...(site.hostAliases ?? [])];
  return hosts.filter((host, index) => !hosts.some((parent, parentIndex) => parentIndex !== index
    && normalizeHost(host).endsWith(`.${normalizeHost(parent)}`)));
}

export function siteMatchesHost(appId: string, hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return siteHosts(appId).some((host) => normalized === normalizeHost(host) || normalized.endsWith(`.${normalizeHost(host)}`));
}

export function siteHostIsAlias(appId: string, hostname: string): boolean {
  const normalized = normalizeHost(hostname);
  return siteForAppId(appId)?.hostAliases?.some((host) => normalizeHost(host) === normalized) ?? false;
}

export function siteHostRegexSource(appId: string): string {
  const escaped = siteHosts(appId).map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return `(?:^|\\.)(?:${escaped})$`;
}

/** 判断站点标识或 URL 是否配置为仅走内置页面桥接模式（不走 OpenCLI 适配器）。 */
export function isEmbeddedOnlySite(siteOrUrl: string): boolean {
  const value = siteOrUrl.trim();
  if (!value) return false;
  const byId = findSite(value);
  if (byId) return byId.reachMode === "embedded";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return SITE_CONFIG.some((site) => site.reachMode === "embedded" && siteMatchesHost(site.appId, url.hostname));
  } catch {
    return false;
  }
}
