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

/** Preserve complete JSON results for reloads; presentation can bound its own preview. */
export function persistedToolResult(value: unknown): unknown {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value) === undefined ? "" : value;
  } catch { return String(value); }
}
