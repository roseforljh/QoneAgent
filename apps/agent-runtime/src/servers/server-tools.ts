import { mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Client, ClientChannel, SFTPWrapper } from "ssh2";
import type { ServerInfo, ServerTunnelInfo } from "@qone/protocol";
import { runtimeError } from "../runtime-localization.js";
import { abortable, exec, sftp, shell, shQuote, type SshPool } from "./ssh.js";

const MAX_READ = 1024 * 1024;
const MAX_EDIT = 8 * 1024 * 1024;
const TERMINAL_BUFFER = 256 * 1024;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export const SERVER_TOOL_NAMES = ["server_exec", "server_read_file", "server_write_file", "server_edit", "server_terminal", "server_upload", "server_download", "server_open_port"] as const;

interface Terminal { id: string; serverId: string; channel: ClientChannel; output: string; base: number; closed: boolean; onData?: (data: string) => void; onExit?: () => void }

const promisify = <T>(run: (done: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((resolve, reject) => run((error, value) => error ? reject(error) : resolve(value as T)));

/** Terminals and tunnels outlive a tool call; the user's dock terminals use the same sessions. */
export class ServerSessions {
  private terminals = new Map<string, Terminal>();
  private tunnels = new Map<string, { info: ServerTunnelInfo; server: net.Server }>();

  constructor(private pool: SshPool, private onTunnelsChanged: () => void) {}

  async openTerminal(server: ServerInfo, cols: number, rows: number, id: string = crypto.randomUUID(), handlers: Pick<Terminal, "onData" | "onExit"> = {}, signal?: AbortSignal): Promise<Terminal> {
    signal?.throwIfAborted();
    this.closeTerminal(id);
    const connection = await abortable(this.pool.get(server), signal);
    const pending = shell(connection, cols, rows).then(channel => { if (signal?.aborted) { channel.close(); signal.throwIfAborted(); } return channel; });
    const channel = await abortable(pending, signal);
    if (signal?.aborted) { channel.close(); signal.throwIfAborted(); }
    const terminal: Terminal = { id, serverId: server.id, channel, output: "", base: 0, closed: false, ...handlers };
    channel.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      terminal.output += text;
      if (terminal.output.length > TERMINAL_BUFFER) {
        const drop = terminal.output.length - TERMINAL_BUFFER;
        terminal.output = terminal.output.slice(drop);
        terminal.base += drop;
      }
      terminal.onData?.(text);
    });
    channel.stderr.on("data", (chunk: Buffer) => terminal.onData?.(chunk.toString("utf8")));
    channel.on("close", () => { terminal.closed = true; this.terminals.delete(id); terminal.onExit?.(); });
    this.terminals.set(id, terminal);
    return terminal;
  }

  terminal(id: string): Terminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw runtimeError("servers.terminal_missing");
    return terminal;
  }

  find(id: string): Terminal | undefined { return this.terminals.get(id); }

  closeTerminal(id: string) { this.terminals.get(id)?.channel.close(); this.terminals.delete(id); }

  async openTunnel(server: ServerInfo, remotePort: number, protocol: "http" | "https", signal?: AbortSignal): Promise<ServerTunnelInfo> {
    signal?.throwIfAborted();
    const existing = [...this.tunnels.values()].find((item) => item.info.serverId === server.id && item.info.remotePort === remotePort);
    if (existing) return existing.info;
    const listener = net.createServer((socket) => {
      void this.pool.get(server).then((client) => client.forwardOut("127.0.0.1", socket.localPort ?? 0, "127.0.0.1", remotePort, (error, stream) => {
        if (error) { socket.destroy(); return; }
        socket.pipe(stream).pipe(socket);
        socket.on("error", () => stream.close());
        stream.on("error", () => socket.destroy());
      }), () => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => listener.once("error", reject).listen(0, "127.0.0.1", resolve));
    if (signal?.aborted) { listener.close(); signal.throwIfAborted(); }
    const localPort = (listener.address() as net.AddressInfo).port;
    const info = { serverId: server.id, remotePort, localPort, url: `${protocol}://127.0.0.1:${localPort}` };
    this.tunnels.set(`${server.id}:${localPort}`, { info, server: listener });
    this.onTunnelsChanged();
    return info;
  }

  closeTunnel(serverId: string, localPort: number) {
    const key = `${serverId}:${localPort}`;
    this.tunnels.get(key)?.server.close();
    if (this.tunnels.delete(key)) this.onTunnelsChanged();
  }

  tunnelList(): ServerTunnelInfo[] { return [...this.tunnels.values()].map((item) => item.info); }

  /** A deleted server takes its terminals and tunnels with it. */
  closeServer(serverId: string) {
    for (const terminal of [...this.terminals.values()]) if (terminal.serverId === serverId) this.closeTerminal(terminal.id);
    for (const item of [...this.tunnels.values()]) if (item.info.serverId === serverId) this.closeTunnel(serverId, item.info.localPort);
  }
}

/** Remote relative paths resolve from the SSH user's home, like `ssh host cmd`. */
async function remotePath(channel: SFTPWrapper, value: string): Promise<string> {
  if (value.startsWith("/")) return value;
  const home = await promisify<string>((done) => channel.realpath(".", done));
  return path.posix.join(home, value.replace(/^~\/?/, ""));
}

async function readRemote(channel: SFTPWrapper, file: string, offset: number, limit: number, signal?: AbortSignal): Promise<{ data: Buffer; size: number }> {
  signal?.throwIfAborted();
  const stats = await promisify<{ size: number }>((done) => channel.stat(file, done));
  signal?.throwIfAborted();
  const handle = await promisify<Buffer>((done) => channel.open(file, "r", done));
  try {
    const length = Math.max(0, Math.min(limit, stats.size - offset));
    const data = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      signal?.throwIfAborted();
      const count = await promisify<number>((done) => channel.read(handle, data, read, length - read, offset + read, (error, bytes) => done(error, bytes)));
      if (!count) break;
      read += count;
    }
    return { data: data.subarray(0, read), size: stats.size };
  } finally {
    channel.close(handle, () => undefined);
  }
}

