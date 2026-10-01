import type { AppendMessage } from "@assistant-ui/react";
import { expandComposerCommand } from "./composer-command";

export function extractComposerPrompt(message: AppendMessage): { text: string; goal: boolean } {
  const raw = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("").trim();
  const directive = /:qone-tool\[[^\]\n]*\]\{name=qone-goal\}\s*/giu;
  const legacy = /^\s*@goal\b\s*/iu;
  if (directive.test(raw)) return { text: expandComposerCommand(raw.replace(directive, "").trim()), goal: true };
  if (legacy.test(raw)) return { text: expandComposerCommand(raw.replace(legacy, "").trim()), goal: true };
  return { text: expandComposerCommand(raw), goal: false };
}
