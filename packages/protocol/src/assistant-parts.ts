/** Visible Pi assistant content, in event and content-block order. */
export type AssistantMessagePart =
  | { type: "text"; text: string; messageSequence: number }
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
    if (block?.type === "text" && typeof block.text === "string" && block.text) {
      return [{ type: "text", text: block.text, messageSequence }];
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
