import { limitPreviewText, toolFileChanges, TOOL_PREVIEW_TEXT_LIMIT } from "@qone/protocol";
import { getLanguageSetting, resolveLocale, translate, translateCurrent, type Locale } from "../../localization";
import { diffLines, parsePatch, formatPatch } from "diff";
import { commandForTool } from "./tool-action-summary";
import { isCommandTool } from "./tool-activity-category";

export type ToolPresentationKind =
  | "diff"
  | "file"
  | "terminal"
  | "search"
  | "image"
  | "text"
  | "unknown";

export interface ToolFile {
  content: string;
  name?: string;
}

export interface ToolSearchItem {
  path?: string;
  line?: number;
  text: string;
}

export interface ScriptCall { id: string; name: string; args: string; status: "running" | "ok" | "error" | "cancelled"; durationMs?: number; error?: string }

export type ToolPresentation =
  | {
      kind: "diff";
      patch?: string;
      oldFile?: ToolFile;
      newFile?: ToolFile;
      name?: string;
    }
  | {
      kind: "file";
      content: string;
      name?: string;
    }
  | {
      kind: "terminal";
      command?: string;
      output: string;
      stderr?: string;
      exitCode?: number;
      timedOut?: boolean;
      truncated?: boolean;
    }
  | {
      kind: "search";
      query?: string;
      items: ToolSearchItem[];
      text?: string;
    }
  | {
      kind: "image";
      src: string;
      mimeType?: string;
      name?: string;
    }
  | {
      kind: "text";
      text: string;
    }
  | {
      /** Pi codemode: the script, every tool call it made, and its text and image output. */
      kind: "script";
      code: string;
      calls: ScriptCall[];
      output: string;
      images: { src: string; mimeType?: string }[];
    }
  | {
      kind: "unknown";
      text?: string;
      debugJson: string;
    };

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function debugJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return limitPreviewText(json ?? String(value));
  } catch {
    return String(value);
  }
}

/** A string argument of a Pi built-in tool, whose parameter schema is fixed. */
export function toolArg(args: unknown, key: string): string | undefined {
  const value = asRecord(parseJson(args))?.[key];
  return typeof value === "string" && value ? value : undefined;
}

/** Old/new text of Pi's edit tool: `edits: [{ oldText, newText }]`, or the legacy top-level pair. */
export function editDiff(args: unknown): Extract<ToolPresentation, { kind: "diff" }> | undefined {
  const record = asRecord(parseJson(args));
  if (!record) return undefined;
  const edits = (Array.isArray(record.edits) ? record.edits : [record])
    .map(asRecord)
    .filter((edit): edit is RecordValue => typeof edit?.oldText === "string" && typeof edit.newText === "string" && edit.oldText !== edit.newText);
  if (!edits.length) return undefined;
  const name = toolArg(record, "path");
  return {
    kind: "diff",
    oldFile: { content: limitPreviewText(edits.map((edit) => edit.oldText as string).join("\n")), ...(name ? { name } : {}) },
    newFile: { content: limitPreviewText(edits.map((edit) => edit.newText as string).join("\n")), ...(name ? { name } : {}) },
    ...(name ? { name } : {}),
  };
}

/** Content blocks of a tool result (`{ content: [...] }`, as returned by Pi and MCP tools). */
function contentBlocks(result: unknown): RecordValue[] {
  const parsed = parseJson(result);
  const content = Array.isArray(parsed) ? parsed : asRecord(parsed)?.content;
  return Array.isArray(content) ? content.flatMap((block): RecordValue[] => { const record = asRecord(block); return record ? [record] : []; }) : [];
}

function resultText(result: unknown, tail = false): string | undefined {
  const parsed = parseJson(result);
  const text = typeof parsed === "string"
    ? parsed
    : contentBlocks(parsed).flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
  if (!text.trim()) return undefined;
  return tail && text.length > TOOL_PREVIEW_TEXT_LIMIT ? `…${text.slice(-TOOL_PREVIEW_TEXT_LIMIT)}` : limitPreviewText(text);
}

/** Pi image blocks carry raw base64; image views need a data URL. */
function imageFromBlock(block: RecordValue): { src: string; mimeType?: string } | undefined {
  if (block.type !== "image" || typeof block.data !== "string" || !block.data) return undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  const src = block.data.startsWith("data:") ? block.data : `data:${mimeType ?? "image/png"};base64,${block.data}`;
  return { src, ...(mimeType ? { mimeType } : {}) };
}

