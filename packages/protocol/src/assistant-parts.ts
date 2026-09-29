/** Visible Pi assistant content, in event and content-block order. */
export type AssistantMessagePart =
  | { type: "text"; text: string; messageSequence: number }
  | { type: "reasoning"; text: string; messageSequence: number; contentIndex?: number; complete?: boolean }
  | { type: "image"; image: string; filename?: string; messageSequence: number }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: unknown;
      messageSequence: number;
      result?: unknown;
      isError?: boolean;
    };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function assistantPartsFromPiMessage(payload: unknown, messageSequence: number): AssistantMessagePart[] {
  const message = asRecord(asRecord(payload)?.message);
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];

  return message.content.flatMap((value: unknown, index: number): AssistantMessagePart[] => {
    const block = asRecord(value);
    if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
      return [{ type: "reasoning", text: block.thinking, messageSequence, contentIndex: index, complete: true }];
    }
    if (block?.type === "text" && typeof block.text === "string" && block.text) {
      return [{ type: "text", text: block.text, messageSequence }];
    }
    if (block?.type === "image" && typeof block.image === "string" && block.image) {
      return [{ type: "image", image: block.image, filename: typeof block.filename === "string" ? block.filename : undefined, messageSequence }];
    }
    if (block?.type === "toolCall") {
      return [{
        type: "tool-call",
        toolCallId: typeof block.id === "string" && block.id ? block.id : `pi-${messageSequence}-${index}`,
        toolName: typeof block.name === "string" ? block.name : "tool",
        args: block.arguments ?? {},
        messageSequence,
      }];
    }
    return [];
  });
}

/** Keep provider reasoning separate from answer text, including interrupted turns. */
export function applyReasoningDelta(parts: readonly AssistantMessagePart[], payload: unknown, messageSequence: number): AssistantMessagePart[] {
  const event = asRecord(payload);
  if (!event || (event.complete !== true && (typeof event.delta !== "string" || !event.delta))) return [...parts];
  const delta = typeof event.delta === "string" ? event.delta : "";
  const contentIndex = typeof event.contentIndex === "number" ? event.contentIndex : undefined;
  const index = parts.findIndex((part) => part.type === "reasoning" && part.messageSequence === messageSequence && part.contentIndex === contentIndex);
  if (index < 0) return delta ? [...parts, { type: "reasoning", text: delta, messageSequence, contentIndex }] : [...parts];
  return parts.map((part, i) => i === index && part.type === "reasoning" ? { ...part, text: part.text + delta, ...(event.complete === true ? { complete: true } : {}) } : part);
}

// Match the existing persisted tool-result limit so live and reloaded parts agree.
function displayToolResult(value: unknown): unknown {
  if (value === undefined) return "";
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return "";
    return serialized.length > 20_000 ? serialized.slice(0, 20_000) : value;
  } catch {
    return String(value);
  }
}

export function applyAssistantToolEvent(
  parts: readonly AssistantMessagePart[],
  type: "tool.started" | "tool.completed" | "tool.failed",
  payload: unknown,
): AssistantMessagePart[] {
  const event = asRecord(payload);
  if (typeof event?.toolCallId !== "string") return [...parts];
  return parts.map((part) => {
    if (part.type !== "tool-call" || part.toolCallId !== event.toolCallId) return part;
    if (type === "tool.started") return {
      ...part,
      toolName: typeof event.toolName === "string" ? event.toolName : part.toolName,
      args: event.args ?? event.input ?? part.args,
    };
    return {
      ...part,
      result: displayToolResult(event.result ?? event.content),
      isError: type === "tool.failed" || event.isError === true,
    };
  });
}
