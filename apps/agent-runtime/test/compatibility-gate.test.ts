import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { defineTool, ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { safeToolName } from "@qone/mcp";
import { Type } from "typebox";
import { PiAdapter } from "../src/pi-adapter.js";

describe("Pi model tool compatibility", () => {
  test("the actual adapter sends only Pi tools and legal MCP names to the model", async () => {
    const faux = fauxProvider({ provider: "qone-compat", models: [{ id: "test-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    let sentNames: string[] = [];
    faux.setResponses([(context) => {
      sentNames = getCurrentTools(context.messages).map((tool) => tool.name);
      return fauxAssistantMessage(fauxText("ok"));
    }]);
    const adapter = new PiAdapter(() => {});
    (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
    const originalName = "mcp:demo:search";
    const mcpTool = defineTool({
      name: safeToolName(originalName),
      label: "Search",
      description: "MCP search",
      parameters: Type.Object({ query: Type.String() }),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    }) as ToolDefinition & { qoneToolName?: string };
    mcpTool.qoneToolName = originalName;
    await adapter.setCustomTools([mcpTool]);

    try {
      await adapter.run("compatibility", "ping", {
        cwd: process.cwd(), model: "qone-compat/test-model", permissionMode: "full",
      }, () => {});
      const expected = ["read", "powershell", "edit", "write", "grep", "find", "ls", "mcp_demo_search"];
      expect(adapter.getSessions()[0]?.getActiveToolNames()).toEqual(expected);
      expect(sentNames).toEqual(expected);
      expect(sentNames.every((name) => /^[a-zA-Z0-9_-]+$/.test(name))).toBe(true);
    } finally {
      await adapter.disposeSession("compatibility");
    }
  });

  test("rejects malformed custom names before making a model request", async () => {
    const adapter = new PiAdapter(() => {});
    const invalidTool = defineTool({
      name: "invalid.name",
      label: "Invalid",
      description: "Invalid model name",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    });
    await adapter.setCustomTools([invalidTool]);
    await expect(adapter.run("invalid", "ping", { cwd: process.cwd() }, () => {}))
      .rejects.toThrow("Invalid model tool name: invalid.name");
  });
});
