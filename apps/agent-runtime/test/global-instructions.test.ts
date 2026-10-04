import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGlobalInstructions, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "../src/global-instructions";

const previousDataDir = process.env.QONE_DATA_DIR;
const previousUserProfile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
let tempDir: string | undefined;

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.QONE_DATA_DIR;
  else process.env.QONE_DATA_DIR = previousDataDir;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

test("persists global instructions as .qone/Qone.md", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-instructions-"));
  process.env.QONE_DATA_DIR = tempDir;

  expect(readGlobalInstructions()).toBe("");
  writeGlobalInstructions("使用中文回答。\n");

  expect(globalInstructionsPath()).toBe(path.join(tempDir, "Qone.md"));
  expect(existsSync(globalInstructionsPath())).toBe(true);
  expect(readFileSync(globalInstructionsPath(), "utf8")).toBe("使用中文回答。\n");
  expect(readGlobalInstructions()).toBe("使用中文回答。\n");
});

test("creates an empty global file without overwriting it", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-instructions-"));
  process.env.QONE_DATA_DIR = tempDir;

  ensureGlobalInstructions();
  expect(readFileSync(globalInstructionsPath(), "utf8")).toBe("");
  writeGlobalInstructions("保留这段内容");
  ensureGlobalInstructions();
  expect(readGlobalInstructions()).toBe("保留这段内容");
});

test("initializes only the new user data root", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-root-"));
  process.env.USERPROFILE = tempDir;
  process.env.HOME = tempDir;
  delete process.env.QONE_DATA_DIR;

  ensureGlobalInstructions();

  const target = path.join(tempDir, ".qone");
  expect(readFileSync(path.join(target, "Qone.md"), "utf8")).toBe("");
  expect(existsSync(path.join(target, "prompts"))).toBe(false);
  expect(existsSync(path.join(tempDir, "appdata"))).toBe(false);
});
