import type { AssistantMessagePart, RuntimeEvent, SubagentRunInfo, SubagentRunPatch } from "@qone/protocol";
import { applyReasoningDelta } from "@qone/protocol";

type ReasoningDelta = NonNullable<Extract<RuntimeEvent, { type: "subagent.streaming" }>["reasoning"]>[number];

/** Full snapshots mark state boundaries; text between them is sent once as deltas. */
export function createSubagentPublisher(options: {
  load: (id: string) => SubagentRunInfo | undefined;
  send: (event: RuntimeEvent) => void;
  intervalMs: number;
  schedule?: (callback: () => void, delay: number) => () => void;
  epoch?: string;
}) {
  const revisionEpoch = options.epoch ?? crypto.randomUUID();
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  });
  const isActive = (status: SubagentRunInfo["status"]) => status === "created" || status === "running"
    || status === "waiting_approval" || status === "paused";
  const sessions = new Map<string, string>();
  const revisions = new Map<string, number>();
  const nextRevision = (id: string) => {
    const revision = (revisions.get(id) ?? 0) + 1;
    revisions.set(id, revision);
    return revision;
  };
  const knownParts = new Map<string, readonly AssistantMessagePart[]>();
  const pending = new Map<string, {
    chunks: string[];
    reasoning: Map<string, { value: ReasoningDelta; chunks: string[] }>;
    parts?: () => AssistantMessagePart[];
    cancel: () => void;
  }>();
  const clear = (id: string) => {
    const buffer = pending.get(id);
    buffer?.cancel();
    pending.delete(id);
  };
  const flush = (id: string, superseded: { text?: boolean; reasoning?: boolean } = {}) => {
    const buffer = pending.get(id);
    const sessionId = sessions.get(id);
    if (!buffer || !sessionId) return;
    clear(id);
    const delta = superseded.text ? "" : buffer.chunks.join("");
    const reasoning = superseded.reasoning ? [] : [...buffer.reasoning.values()]
      .map(({ value, chunks }) => ({ ...value, delta: chunks.join("") }));
    let parts = knownParts.get(id) ?? [];
    for (const value of reasoning) parts = applyReasoningDelta(parts, value, value.messageSequence);
    knownParts.set(id, parts);
    if (delta || reasoning.length) options.send({ type: "subagent.streaming", sessionId, id, revisionEpoch, revision: nextRevision(id), delta, ...(reasoning.length ? { reasoning } : {}) });
    if (buffer.parts && !superseded.reasoning) {
      const current = buffer.parts();
      const updates = current.flatMap((part, index) => parts[index] !== part ? [{ index, part }] : []);
      if (updates.length || current.length !== parts.length) {
        knownParts.set(id, current);
        options.send({ type: "subagent.patch", sessionId, id, patch: { id, revisionEpoch, revision: nextRevision(id), partsChanges: { length: current.length, updates } } });
      }
    }
  };
  const bufferFor = (id: string) => {
    const sessionId = sessions.get(id);
    if (!sessionId) return undefined;
    let buffer = pending.get(id);
    if (!buffer) {
      buffer = { chunks: [], reasoning: new Map(), cancel: schedule(() => flush(id), options.intervalMs) };
      pending.set(id, buffer);
    }
    return buffer;
  };
  return {
    snapshot(subagent: SubagentRunInfo) {
      clear(subagent.id);
      if (sessions.has(subagent.id)) knownParts.set(subagent.id, subagent.parts);
      return { ...subagent, revisionEpoch, revision: nextRevision(subagent.id) };
    },
    publish(id: string) {
      // The snapshot already includes buffered text, so it supersedes unsent deltas.
      clear(id);
      const subagent = options.load(id);
      if (subagent && isActive(subagent.status)) {
        sessions.set(id, subagent.parentSessionId);
        knownParts.set(id, subagent.parts);
      } else {
        sessions.delete(id);
        knownParts.delete(id);
      }
      if (subagent) options.send({ type: "subagent.updated", subagent: { ...subagent, revisionEpoch, revision: nextRevision(id) } });
    },
    append(id: string, delta: string) {
      if (delta) bufferFor(id)?.chunks.push(delta);
    },
    queueParts(id: string, read: () => AssistantMessagePart[]) {
      const buffer = bufferFor(id);
      if (buffer) buffer.parts = read;
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
        const { parts, ...fields } = patch;
        flush(id, { text: fields.streaming !== undefined, reasoning: parts !== undefined || fields.partsPatch !== undefined });
        const previous = knownParts.get(id) ?? [];
        const updates = parts?.flatMap((part, index) => previous[index] !== part ? [{ index, part }] : []);
        if (parts) knownParts.set(id, parts);
        options.send({ type: "subagent.patch", sessionId, id, patch: {
          id, ...fields, revisionEpoch, revision: nextRevision(id),
          ...(parts && (updates!.length || parts.length !== previous.length) ? { partsChanges: { length: parts.length, updates: updates! } } : {}),
        } });
        if (fields.status && !isActive(fields.status)) {
          sessions.delete(id);
          knownParts.delete(id);
        }
      }
    },
    dispose() {
      for (const id of pending.keys()) clear(id);
      sessions.clear();
      knownParts.clear();
    },
  };
}
