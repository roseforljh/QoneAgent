import type { AssistantMessagePart, RuntimeEvent, SubagentRunInfo, SubagentRunPatch } from "@qone/protocol";

type ReasoningDelta = NonNullable<Extract<RuntimeEvent, { type: "subagent.streaming" }>["reasoning"]>[number];

/** Full snapshots mark state boundaries; text between them is sent once as deltas. */
export function createSubagentPublisher(options: {
  load: (id: string) => SubagentRunInfo | undefined;
  send: (event: RuntimeEvent) => void;
  intervalMs: number;
}) {
  const sessions = new Map<string, string>();
  const knownParts = new Map<string, readonly AssistantMessagePart[]>();
  const pending = new Map<string, {
    chunks: string[];
    reasoning: Map<string, { value: ReasoningDelta; chunks: string[] }>;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const clear = (id: string) => {
    const buffer = pending.get(id);
    if (buffer) clearTimeout(buffer.timer);
    pending.delete(id);
  };
  const bufferFor = (id: string) => {
    const sessionId = sessions.get(id);
    if (!sessionId) return undefined;
    let buffer = pending.get(id);
    if (!buffer) {
      buffer = { chunks: [], reasoning: new Map(), timer: setTimeout(() => {
        const current = pending.get(id);
        pending.delete(id);
        if (!current) return;
        const reasoning = [...current.reasoning.values()].map(({ value, chunks }) => ({ ...value, delta: chunks.join("") }));
        options.send({ type: "subagent.streaming", sessionId, id, delta: current.chunks.join(""),
          ...(reasoning.length ? { reasoning } : {}) });
      }, options.intervalMs) };
      pending.set(id, buffer);
    }
    return buffer;
  };
  return {
    publish(id: string) {
      // The snapshot already includes buffered text, so it supersedes unsent deltas.
      clear(id);
      const subagent = options.load(id);
      if (subagent && ["created", "running", "waiting_approval", "paused"].includes(subagent.status)) sessions.set(id, subagent.parentSessionId);
      else sessions.delete(id);
      if (subagent) knownParts.set(id, subagent.parts);
      if (subagent) options.send({ type: "subagent.updated", subagent });
    },
    append(id: string, delta: string) {
      if (delta) bufferFor(id)?.chunks.push(delta);
    },
    appendReasoning(id: string, value: ReasoningDelta) {
      if (!value.delta && !value.complete) return;
      const buffer = bufferFor(id);
      if (!buffer) return;
      const key = `${value.messageSequence}:${value.contentIndex ?? ""}`;
      const current = buffer.reasoning.get(key);
      if (current) {
        current.chunks.push(value.delta);
        if (value.complete) current.value = { ...current.value, complete: true };
      } else buffer.reasoning.set(key, { value, chunks: [value.delta] });
    },
    patch(id: string, patch: Omit<SubagentRunPatch, "id"> & { parts?: AssistantMessagePart[] }) {
      const sessionId = sessions.get(id);
      if (sessionId) {
        // A patch contains the authoritative boundary for the buffered text.
        // Do not let an older timer fire after a completion/tool update.
        clear(id);
        const { parts, ...fields } = patch;
        const previous = knownParts.get(id) ?? [];
        const start = parts?.findIndex((part, index) => previous[index] !== part) ?? -1;
        if (parts) knownParts.set(id, parts);
        options.send({ type: "subagent.patch", sessionId, id, patch: {
          id, ...fields,
          ...(start >= 0 ? { partsPatch: { start, parts: parts!.slice(start) } } : {}),
        } });
      }
    },
    dispose() {
      for (const id of pending.keys()) clear(id);
      sessions.clear();
      knownParts.clear();
    },
  };
}
