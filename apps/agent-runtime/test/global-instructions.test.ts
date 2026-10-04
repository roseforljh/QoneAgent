import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensureGlobalInstructions, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "../src/global-instructions";
import defaultInstructions from "../src/default-global-instructions.md" with { type: "text" };

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

test("seeds bundled defaults once without overwriting user edits or an intentionally empty file", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-instructions-"));
  process.env.QONE_DATA_DIR = tempDir;

  ensureGlobalInstructions();
  expect(readGlobalInstructions()).toBe(defaultInstructions);
  expect(readGlobalInstructions()).toContain("## Ponytail, lazy senior dev mode");
  ensureGlobalInstructions();
  expect(readGlobalInstructions()).toBe(defaultInstructions);
  writeGlobalInstructions("保留这段内容");
  ensureGlobalInstructions();
  expect(readGlobalInstructions()).toBe("保留这段内容");
  writeGlobalInstructions("");
  ensureGlobalInstructions();
  expect(readGlobalInstructions()).toBe("");
});

test("initializes only the new user data root", () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-root-"));
  process.env.USERPROFILE = tempDir;
  process.env.HOME = tempDir;
  delete process.env.QONE_DATA_DIR;

  ensureGlobalInstructions();

  const target = path.join(tempDir, ".qone");
  expect(readFileSync(path.join(target, "Qone.md"), "utf8")).toBe(defaultInstructions);
  expect(existsSync(path.join(target, "prompts"))).toBe(false);
  expect(existsSync(path.join(tempDir, "appdata"))).toBe(false);
});

test("defaults ship in the runtime bundle without a source checkout or network", async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "qone-global-bundle-"));
  process.env.QONE_DATA_DIR = tempDir;
  // Isolate Bun's Windows build-path cache from other in-process bundle tests.
  const entrypoint = path.resolve(import.meta.dir, "../src/global-instructions.ts");
  const child = Bun.spawn([process.execPath, "-e", `
    const build = await Bun.build({ entrypoints: [${JSON.stringify(entrypoint)}], target: "bun", write: false });
    if (!build.success) throw new Error(String(build.logs));
    const code = await build.outputs[0].text();
    const bundled = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
    bundled.ensureGlobalInstructions();
    process.stdout.write(bundled.readGlobalInstructions());
  `], { stdout: "pipe", stderr: "pipe" });
  const [content, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(errors).toBe("");
  expect(exitCode).toBe(0);
  expect(content).toBe(defaultInstructions);
}, 10000);
