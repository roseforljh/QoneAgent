import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { qoneSystemPromptsDir } from "@qone/shared";
import identity from "./system-prompts/01-identity.md" with { type: "text" };
import behavior from "./system-prompts/02-behavior.md" with { type: "text" };
import execution from "./system-prompts/03-execution.md" with { type: "text" };
import coding from "./system-prompts/04-coding.md" with { type: "text" };
import verification from "./system-prompts/05-verification.md" with { type: "text" };
import safety from "./system-prompts/06-safety.md" with { type: "text" };
import communication from "./system-prompts/07-communication.md" with { type: "text" };

// Explicit order is part of the product contract; directory enumeration is not.
export const SYSTEM_PROMPT_MODULES = [
  { file: "01-identity.md", content: identity },
  { file: "02-behavior.md", content: behavior },
  { file: "03-execution.md", content: execution },
  { file: "04-coding.md", content: coding },
  { file: "05-verification.md", content: verification },
  { file: "06-safety.md", content: safety },
  { file: "07-communication.md", content: communication },
] as const;

/** Bundled Markdown seeds a fresh installation without overwriting its source modules. */
export function ensureSystemPromptModules(directory = qoneSystemPromptsDir()): void {
  mkdirSync(directory, { recursive: true });
  for (const module of SYSTEM_PROMPT_MODULES) {
    try {
      writeFileSync(path.join(directory, module.file), module.content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Fixed prefix only. Project, user, tool and runtime context are appended elsewhere. */
export function readSystemPrompt(directory = qoneSystemPromptsDir()): string {
  ensureSystemPromptModules(directory);
  return SYSTEM_PROMPT_MODULES.map(({ file }) => {
    const content = readFileSync(path.join(directory, file), "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
    if (!content) throw new Error(`System prompt module is empty: ${file}`);
    return content;
  }).join("\n\n");
}