async function writeRemote(channel: SFTPWrapper, file: string, data: Buffer, append: boolean) {
  await promisify<void>((done) => channel.writeFile(file, data, { flag: append ? "a" : "w" }, (error) => done(error)));
}

async function mkdirs(client: Client, directory: string, signal?: AbortSignal) {
  const result = await exec(client, `mkdir -p -- ${shQuote(directory)}`, { signal });
  if (result.exit_code !== 0) throw new Error(result.stderr.trim() || `mkdir failed (${result.exit_code})`);
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

export interface ServerToolContext {
  servers: () => ServerInfo[];
  pool: SshPool;
  sessions: ServerSessions;
  workspacePath: string;
  onActivity: (serverId: string) => void;
}

export function createServerTools(context: ServerToolContext): ToolDefinition[] {
  const servers = context.servers();
  if (!servers.length) return [];
  const names = servers.map((server) => `${server.name} [${server.id}]`);
  const targets = [...new Set(servers.flatMap(server => [server.id, server.name]))];
  const targetParam = Type.Union(targets.map(value => Type.Literal(value)), { description: `Selected server ID (preferred) or unique name: ${names.join(", ")}.` });
  const serverParam = servers.length === 1 ? Type.Optional(targetParam) : targetParam;
  const pick = (name?: string): ServerInfo => {
    const matches = name ? servers.filter(server => server.name.toLowerCase() === name.toLowerCase()) : [];
    const target = name ? servers.find(server => server.id === name) ?? (matches.length === 1 ? matches[0] : undefined) : servers.length === 1 ? servers[0] : undefined;
    if (!target) throw runtimeError("servers.choose", { p0: names.join(", ") });
    const current = context.servers().find(server => server.id === target.id);
    if (!current) throw runtimeError("servers.not_found");
    return current;
  };
  const client = async (server: ServerInfo, signal?: AbortSignal) => { signal?.throwIfAborted(); const value = await abortable(context.pool.get(server), signal); signal?.throwIfAborted(); context.onActivity(server.id); return value; };
  const roster = servers.map((server) => `${server.name} (${server.username}@${server.host}${server.port === 22 ? "" : `:${server.port}`}${server.system ? `, ${server.system}` : ""})`).join("; ");
  const remote = "Absolute remote path, or relative to the SSH user's home.";

  const tools: ToolDefinition[] = [
    {
      name: "server_exec", label: "Server · run command",
      description: `Run a shell command on one of the user's servers over SSH. Servers: ${roster}. Read-only diagnostics run directly; anything that changes the server asks the user first unless they granted full access.`,
      promptSnippet: `server_exec: run commands on the user's SSH servers (${names.join(", ")})`,
      parameters: Type.Object({
        server: serverParam,
        command: Type.String({ description: "Command or shell script." }),
        cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the SSH user's home." })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
      }),
      execute: async (_id, args: { server?: string; command: string; cwd?: string; timeout_ms?: number }, signal, onUpdate) => {
        const result = await exec(await client(pick(args.server), signal), args.command, { cwd: args.cwd, timeoutMs: args.timeout_ms, signal,
          onUpdate: value => onUpdate?.(json(value)) });
        return { ...json(result), isError: result.exit_code !== 0 || result.timed_out || Boolean(result.signal) || Boolean(result.cancelled), details: { cancelled: result.cancelled === true } };
      },
    },
    {
      name: "server_read_file", label: "Server · read file",
      description: "Read one page of a file on a server.",
      parameters: Type.Object({
        server: serverParam, path: Type.String({ description: remote }),
        offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ })),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
      }),
      execute: async (_id, args: { server?: string; path: string; offset?: number; limit?: number; encoding?: "utf8" | "base64" }, signal, onUpdate) => {
        const channel = await sftp(await client(pick(args.server), signal), signal);
        try {
          const file = await remotePath(channel, args.path);
          const offset = args.offset ?? 0;
          const { data, size } = await readRemote(channel, file, offset, args.limit ?? 256 * 1024, signal);
          const next = offset + data.length;
          return json({ path: file, size, offset, content: data.toString(args.encoding ?? "utf8"), ...(next < size ? { next_offset: next } : {}) });
        } finally { channel.end(); }
      },
    },
    {
      name: "server_write_file", label: "Server · write file",
      description: "Write a UTF-8 or base64 file on a server. Existing permissions are kept.",
      parameters: Type.Object({
        server: serverParam, path: Type.String({ description: remote }), content: Type.String(),
        encoding: Type.Optional(Type.Union([Type.Literal("utf8"), Type.Literal("base64")])),
        mode: Type.Optional(Type.Union([Type.Literal("overwrite"), Type.Literal("append")])),
        create_parents: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, args: { server?: string; path: string; content: string; encoding?: "utf8" | "base64"; mode?: "overwrite" | "append"; create_parents?: boolean }, signal, onUpdate) => {
        const connection = await client(pick(args.server), signal);
        const channel = await sftp(connection, signal);
        try {
          const file = await remotePath(channel, args.path);
          if (args.create_parents) await mkdirs(connection, path.posix.dirname(file), signal);
          const data = Buffer.from(args.content, args.encoding ?? "utf8");
          signal?.throwIfAborted();
          await writeRemote(channel, file, data, args.mode === "append");
          return json({ path: file, bytes: data.length });
        } finally { channel.end(); }
      },
    },
    {
      name: "server_edit", label: "Server · edit file",
      description: "Edit one file on a server with exact text replacements. Every oldText must be unique in the original file; edits must not overlap.",
      parameters: Type.Object({
        server: serverParam, path: Type.String({ description: remote }),
        edits: Type.Array(Type.Object({ oldText: Type.String({ minLength: 1 }), newText: Type.String() }), { minItems: 1 }),
      }),
      execute: async (_id, args: { server?: string; path: string; edits: { oldText: string; newText: string }[] }, signal, onUpdate) => {
        const channel = await sftp(await client(pick(args.server), signal), signal);
        try {
          const file = await remotePath(channel, args.path);
          const { data, size } = await readRemote(channel, file, 0, MAX_EDIT, signal);
          if (size > MAX_EDIT) throw runtimeError("servers.file_too_large");
          const original = data.toString("utf8");
          const ranges = args.edits.map((edit) => {
            const start = original.indexOf(edit.oldText);
            if (start < 0 || original.indexOf(edit.oldText, start + 1) >= 0) throw runtimeError("servers.edit_not_unique", { p0: edit.oldText.slice(0, 80) });
            return { start, end: start + edit.oldText.length, text: edit.newText };
          }).sort((a, b) => a.start - b.start);
          ranges.forEach((range, index) => { if (index && range.start < ranges[index - 1]!.end) throw runtimeError("servers.edit_overlap"); });
          const updated = ranges.reduceRight((text, range) => text.slice(0, range.start) + range.text + text.slice(range.end), original);
          signal?.throwIfAborted();
          await writeRemote(channel, file, Buffer.from(updated, "utf8"), false);
          return json({ path: file, replacements: ranges.length });
        } finally { channel.end(); }
      },
    },
    {
      name: "server_terminal", label: "Server · terminal",
      description: "Interactive PTY on a server for programs that need a terminal (top, installers, REPLs). open returns terminal_id; read returns output after cursor with the next cursor.",
      parameters: Type.Object({
        server: serverParam,
        action: Type.Union(["open", "write", "read", "resize", "close"].map((value) => Type.Literal(value))),
        terminal_id: Type.Optional(Type.String()), input: Type.Optional(Type.String()),
        cursor: Type.Optional(Type.Integer({ minimum: 0 })),
        cols: Type.Optional(Type.Integer({ minimum: 20, maximum: 400 })), rows: Type.Optional(Type.Integer({ minimum: 5, maximum: 200 })),
      }),
      execute: async (_id, args: { server?: string; action: string; terminal_id?: string; input?: string; cursor?: number; cols?: number; rows?: number }, signal, onUpdate) => {
        if (args.action === "open") {
          const server = pick(args.server);
          await client(server, signal);
          const terminal = await context.sessions.openTerminal(server, args.cols ?? 160, args.rows ?? 48, undefined, {}, signal);
          return json({ terminal_id: terminal.id, cursor: 0 });
        }
        const terminal = context.sessions.terminal(args.terminal_id ?? "");
        const server = pick(args.server ?? terminal.serverId);
        if (terminal.serverId !== server.id) throw runtimeError("servers.choose", { p0: names.join(", ") });
        if (args.action === "close") { context.sessions.closeTerminal(terminal.id); return json({ closed: true }); }
        if (args.action === "resize") { terminal.channel.setWindow(args.rows ?? 48, args.cols ?? 160, 0, 0); return json({ ok: true }); }
        if (args.action === "write") {
          const interrupt = () => { terminal.channel.signal("INT"); terminal.channel.write(""); };
          signal?.addEventListener("abort", interrupt, { once: true });
          try { signal?.throwIfAborted(); terminal.channel.write(args.input ?? ""); await abortable(Bun.sleep(300), signal); }
          finally { signal?.removeEventListener("abort", interrupt); }
        }
        const cursor = Math.max(args.cursor ?? 0, terminal.base);
        return json({ output: terminal.output.slice(cursor - terminal.base).replace(ANSI, ""), cursor: terminal.base + terminal.output.length, closed: terminal.closed });
      },
    },
    {
      name: "server_upload", label: "Server · upload",
      description: "Copy a local file (absolute, or relative to the workspace) to a server.",
      parameters: Type.Object({ server: serverParam, local_path: Type.String(), remote_path: Type.String({ description: remote }), create_parents: Type.Optional(Type.Boolean()) }),
      execute: async (_id, args: { server?: string; local_path: string; remote_path: string; create_parents?: boolean }, signal, onUpdate) => {
        const connection = await client(pick(args.server), signal);
        const channel = await sftp(connection, signal);
        try {
          const target = await remotePath(channel, args.remote_path);
          if (args.create_parents) await mkdirs(connection, path.posix.dirname(target), signal);
          const source = path.resolve(context.workspacePath, args.local_path);
          signal?.throwIfAborted();
          await promisify<void>((done) => channel.fastPut(source, target, { step: (bytes, _chunk, total) => onUpdate?.(json({ bytes, total })) }, (error) => done(error)));
          return json({ local_path: source, remote_path: target, bytes: Bun.file(source).size });
        } finally { channel.end(); }
      },
    },
    {
      name: "server_download", label: "Server · download",
      description: "Copy a server file to this computer. local_path defaults to downloads/servers/<server>/ in the workspace. Only download when the user asks for the file locally.",
      parameters: Type.Object({ server: serverParam, remote_path: Type.String({ description: remote }), local_path: Type.Optional(Type.String()) }),
      execute: async (_id, args: { server?: string; remote_path: string; local_path?: string }, signal, onUpdate) => {
        const server = pick(args.server);
        const channel = await sftp(await client(server, signal), signal);
        try {
          const source = await remotePath(channel, args.remote_path);
          const target = path.resolve(context.workspacePath, args.local_path ?? path.join("downloads", "servers", server.name.replace(/[<>:"/\\|?*]/g, "_"), path.posix.basename(source)));
          mkdirSync(path.dirname(target), { recursive: true });
          signal?.throwIfAborted();
          await promisify<void>((done) => channel.fastGet(source, target, { step: (bytes, _chunk, total) => onUpdate?.(json({ bytes, total })) }, (error) => done(error)));
          return json({ remote_path: source, local_path: target, bytes: Bun.file(target).size });
        } finally { channel.end(); }
      },
    },
    {
      name: "server_open_port", label: "Server · open port",
      description: "Forward an HTTP(S) service on a server to a private local URL on this computer (SSH tunnel). Open the returned url with the browser tools to inspect it.",
      parameters: Type.Object({ server: serverParam, port: Type.Integer({ minimum: 1, maximum: 65_535 }), protocol: Type.Optional(Type.Union([Type.Literal("http"), Type.Literal("https")])) }),
      execute: async (_id, args: { server?: string; port: number; protocol?: "http" | "https" }, signal, onUpdate) => {
        const server = pick(args.server);
        await client(server, signal);
        return json(await context.sessions.openTunnel(server, args.port, args.protocol ?? "http", signal));
      },
    },
  ];
  return tools.map(tool => ({ ...tool, execute: async (id, input, signal, onUpdate, ctx) => {
    const args = input as { server?: string; action?: string; terminal_id?: string };
    let server: ServerInfo | undefined;
    let latest: Awaited<ReturnType<ToolDefinition["execute"]>> | undefined;
    let lastUpdate = 0;
    const decorate = (result: Awaited<ReturnType<ToolDefinition["execute"]>>) => ({ ...result,
      details: { ...(result.details as object), ...(server ? { serverOperation: { serverId: server.id, serverName: server.name } } : {}) } });
    try {
      const terminal = tool.name === "server_terminal" && args.action !== "open" ? context.sessions.terminal(args.terminal_id ?? "") : undefined;
      const target = pick(args.server ?? terminal?.serverId);
      if (terminal && terminal.serverId !== target.id) throw runtimeError("servers.choose", { p0: names.join(", ") });
      server = target;
      signal?.throwIfAborted();
      onUpdate?.(decorate(json({ phase: "connecting" })));
      const pending = tool.execute(id, { ...args, server: server.id }, signal, update => {
        latest = update;
        const now = Date.now();
        if (!signal?.aborted && now - lastUpdate >= 100) { lastUpdate = now; onUpdate?.(decorate(update)); }
      }, ctx);
      const result = await (tool.name === "server_exec" ? pending : abortable(pending, signal));
      if (!(result.details as { cancelled?: boolean })?.cancelled) signal?.throwIfAborted();
      return decorate(result);
    } catch (error) {
      if (!server) throw error;
      return decorate({ ...json({ error: error instanceof Error ? error.message : String(error) }), ...(latest ? { content: latest.content } : {}), isError: true, details: { cancelled: signal?.aborted === true } });
    }
  } }));
}
