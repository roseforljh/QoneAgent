import path from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { ensureQoneLayout, qoneDataDir as resolveQoneDataDir } from "@qone/shared";
import defaultInstructions from "./default-global-instructions.md" with { type: "text" };

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

/** Seed a new file from bundled defaults; existing content, including empty files, is user-owned. */
export function ensureGlobalInstructions(): void {
  ensureQoneLayout();
  const directory = qoneDataDir();
  mkdirSync(directory, { recursive: true });
  const file = globalInstructionsPath();
  try {
    writeFileSync(file, defaultInstructions, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
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
