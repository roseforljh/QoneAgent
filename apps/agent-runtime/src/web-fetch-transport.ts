import { Agent, ProxyAgent, fetch } from "undici";
import { getProxyForUrl } from "proxy-from-env";
import type { LookupFunction } from "node:net";
import { normalizeHostname, type Address } from "./web-fetch-security";

export interface WebResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}
export interface WebRequest {
  headers: Record<string, string>;
  signal: AbortSignal;
}
export type WebTransport = (url: URL, addresses: Address[], init: WebRequest) => Promise<{
  response: WebResponse;
  release: () => Promise<void>;
}>;

/** Connect using the addresses already checked for this hop, never a second DNS lookup. */
export const requestPublicUrl: WebTransport = async (url, addresses, init) => {
  const proxy = getProxyForUrl(url.href);
  const target = new URL(url);
  const headers = { ...init.headers };
  const hostname = normalizeHostname(url.hostname);
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    const matches = addresses.filter((entry) => !options.family || entry.family === Number(options.family));
    if (!matches.length) return callback(new Error("No validated address matches this address family"), []);
    if (options.all) callback(null, matches);
    else callback(null, matches[0].address, matches[0].family);
  };
  if (proxy) {
    // Proxy CONNECT must also target a validated IP. Preserve the original
    // Host and TLS SNI/certificate name without delegating target DNS to the proxy.
    const address = addresses.find((entry) => entry.family === 4) ?? addresses[0];
    target.hostname = address.address;
    headers.Host = url.host;
  }
  const dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, proxyTunnel: true, requestTls: { servername: hostname } })
    : new Agent({ connect: { lookup: pinnedLookup } });
  const release = async () => {
    // Bun's undici compatibility layer does not expose Dispatcher.close/destroy;
    // Node's implementation does, so close it when the host provides the method.
    const closable = dispatcher as unknown as { close?: () => Promise<void>; destroy?: () => Promise<void> };
    if (closable.close) await closable.close();
    else if (closable.destroy) await closable.destroy();
  };
  try {
    const response = await fetch(target, { headers, signal: init.signal, redirect: "manual", dispatcher });
    return { response: response as unknown as WebResponse, release };
  } catch (error) {
    await release();
    throw error;
  }
};
