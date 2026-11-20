import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

export type Prepared = { requestId: string; endpoint: string; loginRequired?: "passkey" };

const browserSessionContext = new AsyncLocalStorage<string | undefined>();

/** 绑定当前模型执行所属会话，便于桌面端在对应会话的右侧内置浏览器面板实时弹出显示。 */
export function withBrowserSessionId<T>(sessionId: string | undefined, work: () => T): T {
  return browserSessionContext.run(sessionId, work);
}

export function currentBrowserSessionId(): string | undefined {
  return browserSessionContext.getStore();
}

export class AppOpenCliBridge {
  private readonly pending = new Map<string, { resolve: (value: Prepared) => void; reject: (error: Error) => void; cleanup: () => void }>();

  constructor(private readonly send: (event: Extract<RuntimeEvent, { type: "apps.opencli.request" | "apps.opencli.release" }>) => void) {}

  prepare(site: string, url: string, signal?: AbortSignal, reuseRequestId?: string): Promise<Prepared | undefined> {
    const requestId = crypto.randomUUID();
    const sessionId = currentBrowserSessionId();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const current = this.pending.get(requestId);
        if (!current) return;
        current.cleanup();
        this.pending.delete(requestId);
        reject(new Error("embedded OpenCLI browser preparation cancelled"));
        if (!reuseRequestId) {
          try { this.send({ type: "apps.opencli.release", requestId }); } catch { /* Transport exited. */ }
        }
      };
      const timer = setTimeout(cancel, 15_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(requestId, { resolve, reject, cleanup });
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.send({
          type: "apps.opencli.request",
          requestId,
          site,
          url,
          ...(sessionId ? { sessionId } : {}),
          ...(reuseRequestId ? { reuseRequestId } : {}),
        });
      }
      catch { cancel(); }
    });
  }

  release(requestId: string, close?: boolean): void {
    try { this.send({ type: "apps.opencli.release", requestId, ...(close ? { close: true } : {}) }); } catch { /* Runtime may be exiting. */ }
  }

  handleResponse(command: Extract<RuntimeCommand, { type: "apps.opencli.response" }>): void {
    const current = this.pending.get(command.requestId);
    if (!current) return;
    current.cleanup();
    this.pending.delete(command.requestId);
    if (!command.ok || !command.endpoint) return current.reject(new Error(command.message || "embedded OpenCLI browser unavailable"));
    current.resolve({ requestId: command.requestId, endpoint: command.endpoint, ...(command.loginRequired ? { loginRequired: command.loginRequired } : {}) });
  }
}

