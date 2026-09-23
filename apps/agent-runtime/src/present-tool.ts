import { buildPresentParameters, defaultGenerativeUILibrary } from "@assistant-ui/react-generative-ui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GENERATIVE_UI_COMPONENTS } from "@qone/protocol";

// Interactive vocabulary needs a response channel. Expose the official visual
// components now; controls are not offered until that channel exists.
const displayLibrary = Object.fromEntries(
  GENERATIVE_UI_COMPONENTS.map((name) => [name, defaultGenerativeUILibrary[name]]),
);

// The schema comes from the same official vocabulary used by the desktop renderer.
// Pi accepts TypeBox schemas; Type.Unsafe preserves the library's recursive JSON schema.
const parameters = Type.Unsafe<Record<string, unknown>>(
  buildPresentParameters(displayLibrary),
);

export const presentTool: ToolDefinition<typeof parameters> = {
  name: "present",
  label: "Present UI",
  description: "Present a read-only structured UI card to the user. Select a component with `$type`, provide its props inline, and nest components with `children`. Use it when a visual result is clearer than plain text.",
  promptSnippet: "present: show a structured UI card in the conversation",
  parameters,
  async execute() {
    // The desktop renders the persisted tool arguments; returning the tree here
    // would duplicate it in the model's context and in the tool result.
    return { content: [{ type: "text", text: "UI presented to the user." }], details: {} };
  },
};
