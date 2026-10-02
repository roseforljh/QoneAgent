import type { AgentEvent } from "@qone/protocol";

/** Update once per assistant message boundary, never once per streamed token or tool event. */
export function isAssistantMessageActivity(event: Pick<AgentEvent, "type" | "payload">): boolean {
  if (event.type !== "message.started" && event.type !== "message.completed") return false;
  const payload = event.payload as { message?: { role?: unknown } } | null | undefined;
  return payload?.message?.role === "assistant";
}
