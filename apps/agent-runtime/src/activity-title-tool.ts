import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ACTIVITY_TITLE_MAX_LENGTH, ACTIVITY_TITLE_TOOL, activityTitleFromArgs } from "@qone/protocol";

/** Progress metadata only: no file, network, permission, or task-state mutation. */
export function createActivityTitleTool(): ToolDefinition {
  return {
    name: ACTIVITY_TITLE_TOOL,
    label: "Describe execution stage",
    description: "Set the heading for the next execution stage. Write a short, specific phrase describing what you are investigating, changing, or verifying, in the user's language. Call at the start of a meaningful stage, then perform its tools. Update only when the stage purpose changes. Do not list tool counts, expose protocol names, invent findings, or claim unverified success. This tool only records a heading; it does not perform the work.",
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: ACTIVITY_TITLE_MAX_LENGTH }) }),
    execute: async (_id, args) => {
      const title = activityTitleFromArgs(args);
      if (!title) throw new Error("Execution stage title must be a short, non-empty phrase.");
      return { content: [{ type: "text", text: JSON.stringify({ title }) }], details: {} };
    },
  };
}
