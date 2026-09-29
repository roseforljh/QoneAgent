export function splitModelName(name: string): [string, string] {
  const slash = name.indexOf("/");
  const colon = name.indexOf(":");
  const cut = slash < 0 ? colon : colon < 0 ? slash : Math.min(slash, colon);
  return cut < 0 ? [name, ""] : [name.slice(0, cut), name.slice(cut + 1)];
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { content?: unknown; message?: unknown; text?: unknown };
  if (typeof record.text === "string") return record.text;
  if (record.message && record.message !== value) return extractTextContent(record.message);
  if (!Array.isArray(record.content)) return "";
  return record.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}
