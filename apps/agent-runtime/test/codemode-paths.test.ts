import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAdapter } from "../src/pi-adapter";

test("Codemode recommends direct calls and preserves Windows paths using raw templates", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-codemode-paths-"));
  const previousDataDir = process.env.QONE_DATA_DIR;
  process.env.QONE_DATA_DIR = path.join(root, "data");
  const faux = fauxProvider({ provider: "qone-codemode-paths", models: [{ id: "test" }] });
  const adapter = new PiAdapter(() => {});
  const file = String.raw`C:\Users\33039\temp\new-file.txt`;
  const command = "Write-Output '" + file + "'";
  const script = (tag = "") => "return (await tools.powershell({command: " + tag + "`" + command + "`})).output;";
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    Object.assign(adapter, { modelRuntime: runtime });
    faux.setResponses([
      (context) => {
        const system = context.messages.filter((message) => message.role === "system");
        expect(system.flatMap((message) => message.toolsAdded ?? []).map(({ name }) => name)).toContain("powershell");
        const guidance = system.map((message) => message.sections?.tool_guidance).join("\n");
        expect(guidance).toContain("call the direct tool when available");
        expect(guidance).toContain("String.raw");
        return fauxAssistantMessage(fauxToolCall("codemode", { code: script() }));
      },
      (context) => {
        const result = context.messages.at(-1);
        expect(result).toMatchObject({ role: "toolResult", toolName: "codemode", isError: true, details: { calls: [] } });
        const output = JSON.stringify(result?.content);
        expect(output).toContain("SyntaxError");
        expect(output).toContain("no shell or file tool ran");
        expect(output).toContain("String.raw");
        return fauxAssistantMessage(fauxToolCall("codemode", { code: script("String.raw") }));
      },
      (context) => {
        const result = context.messages.at(-1);
        expect(result).toMatchObject({ role: "toolResult", toolName: "codemode", isError: false, details: { calls: [{ name: "powershell", status: "ok" }] } });
        expect(JSON.stringify(result?.content)).toContain(JSON.stringify(file).slice(1, -1));
        return fauxAssistantMessage(fauxToolCall("codemode", { code: "const = 1;" }));
      },
      (context) => {
        const result = context.messages.at(-1);
        expect(result).toMatchObject({ role: "toolResult", toolName: "codemode", isError: true });
        expect(JSON.stringify(result?.content)).not.toContain("String.raw");
        return fauxAssistantMessage(fauxToolCall("powershell", { command }));
      },
      (context) => {
        const result = context.messages.at(-1);
        expect(result).toMatchObject({ role: "toolResult", toolName: "powershell", isError: false });
        expect(JSON.stringify(result?.content)).toContain(JSON.stringify(file).slice(1, -1));
        return fauxAssistantMessage(fauxText("Done"));
      },
    ]);
    await adapter.run("codemode-paths", "Print a literal Windows path", {
      cwd: root, model: "qone-codemode-paths/test", permissionMode: "full",
    }, () => {});
  } finally {
    await adapter.disposeSession("codemode-paths");
    if (previousDataDir === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = previousDataDir;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
