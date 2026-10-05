// Address validation adapted from pi-web-access/ssrf-protection.ts (MIT).
// See THIRD_PARTY_NOTICES.md for the source revision and license.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { runtimeError } from "./runtime-localization";

export type Address = { address: string; family: number };
export type Lookup = (hostname: string) => Promise<Address[]>;
export const lookupPublicHost: Lookup = (hostname) => lookup(hostname, { all: true, verbatim: true });

export function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

export function publicWebUrl(input: string): URL {
  try {
    if (!input.trim() || input.length > 8192) throw new Error();
    const url = new URL(input);
    const host = normalizeHostname(url.hostname);
    if (!host || !["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) throw new Error();
    return url;
  } catch {
    throw runtimeError("reach-public-tools.only_public_website_http_s_urls_are_allowed");
  }
}

function blockedIPv4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) || a >= 224;
}

function parseIPv6(address: string): number[] | null {
  if (address.includes(".")) {
    const lastColon = address.lastIndexOf(":");
    const ipv4 = address.slice(lastColon + 1);
    if (isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    address = `${address.slice(0, lastColon)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (pieces.length === 1 && missing !== 0 || pieces.length === 2 && missing < 0) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => /^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : -1);
  return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

export function blockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedIPv4(address);
  if (version !== 6) return true;
  const groups = parseIPv6(address);
  if (!groups) return true;
  const first = groups[0];
  // Only global unicast IPv6; exclude mapped/compatible, ULA, link-local,
  // multicast, translation, Teredo, and 6to4 routes into private IPv4.
  if ((first & 0xe000) !== 0x2000) return true;
  return first === 0x2002 || first === 0x2001 && (groups[1] < 0x200 || groups[1] === 0xdb8) ||
    first === 0x3fff && (groups[1] & 0xf000) === 0;
}

export async function resolvePublicUrl(url: URL, resolver: Lookup = lookupPublicHost): Promise<Address[]> {
  const host = normalizeHostname(url.hostname);
  const version = isIP(host);
  const addresses = version ? [{ address: host, family: version }] : await resolver(host);
  if (!addresses.length || addresses.some(({ address, family }) => blockedAddress(address) || isIP(address) !== family)) {
    throw runtimeError("reach-public-tools.the_website_resolved_to_a_private_network_address");
  }
  return addresses;
}
