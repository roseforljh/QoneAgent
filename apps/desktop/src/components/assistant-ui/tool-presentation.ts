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

export interface ToolPresentationInput {
  result: unknown;
  args?: unknown;
}

type RecordValue = Record<string, unknown>;

const MAX_TEXT_LENGTH = 20_000;
const PATH_KEYS = ["path", "filePath", "file_path", "filename", "file"] as const;
const COMMAND_KEYS = ["command", "commandLine", "script", "shell"] as const;
const SEARCH_KEYS = ["pattern", "query", "search", "term"] as const;
const CHANGED_CONTENT_KEYS = [
  "content",
  "contents",
  "newContent",
  "new_content",
  "changedContent",
  "changed_content",
  "updatedContent",
  "updated_content",
] as const;

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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function firstString(record: RecordValue | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function pathFrom(value: unknown): string | undefined {
  const record = asRecord(value);
  return firstString(record, PATH_KEYS);
}

function isUnifiedPatch(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return /(?:^|\n)(?:diff --git |Index: |--- .+\n\+\+\+ .+|@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m.test(value);
}

function walk(value: unknown, visit: (record: RecordValue) => void, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  const parsed = parseJson(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) walk(item, visit, depth + 1);
    return;
  }
  const record = asRecord(parsed);
  if (!record) return;
  visit(record);
  for (const child of Object.values(record)) walk(child, visit, depth + 1);
}

function walkStrings(value: unknown, visit: (text: string) => void, depth = 0): void {
  if (depth > 8 || value === null || value === undefined) return;
  const parsed = parseJson(value);
  if (typeof parsed === "string") {
    if (parsed.trim()) visit(parsed);
    return;
  }
  if (Array.isArray(parsed)) {
    for (const item of parsed) walkStrings(item, visit, depth + 1);
    return;
  }
  const record = asRecord(parsed);
  if (!record) return;
  for (const child of Object.values(record)) walkStrings(child, visit, depth + 1);
}

function findStringByKeys(value: unknown, keys: readonly string[]): string | undefined {
  let found: string | undefined;
  walk(value, (record) => {
    if (found) return;
    found = firstString(record, keys);
  });
  return found;
}

function findPatch(value: unknown): string | undefined {
  let patch: string | undefined;
  walkStrings(value, (text) => {
    if (!patch && isUnifiedPatch(text)) patch = text;
  });
  return patch;
}

function looksLikeDisplayDiff(value: string): boolean {
  const lines = value.split(/\r?\n/);
  return lines.some((line) => /^\s*-\s+\S/.test(line))
    && lines.some((line) => /^\s*\+\s+\S/.test(line));
}

function findDiffText(value: unknown): string | undefined {
  let diff: string | undefined;
  walkStrings(value, (candidate) => {
    if (!diff && looksLikeDisplayDiff(candidate)) diff = candidate;
  });
  return diff;
}

function filePairFromRecord(record: RecordValue): { oldFile: ToolFile; newFile: ToolFile } | undefined {
  const pairs: [string, string][] = [
    ["oldContent", "newContent"],
    ["old_content", "new_content"],
    ["before", "after"],
    ["beforeContent", "afterContent"],
    ["before_content", "after_content"],
    ["oldText", "newText"],
    ["old_text", "new_text"],
    ["old", "new"],
  ];
  for (const [oldKey, newKey] of pairs) {
    const oldContent = typeof record[oldKey] === "string" ? record[oldKey] as string : undefined;
    const newContent = typeof record[newKey] === "string" ? record[newKey] as string : undefined;
    if (oldContent !== undefined && newContent !== undefined && oldContent !== newContent) {
      const name = pathFrom(record);
      return {
        oldFile: { content: limitText(oldContent), ...(name ? { name } : {}) },
        newFile: { content: limitText(newContent), ...(name ? { name } : {}) },
      };
    }
  }
  return undefined;
}

function findFilePair(value: unknown): { oldFile: ToolFile; newFile: ToolFile } | undefined {
  let pair: { oldFile: ToolFile; newFile: ToolFile } | undefined;
  walk(value, (record) => {
    if (!pair) pair = filePairFromRecord(record);
  });
  return pair;
}

function contentLines(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return undefined;
  return value.join("\n");
}

function diffPairFromRecord(record: RecordValue): { oldFile: ToolFile; newFile: ToolFile } | undefined {
  const additions = contentLines(record.additions);
  const deletions = contentLines(record.deletions);
  if (additions === undefined || deletions === undefined || (additions === "" && deletions === "")) return undefined;
  const name = pathFrom(record);
  return {
    oldFile: { content: limitText(deletions), ...(name ? { name } : {}) },
    newFile: { content: limitText(additions), ...(name ? { name } : {}) },
  };
}

function findDiffPair(value: unknown): { oldFile: ToolFile; newFile: ToolFile } | undefined {
  let pair: { oldFile: ToolFile; newFile: ToolFile } | undefined;
  walk(value, (record) => {
    if (!pair) pair = diffPairFromRecord(record);
  });
  return pair;
}

function changedContentFromRecord(record: RecordValue): { content: string; name: string } | undefined {
  const name = pathFrom(record);
  if (!name) return undefined;
  for (const key of CHANGED_CONTENT_KEYS) {
    if (typeof record[key] === "string") {
      return { content: limitText(record[key] as string), name };
    }
  }
  return undefined;
}

function findChangedFileContent(value: unknown): { content: string; name: string } | undefined {
  let changed: { content: string; name: string } | undefined;
  walk(value, (record) => {
    if (!changed) changed = changedContentFromRecord(record);
  });
  return changed;
}

function displayDiffPair(value: string, name?: string): { oldFile: ToolFile; newFile: ToolFile } | undefined {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let changed = false;
  for (const line of value.split(/\r?\n/)) {
    const match = /^([+-])\s*(?:\d+\s+)?(.*)$/.exec(line);
    if (match?.[1] === "-") {
      oldLines.push(match[2] ?? "");
      changed = true;
    } else if (match?.[1] === "+") {
      newLines.push(match[2] ?? "");
      changed = true;
    }
  }
  if (!changed) return undefined;
  return {
    oldFile: { content: limitText(oldLines.join("\n")), ...(name ? { name } : {}) },
    newFile: { content: limitText(newLines.join("\n")), ...(name ? { name } : {}) },
  };
}

function findImage(value: unknown): { src: string; mimeType?: string; name?: string } | undefined {
  let image: { src: string; mimeType?: string; name?: string } | undefined;
  walk(value, (record) => {
    if (image) return;
    const type = typeof record.type === "string" ? record.type : "";
    const mimeType = nonEmptyString(record.mimeType) ?? nonEmptyString(record.mime_type);
    const src = type === "image"
      ? nonEmptyString(record.data) ?? nonEmptyString(record.image) ?? nonEmptyString(record.src)
      : (mimeType?.startsWith("image/")
        ? nonEmptyString(record.data) ?? nonEmptyString(record.image) ?? nonEmptyString(record.src)
        : undefined);
    if (src) image = { src, ...(mimeType ? { mimeType } : {}), ...(pathFrom(record) ? { name: pathFrom(record) } : {}) };
  });
  return image;
}

function textFrom(value: unknown, depth = 0): string | undefined {
  if (depth > 8 || value === undefined || value === null) return undefined;
  const parsed = parseJson(value);
  if (typeof parsed === "string") return limitText(parsed);
  if (Array.isArray(parsed)) {
    const parts = parsed.map((item) => textFrom(item, depth + 1)).filter(Boolean) as string[];
    return parts.length ? limitText(parts.join("\n")) : undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  if (record.type === "image") return undefined;
  const direct = ["text", "output", "stdout", "stderr", "message", "summary"];
  for (const key of direct) {
    const text = textFrom(record[key], depth + 1);
    if (text) return text;
  }
  for (const key of ["content", "result", "data", "details", "structuredContent"]) {
    const text = textFrom(record[key], depth + 1);
    if (text) return text;
  }
  return undefined;
}

function contentFromArgs(args: unknown): string | undefined {
  const record = asRecord(parseJson(args));
  return record && typeof record.content === "string" ? limitText(record.content) : undefined;
}

function editsFromArgs(args: unknown): { oldFile: ToolFile; newFile: ToolFile; name?: string } | undefined {
  const record = asRecord(parseJson(args));
  if (!record || !Array.isArray(record.edits)) return undefined;
  const edits = record.edits.filter(asRecord).filter((edit): edit is RecordValue =>
    typeof edit.oldText === "string" && typeof edit.newText === "string" && edit.oldText !== edit.newText,
  );
  if (!edits.length) return undefined;
  const name = pathFrom(record);
  return {
    oldFile: { content: limitText(edits.map((edit) => edit.oldText as string).join("\n")), ...(name ? { name } : {}) },
    newFile: { content: limitText(edits.map((edit) => edit.newText as string).join("\n")), ...(name ? { name } : {}) },
    ...(name ? { name } : {}),
  };
}

function commandFrom(value: unknown, allowScalar = false): string | undefined {
  const parsed = parseJson(value);
  if (allowScalar && typeof parsed === "string") return nonEmptyString(parsed);
  return findStringByKeys(parsed, COMMAND_KEYS);
}

function searchQueryFrom(value: unknown): string | undefined {
  return findStringByKeys(value, SEARCH_KEYS);
}

function searchItemsFrom(text: string): ToolSearchItem[] {
  return text.split(/\r?\n/).map((line) => {
    const match = /^(.*?):(\d+):\s?(.*)$/.exec(line);
    return match
      ? { path: match[1], line: Number(match[2]), text: match[3] ?? "" }
      : { text: line };
  }).filter((item) => item.text.trim().length > 0 || item.path !== undefined);
}

function looksLikeSearch(text: string): boolean {
  return /(?:^|\n)[^\n:]+:\d+:\s?/m.test(text) || /(?:No matches found|No files found matching pattern)/i.test(text);
}

function debugJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return limitText(json ?? String(value));
  } catch {
    return String(value);
  }
}

