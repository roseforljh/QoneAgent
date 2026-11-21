import { createLogger } from "@qone/shared";
import { hasExplicitProxy, toolProxyEnvironment, toolProxyEnvironmentKey } from "@qone/protocol/proxy-environment";
import { getProxyForUrl } from "proxy-from-env";
import * as undici from "undici";
import type { Dispatcher } from "undici";

const log = createLogger("network");
type ResolveProxy = (origin: string, signal?: AbortSignal | null) => Promise<string>;

function proxyUrl(route: string): string {
  // Do not bypass a failed proxy by falling back to DIRECT.
  const first = route.split(";", 1)[0].trim();
  if (first === "DIRECT") return "";
  const match = /^(PROXY|HTTPS|SOCKS5) ([^\s]+)$/.exec(first);
  if (!match) throw new Error("Unsupported system proxy route");
  const proxy = new URL(`${match[1] === "PROXY" ? "http" : match[1].toLowerCase()}://${match[2]}`);
  if (proxy.username || proxy.password || !["", "/"].includes(proxy.pathname) || proxy.search || proxy.hash) {
    throw new Error("Invalid system proxy route");
  }
  return proxy.href;
}

let resolveSystemProxy: ResolveProxy | undefined;

export async function proxyForUrl(url: URL, signal?: AbortSignal | null): Promise<string> {
  signal?.throwIfAborted();
  const hostname = url.hostname.replace(/\.$/, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || /^127\.(?:\d+\.){2}\d+$/.test(hostname) || hostname === "[::1]") return "";
  if (!resolveSystemProxy) return getProxyForUrl(url);
  return proxyUrl(await resolveSystemProxy(url.origin, signal));
}

/** Install once, before the first request. Undici selects again on each redirect/upgrade. */
export function installSystemProxy(resolveProxy: ResolveProxy) {
  // Snapshot launcher overrides before supplying the system defaults to subprocesses.
  resolveSystemProxy = hasExplicitProxy(process.env) ? undefined : resolveProxy;
  const direct = new undici.Agent();
  const agents = new Map<string, Dispatcher>();
  const router = direct.compose(() => (options, handler) => {
    if (typeof handler.onRequestStart !== "function") return legacy.dispatch(options, handler);
    if (!options.origin) return direct.dispatch(options, handler);
    const url = new URL(options.origin);
    const pending = new AbortController();
    let upstream: Dispatcher.DispatchController | undefined;
    const controller: Dispatcher.DispatchController = {
      get aborted() { return pending.signal.aborted; },
      get paused() { return upstream?.paused ?? false; },
      get reason() { return pending.signal.reason ?? null; },
      abort(reason) { pending.abort(reason); upstream?.abort(reason); },
      pause() { upstream?.pause(); },
      resume() { upstream?.resume(); },
    };
    const forward = Object.create(handler) as Dispatcher.DispatchHandler;
    // Register abort immediately, before waiting for PAC/desktop IPC. A cancelled POST must not reach the network.
    handler.onRequestStart?.(controller, undefined);
    forward.onRequestStart = actual => { upstream = actual; if (pending.signal.aborted) actual.abort(pending.signal.reason); };
    forward.onResponseError = (actual, error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (!pending.signal.aborted && code && /^[A-Z0-9_]+$/.test(code)) log.warn("HTTP connection failed", { origin: url.origin, code });
      handler.onResponseError?.(actual, error);
    };
    // Some handlers keep private state. Forward callbacks with their original receiver.
    const forwarded = new Proxy(forward, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" && !Object.hasOwn(target, key) ? value.bind(handler) : value;
    } });
    void (async () => {
      try {
        const proxy = await proxyForUrl(url, pending.signal);
        pending.signal.throwIfAborted();
        let agent = proxy ? agents.get(proxy) : direct;
        if (!agent) { agent = new undici.ProxyAgent(proxy); agents.set(proxy, agent); }
        agent.dispatch(options, forwarded);
      } catch (error) { forward.onResponseError?.(controller, error as Error); }
    })();
    return true;
  });
  const legacy = new undici.Dispatcher1Wrapper(router);
  undici.setGlobalDispatcher(router);
}

export function installDesktopSystemProxy() {
  if (!process.send || process.env.QONE_SYSTEM_PROXY !== "1") return;
  const pending = new Map<string, (route: string | null) => void>();
  process.on("message", (message: { type?: string; id?: string; route?: string | null } | null) => {
    if (message?.type === "network.proxy.resolved" && typeof message.id === "string") {
      pending.get(message.id)?.(typeof message.route === "string" ? message.route : null);
    }
  });
  process.once("disconnect", () => { for (const finish of pending.values()) finish(null); });
  process.channel?.unref();
  installSystemProxy((origin, signal) => new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    function finish(route: string | null) {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(signal.reason);
      else if (route === null) reject(new Error("System proxy resolution failed"));
      else resolve(route);
    }
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, 5_000);
    pending.set(id, finish);
    if (signal?.aborted || !process.send || !process.connected) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    process.send({ type: "network.proxy.resolve", id, origin }, error => { if (error) cancel(); });
  }));
  Object.assign(process.env, toolProxyEnvironment(process.env));
  delete process.env[toolProxyEnvironmentKey];
  delete process.env.QONE_SYSTEM_PROXY;
}
