/** Longest text a tool preview shows; streamed argument snapshots never carry more. */
export const TOOL_PREVIEW_TEXT_LIMIT = 20_000;

export function limitPreviewText(value: string): string {
  return value.length > TOOL_PREVIEW_TEXT_LIMIT ? `${value.slice(0, TOOL_PREVIEW_TEXT_LIMIT)}…` : value;
}

/**
 * Caps every string inside streamed tool arguments. A model writing a large
 * file would otherwise resend the whole growing content ~30 times a second;
 * the final arguments still arrive uncut when the block completes.
 */
export function limitPreviewStrings(value: unknown): unknown {
  if (typeof value === "string") return limitPreviewText(value);
  if (Array.isArray(value)) return value.map(limitPreviewStrings);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, limitPreviewStrings(item)]));
  }
  return value;
}
