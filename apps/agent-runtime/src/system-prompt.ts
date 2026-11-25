import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { qoneSystemPromptsDir } from "@qone/shared";
import identity from "./system-prompts/01-identity.md" with { type: "text" };
import behavior from "./system-prompts/02-behavior.md" with { type: "text" };
import execution from "./system-prompts/03-execution.md" with { type: "text" };
import webAccess from "./system-prompts/04-web-access.md" with { type: "text" };
import coding from "./system-prompts/05-coding.md" with { type: "text" };
import verification from "./system-prompts/06-verification.md" with { type: "text" };
import safety from "./system-prompts/07-safety.md" with { type: "text" };
import communication from "./system-prompts/08-communication.md" with { type: "text" };
import codemode from "./system-prompts/09-codemode.md" with { type: "text" };
import commandExecution from "./system-prompts/10-command-execution.md" with { type: "text" };

const normalizeLineEndings = (text: string) => text.replace(/\r\n?/g, "\n");
const normalizeModule = (text: string) => normalizeLineEndings(text).trim();

// Explicit order is part of the product contract; directory enumeration is not.
export const SYSTEM_PROMPT_MODULES = [
  { file: "01-identity.md", content: normalizeLineEndings(identity) },
  { file: "02-behavior.md", content: normalizeLineEndings(behavior) },
  { file: "03-execution.md", content: normalizeLineEndings(execution) },
  { file: "04-web-access.md", content: normalizeLineEndings(webAccess) },
  { file: "05-coding.md", content: normalizeLineEndings(coding) },
  { file: "06-verification.md", content: normalizeLineEndings(verification) },
  { file: "07-safety.md", content: normalizeLineEndings(safety) },
  { file: "08-communication.md", content: normalizeLineEndings(communication) },
  { file: "09-codemode.md", content: normalizeLineEndings(codemode) },
  { file: "10-command-execution.md", content: normalizeLineEndings(commandExecution) },
] as const;

// Fingerprints of earlier defaults, keyed by module so local edits stay intact.
const LEGACY_DEFAULT_HASHES: Record<string, readonly string[]> = {
  "01-identity.md": ["72405491216a1ba5b921cc13461ba30cfca9401858380fa30f646cdf7e266577"],
  "02-behavior.md": ["f0999de4d00cb7c73ffce45e94441d8c32f0cff02b8f460d23da4dabe7d39a4b"],
  "03-execution.md": [
    "3a4d91ed932723914a8a80fd3ee406383ca4e65bbd1975dd7bd0bb8e5eb5b950",
    "befdf6c9f18740381bb4b6d3bc92c5de24b607e808dada07ddd138642ae984ec",
  ],
  "04-web-access.md": [
    "72716b8c600d9ce16ff9204e0ec5392afa367d03fbcd466b04d4ca723f38c3b6",
    "62d1e5891524cbab7f60a32a9f97a30290519f440870cb9b0834ac228a247b40",
    "b12b8b60111d402621cdcdf3cb3c9d8be3926a72677dba32545b8aabba6b2d71",
    "f671bc61b975bf5022f2a51f31f4edf39cf3f791564a7c789f2ab86cdc38bd7d",
    "b1f99854139415189dc46d2791483b0be3ec3f5fcefd2d80d2880ed13e3287d9",
  ],
  "05-coding.md": ["d8ce33353360625a652833aa1ccd2b8a8a9a81182d1c71e2f949f977edd58aff"],
  "06-verification.md": ["3fb488926e2e46611e9e6e6ad142e3dfaeffeecbfbdd265b304422389d662628"],
  "07-safety.md": ["2cd4b6819726c74c8bd8a5d8ed46ef6c6588793c4dd5242165843e6080352d0e"],
  "08-communication.md": ["ae07243a5c7e9665511560b9cf0af906cb8a54c6a04cde35d8e6b5aaaf485aa2"],
};

/** Bundled Markdown seeds missing modules. Existing files stay user-editable. */
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
  return SYSTEM_PROMPT_MODULES.map(({ file, content: bundled }) => {
    const content = normalizeModule(readFileSync(path.join(directory, file), "utf8"));
    if (!content) throw new Error(`System prompt module is empty: ${file}`);
    // Apply updated defaults without overwriting local files.
    return LEGACY_DEFAULT_HASHES[file]?.includes(createHash("sha256").update(content).digest("hex"))
      ? normalizeModule(bundled) : content;
  }).join("\n\n");
}
