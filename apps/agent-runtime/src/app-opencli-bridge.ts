import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenCliBrowserTab, RuntimeCommand, RuntimeEvent } from "@qone/protocol";

type OpenCliRequest = Extract<RuntimeEvent, { type: "apps.opencli.request" }>;
type OpenCliResponse = Extract<RuntimeCommand, { type: "apps.opencli.response" }>;
type Prepared = { requestId: string; endpoint: string; url?: string; loginRequired?: "passkey" };

const browserSessionContext = new AsyncLocalStorage<string | undefined>();

/** 绑定当前模型执行所属会话，便于桌面端在对应会话的右侧内置浏览器面板实时弹出显示。 */
export function withBrowserSessionId<T>(sessionId: string | undefined, work: () => T): T {
  return browserSessionContext.run(sessionId, work);
}

export function currentBrowserSessionId(): string | undefined {
  return browserSessionContext.getStore();
}

export class AppOpenCliBridge {
  private readonly pending = new Map<string, { resolve: (value: OpenCliResponse) => void; reject: (error: Error) => void; cleanup: () => void }>();

  constructor(private readonly send: (event: Extract<RuntimeEvent, { type: "apps.opencli.request" | "apps.opencli.release" }>) => void) {}

  async prepare(site: string, url: string | undefined, signal?: AbortSignal, reuseRequestId?: string): Promise<Prepared> {
    const response = await this.request({ site, url, reuseRequestId }, signal);
    if (!response.endpoint) throw new Error("Built-in browser bridge did not prepare a page");
    return { requestId: response.requestId, endpoint: response.endpoint, url: response.url, loginRequired: response.loginRequired };
  }

  async listTabs(signal?: AbortSignal): Promise<OpenCliBrowserTab[]> {
    const response = await this.request({ site: "browser", listTabs: true }, signal);
    if (!response.tabs) throw new Error("Built-in browser bridge did not return a tab list");
    return response.tabs;
  }

  private request(request: Omit<OpenCliRequest, "type" | "requestId" | "sessionId">, signal?: AbortSignal): Promise<OpenCliResponse> {
    const requestId = crypto.randomUUID();
    const sessionId = currentBrowserSessionId();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const current = this.pending.get(requestId);
        if (!current) return;
        current.cleanup();
        this.pending.delete(requestId);
        reject(new Error("embedded OpenCLI browser preparation cancelled"));
        if (!request.reuseRequestId && !request.listTabs) {
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
          ...request,
          ...(sessionId ? { sessionId } : {}),
        });
      }
      catch { cancel(); }
    });
  }

  release(requestId: string, close?: boolean): void {
    try { this.send({ type: "apps.opencli.release", requestId, ...(close ? { close: true } : {}) }); } catch { /* Runtime may be exiting. */ }
  }

  handleResponse(command: OpenCliResponse): void {
    const current = this.pending.get(command.requestId);
    if (!current) return;
    current.cleanup();
    this.pending.delete(command.requestId);
    if (!command.ok) return current.reject(new Error(command.message || "embedded OpenCLI browser unavailable"));
    current.resolve(command);
  }
}

