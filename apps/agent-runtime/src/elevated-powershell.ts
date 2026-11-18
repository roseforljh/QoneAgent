import { randomUUID } from "node:crypto";
import type { PowerShellOperations } from "@earendil-works/pi-coding-agent";
import { elevatedTerminalEnv, type ShellHostRequest, type ShellHostResponse } from "@qone/protocol/terminal-host";

interface PendingCommand {
  onData: (data: Buffer) => void;
  finish: (exitCode: number | null, error?: Error) => void;
}

export function createElevatedPowerShell(): PowerShellOperations | undefined {
  if (process.platform !== "win32" || process.env[elevatedTerminalEnv] !== "1" || !process.send) return;
  return createBrokeredPowerShell(
    (message, callback) => {
      if (!process.connected || !process.send) return callback(new Error("Administrator terminal is disconnected. Restart Qone to reconnect."));
      process.send(message, callback);
    },
    handler => process.on("message", handler),
    handler => process.once("disconnect", handler),
  );
}

export function createBrokeredPowerShell(
  send: (message: ShellHostRequest, callback: (error: Error | null) => void) => void,
  receive: (handler: (message: ShellHostResponse) => void) => void,
  onClose: (handler: () => void) => void,
): PowerShellOperations {
  const pending = new Map<string, PendingCommand>();
  receive(message => {
    const job = message && pending.get(message.id);
    if (!job) return;
    if (message.type === "terminal-host.output") job.onData(Buffer.from(message.data, "base64"));
    if (message.type === "terminal-host.exit") job.finish(message.exitCode);
    if (message.type === "terminal-host.error") job.finish(null, new Error(message.message));
  });
  onClose(() => {
    for (const job of pending.values()) job.finish(null, new Error("Administrator terminal is disconnected. Restart Qone to reconnect."));
  });
  return { exec: (command, cwd, { env, timeout, onData, signal }) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const id = randomUUID();
    const cancel = () => send({ type: "terminal-host.cancel", id }, error => { if (error) finish(null, error); });
    const finish = (exitCode: number | null, error?: Error) => {
      if (!pending.delete(id)) return;
      signal?.removeEventListener("abort", cancel);
      if (signal?.aborted) reject(new Error("aborted"));
      else if (error) reject(error);
      else resolve({ exitCode });
    };
    pending.set(id, { onData, finish });
    signal?.addEventListener("abort", cancel, { once: true });
    const shellEnv = { ...env };
    delete shellEnv[elevatedTerminalEnv];
    send({ type: "terminal-host.exec", id, command, cwd, timeout, env: shellEnv }, error => { if (error) finish(null, error); });
  }) };
}

// One listener per runtime, not per Agent session.
export const elevatedPowerShell = createElevatedPowerShell();
