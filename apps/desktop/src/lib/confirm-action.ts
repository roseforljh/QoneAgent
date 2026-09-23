export interface ConfirmationRequest {
  message: string;
}

type PendingRequest = ConfirmationRequest & { resolve: (confirmed: boolean) => void };

let activeRequest: PendingRequest | null = null;
const queuedRequests: PendingRequest[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** The single confirmation gate for all destructive UI actions. */
export function confirmDestructiveAction(message: string): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const request = { message, resolve };
    if (activeRequest) queuedRequests.push(request);
    else activeRequest = request;
    notify();
  });
}

export function getConfirmationRequest(): ConfirmationRequest | null {
  return activeRequest;
}

export function subscribeConfirmation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resolveConfirmation(confirmed: boolean): void {
  const request = activeRequest;
  if (!request) return;
  activeRequest = queuedRequests.shift() ?? null;
  request.resolve(confirmed);
  notify();
}
