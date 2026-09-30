import { toolFileChanges, type ToolFileChange } from "@qone/protocol";
import { parsePatch } from "diff";
import { detectToolPreview } from "./tool-preview";
import { detectToolPresentation, splitMutationPatch, toolArg, toolMutationPresentations, type ToolPresentation } from "./tool-presentation";

export type FileChangeKind = "created" | "edited" | "deleted";
export interface FileChangeActivity {
  path: string;
  changeKind?: FileChangeKind;
  presentation?: ToolPresentation;
}

/** Null means absence; a write operation alone cannot prove file creation. */
export function fileChangeKind(change: ToolFileChange): FileChangeKind {
  if ("oldContent" in change) return change.oldContent === null ? "created" : change.newContent === null ? "deleted" : "edited";
  try {
    const patch = parsePatch(change.patch)[0];
    return patch?.oldFileName === "/dev/null" ? "created" : patch?.newFileName === "/dev/null" ? "deleted" : "edited";
  } catch { return "edited"; }
}

/** Per-operation entries, independent of completed-run summary ownership. */
export function toolFileActivities(toolName: string, result: unknown, args: unknown, status: string): FileChangeActivity[] {
  const evidence = toolFileChanges(result);
  if (evidence.length) return evidence.flatMap((change) => {
    const presentation = detectToolPresentation(toolName, { details: { fileChanges: [change] } });
    if (presentation.kind !== "diff") return [];
    return splitMutationPatch(presentation).map((item) => ({ path: item.name ?? change.path, changeKind: fileChangeKind(change), presentation: item }));
  });
  if (toolName !== "edit" && toolName !== "write") return [];
  if (status === "success") {
    const changes = toolMutationPresentations(toolName, result, args);
    if (changes.length) return changes.flatMap((presentation) => presentation.name ? [{ path: presentation.name, changeKind: "edited" as const, presentation }] : []);
  }
  const path = toolArg(args, "path");
  if (!path) return [];
  // Arguments are a preview only, never an applied diff after failure or a
  // fabricated baseline for a legacy write that has already completed.
  return [{ path, presentation: status === "failed" || status === "success" ? undefined : detectToolPreview(toolName, args) }];
}
