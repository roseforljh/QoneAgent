import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ensureQoneLayout, qoneDataDir as resolveQoneDataDir } from "@qone/shared";

const GLOBAL_INSTRUCTIONS_FILE = "Qone.md";

export function qoneDataDir(): string {
  return resolveQoneDataDir();
}

export function globalInstructionsPath(): string {
  return path.join(qoneDataDir(), GLOBAL_INSTRUCTIONS_FILE);
}

export function globalInstructionsDirectory(): string {
  return qoneDataDir();
}

/** Create the user-level file without changing an existing user's content. */
export function ensureGlobalInstructions(): void {
  ensureQoneLayout();
  const directory = qoneDataDir();
  mkdirSync(directory, { recursive: true });
  const file = globalInstructionsPath();
  if (!existsSync(file)) writeFileSync(file, "", "utf8");
}

export function readGlobalInstructions(): string {
  try {
    return readFileSync(globalInstructionsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

export function writeGlobalInstructions(content: string): void {
  const directory = qoneDataDir();
  mkdirSync(directory, { recursive: true });
  writeFileSync(globalInstructionsPath(), content, "utf8");
}
