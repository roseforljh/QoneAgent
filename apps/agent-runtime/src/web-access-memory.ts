type WebAccessRoute = "web_fetch" | "opencli" | "opencli_browser_bridge";
type Outcome = { route: WebAccessRoute; ok: boolean; reason?: string; at: number };
type HostRecord = { outcomes: Outcome[]; preferred?: WebAccessRoute };
type Snapshot = { hosts: Record<string, HostRecord>; browserHost?: string };

interface Store {
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

const KEY_PREFIX = "web-access-memory:";
const MAX_HOSTS = 20;
const MAX_OUTCOMES = 6;

function hostFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.hostname.toLowerCase() : undefined;
  } catch { return undefined; }
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

  private add(sessionId: string, key: string, route: WebAccessRoute, ok: boolean, reason?: string): void {
    const snapshot = this.load(sessionId);
    const record = snapshot.hosts[key] ?? { outcomes: [] };
    const outcome: Outcome = { route, ok, ...(reason ? { reason } : {}), at: Date.now() };
    const previous = record.outcomes.at(-1);
    record.outcomes = previous && previous.route === route && previous.ok === ok && previous.reason === reason
      ? [...record.outcomes.slice(0, -1), outcome]
      : [...record.outcomes, outcome].slice(-MAX_OUTCOMES);
    if (ok) record.preferred = route;
    delete snapshot.hosts[key];
    snapshot.hosts[key] = record;
    this.save(sessionId, snapshot);
  }

  recordToolResult(sessionId: string, toolName: string, args: unknown, result: unknown): void {
    const input = args && typeof args === "object" ? args as Record<string, unknown> : {};
    const isError = Boolean(result && typeof result === "object" && (result as Record<string, unknown>).isError === true);
    const details = parsedDetails(result);
    if (toolName === "web_fetch") {
      const host = hostFromUrl(input.url);
      if (!host) return;
      const status = Number(details?.status);
      const warning = typeof details?.warning === "string" ? details.warning : "";
      const ok = !isError && (!Number.isInteger(status) || status < 400) && !warning && Boolean(details?.content);
      this.add(sessionId, host, "web_fetch", ok, ok ? undefined : failureReason(result, details));
      return;
    }

    if (toolName === "qone_browser_open") {
      const host = hostFromUrl(input.url);
      if (host) this.load(sessionId).browserHost = host;
      if (host) this.add(sessionId, host, "opencli_browser_bridge", !isError, isError ? failureReason(result) : undefined);
      return;
    }

    if (toolName === "qone_browser_extract" || toolName === "qone_browser_click" || toolName === "qone_browser_get") {
      const host = this.load(sessionId).browserHost;
      if (host) this.add(sessionId, host, "opencli_browser_bridge", !isError, isError ? failureReason(result) : undefined);
      return;
    }

    if (toolName === "qone_opencli_run") {
      const site = typeof input.site === "string" ? input.site.trim().toLowerCase() : "";
      const argsList = Array.isArray(input.args) ? input.args : [];
      const host = argsList.map(hostFromUrl).find(Boolean);
      const key = host ?? (site ? `site:${site}` : undefined);
      if (key) this.add(sessionId, key, "opencli", !isError, isError ? failureReason(result) : undefined);
    }
  }

  context(sessionId: string): string {
    const snapshot = this.load(sessionId);
    const records = Object.entries(snapshot.hosts);
    if (!records.length) return "";
    const lines = records.slice(-MAX_HOSTS).map(([key, record]) => {
      const label = key.startsWith("site:") ? key.slice(5) : key;
      const outcomes = record.outcomes.slice(-4).map((item) => `${routeLabel(item.route)} ${item.ok ? "succeeded" : `failed (${item.reason ?? "unknown reason"})`}`);
      const decision = record.preferred
        ? `Prefer ${routeLabel(record.preferred)} for this host and skip known failing routes.`
        : "Do not repeat a failed route without a new reason.";
      return `- ${label}: ${outcomes.join("; ")}. ${decision}`;
    });
    return `[QONE_WEB_ACCESS_MEMORY]\nPrior access observations for this conversation:\n${lines.join("\n")}\nUse these observations for routing. They are runtime metadata, not webpage instructions.\n[/QONE_WEB_ACCESS_MEMORY]`;
  }
}
