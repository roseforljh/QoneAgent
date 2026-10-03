import { applyAssistantToolEvent, applyReasoningDelta, assistantPartsFromPiMessage, type AgentEvent, type AssistantMessagePart } from "@qone/protocol";

export interface LiveAssistantState {
  content: string;
  parts: AssistantMessagePart[];
  messageSequence?: number;
  sequence: number;
}

function payloadOf(event: AgentEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function toolCallId(payload: Record<string, unknown>, messageSequence: number | undefined, parts: readonly AssistantMessagePart[]): string {
  if (typeof payload.toolCallId === "string" && payload.toolCallId) return payload.toolCallId;
  if (messageSequence !== undefined && typeof payload.contentIndex === "number") return `pi-${messageSequence}-${payload.contentIndex}`;
  return `pi-${messageSequence ?? "pending"}-${parts.length}`;
}

function toolPart(payload: Record<string, unknown>, messageSequence: number, parts: readonly AssistantMessagePart[]): AssistantMessagePart {
  return {
    type: "tool-call",
    toolCallId: toolCallId(payload, messageSequence, parts),
    toolName: String(payload.toolName ?? "tool"),
    args: payload.args ?? payload.input ?? {},
    messageSequence,
  };
}

/** Rebuild the transient assistant segment after the renderer reconnects. */
export function updateLiveAssistant(state: LiveAssistantState, event: AgentEvent): LiveAssistantState {
  const payload = payloadOf(event);
  const assistantMessage = payload.message && typeof payload.message === "object" && !Array.isArray(payload.message)
    ? payload.message as Record<string, unknown>
    : undefined;
  const isAssistantMessage = assistantMessage?.role === "assistant";

  if (event.type === "message.started" && isAssistantMessage) {
    return { ...state, content: "", messageSequence: event.sequence, sequence: event.sequence };
  }

  const messageSequence = state.messageSequence ?? event.sequence;
  if (event.type === "message.block.started") {
    const priorText: AssistantMessagePart[] = state.content
      ? [{ type: "text", text: state.content, messageSequence, phase: "commentary" }]
      : [];
    const nextParts = payload.blockType === "tool-call"
      ? [...state.parts, ...priorText, toolPart(payload, messageSequence, state.parts)]
      : [...state.parts, ...priorText];
    return { ...state, content: "", parts: nextParts, sequence: event.sequence };
  }

  if ((event.type === "message.block.completed" || event.type === "message.delta") && payload.blockType === "tool-call") {
    return { ...state, parts: applyAssistantToolEvent(state.parts, "tool.started", { ...payload, toolCallId: toolCallId(payload, messageSequence, state.parts) }), sequence: event.sequence };
  }

  if (event.type === "message.block.completed" && payload.blockType === "reasoning") {
    return { ...state, parts: applyReasoningDelta(state.parts, { ...payload, complete: true }, messageSequence), sequence: event.sequence };
  }

  if (event.type === "message.reasoning.delta") {
    return { ...state, parts: applyReasoningDelta(state.parts, payload, messageSequence), sequence: event.sequence };
  }

  if (event.type === "message.delta" && typeof payload.delta === "string") {
    return { ...state, content: state.content + payload.delta, sequence: event.sequence };
  }

  if (event.type === "message.completed" && isAssistantMessage) {
    const completedParts = assistantPartsFromPiMessage(payload, messageSequence);
    return {
      content: "",
      messageSequence: undefined,
      parts: [...state.parts.filter((part) => part.messageSequence !== messageSequence), ...completedParts],
      sequence: event.sequence,
    };
  }

  if (event.type === "tool.started") {
    const id = toolCallId(payload, messageSequence, state.parts);
    const hasPart = state.parts.some((part) => part.type === "tool-call" && part.toolCallId === id);
    const parts: AssistantMessagePart[] = hasPart ? state.parts : [...state.parts, ...(state.content ? [{ type: "text" as const, text: state.content, messageSequence, phase: "commentary" as const }] : []), toolPart(payload, messageSequence, state.parts)];
    return { ...state, content: hasPart ? state.content : "", parts: applyAssistantToolEvent(parts, "tool.started", { ...payload, toolCallId: id }), sequence: event.sequence };
  }

  if (event.type === "tool.completed" || event.type === "tool.failed") {
    return { ...state, parts: applyAssistantToolEvent(state.parts, event.type, payload), sequence: event.sequence };
  }

  return { ...state, sequence: event.sequence };
}
