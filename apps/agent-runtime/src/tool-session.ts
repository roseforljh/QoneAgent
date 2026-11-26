import { AsyncLocalStorage } from "node:async_hooks";

const toolSession = new AsyncLocalStorage<string | undefined>();

/** The conversation whose agent made the current tool call; nested calls (codemode) inherit it. */
export function withToolSession<T>(sessionId: string | undefined, work: () => T): T {
  return toolSession.run(sessionId, work);
}

export function currentToolSession(): string | undefined {
  return toolSession.getStore();
}
