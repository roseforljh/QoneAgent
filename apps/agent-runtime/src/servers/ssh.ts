import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { ServerInfo } from "@qone/protocol";
import { runtimeError } from "../runtime-localization.js";

export const fingerprint = (key: Buffer) => `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;

/** Windows OpenSSH's agent pipe, or the POSIX socket. */
export const agentPath = () => process.platform === "win32" ? "\\\\.\\pipe\\openssh-ssh-agent" : process.env.SSH_AUTH_SOCK;

export class HostKeyChangedError extends Error {
  constructor(readonly presented: string) { super(presented); }
}

export type Credentials = { password?: string; privateKey?: string | Buffer; agent?: string };

export function credentialsFor(server: Pick<ServerInfo, "auth">): Credentials {
  return server.auth.kind === "agent" ? { agent: agentPath() } : { privateKey: readFileSync(server.auth.keyPath) };
}

/**
 * Open one authenticated connection. `pinned` is the trusted fingerprint; the
 * presented key is reported through `onHostKey` (first contact) or rejected.
 */
export function connect(target: { host: string; port: number; username: string }, credentials: Credentials, pinned?: string, onHostKey?: (value: string) => void): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | undefined;
    const config: ConnectConfig = {
      host: target.host, port: target.port, username: target.username,
      ...credentials,
      readyTimeout: 15_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer) => {
        presented = fingerprint(key);
        if (pinned && pinned !== presented) return false;
        onHostKey?.(presented);
        return true;
      },
    };
    client.once("ready", () => resolve(client));
    client.once("error", (error) => {
      client.end();
      if (pinned && presented && presented !== pinned) reject(new HostKeyChangedError(presented));
      else reject(error);
    });
    client.connect(config);
  });
}

const LIMIT = 64 * 1024;

/** Keep the beginning and end of large output; the middle is the least useful part. */
function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= LIMIT) return { text, truncated: false };
  const half = LIMIT / 2;
  return { text: `${text.slice(0, half)}\n[… ${text.length - LIMIT} characters omitted …]\n${text.slice(-half)}`, truncated: true };
}

export const shQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** `~` stays expandable by the remote shell; everything else is quoted literally. */
export function shellPath(value: string): string {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"$HOME"/${shQuote(value.slice(2))}`;
  return shQuote(value);
}

export interface ExecResult { exit_code: number | null; signal?: string; stdout: string; stderr: string; truncated: boolean; timed_out: boolean }

export function exec(client: Client, command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  const script = options.cwd ? `cd ${shellPath(options.cwd)} && ${command}` : command;
  return new Promise((resolve, reject) => {
    client.exec(script, (error, stream) => {
      if (error) return reject(error);
      let stdout = "", stderr = "", timedOut = false;
      const stop = () => { stream.signal("KILL"); stream.close(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120_000);
      options.signal?.addEventListener("abort", stop, { once: true });
      stream.on("data", (chunk: Buffer) => { if (stdout.length < LIMIT * 8) stdout += chunk.toString("utf8"); });
      stream.stderr.on("data", (chunk: Buffer) => { if (stderr.length < LIMIT * 8) stderr += chunk.toString("utf8"); });
      stream.on("close", (code: number | null, signal?: string) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        const out = clip(stdout), err = clip(stderr);
        resolve({ exit_code: code ?? null, ...(signal ? { signal } : {}), stdout: out.text, stderr: err.text, truncated: out.truncated || err.truncated, timed_out: timedOut });
      });
    });
  });
}

export const sftp = (client: Client) => new Promise<SFTPWrapper>((resolve, reject) => client.sftp((error, wrapper) => error ? reject(error) : resolve(wrapper)));

export const shell = (client: Client, cols: number, rows: number) => new Promise<ClientChannel>((resolve, reject) =>
  client.shell({ term: "xterm-256color", cols, rows }, (error, channel) => error ? reject(error) : resolve(channel)));

/**
 * One live connection per server, reused by every tool call and terminal.
 * A dropped connection is replaced on next use.
 */
export class SshPool {
  private clients = new Map<string, Promise<Client>>();

  constructor(private onHostKeyChanged: (serverId: string, presented: string) => void) {}

  get(server: ServerInfo): Promise<Client> {
    let pending = this.clients.get(server.id);
    if (!pending) {
      pending = connect(server, credentialsFor(server), server.hostKey).then((client) => {
        client.once("close", () => { if (this.clients.get(server.id) === pending) this.clients.delete(server.id); });
        return client;
      }, (error) => {
        this.clients.delete(server.id);
        if (error instanceof HostKeyChangedError) {
          this.onHostKeyChanged(server.id, error.presented);
          throw runtimeError("servers.host_key_changed", { p0: server.name });
        }
        throw error;
      });
      this.clients.set(server.id, pending);
    }
    return pending;
  }

  drop(serverId: string) {
    const pending = this.clients.get(serverId);
    this.clients.delete(serverId);
    void pending?.then((client) => client.end(), () => undefined);
  }

  dropAll() { for (const id of [...this.clients.keys()]) this.drop(id); }
}
