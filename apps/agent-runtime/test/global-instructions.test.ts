import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGlobalInstructions, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "../src/global-instructions";

const previousAppData = process.env.APPDATA;
let tempDir: string | undefined;

afterEach(() => {
  if (previousAppData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousAppData;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test("persists global instructions as Qone/Qone.md", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-instructions-"));
  process.env.APPDATA = tempDir;

  expect(readGlobalInstructions()).toBe("");
  writeGlobalInstructions("使用中文回答。\n");

  expect(globalInstructionsPath()).toBe(path.join(tempDir, "Qone", "Qone.md"));
  expect(existsSync(globalInstructionsPath())).toBe(true);
  expect(readFileSync(globalInstructionsPath(), "utf8")).toBe("使用中文回答。\n");
  expect(readGlobalInstructions()).toBe("使用中文回答。\n");
});

test("creates an empty global file without overwriting it", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-instructions-"));
  process.env.APPDATA = tempDir;

  ensureGlobalInstructions();
  expect(readFileSync(globalInstructionsPath(), "utf8")).toBe("");
  writeGlobalInstructions("保留这段内容");
  ensureGlobalInstructions();
  expect(readGlobalInstructions()).toBe("保留这段内容");
});
