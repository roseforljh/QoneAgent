import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { qoneSystemPromptsDir } from "@qone/shared";
import { SYSTEM_PROMPT_MODULES, ensureSystemPromptModules, readSystemPrompt } from "../src/system-prompt";
import { createResourceLoader } from "../src/skills";

const originalRoot = process.env.QONE_DATA_DIR;
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "qone-system-prompt-"));
  process.env.QONE_DATA_DIR = root;
});
afterEach(() => {
  if (originalRoot === undefined) delete process.env.QONE_DATA_DIR;
  else process.env.QONE_DATA_DIR = originalRoot;
  if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error("Unsafe test cleanup");
  rmSync(root, { recursive: true, force: true });
});

test("initialization creates exactly the eight English source modules without overwriting existing content", () => {
  const directory = qoneSystemPromptsDir();
  ensureSystemPromptModules();
  expect(readdirSync(directory).sort()).toEqual([
    "01-identity.md", "02-behavior.md", "03-execution.md", "04-web-access.md",
    "05-coding.md", "06-verification.md", "07-safety.md", "08-communication.md",
  ]);
  for (const module of SYSTEM_PROMPT_MODULES) {
    expect(readFileSync(path.join(directory, module.file), "utf8")).toBe(module.content);
    expect(module.content).not.toMatch(/[\u4e00-\u9fff]/);
  }
  const identity = path.join(directory, "01-identity.md");
  writeFileSync(identity, "# Identity\n\nLocal product identity.\n");
  const modified = statSync(identity).mtimeMs;
  ensureSystemPromptModules();
  expect(readFileSync(identity, "utf8")).toContain("Local product identity.");
  expect(statSync(identity).mtimeMs).toBe(modified);
});

test("assembly has a fixed order, ignores extra files and normalizes line endings without variable context", () => {
  ensureSystemPromptModules();
  const directory = qoneSystemPromptsDir();
  for (const module of [...SYSTEM_PROMPT_MODULES].reverse()) {
    writeFileSync(path.join(directory, module.file), `\uFEFF${module.content.replace(/\n/g, "\r\n")}\r\n`);
  }
  writeFileSync(path.join(directory, "00-runtime.md"), "DYNAMIC_CONTENT_MUST_NOT_LOAD");
  const expected = SYSTEM_PROMPT_MODULES.map((module) => module.content.trim()).join("\n\n");
  expect(readSystemPrompt()).toBe(expected);
  expect(readSystemPrompt()).toBe(readSystemPrompt());
  expect(readSystemPrompt()).not.toContain(root);
  expect(readSystemPrompt()).not.toContain("DYNAMIC_CONTENT_MUST_NOT_LOAD");
  expect(readSystemPrompt()).not.toContain("Qone 工作原则");
  expect(readSystemPrompt()).not.toContain("finalize_response");
  const secondRoot = path.join(root, "another-installation", "system-prompts");
  expect(readSystemPrompt(secondRoot)).toBe(expected);
});

test("empty or unreadable modules fail explicitly rather than silently dropping rules or using Pi's identity", () => {
  ensureSystemPromptModules();
  const module = path.join(qoneSystemPromptsDir(), "03-execution.md");
  writeFileSync(module, " \r\n");
  expect(() => readSystemPrompt()).toThrow("System prompt module is empty: 03-execution.md");
  rmSync(module);
  mkdirSync(module);
  expect(() => readSystemPrompt()).toThrow();
});

test("the ResourceLoader uses modules as its preamble and keeps user/project/runtime guidance outside it", async () => {
  const cwd = path.join(root, "workspace");
  mkdirSync(cwd);
  writeFileSync(path.join(root, "Qone.md"), "USER_GUIDANCE");
  writeFileSync(path.join(cwd, "AGENTS.md"), "PROJECT_GUIDANCE");
  const piDirectory = path.join(root, "runtime", "pi");
  mkdirSync(piDirectory, { recursive: true });
  writeFileSync(path.join(piDirectory, "SYSTEM.md"), "OTHER_IDENTITY");
  writeFileSync(path.join(piDirectory, "APPEND_SYSTEM.md"), "UNREQUESTED_APPEND");
  const { loader } = await createResourceLoader(cwd, "SESSION_GUIDANCE", true);
  const fixed = readSystemPrompt();
  expect(loader.getSystemPrompt()).toBe(fixed);
  expect(loader.getSystemPrompt()).not.toContain("USER_GUIDANCE");
  expect(loader.getAppendSystemPrompt().join("\n\n")).toContain("USER_GUIDANCE");
  expect(loader.getAppendSystemPrompt().join("\n\n")).toContain("SESSION_GUIDANCE");
  expect(loader.getAppendSystemPrompt().join("\n\n")).not.toContain("UNREQUESTED_APPEND");
  expect(loader.getAgentsFiles().agentsFiles[0]?.content).toContain("PROJECT_GUIDANCE");
  expect(loader.getAgentsFiles().agentsFiles[0]?.content).toContain("QoneAgent managed: ponytail:start");
  writeFileSync(path.join(qoneSystemPromptsDir(), "01-identity.md"), "# Identity\n\nChanged product identity.");
  await loader.reload();
  expect(loader.getSystemPrompt()).toBe(readSystemPrompt());
  expect(loader.getSystemPrompt()).toContain("Changed product identity.");
});

test("bundled defaults work offline without reading Markdown from a source checkout", async () => {
  const build = await Bun.build({ entrypoints: [path.resolve(import.meta.dir, "../src/system-prompt.ts")], target: "bun", write: false });
  expect(build.success).toBe(true);
  const code = await build.outputs[0]!.text();
  const bundled = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as typeof import("../src/system-prompt");
  const directory = path.join(root, "bundled", "system-prompts");
  expect(bundled.readSystemPrompt(directory)).toBe(readSystemPrompt());
}, 10000);
