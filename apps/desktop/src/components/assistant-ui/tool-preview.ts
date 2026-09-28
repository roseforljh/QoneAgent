import { editDiff, toolArg, type ToolPresentation } from "./tool-presentation";

/** Arguments describe a proposal, never proof that a file has changed. */
export function detectToolPreview(toolName: string, args: unknown): ToolPresentation | undefined {
  switch (toolName) {
    case "write": {
      const name = toolArg(args, "path");
      const content = toolArg(args, "content");
      // A write without the old contents can preview its code, but cannot claim
      // that every line is an addition to an empty file.
      return name && content !== undefined ? { kind: "file", name, content } : undefined;
    }
    case "edit":
      return editDiff(args);
    case "bash":
    case "powershell": {
      const command = toolArg(args, "command");
      return command ? { kind: "terminal", command, output: "" } : undefined;
    }
  }
  return undefined;
}
