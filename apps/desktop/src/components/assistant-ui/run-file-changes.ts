import { toolFileChanges } from "@qone/protocol";
import { applyPatch, parsePatch } from "diff";
import type { ChatMessage, ToolCall } from "../../store";
import { splitMutationPatch, toolDiffStats, toolMutationPresentations, type ToolPresentation } from "./tool-presentation";

type DiffPresentation = Extract<ToolPresentation, { kind: "diff" }>;
/** Flat file nodes mirror assistant-ui File Tree's path/name/count contract. */
export interface RunFileNode {
  path: string;
  name: string;
  depth: 0;
  kind: "file";
  changeKind: "created" | "edited" | "deleted";
  additions: number;
  deletions: number;
  presentations: DiffPresentation[];
}
export interface RunFileChanges {
  nodes: RunFileNode[];
  totalAdditions: number;
  totalDeletions: number;
}

function pathKey(value: string) {
  const path = value.replaceAll("\\", "/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === ".") continue;
    if (segment === ".." && segments.length && segments.at(-1) !== "..") segments.pop();
    else segments.push(segment);
  }
  const normalized = segments.join("/");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

/** Derive, never accumulate, from the existing run-bound tool results. */
export function collectRunFileChanges(runId: string, calls: readonly ToolCall[], messages: readonly ChatMessage[]): RunFileChanges {
  const byId = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.runId !== runId || message.role !== "assistant") continue;
    for (const part of message.parts ?? []) {
      if (part.type !== "tool-call") continue;
      byId.set(part.toolCallId, { toolCallId: part.toolCallId, runId, toolName: part.toolName, args: part.args, result: part.result, status: part.isError ? "failed" : part.result === undefined ? "running" : "success" });
    }
  }
  for (const call of calls) {
    if (call.runId !== runId) continue;
    const saved = byId.get(call.toolCallId);
    // Old ToolCallRepo summaries may be truncated JSON; the saved parts may
    // still hold complete evidence. Do not replace it with a lossy summary.
    byId.set(call.toolCallId, saved && toolFileChanges(saved.result).length && !toolFileChanges(call.result).length
      ? { ...call, result: saved.result } : { ...saved, ...call, result: call.result ?? saved?.result });
  }
  return collectToolFileChanges([...byId.values()]);
}

/** The same net change calculation also serves a bounded activity group. */
export function collectToolFileChanges(calls: readonly Pick<ToolCall, "toolName" | "result" | "args" | "status">[]): RunFileChanges {
  type Accumulated = { path: string; snapshots: boolean; oldContent?: string; newContent?: string; presentations: DiffPresentation[]; existed?: boolean; exists?: boolean; patchKind?: RunFileNode["changeKind"] };
  const files = new Map<string, Accumulated>();
  for (const call of calls) {
    const evidence = toolFileChanges(call.result);
    if (call.status !== "success" && !(call.status === "failed" && evidence.length)) continue;
    const presentations = toolMutationPresentations(call.toolName, call.result, call.args);
    for (const [index, source] of presentations.entries()) {
      const snapshot = evidence[index];
      for (const presentation of splitMutationPatch(source)) {
        if (!presentation.name) continue;
        const key = pathKey(presentation.name);
        let file = files.get(key);
        const isSnapshot = snapshot && "oldContent" in snapshot;
        if (!file) {
          const patchFile = presentation.patch ? parsePatch(presentation.patch)[0] : undefined;
          file = { path: presentation.name, snapshots: Boolean(isSnapshot), oldContent: isSnapshot ? snapshot.oldContent ?? "" : undefined,
            existed: isSnapshot ? snapshot.oldContent !== null : undefined,
            patchKind: patchFile?.oldFileName === "/dev/null" ? "created" : patchFile?.newFileName === "/dev/null" ? "deleted" : "edited", presentations: [] };
          files.set(key, file);
        }
        if (isSnapshot && file.snapshots) {
          file.newContent = snapshot.newContent ?? "";
          file.exists = snapshot.newContent !== null;
          file.presentations = [{ kind: "diff", name: file.path, oldFile: { name: file.path, content: file.oldContent! }, newFile: { name: file.path, content: file.newContent } }];
        } else if (file.snapshots && presentation.patch && file.newContent !== undefined) {
          const next = applyPatch(file.newContent, presentation.patch);
          if (next !== false) {
            file.newContent = next;
            file.presentations = [{ kind: "diff", name: file.path, oldFile: { name: file.path, content: file.oldContent! }, newFile: { name: file.path, content: next } }];
          } else { file.snapshots = false; file.presentations.push(presentation); }
        } else {
          // Older partial edits/patch-only producers have no complete baseline.
          // Preserve each actual delta for the viewer, never fabricate a file.
          file.snapshots = false;
          file.presentations.push(presentation);
        }
      }
    }
  }
  const nodes: RunFileNode[] = [];
  for (const file of files.values()) {
    if (file.snapshots && file.oldContent === file.newContent && file.existed === file.exists) continue;
    let additions = 0;
    let deletions = 0;
    for (const presentation of file.presentations) {
      const stats = toolDiffStats(presentation);
      additions += stats?.added ?? 0;
      deletions += stats?.removed ?? 0;
    }
    if (!file.snapshots && !additions && !deletions) continue;
    const changeKind = file.snapshots
      ? !file.existed && file.exists ? "created" : file.existed && !file.exists ? "deleted" : "edited"
      : file.patchKind ?? "edited";
    nodes.push({ path: file.path, name: file.path.replaceAll("\\", "/").split("/").at(-1) || file.path, depth: 0, kind: "file", changeKind, additions, deletions, presentations: file.presentations });
  }
  return { nodes, totalAdditions: nodes.reduce((sum, file) => sum + file.additions, 0), totalDeletions: nodes.reduce((sum, file) => sum + file.deletions, 0) };
}

export function isRunSummaryOwner(messageId: string, runId: string | undefined, messages: readonly ChatMessage[], status: string | undefined, activeRunId?: string): boolean {
  if (!runId || messageId === "streaming" || activeRunId === runId || status !== "completed") return false;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.runId === runId) return message.id === messageId;
  }
  return false;
}