function resultImage(result: unknown): { src: string; mimeType?: string } | undefined {
  for (const block of contentBlocks(result)) {
    const image = imageFromBlock(block);
    if (image) return image;
  }
  return undefined;
}

/** Pi's grep prints `path:line: text`; only parsed for the grep tool itself. */
function grepItems(text: string): ToolSearchItem[] {
  return text.split(/\r?\n/).map((line) => {
    const match = /^(.*?):(\d+):\s?(.*)$/.exec(line);
    return match
      ? { path: match[1], line: Number(match[2]), text: match[3] ?? "" }
      : { text: line };
  }).filter((item) => item.text.trim().length > 0 || item.path !== undefined);
}

/** Running results arrive as partial updates with the same shape: `{ content, details: { calls } }`. */
function scriptPresentation(result: unknown, args: unknown): Extract<ToolPresentation, { kind: "script" }> {
  const parsed = parseJson(result);
  const calls = asRecord(asRecord(parsed)?.details)?.calls;
  const blocks = contentBlocks(parsed);
  return {
    kind: "script",
    code: toolArg(args, "code") ?? "",
    calls: Array.isArray(calls) ? calls.flatMap((call) => {
      const item = asRecord(call);
      return item && typeof item.name === "string" ? [{
        id: String(item.id ?? item.name), name: item.name, args: typeof item.args === "string" ? item.args : "",
        status: (["running", "ok", "error", "cancelled"].includes(String(item.status)) ? item.status : "running") as ScriptCall["status"],
        ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}),
        ...(typeof item.error === "string" ? { error: item.error } : {}),
      }] : [];
    }) : [],
    output: typeof parsed === "string" ? limitPreviewText(parsed) : limitPreviewText(blocks.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n")),
    images: blocks.flatMap((block) => imageFromBlock(block) ?? []),
  };
}

/**
 * Present a tool result. Pi's built-in tools have fixed arguments and result
 * shapes, so they get dedicated views by name; every other tool (MCP, plugins,
 * subagents) is shown by content block type only. Nothing is inferred from
 * result wording or guessed field names.
 */
export function detectToolPresentation(toolName: string, result: unknown, args?: unknown): ToolPresentation {
  const mutations = toolFileChanges(result);
  if (mutations.length) {
    const change = mutations[0]!;
    return "patch" in change
      ? { kind: "diff", patch: change.patch, name: change.path }
      : { kind: "diff", name: change.path, oldFile: { content: change.oldContent ?? "", name: change.path }, newFile: { content: change.newContent ?? "", name: change.path } };
  }
  if (toolName === "codemode") return scriptPresentation(result, args);
  const commandTool = isCommandTool({ toolName });
  if (toolName.startsWith("server_")) {
    const text = contentBlocks(result).filter(block => block.type === "text").map(block => block.text).join("\n");
    const value = asRecord(parseJson(text));
    if (toolName === "server_exec" && value && ("stdout" in value || "stderr" in value)) {
      return { kind: "terminal", command: toolArg(args, "command"), output: limitPreviewText(String(value.stdout ?? "")), stderr: limitPreviewText(String(value.stderr ?? "")),
        exitCode: typeof value.exit_code === "number" ? value.exit_code : undefined, timedOut: value.timed_out === true, truncated: value.truncated === true };
    }
    if (toolName === "server_read_file" && typeof value?.content === "string") return { kind: "file", name: toolArg(args, "path"), content: limitPreviewText(value.content) };
    if (toolName === "server_terminal" && typeof value?.output === "string") return { kind: "terminal", output: limitPreviewText(value.output) };
    if (typeof value?.error === "string") return { kind: "text", text: value.error };
    if (value) return { kind: "text", text: debugJson(value) };
  }
  const text = resultText(result, commandTool);
  const path = toolArg(args, "path");
  if (commandTool) {
    const command = commandForTool({ toolName, args });
    return { kind: "terminal", ...(command ? { command } : {}), output: text ?? "" };
  }
  switch (toolName) {
    case "write": {
      const content = toolArg(args, "content");
      if (path && content !== undefined) {
        return { kind: "diff", oldFile: { content: "", name: path }, newFile: { content: limitPreviewText(content), name: path }, name: path };
      }
      break;
    }
    case "edit": {
      const patch = asRecord(asRecord(parseJson(result))?.details)?.patch;
      if (typeof patch === "string" && patch.trim()) return { kind: "diff", patch, ...(path ? { name: path } : {}) };
      const diff = args === undefined ? undefined : editDiff(args);
      if (diff) return diff;
      break;
    }
    case "read":
      if (path && text !== undefined) return { kind: "file", content: text, name: path };
      break;
    case "grep": {
      const query = toolArg(args, "pattern");
      if (text !== undefined) return { kind: "search", ...(query ? { query } : {}), items: grepItems(text), text };
      break;
    }
  }
  const image = resultImage(result);
  if (image) return { kind: "image", ...image };
  if (text !== undefined) return { kind: "text", text };
  return { kind: "unknown", debugJson: debugJson(parseJson(result)) };
}

