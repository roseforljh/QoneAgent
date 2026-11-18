import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "ssh2";
import type { ServerCandidate } from "@qone/protocol";

const GIT_HOSTS = /(^|\.)(github\.com|gitlab\.com|gitee\.com|bitbucket\.org)$/i;

const sshDir = () => path.join(os.homedir(), ".ssh");
const expandHome = (value: string) => value.replace(/^~(?=[\\/]|$)/, os.homedir());

/** `Host` blocks without wildcards; only the fields Qone needs. */
export function parseSshConfig(text: string): ServerCandidate[] {
  const result: ServerCandidate[] = [];
  let current: ServerCandidate[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+|=/).filter(Boolean);
    const value = rest.join(" ").replace(/^"|"$/g, "");
    switch (key?.toLowerCase()) {
      case "host":
        current = rest.filter((alias) => !/[*?!]/.test(alias)).map((alias) => ({ alias, host: alias, port: 22, configured: true }));
        result.push(...current);
        break;
      case "match": current = []; break;
      case "hostname": for (const item of current) item.host = value; break;
      case "port": for (const item of current) item.port = Number(value) || 22; break;
      case "user": for (const item of current) item.username = value; break;
      case "identityfile": for (const item of current) item.identityFile ??= expandHome(value); break;
    }
  }
  return result.filter((item) => !GIT_HOSTS.test(item.host));
}

/** Plain (non-hashed) entries: `host` or `[host]:port`. */
export function parseKnownHosts(text: string): ServerCandidate[] {
  const seen = new Set<string>();
  const result: ServerCandidate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const field = line.trim().split(/\s+/)[0];
    if (!field || field.startsWith("|") || field.startsWith("#") || field.startsWith("@")) continue;
    for (const entry of field.split(",")) {
      const match = /^\[(.+)\]:(\d+)$/.exec(entry);
      const host = match ? match[1]! : entry;
      const port = match ? Number(match[2]) : 22;
      if (GIT_HOSTS.test(host) || seen.has(`${host}:${port}`)) continue;
      seen.add(`${host}:${port}`);
      result.push({ host, port, configured: false });
    }
  }
  return result;
}

/** Private keys next to a `.pub` in ~/.ssh. */
export function localIdentities(directory = sshDir()): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".pub") && existsSync(path.join(directory, name.slice(0, -4))))
    .map((name) => path.join(directory, name.slice(0, -4)));
}

/**
 * Try every local key (and the agent) in one connection per candidate;
 * publickey auth only, so nothing runs on the server and no password is asked.
 */
function findIdentity(candidate: ServerCandidate, identities: string[], agent: string | undefined): Promise<string | undefined> {
  const keys = (candidate.identityFile ? [candidate.identityFile, ...identities.filter((key) => key !== candidate.identityFile)] : identities)
    .flatMap((file) => { try { return [{ file, key: readFileSync(file) }]; } catch { return []; } });
  const username = candidate.username ?? "root";
  return new Promise((resolve) => {
    const client = new Client();
    let attempt = 0;
    let found: string | undefined;
    const timer = setTimeout(() => client.end(), 10_000);
    client.once("ready", () => { clearTimeout(timer); client.end(); resolve(found); });
    const failed = () => { clearTimeout(timer); resolve(undefined); };
    client.on("error", failed);
    client.once("close", failed);
    client.connect({
      host: candidate.host, port: candidate.port, username, readyTimeout: 8_000,
      hostVerifier: () => true,
      authHandler: (_methods, _partial, next) => {
        const item = keys[attempt++];
        if (item) { found = item.file; return next({ type: "publickey", username, key: item.key }); }
        if (agent && attempt === keys.length + 1) { found = "agent"; return next({ type: "agent", username, agent }); }
        return next(false as never);
      },
    });
  });
}

export async function discoverServers(known: { host: string; port: number }[], agent: string | undefined): Promise<ServerCandidate[]> {
  const read = (file: string) => { try { return readFileSync(path.join(sshDir(), file), "utf8"); } catch { return ""; } };
  const configured = parseSshConfig(read("config"));
  const fromKnownHosts = parseKnownHosts(read("known_hosts")).filter((item) => !configured.some((entry) => entry.host === item.host && entry.port === item.port));
  const saved = new Set(known.map((item) => `${item.host}:${item.port}`));
  const candidates = [...configured, ...fromKnownHosts].filter((item) => !saved.has(`${item.host}:${item.port}`));
  const identities = localIdentities();
  // ponytail: one probe per host in parallel; cap it if users carry hundreds of hosts.
  return Promise.all(candidates.map(async (candidate) => {
    const identity = await findIdentity(candidate, identities, agent);
    return identity ? { ...candidate, username: candidate.username ?? "root", identityFile: identity } : { ...candidate, identityFile: undefined };
  }));
}
