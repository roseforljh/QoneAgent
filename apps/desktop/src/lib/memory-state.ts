import { create } from "zustand";
import type { MemoryStateInfo, RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { localizeError } from "./error-localization";

type MemoryCommand = Extract<RuntimeCommand, { type: `memory.${string}` }>;
type MemoryCommandInput = MemoryCommand extends infer C ? C extends MemoryCommand ? Omit<C, "requestId"> : never : never;

export const useMemoryStore = create<{ state?: MemoryStateInfo; pending: number; error?: string }>(() => ({ pending: 0 }));
const requests = new Map<string, (ok: boolean) => void>();

/** Resolves when the runtime answers, so callers only leave an editor after a successful write. */
export function sendMemoryCommand(command: MemoryCommandInput, send: (command: RuntimeCommand) => Promise<boolean>): Promise<boolean> {
  const requestId = crypto.randomUUID();
  useMemoryStore.setState((current) => ({ pending: current.pending + 1, error: undefined }));
  const result = new Promise<boolean>((resolve) => requests.set(requestId, resolve));
  send({ ...command, requestId } as RuntimeCommand).then(
    (sent) => { if (!sent) finish(requestId, "disconnected"); },
    (error) => finish(requestId, localizeError(error)),
  );
  return result;
}

function finish(requestId: string | undefined, error?: string): boolean {
  const resolve = requestId ? requests.get(requestId) : undefined;
  if (!resolve) return false;
  requests.delete(requestId!);
  useMemoryStore.setState((current) => ({ pending: Math.max(0, current.pending - 1), ...(error ? { error } : {}) }));
  resolve(!error);
  return true;
}

/** Pushed after background consolidation too, so the page refreshes without polling. */
export function dispatchMemoryState(message: Extract<RuntimeEvent, { type: "memory.state" }>): void {
  finish(message.requestId);
  useMemoryStore.setState({ state: message.state });
}

export function dispatchMemoryError(requestId: string | undefined, message: string): boolean {
  return finish(requestId, message);
}

export function resetMemoryRequests(): void {
  for (const resolve of requests.values()) resolve(false);
  requests.clear();
  useMemoryStore.setState({ pending: 0, error: undefined });
}
