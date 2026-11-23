/** File mutation evidence carried by the existing tool-result/diff pipeline.
 * Custom tools may publish this contract in details.fileChanges; read-only
 * diff output must not publish mutation evidence.
 */
export type ToolFileChange =
  | { path: string; oldContent: string | null; newContent: string | null }
  | { path: string; patch: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function toolFileChanges(result: unknown): ToolFileChange[] {
  if (typeof result === "string") {
    try { result = JSON.parse(result); } catch { return []; }
  }
  const changes = record(record(result)?.details)?.fileChanges;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((value): ToolFileChange[] => {
    const change = record(value);
    if (!change || typeof change.path !== "string" || !change.path.trim()) return [];
    if ((typeof change.oldContent === "string" || change.oldContent === null) &&
        (typeof change.newContent === "string" || change.newContent === null)) {
      return [{ path: change.path, oldContent: change.oldContent, newContent: change.newContent }];
    }
    return typeof change.patch === "string" && change.patch.trim() ? [{ path: change.path, patch: change.patch }] : [];
  });
}

const DEFAULT_MAX_PERSISTED_TEXT = 32_768;

function truncatePersistedText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const omitted = text.length - limit;
  const marker = `\n...[truncated ${omitted} chars]...\n`;
  if (limit <= marker.length + 16) return text.slice(0, limit);
  const budget = limit - marker.length;
  const head = Math.ceil(budget * 0.65);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

function boundPersistedValue(value: unknown, limit: number, preserveKey = false): unknown {
  if (typeof value === "string") return preserveKey ? value : truncatePersistedText(value, limit);
  if (Array.isArray(value)) return value.map((item) => boundPersistedValue(item, limit, preserveKey));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // 保留 fileChanges 完整 diff，仅截断其余超大工具文本输出；不影响模型上下文 raw_message。
    out[key] = boundPersistedValue(entry, limit, preserveKey || key === "fileChanges");
  }
  return out;
}

/** Preserve structured fields (e.g. fileChanges) while bounding oversized tool text; idempotent. */
export function persistedToolResult(value: unknown, maxTextChars = DEFAULT_MAX_PERSISTED_TEXT): unknown {
  if (value === undefined) return "";
  try {
    const bounded = boundPersistedValue(value, maxTextChars);
    return JSON.stringify(bounded) === undefined ? "" : bounded;
  } catch { return truncatePersistedText(String(value), maxTextChars); }
}
