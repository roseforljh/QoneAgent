import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { utils } from "ssh2";
import { qoneAuthDir } from "@qone/shared";
import type { PreferenceStore } from "@qone/database";
import type { ServerGroupInfo, ServerInfo, ServerSetupStage } from "@qone/protocol";
import { runtimeError } from "../runtime-localization.js";
import { agentPath, connect, credentialsFor, exec, HostKeyChangedError, shQuote, type Credentials, type SshPool } from "./ssh.js";

const KEY = "servers.list";
const GROUPS = "servers.groups";
const keyDirectory = () => path.join(qoneAuthDir(), "ssh");
const dedicatedComment = (id: string) => `qone:${id}`;

/** One line, e.g. "Debian GNU/Linux 13 (trixie) · x86_64 · 4 CPU". */
const PROBE = `. /etc/os-release 2>/dev/null; printf '%s · %s · %s CPU' "\${PRETTY_NAME:-$(uname -s)}" "$(uname -m)" "$(nproc 2>/dev/null || echo ?)"`;

export interface AddServerInput {
  name?: string; host: string; port: number; username: string; groupId?: string;
  password?: string; keyPath?: string; useAgent?: boolean;
}

/** Saved servers live in settings.json; the only secret is a key file in Qone's auth directory. */
export class ServerRegistry {
  constructor(private repo: PreferenceStore, private pool: SshPool) {}

  list(): ServerInfo[] { return this.repo.get<ServerInfo[]>(KEY) ?? []; }

  get(idOrName: string): ServerInfo | undefined {
    const servers = this.list();
    return servers.find((server) => server.id === idOrName) ?? servers.find((server) => server.name.toLowerCase() === idOrName.toLowerCase());
  }

  private save(servers: ServerInfo[]) { this.repo.set(KEY, servers); }

  groups(): ServerGroupInfo[] { return this.repo.get<ServerGroupInfo[]>(GROUPS) ?? []; }

  createGroup(name: string): ServerGroupInfo {
    const group = { id: crypto.randomUUID(), name: name.trim() };
    this.repo.set(GROUPS, [...this.groups(), group]);
    return group;
  }

  renameGroup(id: string, name: string) {
    this.repo.set(GROUPS, this.groups().map((group) => group.id === id ? { ...group, name: name.trim() } : group));
  }

  /** Servers of a deleted group become ungrouped; nothing else changes. */
  deleteGroup(id: string) {
    this.repo.set(GROUPS, this.groups().filter((group) => group.id !== id));
    this.save(this.list().map((server) => server.groupId === id ? { ...server, groupId: undefined } : server));
  }

  move(id: string, groupId: string | undefined) {
    this.update(id, { groupId: groupId && this.groups().some((group) => group.id === groupId) ? groupId : undefined });
  }

  update(id: string, patch: Partial<ServerInfo>): ServerInfo {
    const servers = this.list();
    const current = servers.find((server) => server.id === id);
    if (!current) throw runtimeError("servers.not_found");
    const next = { ...current, ...patch };
    this.save(servers.map((server) => server.id === id ? next : server));
    return next;
  }

