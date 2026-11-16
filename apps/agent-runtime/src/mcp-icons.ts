import { mcpPackage, mcpServerIdentity, type McpServerInfo, type RuntimeEvent } from "@qone/protocol";
import type { PreferenceStore } from "@qone/database";

const PREFERENCE = "mcp.icons";
const MAX_BYTES = 256 * 1024;
// Proxied networks can need ~12s for a first lookup; resolution runs in the background.
const TIMEOUT = 20_000;
// ponytail: failures are retried on the next launch only, not persisted.
const failed = new Set<string>();
const resolving = new Map<string, Promise<string | undefined>>();
let lastSent = "";

async function image(url: string): Promise<string | undefined> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!response.ok || !type.startsWith("image/")) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  return bytes.length && bytes.length <= MAX_BYTES ? `data:${type};base64,${bytes.toString("base64")}` : undefined;
}
async function json(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  return response.ok ? response.json() : undefined;
}
/** The icon a site declares (largest touch icon first), else its conventional favicon. */
async function siteIcon(origin: string): Promise<string | undefined> {
  const response = await fetch(origin, { signal: AbortSignal.timeout(TIMEOUT) });
  const html = response.ok ? (await response.text()).slice(0, 200_000) : "";
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    rel: /\brel=["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase() ?? "",
    href: /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1],
  })).filter(link => link.href && /\bicon\b/.test(link.rel));
  links.sort((a, b) => Number(b.rel.includes("apple-touch-icon")) - Number(a.rel.includes("apple-touch-icon")));
  for (const link of [...links, { href: "/favicon.ico" }]) {
    const icon = await image(new URL(link.href!.replaceAll("&amp;", "&"), response.url || origin).href).catch(() => undefined);
    if (icon) return icon;
  }
  return undefined;
}
const githubOwner =(link: unknown) => typeof link === "string" ? /github\.com[/:]([^/#?]+)/i.exec(link)?.[1] : undefined;

/** Official icon: the publishing GitHub organisation for packages, the site favicon for remote servers. */
async function resolve(server: McpServerInfo): Promise<string | undefined> {
  if (server.url) {
    const host = new URL(server.url).hostname;
    const labels = host.split(".");
    for (const domain of labels.length > 2 ? [labels.slice(1).join("."), host] : [host]) {
      const icon = await siteIcon(`https://${domain}/`).catch(() => undefined);
      if (icon) return icon;
    }
    return undefined;
  }
  const pkg = mcpPackage(server);
  if (!pkg) return undefined;
  const meta = pkg.runner === "uvx" ? await json(`https://pypi.org/pypi/${encodeURIComponent(pkg.name)}/json`) : await json(`https://registry.npmjs.org/${pkg.name.replace("/", "%2F")}/latest`);
  const links = pkg.runner === "uvx" ? [...Object.values(meta?.info?.project_urls ?? {}), meta?.info?.home_page] : [meta?.repository?.url ?? meta?.repository, meta?.homepage];
  const owner = links.map(githubOwner).find(Boolean);
  return owner ? image(`https://github.com/${owner}.png?size=96`) : undefined;
}

/** A renderer asking for the list may have lost its state; deliver icons again. */
export function resendMcpIcons() { lastSent = ""; }

/** Resolves missing icons in the background and emits only when the set changed. */
export async function sendMcpIcons(servers: McpServerInfo[], preferences: PreferenceStore, send: (event: RuntimeEvent) => void) {
  const keyed = servers.flatMap(server => { const key = mcpServerIdentity(server); return key ? [{ server, key }] : []; });
  const cached = preferences.get<Record<string, string>>(PREFERENCE) ?? {};
  const missing = keyed.filter(({ key }) => !cached[key] && !failed.has(key));
  if (missing.length) {
    const found = await Promise.all(missing.map(async ({ server, key }) => {
      if (!resolving.has(key)) resolving.set(key, resolve(server).catch(() => undefined).finally(() => resolving.delete(key)));
      const icon = await resolving.get(key);
      if (!icon) failed.add(key);
      return [key, icon] as const;
    }));
    Object.assign(cached, preferences.get<Record<string, string>>(PREFERENCE) ?? {}, Object.fromEntries(found.filter(([, icon]) => icon)));
    preferences.set(PREFERENCE, cached);
  }
  const icons = Object.fromEntries(keyed.flatMap(({ server, key }) => cached[key] ? [[server.id, cached[key]!]] : []));
  const signature = JSON.stringify(Object.keys(icons).sort().map(id => [id, icons[id]!.length]));
  if (signature === lastSent) return;
  lastSent = signature;
  send({ type: "mcp.icons", icons });
}
