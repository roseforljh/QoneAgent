import type { ThreadAssistantMessagePart, ThreadMessageLike } from "@assistant-ui/react";
import type { AssistantMessagePart } from "@qone/protocol";
import type { ToolCall } from "../store";

type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
type JsonObject = { readonly [key: string]: JsonValue };

function asJsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? {}) ?? "{}"; } catch { return "{}"; }
}

function orderedPart(part: AssistantMessagePart, parentId: string): ThreadAssistantMessagePart {
  if (part.type === "text") return { type: "text", text: part.text, parentId };
  return {
    type: "tool-call",
    toolCallId: part.toolCallId,
    toolName: part.toolName,
    args: asJsonObject(part.args),
    argsText: stringifyToolValue(part.args),
    ...(part.result !== undefined ? { result: part.result } : {}),
    ...(part.isError ? { isError: true } : {}),
    parentId,
  };
}

export function assistantMessageContent(
  message: { content: string; parts?: AssistantMessagePart[] },
  legacyCalls: readonly ToolCall[],
  streaming: boolean,
): ThreadMessageLike["content"] {
  const parts = message.parts;
  if (parts) {
    let toolGroupStart = -1;
    const content: ThreadAssistantMessagePart[] = parts.map((part, index) => {
      const previous = parts[index - 1];
      if (part.type === "tool-call" && (previous?.type !== "tool-call" || previous.messageSequence !== part.messageSequence)) {
        toolGroupStart = index;
      }
      const parentId = part.type === "tool-call"
        ? `pi:${part.messageSequence}:tools:${toolGroupStart}`
        : `pi:${part.messageSequence}`;
      return orderedPart(part, parentId);
    });
    if (streaming && message.content) content.push({ type: "text", text: message.content, parentId: "pi:pending" });
    if (!streaming && content.length === 0 && message.content) content.push({ type: "text", text: message.content });
    return content;
  }

  // Rows created before ordered parts existed retain their final text and tool list.
  return [
    ...legacyCalls.map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      args: asJsonObject(call.args),
      argsText: call.argsText ?? stringifyToolValue(call.args),
      ...(call.status === "success" || call.status === "failed" ? { result: call.result ?? call.summary ?? "" } : {}),
      ...(call.status === "failed" ? { isError: true } : {}),
    })),
    ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
  ];
}
