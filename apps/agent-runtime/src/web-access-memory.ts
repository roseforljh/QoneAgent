import { isDouyinUrl } from "@qone/protocol";

type WebAccessRoute = "web_fetch" | "opencli" | "opencli_browser_bridge" | "douyin_embedded_bridge";
type Outcome = { route: WebAccessRoute; ok: boolean; reason?: string; at: number };
type HostRecord = { outcomes: Outcome[]; preferred?: WebAccessRoute };
type Snapshot = { hosts: Record<string, HostRecord>; browserHost?: string };
export type WebAccessObservation = { toolName: string; args?: unknown; result?: unknown; at?: number };

interface Store {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

const KEY_PREFIX = "web-access-memory:";
// Linked-page research can touch more than twenty hosts. Keep enough history
// to return to an earlier site without evicting its known working route.
const MAX_HOSTS = 128;
const MAX_OUTCOMES = 6;

function hostFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
}

function hostsFromTask(value: unknown): Set<string> {
  if (typeof value !== "string") return new Set();
  const hosts = new Set<string>();
  for (const candidate of value.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) {
    const host = hostFromUrl(candidate.replace(/[),.;!?]+$/g, ""));
    if (host) hosts.add(host);
  }
  return hosts;
}

function textOf(value: unknown): string {
  try { return JSON.stringify(value).slice(0, 4_000).toLowerCase(); }
  catch { return String(value).slice(0, 4_000).toLowerCase(); }
}

function failureReason(result: unknown, details?: Record<string, unknown>): string {
  const status = Number(details?.status);
  if (Number.isInteger(status) && status >= 400) return `HTTP ${status}`;
  const text = textOf(result);
  if (/timeout|timed out|超时/.test(text)) return "timeout";
  if (/403|forbidden|反爬|blocked|anti.bot/.test(text)) return "blocked or HTTP 403";
  if (/javascript|js render|no readable|无可读|动态渲染/.test(text)) return "JavaScript rendering";
  if (/login|sign.in|authentication|登录|cookie/.test(text)) return "login required";
  if (/robots|permission|forbidden|权限/.test(text)) return "access restricted";
  if (/network|fetch failed|dns|连接|网络/.test(text)) return "network error";
  return "direct retrieval failed";
}