  /**
   * Connect, pin the host key, probe the system and, for password sign-in,
   * install a per-server Ed25519 key (ET's dedicated key) and verify it before
   * saving. The password is never stored.
   */
  async add(input: AddServerInput, progress: (stage: ServerSetupStage) => void): Promise<ServerInfo> {
    const id = crypto.randomUUID();
    const target = { host: input.host.trim(), port: input.port, username: input.username.trim() };
    const credentials: Credentials = input.password ? { password: input.password }
      : input.keyPath ? { privateKey: readFileSync(input.keyPath) }
      : { agent: agentPath() };
    progress("host-key");
    let hostKey = "";
    const client = await connect(target, credentials, undefined, (value) => { hostKey = value; progress("authenticating"); })
      .catch((error) => { throw signInError(error, target.host); });
    try {
      progress("inspecting");
      const probe = await exec(client, PROBE, { timeoutMs: 20_000 });
      let auth: ServerInfo["auth"] = input.keyPath ? { kind: "key", keyPath: input.keyPath, dedicated: false } : { kind: "agent" };
      if (input.password) {
        progress("securing");
        const pair = utils.generateKeyPairSync("ed25519", { comment: dedicatedComment(id) });
        const line = pair.public.trim();
        const install = await exec(client, `umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF ${shQuote(line)} ~/.ssh/authorized_keys || printf '%s\\n' ${shQuote(line)} >> ~/.ssh/authorized_keys)`, { timeoutMs: 20_000 });
        if (install.exit_code !== 0) throw runtimeError("servers.key_install_failed", { p0: install.stderr.trim() || install.exit_code });
        mkdirSync(keyDirectory(), { recursive: true });
        const keyPath = path.join(keyDirectory(), id);
        writeFileSync(keyPath, pair.private, { mode: 0o600 });
        // The saved key must work on its own before the password is forgotten.
        await connect(target, { privateKey: pair.private }, hostKey).then((verified) => verified.end(), (error) => {
          rmSync(keyPath, { force: true });
          throw runtimeError("servers.key_verify_failed", { p0: error instanceof Error ? error.message : String(error) });
        });
        auth = { kind: "key", keyPath, dedicated: true };
      }
      const server: ServerInfo = {
        id, name: input.name?.trim() || target.host, ...target, auth, hostKey,
        ...(input.groupId && this.groups().some((group) => group.id === input.groupId) ? { groupId: input.groupId } : {}),
        system: probe.stdout.trim().slice(0, 160) || undefined,
        status: "ready", lastConnectedAt: Date.now(), createdAt: Date.now(),
      };
      this.save([...this.list(), server]);
      return server;
    } finally {
      client.end();
    }
  }

  async test(id: string): Promise<ServerInfo> {
    const server = this.get(id);
    if (!server) throw runtimeError("servers.not_found");
    this.pool.drop(id);
    try {
      const probe = await exec(await this.pool.get(server), PROBE, { timeoutMs: 20_000 });
      return this.update(id, { status: "ready", statusDetail: undefined, system: probe.stdout.trim().slice(0, 160) || server.system, lastConnectedAt: Date.now() });
    } catch (error) {
      const current = this.get(id)!;
      // A host-key mismatch was already recorded by the pool; keep that state.
      return current.status === "host-key-changed" ? current : this.update(id, { status: signInFailed(error) ? "auth-failed" : "offline", statusDetail: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Only after the user confirms in the UI: re-pin to the key the server presents now. */
  async trustHostKey(id: string): Promise<ServerInfo> {
    const server = this.get(id);
    if (!server) throw runtimeError("servers.not_found");
    this.update(id, { hostKey: undefined });
    let presented = "";
    const client = await connect(server, credentialsFor(server), undefined, (value) => { presented = value; });
    client.end();
    this.update(id, { hostKey: presented });
    return this.test(id);
  }

  /** Revoke the dedicated key before discarding the only credential that can clean it up. */
  async delete(id: string): Promise<void> {
    const server = this.get(id);
    if (!server) return;
    if (server.auth.kind === "key" && server.auth.dedicated) {
      try {
        const result = await exec(await this.pool.get(server), `sed -i ${shQuote(`/ ${dedicatedComment(id)}$/d`)} ~/.ssh/authorized_keys && ! grep -qF ${shQuote(dedicatedComment(id))} ~/.ssh/authorized_keys`, { timeoutMs: 10_000 });
        if (result.exit_code !== 0 || result.timed_out || result.signal) throw new Error(result.stderr.trim() || `exit ${result.exit_code}`);
      } catch (error) {
        throw runtimeError("servers.key_remove_failed", { p0: error instanceof Error ? error.message : String(error) });
      }
      rmSync(server.auth.keyPath, { force: true });
    }
    this.pool.drop(id);
    this.save(this.list().filter((item) => item.id !== id));
  }
}

const signInFailed = (error: unknown) => /authentication|auth methods|permission denied/i.test(error instanceof Error ? error.message : String(error));

function signInError(error: unknown, host: string): Error {
  if (error instanceof HostKeyChangedError) return runtimeError("servers.host_key_changed", { p0: host });
  if (signInFailed(error)) return runtimeError("servers.auth_failed");
  return runtimeError("servers.connect_failed", { p0: host, p1: error instanceof Error ? error.message : String(error) });
}
