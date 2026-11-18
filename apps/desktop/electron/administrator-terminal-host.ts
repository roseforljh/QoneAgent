import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { EventEmitter } from "node:events";
import type { IPty } from "node-pty";
import type { ShellHostRequest, ShellHostResponse, TerminalHostRequest, TerminalHostResponse } from "@qone/protocol/terminal-host";
import { sendTerminalMessage, terminalMessages, terminalPipe, terminalProof } from "./terminal-pipe";

export type TerminalProcess = Pick<IPty, "onData" | "onExit" | "resize" | "clear" | "kill"> & { pid?: number; write(data: string): void };
type TerminalOptions = Extract<TerminalHostRequest, { type: "pty.spawn" }>["options"];
const disconnected = "Administrator terminal is disconnected. Restart Qone to reconnect.";

export class AdministratorTerminalHost {
  private readonly jobs = new Map<string, { owner: object; reply: (message: TerminalHostResponse) => void; close: () => void }>();

  private constructor(private readonly socket: Socket) {
    socket.once("close", () => {
      for (const job of this.jobs.values()) job.close();
      this.jobs.clear();
    });
  }

  static async start(launch: (pipeId: string, token: string) => Promise<unknown>, signal: AbortSignal): Promise<AdministratorTerminalHost> {
    const pipeId = randomBytes(32).toString("hex");
    const token = randomBytes(32).toString("hex");
    const candidates = new Set<Socket>();
    let host: AdministratorTerminalHost | undefined;
    let connected!: (host: AdministratorTerminalHost) => void;
    const ready = new Promise<AdministratorTerminalHost>(resolve => { connected = resolve; });
    const server = createServer(socket => {
      if (host) { socket.destroy(); return; }
      candidates.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("timeout", () => socket.destroy());
      socket.once("close", () => candidates.delete(socket));
      socket.setTimeout(5_000);
      terminalMessages(socket, message => {
        if (host?.socket === socket) { host.receive(message); return; }
        if (host || message?.type !== "ready" || message.proof !== terminalProof(token, "worker")) { socket.destroy(); return; }
        socket.setTimeout(0);
        sendTerminalMessage(socket, { type: "accept", proof: terminalProof(token, "desktop") });
        host = new AdministratorTerminalHost(socket);
        candidates.delete(socket);
        connected(host);
      });
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let fail!: (reason: Error) => void;
    const failed = new Promise<never>((_, reject) => { fail = reject; });
    const abort = () => fail(new Error("Administrator terminal startup stopped"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      const started = new Promise<void>(resolve => server.listen(terminalPipe(pipeId), resolve));
      server.on("error", fail);
      await Promise.race([started, failed]);
      await Promise.race([launch(pipeId, token), failed]);
      timeout = setTimeout(() => fail(new Error("Administrator terminal did not connect")), 10_000);
      return await Promise.race([ready, failed]);
    } catch (error) {
      host?.stop();
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      server.close();
      for (const socket of candidates) socket.destroy();
    }
  }

  get active(): boolean { return !this.socket.destroyed && this.socket.writable; }
  stop(): void { this.socket.destroy(); }

  private receive(message: TerminalHostResponse): void {
    const job = this.jobs.get(message?.id);
    if (!job) return;
    if (message.type === "pty.exit" || message.type === "terminal-host.exit" || message.type === "terminal-host.error") this.jobs.delete(message.id);
    job.reply(message);
  }

  shell(owner: object, request: ShellHostRequest, reply: (response: ShellHostResponse) => void): void {
    if (request.type === "terminal-host.cancel") {
      if (this.jobs.get(request.id)?.owner === owner) sendTerminalMessage(this.socket, request);
      return;
    }
    if (this.jobs.has(request.id)) return;
    const close = () => reply({ type: "terminal-host.error", id: request.id, message: disconnected });
    this.jobs.set(request.id, { owner, reply: message => { if (message.type.startsWith("terminal-host.")) reply(message as ShellHostResponse); }, close });
    if (!sendTerminalMessage(this.socket, request)) {
      this.jobs.delete(request.id);
      close();
    }
  }

  cancelShells(owner: object): void {
    for (const [id, job] of this.jobs) {
      if (job.owner !== owner) continue;
      this.jobs.delete(id);
      sendTerminalMessage(this.socket, { type: "terminal-host.cancel", id });
    }
  }

  spawnPty(shell: string, args: string[], options: TerminalOptions): TerminalProcess {
    const id = randomUUID();
    const events = new EventEmitter();
    const send = (message: TerminalHostRequest) => sendTerminalMessage(this.socket, message);
    const subscribe = (event: string) => (listener: (...args: any[]) => void) => {
      events.on(event, listener);
      return { dispose: () => { events.off(event, listener); } };
    };
    this.jobs.set(id, {
      owner: events,
      reply: message => {
        if (message.type === "pty.data") events.emit("data", message.data);
        if (message.type === "pty.exit") {
          if (message.error) events.emit("data", `[terminal error: ${message.error}]\r\n`);
          events.emit("exit", { exitCode: message.exitCode, signal: message.signal });
        }
      },
      close: () => {
        events.emit("data", `[${disconnected}]\r\n`);
        events.emit("exit", { exitCode: 1 });
      },
    });
    if (!send({ type: "pty.spawn", id, shell, args, options })) {
      this.jobs.delete(id);
      throw new Error(disconnected);
    }
    return {
      onData: subscribe("data"), onExit: subscribe("exit"),
      write: data => { send({ type: "pty.write", id, data }); },
      resize: (cols, rows) => { send({ type: "pty.resize", id, cols, rows }); },
      clear: () => { send({ type: "pty.clear", id }); },
      kill: () => { this.jobs.delete(id); send({ type: "pty.kill", id }); },
    };
  }
}
