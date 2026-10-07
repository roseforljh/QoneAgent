import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

export type Prepared = { requestId: string; endpoint: string };

export class AppOpenCliBridge {
  private readonly pending = new Map<string, { resolve: (value: Prepared) => void; reject: (error: Error) => void; cleanup: () => void }>();

  constructor(private readonly send: (event: Extract<RuntimeEvent, { type: "apps.opencli.request" | "apps.opencli.release" }>) => void) {}

  prepare(site: string, url: string, signal?: AbortSignal): Promise<Prepared | undefined> {
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

