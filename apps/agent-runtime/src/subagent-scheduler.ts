/** FIFO permits. A parent awaiting descendants yields its permit to avoid nesting deadlocks. */
export class SubagentScheduler {
  private owners = new Set<string>();
  private queue: { id: string; signal: AbortSignal; resolve: () => void; reject: (error: unknown) => void; abort: () => void }[] = [];
  constructor(private limit: () => number) {}

  get activeCount(): number {
    return this.owners.size;
  }

  tryAcquire(id: string): boolean {
    if (this.owners.has(id)) return true;
    if (this.owners.size >= this.limit() || this.queue.length) return false;
    this.owners.add(id);
    return true;
  }

  acquire(id: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.owners.has(id)) return Promise.resolve();
    if (this.owners.size < this.limit() && !this.queue.length) {
      this.owners.add(id);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const item = { id, signal, resolve, reject, abort: () => {
        this.queue = this.queue.filter((queued) => queued !== item);
        reject(signal.reason);
      } };
      signal.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item);
    });
  }

  release(id: string): boolean {
    const owned = this.owners.delete(id);
    while (this.owners.size < this.limit() && this.queue.length) {
      const item = this.queue.shift()!;
      item.signal.removeEventListener("abort", item.abort);
      if (item.signal.aborted) { item.reject(item.signal.reason); continue; }
      this.owners.add(item.id);
      item.resolve();
    }
    return owned;
  }
}
