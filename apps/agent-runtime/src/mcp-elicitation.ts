import type { McpLifecycleOptions } from "@qone/mcp";
import type { AutomationCommand, McpElicitationField, McpElicitationInfo, RuntimeEvent } from "@qone/protocol";

type Elicit = NonNullable<McpLifecycleOptions["onElicitation"]>;
export type ElicitResult = Awaited<ReturnType<Elicit>>;
type Respond = Extract<AutomationCommand, { type: "mcp.elicitation.respond" }>;
export type ElicitationRequest = Omit<McpElicitationInfo, "id" | "createdAt">;

/**
 * Questions MCP servers ask the person mid-tool (`elicitation/create`). Every
 * change re-sends the whole list, so a reloaded window shows what is still
 * open; a request the server cancels disappears by itself.
 */
export class McpElicitations {
  private readonly pending = new Map<string, { info: McpElicitationInfo; settle: (result: ElicitResult) => void }>();

  constructor(private readonly send: (event: RuntimeEvent) => void, private readonly conversation: (sessionId: string) => string = (sessionId) => sessionId) {}

  readonly ask: Elicit = (config, params, signal, caller) => {
    const request = params as { mode?: string; message?: unknown; url?: unknown; requestedSchema?: { properties?: Record<string, McpElicitationField>; required?: string[] } };
    return this.request({
      serverId: config.id, serverName: config.name, message: String(request.message ?? ""),
      ...(caller ? { sessionId: caller } : {}),
      ...(request.mode === "url"
        ? { mode: "url" as const, url: String(request.url ?? "") }
        : { mode: "form" as const, fields: request.requestedSchema?.properties ?? {}, required: request.requestedSchema?.required ?? [] }),
    }, signal);
  };

  /** Shows one request above the asking conversation's composer until it is answered or aborted. */
  request(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitResult> {
    return new Promise<ElicitResult>((resolve) => {
      if (signal.aborted) return resolve({ action: "cancel" });
      const id = crypto.randomUUID();
      const info: McpElicitationInfo = { ...request, id, createdAt: Date.now(), ...(request.sessionId ? { sessionId: this.conversation(request.sessionId) } : {}) };
      const abort = () => settle({ action: "cancel" });
      const settle = (result: ElicitResult) => {
        if (!this.pending.delete(id)) return;
        signal.removeEventListener("abort", abort);
        this.publish();
        resolve(result);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending.set(id, { info, settle });
      this.publish();
    });
  }

  respond(cmd: Respond): boolean {
    const entry = this.pending.get(cmd.elicitationId);
    if (!entry) return false;
    // A URL request only asks for consent; its result never carries content.
    entry.settle(cmd.action === "accept" && entry.info.mode === "form" ? { action: "accept", content: cmd.content ?? {} } : { action: cmd.action });
    return true;
  }

  publish() {
    this.send({ type: "mcp.elicitations", requests: [...this.pending.values()].map((entry) => entry.info) });
  }
}
