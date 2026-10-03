import type { AppendMessage } from "@assistant-ui/react";
import { expandComposerCommand } from "./composer-command";
import { messageQuote, withMessageQuote } from "./message-quote";

export function extractComposerPrompt(message: AppendMessage): { text: string; goal: boolean; quote?: ReturnType<typeof messageQuote> } {
  const raw = message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("").trim();
  const directive = /:qone-tool\[[^\]\n]*\]\{name=qone-goal\}\s*/giu;
  const legacy = /^\s*@goal\b\s*/iu;
  const goal = directive.test(raw) || legacy.test(raw);
  const text = expandComposerCommand(raw.replace(directive, "").replace(legacy, "").trim());
  const quote = messageQuote(message);
  return { text: withMessageQuote(text, quote), goal, quote };
}
