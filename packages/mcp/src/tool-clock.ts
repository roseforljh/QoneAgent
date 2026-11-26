/**
 * Tool-call timeouts that stop counting while the server waits on the person.
 * An elicitation arrives during a tools/call, so the SDK's own timer would
 * expire the call while the question is still on screen. When the answer is
 * sent, the call gets a full timeout again, the same as a progress update.
 * Each call also remembers who made it, so a question can be shown where it
 * was asked.
 */
export class ToolClocks {
  private readonly waiting = new Map<string, number>();
  private readonly clocks = new Map<string, Set<{ restart: () => void; caller?: string }>>();

  constructor(private readonly timeoutMs: number) {}

  /** Starts a clock for one call; returns its stop function. */
  track(serverId: string, onTimeout: () => void, caller?: string): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry = {
      caller,
      restart: () => {
        clearTimeout(timer);
        timer = this.waiting.has(serverId) ? undefined : setTimeout(onTimeout, this.timeoutMs);
      },
    };
    const clocks = this.clocks.get(serverId) ?? new Set();
    this.clocks.set(serverId, clocks.add(entry));
    entry.restart();
    return () => {
      clearTimeout(timer);
      clocks.delete(entry);
      if (!clocks.size) this.clocks.delete(serverId);
    };
  }

  /**
   * Who is waiting on this server. MCP requests carry no caller, so with
   * several open calls the most recent one is taken.
   * ponytail: latest caller wins; pass the call's request id through
   * `relatedRequestId` if concurrent askers on one server ever matter.
   */
  caller(serverId: string): string | undefined {
    return [...this.clocks.get(serverId) ?? []].at(-1)?.caller;
  }

  async whileWaiting<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    this.waiting.set(serverId, (this.waiting.get(serverId) ?? 0) + 1);
    this.restartAll(serverId);
    try {
      return await work();
    } finally {
      const left = this.waiting.get(serverId)! - 1;
      if (left) this.waiting.set(serverId, left);
      else this.waiting.delete(serverId);
      this.restartAll(serverId);
    }
  }

  private restartAll(serverId: string) {
    for (const entry of this.clocks.get(serverId) ?? []) entry.restart();
  }
}
