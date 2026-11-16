import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import type { TerminalEvents, TerminalInvoke } from "./dock-terminal-session";

type Send = (command: RuntimeCommand) => Promise<boolean>;

const listeners = new Map<string, TerminalEvents>();
const opening = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

/** Runtime → xterm for SSH terminals; called by the runtime bridge. */
export function dispatchServerTerminal(message: Extract<RuntimeEvent, { type: "server.terminal.data" | "server.terminal.exit" | "server.terminal.opened" }>): void {
  if (message.type === "server.terminal.opened") { opening.get(message.requestId)?.resolve(); opening.delete(message.requestId); return; }
  const target = listeners.get(message.terminalId);
  if (message.type === "server.terminal.data") target?.data(message.data);
  else target?.exit();
}

export function dispatchServerTerminalError(requestId: string | undefined, message: string): boolean {
  const pending = requestId ? opening.get(requestId) : undefined;
  if (!pending) return false;
  opening.delete(requestId!);
  pending.reject(new Error(message));
  return true;
}

/** The dock session's local-PTY verbs mapped onto the runtime's SSH shell commands. */
export function serverTerminalTransport(serverId: string, terminalId: string, send: Send): { invoke: TerminalInvoke; listen: (events: TerminalEvents) => Promise<() => void> } {
  const fire = async (command: Record<string, unknown>) => {
    if (!await send({ ...command, requestId: crypto.randomUUID() } as RuntimeCommand)) throw new Error("disconnected");
  };
  return {
    invoke: async (verb, args) => {
      if (verb === "terminal_spawn") {
        const requestId = crypto.randomUUID();
        const opened = new Promise<void>((resolve, reject) => opening.set(requestId, { resolve, reject }));
        if (!await send({ type: "server.terminal.open", requestId, terminalId, serverId, cols: Number(args.cols) || 120, rows: Number(args.rows) || 30 })) {
          opening.delete(requestId);
          throw new Error("disconnected");
        }
        return opened;
      }
      if (verb === "terminal_write") return fire({ type: "server.terminal.write", terminalId, data: String(args.data) });
      if (verb === "terminal_resize") return fire({ type: "server.terminal.resize", terminalId, cols: Number(args.cols), rows: Number(args.rows) });
      if (verb === "terminal_kill") return fire({ type: "server.terminal.close", terminalId });
    },
    listen: async (events) => {
      listeners.set(terminalId, events);
      return () => { if (listeners.get(terminalId) === events) listeners.delete(terminalId); };
    },
  };
}
