import type { RuntimeEvent } from "@qone/protocol";

const pending = new Map<string, (saved: boolean) => void>();
export function acknowledgeClaudeCredentials(requestId: string, saved: boolean) {
  pending.get(requestId)?.(saved);
}

/** Wait for the Electron main process to finish encrypted disk storage. */
export function persistClaudeCredentials(send: (event: RuntimeEvent) => void, serverId: string, values: Record<string, string>, removeKeys: string[]) {
  if (!Object.keys(values).length && !removeKeys.length) return Promise.resolve();
  const requestId = crypto.randomUUID();
  return new Promise<void>((resolve, reject) => {
    const finish = (saved: boolean) => {
      clearTimeout(timer);
      pending.delete(requestId);
      if (saved) resolve(); else reject(new Error("MCP credentials could not be stored"));
    };
    const timer = setTimeout(() => finish(false), 15_000);
    pending.set(requestId, finish);
    try { send({ type: "claude-code.credentials", requestId, serverId, values, removeKeys }); }
    catch { finish(false); }
  });
}
