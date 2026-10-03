import { encode, type RuntimeEvent } from "@qone/protocol";

type StreamEvent = Extract<RuntimeEvent, { type: "agent.event" }>;

function canMerge(previous: StreamEvent, next: StreamEvent) {
  const a = previous.event, b = next.event;
  if (a.type !== b.type || a.sessionId !== b.sessionId || a.runId !== b.runId || a.scope !== b.scope) return false;
  const before = a.payload as Record<string, unknown>, after = b.payload as Record<string, unknown>;
  return typeof before?.delta === "string" && typeof after?.delta === "string"
    && Object.keys(before).every((key) => key === "delta" || before[key] === after[key])
    && Object.keys(after).every((key) => key === "delta" || before[key] === after[key]);
}

export function createRuntimeOutput(options: {
  write: (line: string) => void;
  intervalMs: number;
  maxEvents: number;
  schedule?: (callback: () => void, delay: number) => () => void;
}) {
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  });
  let pending: { message: StreamEvent; chunks: string[] }[] = [];
  let cancel: (() => void) | undefined;
  const flush = () => {
    cancel?.(); cancel = undefined;
    if (!pending.length) return;
    const batch = pending.map(({ message, chunks }) => chunks.length === 1 ? message
      : { ...message, event: { ...message.event, payload: { ...(message.event.payload as object), delta: chunks.join("") } } });
    pending = [];
    options.write(encode(batch));
  };
  return {
    flush,
    sendBatch(messages: RuntimeEvent[]) {
      flush();
      if (messages.length) options.write(encode(messages));
    },
    send(message: RuntimeEvent) {
      if (message.type !== "agent.event" || (message.event.type !== "message.delta" && message.event.type !== "message.reasoning.delta")) {
        flush(); options.write(encode(message)); return;
      }
      const last = pending.at(-1);
      if (last && canMerge(last.message, message)) {
        last.chunks.push((message.event.payload as { delta: string }).delta);
        last.message = message;
      } else pending.push({ message, chunks: [(message.event.payload as { delta?: string }).delta ?? ""] });
      if (pending.length >= options.maxEvents) flush();
      else if (!cancel) cancel = schedule(flush, options.intervalMs);
    },
  };
}
