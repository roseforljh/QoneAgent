import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

const asText = (result: unknown) => {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
};

describe("Pi built-in Windows coding tools", () => {
  test("read/write/edit/grep/find/ls/powershell execute against the workspace", async () => {
    const root = path.join(process.cwd(), ".test-data", `builtin-${crypto.randomUUID()}`);
    mkdirSync(root, { recursive: true });
    const source = path.join(root, "src", "sample.txt");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(source, "alpha\nbeta\n", "utf8");
    const execute = (tool: { execute: (...args: never[]) => Promise<unknown> }, params: unknown) =>
      tool.execute("test", params as never, undefined as never, undefined as never, undefined as never);

    try {
      const read = await execute(createReadTool(root), { path: "src/sample.txt" });
      expect(asText(read)).toContain("alpha");

      const write = await execute(createWriteTool(root), { path: "out.txt", content: "created" });
      expect(asText(write).toLowerCase()).toMatch(/wrote|written/);

      const edit = await execute(createEditTool(root), {
        path: "src/sample.txt",
        edits: [{ oldText: "beta", newText: "gamma" }],
      });
      expect(asText(edit).toLowerCase()).toMatch(/edit|updated|replaced/);

      const grep = await execute(createGrepTool(root), { pattern: "gamma", path: "." });
      expect(asText(grep)).toContain("sample.txt");

      const find = await execute(createFindTool(root), { pattern: "**/*.txt", path: "." });
      expect(asText(find)).toContain("sample.txt");

      const ls = await execute(createLsTool(root), { path: "." });
      expect(asText(ls)).toContain("out.txt");

      const command = `Get-Content -LiteralPath '${source.replaceAll("'", "''")}'`;
      const powershell = await execute(createPowerShellTool(root), { command, timeout: 10 });
      expect(asText(powershell)).toContain("gamma");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, { timeout: 30_000 });
});
