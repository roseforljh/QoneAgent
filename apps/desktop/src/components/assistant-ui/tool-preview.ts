import { detectToolPresentation, type ToolPresentation } from "./tool-presentation";

/** Arguments describe a proposal, never proof that a file has changed. */
export function detectToolPreview(args: unknown): ToolPresentation | undefined {
  const presentation = detectToolPresentation(undefined, args);
  if (presentation.kind === "diff" || presentation.kind === "terminal") return presentation;
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  const name = [record.path, record.filePath, record.file_path, record.filename, record.file]
    .find((value): value is string => typeof value === "string" && value.length > 0);
  // A write without the old contents can preview its code, but cannot claim
  // that every line is an addition to an empty file.
  if (name && typeof record.content === "string") return { kind: "file", name, content: record.content };
  return undefined;
}
