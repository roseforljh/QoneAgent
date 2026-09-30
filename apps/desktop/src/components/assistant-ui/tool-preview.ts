import { editDiff, toolArg, type ToolPresentation } from "./tool-presentation";
import { commandForTool } from "./tool-action-summary";
import { isCommandTool } from "./tool-activity-category";

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
  }
  if (isCommandTool({ toolName })) {
    const command = commandForTool({ toolName, args });
    return command ? { kind: "terminal", command, output: "" } : undefined;
  }
  return undefined;
}
