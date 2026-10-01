import { expect, test } from "bun:test";
import { runtimeCopy } from "../../../packages/protocol/src/runtime-copy";
import { decodeCommand, runtimeMessage } from "@qone/protocol";
import { runtimeError, runtimeErrorInfo, runtimeText, withRuntimeLocale } from "../src/runtime-localization";
import { createLocalSkill } from "../src/skills";
import { generateSpeech } from "../src/speech-generation";
import { McpAccountLoginRequiredError } from "../../../packages/mcp/src/auth-error";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { normalizeSubagentConfig, subagentCatalog } from "../src/subagents";

test("runtime copy is complete, English contains no fixed Chinese, and parameters match", () => {
  const placeholders = (value: string) => [...value.matchAll(/\{p\d+\}/g)].map(([match]) => match).sort();
  for (const [key, copy] of Object.entries(runtimeCopy)) {
    expect(copy.en.trim(), key).not.toBe("");
    expect(copy["zh-CN"].trim(), key).not.toBe("");
    expect(copy.en, key).not.toMatch(/\p{Script=Han}/u);
    expect(placeholders(copy.en), key).toEqual(placeholders(copy["zh-CN"]));
  }
});

test("command decoding keeps a validated locale and remains compatible with old clients", () => {
  const command = { type: "ping", requestId: "test" };
  for (const locale of ["en", "zh-CN"] as const) expect(decodeCommand(JSON.stringify({ ...command, locale }))?.locale).toBe(locale);
  expect(decodeCommand(JSON.stringify(command))?.type).toBe("ping");
  expect(decodeCommand(JSON.stringify({ ...command, locale: "invalid" }))).toBeNull();
});

test("the real NDJSON runtime returns English and Chinese errors with stable codes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "qone-locale-test-"));
  const entry = resolve(import.meta.dir, "../src/index.ts");
  const child = Bun.spawn([process.execPath, entry], {
    cwd: directory, env: { ...process.env, APPDATA: directory, QONE_DB: ":memory:" }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const output = new Response(child.stdout).text();
    const diagnostics = new Response(child.stderr).text();
    for (const locale of ["en", "zh-CN"] as const) {
      child.stdin.write(JSON.stringify({ type: "skills.create", requestId: locale, locale, name: "invalid name", description: "test", instructions: "test" }) + "\n");
    }
    child.stdin.end();
    const lines = (await output).trim().split("\n").map((line) => JSON.parse(line));
    const errors = lines.filter((line) => line.type === "error");
    expect(errors).toHaveLength(2);
    expect(errors.find((error) => error.requestId === "en").message).toBe("Skill names may only contain lowercase letters, numbers, and hyphens");
    expect(errors.find((error) => error.requestId === "zh-CN").message).toBe("Skill 名称只能使用小写字母、数字和连字符");
    expect(errors.every((error) => error.localization.code === "skills.skill_names_may_only_contain_lowercase_letters_numbers_and")).toBe(true);
    expect(await child.exited, await diagnostics).toBe(0);
  } finally {
    clearTimeout(timer);
    child.kill();
    await child.exited;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("untouched built-in profiles retain language keys through normalization and protocol validation", () => {
  const config = normalizeSubagentConfig(undefined);
  expect(config.profiles).toHaveLength(5);
  const decoded = decodeCommand(JSON.stringify({ type: "subagent.sync", requestId: "sync", locale: "en", config }));
  if (decoded?.type !== "subagent.sync") throw new Error("Expected subagent sync");
  const restored = normalizeSubagentConfig(decoded.config);
  for (const profile of restored.profiles) {
    expect(profile.nameKey).toBeDefined();
    expect(profile.instructionsKey).toBeDefined();
  }
  restored.profiles.forEach((profile) => { profile.enabled = true; });
  const english = withRuntimeLocale("en", () => subagentCatalog(restored));
  expect(JSON.stringify(english)).not.toMatch(/\p{Script=Han}/u);
});

test("concurrent language contexts remain isolated through async tools and child work", async () => {
  const code = "skills.the_skill_description_cannot_be_empty";
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const chinese = withRuntimeLocale("zh-CN", async () => {
    await barrier;
    expect(runtimeText(code)).toBe("Skill 描述不能为空");
    await expect(createLocalSkill("example", "", "content")).rejects.toThrow("Skill 描述不能为空");
    return withRuntimeLocale("en", () => runtimeText(code));
  });
  const english = withRuntimeLocale("en", async () => {
    release();
    await Promise.resolve();
    await expect(createLocalSkill("example", "", "content")).rejects.toThrow("The skill description cannot be empty");
    return runtimeText(code);
  });
  expect(await Promise.all([chinese, english])).toEqual(["The skill description cannot be empty", "The skill description cannot be empty"]);
  expect(runtimeText(code)).toBe("Skill 描述不能为空");
});

test("structured errors can be translated again without replacing user paths or diagnostics", () => {
  const code = "pi-attachments.could_not_read_local_attachment";
  const path = "C:\\中文目录\\{p0}.txt";
  const cause = new Error("provider diagnostic");
  const error = withRuntimeLocale("en", () => runtimeError(code, { p0: path }, { cause }));
  expect(error.message).toBe(`Could not read local attachment: ${path}`);
  expect(error.cause).toBe(cause);
  const serialized = JSON.parse(JSON.stringify(runtimeErrorInfo(error)));
  expect(serialized.message).toBe(`Could not read local attachment: ${path}`);
  expect(runtimeMessage("zh-CN", serialized.localization.code, serialized.localization.values)).toBe(`无法读取本地附件：${path}`);
  expect(runtimeErrorInfo(cause)).toEqual({ message: "provider diagnostic" });
  expect(withRuntimeLocale("zh-CN", () => runtimeErrorInfo(new McpAccountLoginRequiredError("用户服务")))).toMatchObject({
    message: "用户服务 登录凭据已失效，请重新登录授权。", localization: { code: "mcp.loginRequired", values: { p0: "用户服务" } },
  });
});

test("media generation validation reports the requested language before any network call", async () => {
  const input = { text: "", config: { id: "test", provider: "test", model: "tts", config: {} }, apiKey: "", signal: new AbortController().signal };
  await withRuntimeLocale("en", async () => {
    await expect(generateSpeech(input)).rejects.toThrow("Speech generation requires text to read aloud");
  });
  await withRuntimeLocale("zh-CN", async () => {
    await expect(generateSpeech(input)).rejects.toThrow("语音生成缺少待朗读文本");
  });
});

test("runtime errors cannot reintroduce untranslated Chinese literals", () => {
  const root = new URL("../src/", import.meta.url);
  const errors: string[] = [];
  for (const file of readdirSync(root).filter((name) => name.endsWith(".ts"))) {
    const source = ts.createSourceFile(file, readFileSync(new URL(file, root), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && node.expression.getText(source) === "Error" && /\p{Script=Han}/u.test(node.arguments?.[0]?.getText(source) ?? "")) errors.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(errors).toEqual([]);
});
