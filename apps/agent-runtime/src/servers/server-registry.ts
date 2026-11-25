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

  async add(input: AddServerInput, progress: (stage: ServerSetupStage) => void): Promise<ServerInfo> {
    const server = await this.setup(crypto.randomUUID(), input, progress);
    this.save([...this.list(), server]);
    return server;
  }

  /**
   * Change address, name or sign-in; omitted credentials reuse the saved ones. Saved only after it connects.
   * `trustHostKey` (confirmed by the user) accepts whatever key the server presents now.
   */
  async edit(id: string, input: AddServerInput, progress: (stage: ServerSetupStage) => void, trustHostKey = false): Promise<ServerInfo> {
    const current = this.list().find((server) => server.id === id);
    if (!current) throw runtimeError("servers.not_found");
    const server = await this.setup(id, input, progress, current, trustHostKey);
    this.pool.drop(id);
    this.save(this.list().map((item) => item.id === id ? server : item));
    return server;
  }

  /**
   * Connect, pin the host key, probe the system and, for password sign-in,
   * install a per-server Ed25519 key (ET's dedicated key) and verify it before
   * saving. The password is never stored.
   */
  private async setup(id: string, input: AddServerInput, progress: (stage: ServerSetupStage) => void, current?: ServerInfo, trustHostKey = false): Promise<ServerInfo> {
    const target = { host: input.host.trim(), port: input.port, username: input.username.trim() };
    const newSignIn = Boolean(input.password || input.keyPath || input.useAgent) || !current;
    const credentials: Credentials = input.password ? { password: input.password }
      : input.keyPath ? { privateKey: readFileSync(input.keyPath) }
      : newSignIn ? { agent: agentPath() } : credentialsFor(current!);
    // The same address keeps its pinned key; a changed one is pinned anew like a first contact.
    const pinned = current && !trustHostKey && current.host === target.host && current.port === target.port ? current.hostKey : undefined;
    progress("host-key");
    let hostKey = "";
    const client = await connect(target, credentials, pinned, (value) => { hostKey = value; progress("authenticating"); })
      .catch((error) => {
        // Surface the mismatch on the saved server so the form can offer to trust it.
        if (current && error instanceof HostKeyChangedError) this.update(id, { status: "host-key-changed", statusDetail: error.presented });
        throw signInError(error, target.host);
      });
    try {
      progress("inspecting");
      const probe = await exec(client, PROBE, { timeoutMs: 20_000 });
      let auth: ServerInfo["auth"] = !newSignIn ? current!.auth : input.keyPath ? { kind: "key", keyPath: input.keyPath, dedicated: false } : { kind: "agent" };
      const keyPath = path.join(keyDirectory(), id);
      if (input.password) {
        progress("securing");
        const pair = utils.generateKeyPairSync("ed25519", { comment: dedicatedComment(id) });
        const line = pair.public.trim();
        // Replaces this server's previous dedicated key, if any.
        const install = await exec(client, `umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && sed -i ${shQuote(`/ ${dedicatedComment(id)}$/d`)} ~/.ssh/authorized_keys && printf '%s\\n' ${shQuote(line)} >> ~/.ssh/authorized_keys`, { timeoutMs: 20_000 });
        if (install.exit_code !== 0) throw runtimeError("servers.key_install_failed", { p0: install.stderr.trim() || install.exit_code });
        // The new key must work on its own before it replaces the saved one and the password is forgotten.
        await connect(target, { privateKey: pair.private }, hostKey).then((verified) => verified.end(), (error) => {
          throw runtimeError("servers.key_verify_failed", { p0: error instanceof Error ? error.message : String(error) });
        });
        mkdirSync(keyDirectory(), { recursive: true });
        writeFileSync(keyPath, pair.private, { mode: 0o600 });
        auth = { kind: "key", keyPath, dedicated: true };
      } else if (current?.auth.kind === "key" && current.auth.dedicated && newSignIn) {
        // Switching away from the dedicated key: revoke it while connected; best effort, the local key goes either way.
        await exec(client, `sed -i ${shQuote(`/ ${dedicatedComment(id)}$/d`)} ~/.ssh/authorized_keys`, { timeoutMs: 10_000 }).catch(() => undefined);
        rmSync(current.auth.keyPath, { force: true });
      }
      return {
        id, name: input.name?.trim() || target.host, ...target, auth, hostKey,
        ...(input.groupId && this.groups().some((group) => group.id === input.groupId) ? { groupId: input.groupId } : {}),
        system: probe.stdout.trim().slice(0, 160) || undefined,
        status: "ready", lastConnectedAt: Date.now(), createdAt: current?.createdAt ?? Date.now(),
      };
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

  /**
   * Revoke the dedicated key before discarding the only credential that can clean it up.
   * `force` skips the revocation for a server that can no longer be reached or verified.
   */
  async delete(id: string, force = false): Promise<void> {
    const server = this.get(id);
    if (!server) return;
    if (server.auth.kind === "key" && server.auth.dedicated) {
      if (!force) try {
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
