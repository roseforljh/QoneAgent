import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Client, type ClientChannel, type ConnectConfig, type SFTPWrapper } from "ssh2";
import type { ServerInfo } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { runtimeError } from "../runtime-localization.js";

const log = createLogger("ssh");

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
    // The socket may report another error while the first one is closing it.
    client.on("error", (error) => {
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

export interface ExecResult { exit_code: number | null; signal?: string; stdout: string; stderr: string; truncated: boolean; timed_out: boolean; cancelled?: boolean }

/** Cancel this waiter, not the pooled connection other callers still use. */
export function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export function exec(client: Client, command: string, options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; onUpdate?: (result: ExecResult) => void; env?: Record<string, string> } = {}): Promise<ExecResult> {
  // Guard the entire script, not only the first command in a list.
  const body = options.cwd ? `cd ${shellPath(options.cwd)} || exit $?\n${command}` : command;
  // Secrets arrive on stdin, never in the command line other users can see in ps.
  const env = Object.entries(options.env ?? {});
  const envLine = env.map(([name, value]) => `export ${name}="$(printf %s '${Buffer.from(value).toString("base64")}' | base64 -d)"`).join("; ");
  const script = env.length ? `IFS= read -r __qone_env && eval "$__qone_env"; unset __qone_env\n${body}` : body;
  return new Promise((resolve, reject) => {
    options.signal?.throwIfAborted();
    let channel: ClientChannel | undefined, settled = false, timedOut = false, cancelled = false;
    let updateTimer: ReturnType<typeof setTimeout> | undefined;
    const output = ["", ""], omitted = [0, 0];
    const decoders = [new StringDecoder("utf8"), new StringDecoder("utf8")];
    const snapshot = (code: number | null = null, signal?: string): ExecResult => {
      const [out, err] = output.map(clip);
      return { exit_code: code, ...(signal ? { signal } : {}), stdout: out!.text, stderr: err!.text,
        truncated: omitted.some(Boolean) || out!.truncated || err!.truncated, timed_out: timedOut, ...(cancelled ? { cancelled: true } : {}) };
    };
    const finish = (error?: Error, code: number | null = null, signal?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(updateTimer);
      options.signal?.removeEventListener("abort", abort);
      for (const [index, decoder] of decoders.entries()) output[index] += decoder.end();
      if (error && !cancelled && !timedOut) reject(error); else resolve(snapshot(code, signal));
    };
    const closeChannel = (stream: ClientChannel) => {
      try { stream.signal("KILL"); stream.close(); }
      catch (error) { log.warn("Could not close SSH command channel", { err: String(error) }); }
    };
    const stop = () => {
      if (channel) closeChannel(channel);
      // A broken connection need not acknowledge CHANNEL_CLOSE.
      finish();
    };
    const abort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    try { client.exec(script, (error, stream) => {
      // A channel delivered after cancellation still owns its teardown errors.
      stream?.on("error", finish);
      stream?.stderr.on("error", finish);
      if (settled || options.signal?.aborted) { if (stream) closeChannel(stream); return; }
      if (error) return finish(error);
      channel = stream;
      if (envLine) stream.write(`${envLine}\n`);
      const append = (index: number, text: string) => {
        if (settled) return;
        const next = output[index]! + text;
        if (next.length > LIMIT * 2) { omitted[index]! += next.length - LIMIT * 2; output[index] = next.slice(0, LIMIT) + next.slice(-LIMIT); }
        else output[index] = next;
        if (options.onUpdate && !updateTimer) updateTimer = setTimeout(() => { updateTimer = undefined; if (!settled) options.onUpdate?.(snapshot()); }, 100);
      };
      stream.on("data", (chunk: Buffer) => append(0, decoders[0]!.write(chunk)));
      stream.stderr.on("data", (chunk: Buffer) => append(1, decoders[1]!.write(chunk)));
      stream.once("close", (code: number | null, signal?: string) => finish(undefined, code ?? null, signal));
      if (options.signal?.aborted) abort();
    }); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

export const sftp = (client: Client, signal?: AbortSignal) => new Promise<SFTPWrapper>((resolve, reject) => {
  signal?.throwIfAborted();
  const abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  signal?.addEventListener("abort", abort, { once: true });
  try { client.sftp((error, wrapper) => {
    // ssh2 removes its handshake listener before handoff and rejects pending requests itself.
    wrapper?.on("error", (error: Error) => log.warn("SFTP channel failed", { err: error.message }));
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted) { wrapper?.end(); abort(); }
    else if (error) reject(error); else {
      const close = () => wrapper.end();
      signal?.addEventListener("abort", close, { once: true });
      wrapper.once("close", () => signal?.removeEventListener("abort", close));
      resolve(wrapper);
    }
  }); } catch (error) { signal?.removeEventListener("abort", abort); reject(error); }
});

export const shell = (client: Client, cols: number, rows: number) => new Promise<ClientChannel>((resolve, reject) =>
  client.shell({ term: "xterm-256color", cols, rows }, (error, channel) => {
    if (error) { reject(error); return; }
    const close = (error: Error) => { log.warn("terminal channel failed", { err: error.message }); channel.close(); };
    channel.on("error", close);
    channel.stderr.on("error", close);
    resolve(channel);
  }));

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