function mutationContent(args: unknown, result: unknown, resultText: string | undefined): { content: string; name?: string } | undefined {
  const content = contentFromArgs(args);
  const name = pathFrom(args);
  if (content === undefined || !name) return undefined;
  if (resultText && /(?:wrote|write|created|updated|patched|edited|replaced|saved|modified|success|\bok\b|\bdone\b|写入|创建|更新|修改|替换|保存|成功)/i.test(resultText)) {
    return { content, name };
  }
  let signaled = false;
  walk(result, (record) => {
    if (signaled) return;
    signaled = ["changed", "modified", "updated", "created", "written", "saved"].some((key) => record[key] === true)
      || ["operation", "action", "status"].some((key) => /(?:write|create|update|patch|edit|replace|save|modify|success|done)/i.test(String(record[key] ?? "")));
  });
  if (signaled) return { content, name };
  return undefined;
}

/** Normalize arbitrary tool output into a small set of user-facing result presentations. */
export function detectToolPresentation(result: unknown, args?: unknown): ToolPresentation {
  const parsedResult = parseJson(result);
  const resultText = textFrom(parsedResult);
  const name = pathFrom(parsedResult) ?? pathFrom(args);
  // Command output stays terminal even when stdout looks like a patch:
  // `git diff` prints a diff but the call itself edited nothing.
  const command = commandFrom(args, true) ?? commandFrom(parsedResult);
  const terminalRecord = asRecord(parsedResult);
  if (command || (terminalRecord && (terminalRecord.stdout !== undefined || terminalRecord.stderr !== undefined || terminalRecord.exitCode !== undefined))) {
    return { kind: "terminal", ...(command ? { command } : {}), output: resultText ?? "" };
  }

  const patch = findPatch(parsedResult) ?? findPatch(args);
  if (patch) return { kind: "diff", patch, ...(name ? { name } : {}) };

  const pair = findFilePair(parsedResult) ?? editsFromArgs(args) ?? findFilePair(args);
  if (pair) return { kind: "diff", ...pair, ...(name ? { name } : {}) };

  const additionsPair = findDiffPair(parsedResult) ?? findDiffPair(args);
  if (additionsPair) return { kind: "diff", ...additionsPair, ...(name ? { name } : {}) };

  const displayDiff = findDiffText(parsedResult);
  const displayPair = displayDiff ? displayDiffPair(displayDiff, name) : undefined;
  if (displayPair) return { kind: "diff", ...displayPair, ...(name ? { name } : {}) };

  const changedFile = findChangedFileContent(parsedResult);
  if (changedFile) {
    return {
      kind: "diff",
      oldFile: { content: "", name: changedFile.name },
      newFile: { content: changedFile.content, name: changedFile.name },
      name: changedFile.name,
    };
  }

  const mutation = mutationContent(args, parsedResult, resultText);
  if (mutation) {
    return {
      kind: "diff",
      oldFile: { content: "", ...(mutation.name ? { name: mutation.name } : {}) },
      newFile: { content: mutation.content, ...(mutation.name ? { name: mutation.name } : {}) },
      ...(mutation.name ? { name: mutation.name } : {}),
    };
  }

  const image = findImage(parsedResult);
  if (image) return { kind: "image", ...image };

  const query = searchQueryFrom(args);
  if (query && resultText && looksLikeSearch(resultText)) {
    return { kind: "search", query, items: searchItemsFrom(resultText), text: resultText };
  }

  if (name && resultText) return { kind: "file", content: resultText, name };
  if (resultText) return { kind: "text", text: resultText };
  return { kind: "unknown", ...(resultText ? { text: resultText } : {}), debugJson: debugJson(parsedResult) };
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
