import type { ToolCall } from "../../store";

type ToolPart = {
  result?: unknown;
  isError?: boolean;
  status?: { type: string };
};

export function toolCallStatus(part: ToolPart, call?: Pick<ToolCall, "status">): ToolCall["status"] {
  if (call) return call.status;
  if (part.isError || part.status?.type === "incomplete") return "failed";
  if (part.status?.type === "requires-action") return "waiting";
  return part.result !== undefined ? "success" : "running";
}

export function formatToolPayload(value: unknown): string {
  if (value === undefined) return "";
  let formatted: string;
  if (typeof value === "string") {
    try { formatted = JSON.stringify(JSON.parse(value), null, 2); }
    catch { formatted = value; }
  } else {
    try { formatted = JSON.stringify(value, null, 2) ?? String(value); }
    catch { formatted = String(value); }
  }
  return formatted.length > 20_000 ? `${formatted.slice(0, 20_000)}…` : formatted;
}