/** Mutation presentations share the same data as the tool's Diff Viewer.
 * A structured fileChanges result works for any tool, including multi-file
 * patch tools. Plain text containing a diff is never mutation evidence.
 */
export function toolMutationPresentations(toolName: string, result: unknown, args?: unknown): Extract<ToolPresentation, { kind: "diff" }>[] {
  const parsed = asRecord(parseJson(result));
  const details = asRecord(parsed?.details);
  if (Array.isArray(details?.fileChanges)) return toolFileChanges(result).map((change) => "patch" in change
    ? { kind: "diff", patch: change.patch, name: change.path }
    : { kind: "diff", name: change.path, oldFile: { content: change.oldContent ?? "", name: change.path }, newFile: { content: change.newContent ?? "", name: change.path } });
  // Compatibility with persisted Pi edits predating snapshot evidence. A
  // legacy write has no old content, so cannot establish an honest baseline.
  if (toolName !== "edit") return [];
  const presentation = detectToolPresentation(toolName, result, args);
  if (presentation.kind !== "diff") return [];
  if (!presentation.patch) return [presentation];
  return splitMutationPatch(presentation);
}

export function splitMutationPatch(presentation: Extract<ToolPresentation, { kind: "diff" }>): Extract<ToolPresentation, { kind: "diff" }>[] {
  if (!presentation.patch) return [presentation];
  try {
    return parsePatch(presentation.patch).map((file) => ({
      kind: "diff", patch: formatPatch(file),
      name: presentation.name ?? (file.newFileName === "/dev/null" ? file.oldFileName : file.newFileName)?.replace(/^[ab]\//, ""),
    }));
  } catch { return []; }
}

/** Use the same ordered line diff as Diff Viewer, not a line multiset. */
export function toolDiffStats(presentation: ToolPresentation): { file: string; added: number; removed: number } | undefined {
  if (presentation.kind !== "diff") return undefined;
  const file = presentation.name ?? translateCurrent("attachment.file");
  let added = 0;
  let removed = 0;
  if (presentation.patch) {
    try {
      for (const patch of parsePatch(presentation.patch)) for (const hunk of patch.hunks) for (const line of hunk.lines) {
        if (line.startsWith("+")) added++;
        else if (line.startsWith("-")) removed++;
      }
    } catch { return undefined; }
  } else {
    for (const change of diffLines(presentation.oldFile?.content ?? "", presentation.newFile?.content ?? "")) {
      if (change.added) added += change.count;
      else if (change.removed) removed += change.count;
    }
  }
  return { file, added, removed };
}

export function toolPresentationSummary(presentation: ToolPresentation, locale: Locale = resolveLocale(getLanguageSetting())): string {
  switch (presentation.kind) {
    case "diff":
      return translate(locale, "tool.fileUpdated", { name: presentation.name ?? translate(locale, "attachment.file") });
    case "file":
      return presentation.content;
    case "terminal":
      return presentation.output;
    case "search":
      return presentation.text ?? presentation.items.map((item) => `${item.path ?? ""}${item.line !== undefined ? `:${item.line}` : ""} ${item.text}`.trim()).join("\n");
    case "image":
      return presentation.name ?? translate(locale, "tool.imageResult");
    case "text":
      return presentation.text;
    case "script":
      return presentation.output || presentation.code;
    case "unknown":
      return presentation.text ?? translate(locale, "tool.debugResult");
  }
}