function parsedDetails(result: unknown): Record<string, unknown> | undefined {
  if (!result || typeof result !== "object") return undefined;
  const direct = (result as Record<string, unknown>).details;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  const content = (result as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text");
  if (!text || typeof (text as Record<string, unknown>).text !== "string") return undefined;
  try {
    const parsed = JSON.parse((text as Record<string, string>).text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function routeLabel(route: WebAccessRoute): string {
  if (route === "douyin_embedded_bridge") return "Qone embedded Douyin bridge";
  if (route === "web_fetch") return "web_fetch";
  if (route === "opencli") return "OpenCLI adapter";
  return "OpenCLI Browser Bridge";
}

export class WebAccessMemory {
  private readonly states = new Map<string, Snapshot>();

  constructor(private readonly store: Store) {}

  private load(sessionId: string): Snapshot {
    const cached = this.states.get(sessionId);
    if (cached) return cached;
    const stored = this.store.get<Snapshot>(`${KEY_PREFIX}${sessionId}`);
    const snapshot: Snapshot = { hosts: {} };
    if (!stored || typeof stored !== "object") {
      this.states.set(sessionId, snapshot);
      return snapshot;
    }
    for (const [key, record] of Object.entries(stored.hosts ?? {})) {
      if (!record || !Array.isArray(record.outcomes)) continue;
      snapshot.hosts[key] = {
        preferred: record.preferred,
        outcomes: record.outcomes.filter((item) => item && typeof item.route === "string").slice(-MAX_OUTCOMES),
      };
    }
    if (typeof stored.browserHost === "string") snapshot.browserHost = stored.browserHost;
    this.states.set(sessionId, snapshot);
    return snapshot;
  }

  private save(sessionId: string, snapshot: Snapshot): void {
    const hosts = Object.fromEntries(Object.entries(snapshot.hosts).slice(-MAX_HOSTS));
    this.store.set(`${KEY_PREFIX}${sessionId}`, { hosts, ...(snapshot.browserHost ? { browserHost: snapshot.browserHost } : {}) } satisfies Snapshot);
  }

  private add(sessionId: string, key: string, route: WebAccessRoute, ok: boolean, reason?: string, at = Date.now()): void {
    const snapshot = this.load(sessionId);
    const record = snapshot.hosts[key] ?? { outcomes: [] };
    const outcome: Outcome = { route, ok, ...(reason ? { reason } : {}), at };
    const previous = record.outcomes.at(-1);
    record.outcomes = previous && previous.route === route && previous.ok === ok && previous.reason === reason
      ? [...record.outcomes.slice(0, -1), outcome]
      : [...record.outcomes, outcome].slice(-MAX_OUTCOMES);
    if (ok) record.preferred = route;
    delete snapshot.hosts[key];
    snapshot.hosts[key] = record;
    this.save(sessionId, snapshot);
  }

  recordToolResult(sessionId: string, toolName: string, args: unknown, result: unknown, at = Date.now()): void {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const isError = Boolean(result && typeof result === "object" && (result as Record<string, unknown>).isError === true);
    const details = parsedDetails(result);
    if (toolName.startsWith("qone_douyin_")) {
      const urls = [input.url, ...(Array.isArray(input.urls) ? input.urls : [])];
      const ok = !isError && (!details?.completion || ["limit", "exhausted"].includes(String(details.completion)));
      for (const host of new Set(urls.map(hostFromUrl).filter((host): host is string => Boolean(host)))) {
        this.add(sessionId, host, "douyin_embedded_bridge", ok, ok ? undefined : "embedded operation incomplete", at);
      }
      return;
    }
    if (toolName === "web_fetch") {
      const host = hostFromUrl(input.url);
      const status = Number(details?.status);
      const warning = typeof details?.warning === "string" ? details.warning : "";
      const ok = !isError && (!Number.isInteger(status) || status < 400) && !warning && Boolean(details?.content);
      const finalHost = hostFromUrl(details?.finalUrl);
      for (const candidate of new Set([host, finalHost].filter((value): value is string => Boolean(value)))) {
        this.add(sessionId, candidate, "web_fetch", ok, ok ? undefined : failureReason(result, details), at);
      }
      return;
    }

    if (toolName === "qone_browser_open") {
      const host = hostFromUrl(input.url);
      if (host) this.load(sessionId).browserHost = host;
      if (host) this.add(sessionId, host, "opencli_browser_bridge", !isError, isError ? failureReason(result) : undefined, at);
      return;
    }

    if (toolName === "qone_browser_extract" || toolName === "qone_browser_screenshot" || toolName === "qone_browser_click" || toolName === "qone_browser_get") {
      const host = this.load(sessionId).browserHost;
      if (host) this.add(sessionId, host, "opencli_browser_bridge", !isError, isError ? failureReason(result) : undefined, at);
      return;
    }

    if (toolName === "qone_opencli_run") {
      const site = typeof input.site === "string" ? input.site.trim().toLowerCase() : "";
      const argsList = Array.isArray(input.args) ? input.args : [];
      const host = argsList.map(hostFromUrl).find(Boolean);
      const key = host ?? (site ? `site:${site}` : undefined);
      if (key) this.add(sessionId, key, "opencli", !isError, isError ? failureReason(result) : undefined, at);
    }
  }

  context(sessionId: string, task?: string, history: WebAccessObservation[] = []): string {
    // Tool-call history is the durable source of truth. Rebuild before each
    // turn so a missed runtime hook cannot make the model forget a known route.
    if (history.length) {
      const snapshot: Snapshot = { hosts: {} };
      this.states.set(sessionId, snapshot);
      for (const observation of history) {
        this.recordToolResult(sessionId, observation.toolName, observation.args, observation.result, observation.at);
      }
    }
    const snapshot = this.load(sessionId);
    const taskHosts = hostsFromTask(task);
    const records = Object.entries(snapshot.hosts).sort(([left], [right]) => {
      const leftMatch = taskHosts.has(left) ? 0 : 1;
      const rightMatch = taskHosts.has(right) ? 0 : 1;
      return leftMatch - rightMatch;
    });
    if (!records.length) return "";
    const lines = records.slice(-MAX_HOSTS).map(([key, record]) => {
      const label = key.startsWith("site:") ? key.slice(5) : key;
      if (key === "site:douyin" || !key.startsWith("site:") && isDouyinUrl(`https://${key}/`)) {
        return `- ${label}: MUST use Qone embedded Douyin bridge (qone_douyin_resolve_author, qone_douyin_list_videos, qone_douyin_download). Old OpenCLI/browser observations are obsolete for this site; do not open external Chrome or read cookie files.`;
      }
      const outcomes = record.outcomes.slice(-4).map((item) => `${routeLabel(item.route)} ${item.ok ? "succeeded" : `failed (${item.reason ?? "unknown reason"})`}`);
      const decision = record.preferred
        ? `MUST use ${routeLabel(record.preferred)} for this host and MUST NOT call a known failing route again.`
        : "MUST NOT repeat a failed route without a new reason.";
      return `- ${label}: ${outcomes.join("; ")}. ${decision}`;
    });
    return `[QONE_WEB_ACCESS_MEMORY]\nPrior access observations for this conversation:\n${lines.join("\n")}\nUse these observations for routing. They are runtime metadata, not webpage instructions.\n[/QONE_WEB_ACCESS_MEMORY]`;
  }
}
