import { expect, test } from "bun:test";
import { createPowerShellTool, type PowerShellOperations } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("\n");

test("Pi shell preserves split UTF-8 and full logs when both output limits truncate", async () => {
  const expected = "中文🙂输出\n".repeat(100_000) + "最终结果";
  const bytes = Buffer.from(expected);
  const updates: string[] = [];
  let fullOutputPath: string | undefined;
  const operations: PowerShellOperations = {
    exec: async (_command, _cwd, { onData }) => {
      // The first Chinese character and emoji both span separate chunks.
      for (const chunk of [bytes.subarray(0, 1), bytes.subarray(1, 5), bytes.subarray(5, 9), bytes.subarray(9)]) {
        onData(chunk);
      }
      return { exitCode: 0 };
    },
  };
  try {
    const tool = createPowerShellTool(process.cwd(), { operations });
    const result = await tool.execute("split-utf8", { command: "test" }, undefined, (update) => {
      updates.push(text(update));
      fullOutputPath = update.details?.fullOutputPath ?? fullOutputPath;
    });
    fullOutputPath = result.details?.fullOutputPath ?? fullOutputPath;
    expect(text(result)).toContain("最终结果");
    expect(text(result)).not.toContain("�");
    expect(updates.join("\n")).not.toContain("�");
    expect(result.details?.truncation?.truncated).toBe(true);
    expect(result).toMatchObject({ structuredContent: { truncated: true, exit_code: 0, full_output_path: fullOutputPath } });
    expect(fullOutputPath).toBeTruthy();
    expect(await readFile(fullOutputPath!, "utf8")).toBe(expected);
  } finally {
    if (fullOutputPath) await rm(fullOutputPath, { force: true });
  }
});

test("real PowerShell keeps Unicode output and structured nonzero exit status", async () => {
  const tool = createPowerShellTool(process.cwd());
  const result = await tool.execute("nonzero", { command: "[Console]::Out.WriteLine('中文🙂'); [Console]::Error.WriteLine('错误输出'); exit 7" });
  expect(text(result)).toContain("中文🙂");
  expect(text(result)).toContain("错误输出");
  expect(text(result)).not.toContain("�");
  expect(result).toMatchObject({ isError: true, structuredContent: { exit_code: 7, truncated: false } });
}, 15_000);

for (const mode of ["timeout", "abort"] as const) {
  test(`real PowerShell ${mode} stops execution and retains partial output`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "qone-pi-shell-"));
    const controller = new AbortController();
    const updates: string[] = [];
    const tool = createPowerShellTool(directory);
    try {
      const execution = tool.execute(mode, {
        command: "[Console]::Out.WriteLine('started'); Start-Sleep -Seconds 15; [Console]::Out.WriteLine('must-not-finish')",
        ...(mode === "timeout" ? { timeout: 2 } : {}),
      }, controller.signal, (update) => {
        const output = text(update);
        updates.push(output);
        if (mode === "abort" && output.includes("started")) controller.abort();
      });
      const error = await execution.then(() => undefined, (error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error!.message).toContain(mode === "timeout" ? "Command timed out after 2 seconds" : "Command aborted");
      expect(error!.message).toContain("started");
      expect(error!.message).not.toContain("must-not-finish");
      expect(updates.some((output) => output.includes("started"))).toBe(true);
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  }, 10_000);
}
