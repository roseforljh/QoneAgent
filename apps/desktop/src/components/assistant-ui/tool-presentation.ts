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
      kind: "unknown";
      text?: string;
      debugJson: string;
    };

type RecordValue = Record<string, unknown>;

const MAX_TEXT_LENGTH = 20_000;

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

function limitText(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;
}

function debugJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return limitText(json ?? String(value));
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
    oldFile: { content: limitText(edits.map((edit) => edit.oldText as string).join("\n")), ...(name ? { name } : {}) },
    newFile: { content: limitText(edits.map((edit) => edit.newText as string).join("\n")), ...(name ? { name } : {}) },
    ...(name ? { name } : {}),
  };
}

/** Content blocks of a tool result (`{ content: [...] }`, as returned by Pi and MCP tools). */
function contentBlocks(result: unknown): RecordValue[] {
  const parsed = parseJson(result);
  const content = Array.isArray(parsed) ? parsed : asRecord(parsed)?.content;
  return Array.isArray(content) ? content.flatMap((block): RecordValue[] => { const record = asRecord(block); return record ? [record] : []; }) : [];
}

function resultText(result: unknown): string | undefined {
  const parsed = parseJson(result);
  const text = typeof parsed === "string"
    ? parsed
    : contentBlocks(parsed).flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("\n");
  return text.trim() ? limitText(text) : undefined;
}

function resultImage(result: unknown): { src: string; mimeType?: string } | undefined {
  const block = contentBlocks(result).find((item) => item.type === "image" && typeof item.data === "string" && item.data);
  if (!block) return undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  return { src: block.data as string, ...(mimeType ? { mimeType } : {}) };
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

/**
 * Present a tool result. Pi's built-in tools have fixed arguments and result
 * shapes, so they get dedicated views by name; every other tool (MCP, plugins,
 * subagents) is shown by content block type only. Nothing is inferred from
 * result wording or guessed field names.
 */
export function detectToolPresentation(toolName: string, result: unknown, args?: unknown): ToolPresentation {
  const text = resultText(result);
  const path = toolArg(args, "path");
  switch (toolName) {
    case "write": {
      const content = toolArg(args, "content");
      if (path && content !== undefined) {
        return { kind: "diff", oldFile: { content: "", name: path }, newFile: { content: limitText(content), name: path }, name: path };
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
    case "bash":
    case "powershell": {
      const command = toolArg(args, "command");
      return { kind: "terminal", ...(command ? { command } : {}), output: text ?? "" };
    }
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

/** Count added/removed lines for a diff presentation using a line-multiset diff. */
export function toolDiffStats(presentation: ToolPresentation): { file: string; added: number; removed: number } | undefined {
  if (presentation.kind !== "diff") return undefined;
  const file = presentation.name ?? "文件";
  if (presentation.patch) {
    let added = 0;
    let removed = 0;
    for (const line of presentation.patch.split(/\r?\n/)) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    return { file, added, removed };
  }
  const oldLines = presentation.oldFile?.content ? presentation.oldFile.content.split(/\r?\n/) : [];
  const newLines = presentation.newFile?.content ? presentation.newFile.content.split(/\r?\n/) : [];
  const remaining = new Map<string, number>();
  for (const line of oldLines) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of newLines) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) remaining.set(line, left - 1);
    else added += 1;
  }
  let removed = 0;
  for (const count of remaining.values()) removed += count;
  return { file, added, removed };
}

export function toolPresentationSummary(presentation: ToolPresentation): string {
  switch (presentation.kind) {
    case "diff":
      return presentation.name ? `${presentation.name} 已更新` : "文件已更新";
    case "file":
      return presentation.content;
    case "terminal":
      return presentation.output;
    case "search":
      return presentation.text ?? presentation.items.map((item) => `${item.path ?? ""}${item.line !== undefined ? `:${item.line}` : ""} ${item.text}`.trim()).join("\n");
    case "image":
      return presentation.name ?? "图片结果";
    case "text":
      return presentation.text;
    case "unknown":
      return presentation.text ?? "工具结果可在调试回退中查看";
  }
}
