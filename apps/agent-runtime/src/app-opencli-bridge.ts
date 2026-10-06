import { readFileSync } from "node:fs";
import path from "node:path";
import { qoneAuthDir } from "@qone/shared";
import { siteAppId, type RuntimeCommand, type RuntimeEvent } from "@qone/protocol";

export type Prepared = { requestId: string; endpoint: string };

export class AppOpenCliBridge {
  private readonly pending = new Map<string, { resolve: (value: Prepared) => void; reject: (error: Error) => void; cleanup: () => void }>();

  constructor(private readonly send: (event: Extract<RuntimeEvent, { type: "apps.opencli.request" | "apps.opencli.release" }>) => void) {}

  hasSavedSession(site: string): boolean {
    const appId = siteAppId(site);
    if (!appId) return false;
    try {
      const value = JSON.parse(readFileSync(path.join(qoneAuthDir(), `${appId}.json`), "utf8")) as { appId?: unknown; cookies?: unknown };
      return value.appId === appId && Array.isArray(value.cookies) && value.cookies.length > 0;
    } catch { return false; }
  }

  prepare(site: string, url: string, signal?: AbortSignal): Promise<Prepared | undefined> {
    if (!this.hasSavedSession(site)) return Promise.resolve(undefined);
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const current = this.pending.get(requestId);
        if (!current) return;
        current.cleanup();
        this.pending.delete(requestId);
        reject(new Error("embedded OpenCLI browser preparation cancelled"));
        try { this.send({ type: "apps.opencli.release", requestId }); } catch { /* Transport exited. */ }
      };
      const timer = setTimeout(cancel, 15_000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
      this.pending.set(requestId, { resolve, reject, cleanup });
      if (signal?.aborted) return cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try { this.send({ type: "apps.opencli.request", requestId, site, url }); }
      catch { cancel(); }
    });
  }

  release(requestId: string): void {
    try { this.send({ type: "apps.opencli.release", requestId }); } catch { /* Runtime may be exiting. */ }
  }

  handleResponse(command: Extract<RuntimeCommand, { type: "apps.opencli.response" }>): void {
    const current = this.pending.get(command.requestId);
    if (!current) return;
    current.cleanup();
    this.pending.delete(command.requestId);
    if (!command.ok || !command.endpoint) return current.reject(new Error(command.message || "embedded OpenCLI browser unavailable"));
    current.resolve({ requestId: command.requestId, endpoint: command.endpoint });
  }
}

