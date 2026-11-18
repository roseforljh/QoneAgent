import { createHmac } from "node:crypto";
import type { Socket } from "node:net";

export function terminalPipe(id: string): string {
  return String.raw`\\.\pipe\qone-terminal-${id}`;
}

export function terminalProof(token: string, peer: "worker" | "desktop"): string {
  return createHmac("sha256", token).update(peer).digest("hex");
}

export function terminalMessages(socket: Socket, receive: (message: any) => void): void {
  // Bound incomplete messages, including unauthenticated connections.
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let end: number;
    try {
      while ((end = pending.indexOf("\n")) !== -1 && !socket.destroyed) {
        if (end > 16 * 1024 * 1024) throw new Error("Invalid terminal message size");
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        receive(JSON.parse(line));
      }
      if (pending.length > 16 * 1024 * 1024) socket.destroy();
    } catch { socket.destroy(); }
  });
}

export function sendTerminalMessage(socket: Socket, message: object): boolean {
  if (socket.destroyed || !socket.writable) return false;
  socket.write(JSON.stringify(message) + "\n");
  return true;
}
