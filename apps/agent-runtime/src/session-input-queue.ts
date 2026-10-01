/** Serialize preparation and delivery together so attachment work cannot
 * reorder two inputs intended for the same live run. */
export class SessionInputQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.tails.get(sessionId) ?? Promise.resolve()).then(operation);
    const tail = result.then(() => {}, () => {});
    this.tails.set(sessionId, tail);
    void tail.then(() => { if (this.tails.get(sessionId) === tail) this.tails.delete(sessionId); });
    return result;
  }
}
