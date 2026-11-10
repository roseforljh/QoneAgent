import { describe, expect, test } from "bun:test";
import { runToolCall } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { McpManager } from "@qone/mcp";
import type { ModelConfigInfo } from "@qone/protocol";
import { Type } from "typebox";
import { PiAdapter } from "../src/pi-adapter.js";

const assistantMessage = fauxAssistantMessage(fauxToolCall("noop", {}));

/** Run one tool call through the same preparation + validation path the agent loop uses. */
async function call(tool: ToolDefinition, args: unknown) {
  return runToolCall({ id: "call-1", name: tool.name, arguments: args } as never, {
    tools: [tool as never],
    assistantMessage,
    context: { messages: [] },
  });
}

const searchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    limit: { type: "number" },
    nested: {
      type: "object",
      properties: { deep: { type: "string" } },
      required: ["deep"],
      additionalProperties: false,
    },
  },
  required: ["query", "nested"],
  additionalProperties: false,
};

/** A real McpManager.adaptTool() definition, with a recording stand-in for the MCP client. */
function mcpTool(
  inputSchema?: unknown,
  extra: { outputSchema?: unknown; structuredContent?: unknown } = {},
) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const manager = new McpManager();
  const tool = (manager as unknown as {
    adaptTool(config: { id: string; name: string }, client: unknown, def: unknown): ToolDefinition;
  }).adaptTool({ id: "demo", name: "Demo" }, {
    callTool: async (request: { name: string; arguments: Record<string, unknown> }) => {
      calls.push(request);
      return {
        content: [{ type: "text", text: "ok" }],
        ...(extra.structuredContent === undefined ? {} : { structuredContent: extra.structuredContent }),
      };
    },
  }, { name: "search", description: "Search", inputSchema, outputSchema: extra.outputSchema });
  return { tool, calls };
}

describe("Pi 1.5 pi-schema compatibility", () => {
  test("plain TypeBox schemas still enforce required fields and coerce numbers", async () => {
    const calls: unknown[] = [];
    const tool = {
      name: "plain",
      label: "Plain",
      description: "Plain TypeBox tool",
      parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }),
      execute: async (_id: string, params: unknown) => {
        calls.push(params);
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    } as ToolDefinition;

    const optional = await call(tool, { query: "x" });
    expect(optional.isError).toBe(false);

    const coerced = await call(tool, { query: "x", limit: "3" });
    expect(coerced.isError).toBe(false);
    expect(calls).toEqual([{ query: "x" }, { query: "x", limit: 3 }]);

    const missing = await call(tool, { limit: 2 });
    expect(missing.isError).toBe(true);
    expect(String(missing.result.content[0] && "text" in missing.result.content[0] ? missing.result.content[0].text : ""))
      .toContain("query: missing");
    expect(calls).toHaveLength(2);
  });

  test("Type.Unsafe schemas from adaptTool validate required, optional and nested arguments", async () => {
    const { tool, calls } = mcpTool(searchSchema);

    const minimal = await call(tool, { query: "x", nested: { deep: "y" } });
    expect(minimal.isError).toBe(false);
    const optional = await call(tool, { query: "x", nested: { deep: "y" }, limit: "2" });
    expect(optional.isError).toBe(false);
    // Validation coerces before execution, so the MCP server receives the typed value.
    expect(calls.map((entry) => entry.arguments)).toEqual([
      { query: "x", nested: { deep: "y" } },
      { query: "x", nested: { deep: "y" }, limit: 2 },
    ]);
  });

  test("invalid Type.Unsafe arguments fail validation and never reach the MCP server", async () => {
    const { tool, calls } = mcpTool(searchSchema);

    const missingRequired = await call(tool, { query: "x" });
    expect(missingRequired.isError).toBe(true);
    expect(String((missingRequired.result.content[0] as { text?: string }).text)).toContain("nested: missing");

    const unknownTopLevel = await call(tool, { query: "x", nested: { deep: "y" }, extra: 1 });
    expect(unknownTopLevel.isError).toBe(true);
    expect(String((unknownTopLevel.result.content[0] as { text?: string }).text)).toContain("extra: unknown field");

    const unknownNested = await call(tool, { query: "x", nested: { deep: "y", extra: 1 } });
    expect(unknownNested.isError).toBe(true);
    expect(String((unknownNested.result.content[0] as { text?: string }).text)).toContain("nested.extra: unknown field");

    const missingNested = await call(tool, { query: "x", nested: {} });
    expect(missingNested.isError).toBe(true);
    expect(String((missingNested.result.content[0] as { text?: string }).text)).toContain("nested.deep: missing");

    expect(calls).toHaveLength(0);
  });

  test("adaptTool without an input schema keeps accepting arbitrary arguments", async () => {
    const { tool, calls } = mcpTool(undefined);
    const result = await call(tool, { anything: [1, 2] });
    expect(result.isError).toBe(false);
    expect(calls).toEqual([{ name: "search", arguments: { anything: [1, 2] } }]);
  });

  test("a model-issued MCP call runs with coerced arguments and a bad call fails without executing", async () => {
    const { tool, calls } = mcpTool(searchSchema);
    const faux = fauxProvider({ provider: "qone-schema", models: [{ id: "test-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(tool.name, { query: "x", nested: { deep: "y" }, limit: "3" })),
      fauxAssistantMessage(fauxToolCall(tool.name, { query: "x", bogus: true })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const toolEvents: { type: string; name: string; isError?: boolean; text?: string }[] = [];
    const adapter = new PiAdapter((event) => {
      const payload = event.payload as { toolName?: string; isError?: boolean; result?: { content?: { text?: string }[] } } | undefined;
      if (event.type === "tool.completed" || event.type === "tool.failed") {
        toolEvents.push({
          type: event.type,
          name: String(payload?.toolName),
          isError: payload?.isError,
          text: payload?.result?.content?.[0]?.text,
        });
      }
    });
    Object.assign(adapter, { modelRuntime: runtime });
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-schema/test-model", provider: "qone-schema", model: "test-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-compatible", input: ["text"], output: ["text"] },
    }];
    await adapter.setCustomTools([tool]);
    try {
      await adapter.run("schema", "go", { cwd: process.cwd(), model: "qone-schema/test-model", permissionMode: "full" }, () => {});
      expect(calls).toEqual([{ name: "search", arguments: { query: "x", nested: { deep: "y" }, limit: 3 } }]);
      expect(toolEvents.map((event) => event.type)).toEqual(["tool.completed", "tool.failed"]);
      expect(toolEvents[1].text).toContain("unknown field");
    } finally {
      await adapter.disposeSession("schema");
    }
  });

  test("adaptTool keeps outputSchema and structuredContent so codemode scripts receive structured values", async () => {
    const { tool } = mcpTool({ type: "object", properties: {} }, {
      outputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"] },
      structuredContent: { marker: "STRUCTURED" },
    });
    expect(JSON.parse(JSON.stringify(tool.outputSchema)))
      .toEqual({ type: "object", properties: { marker: { type: "string" } }, required: ["marker"] });

    const direct = await tool.execute("call-1", {}, undefined, undefined, {} as never);
    expect(direct.structuredContent).toEqual({ marker: "STRUCTURED" });

    const faux = fauxProvider({ provider: "qone-codemode-schema", models: [{ id: "test-model" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", {
        code: 'const r = await tools.mcp_demo_search({}); return typeof r === "object" && r !== null && r.marker === "STRUCTURED" ? "OBJECT-OK" : "NOT-STRUCTURED:" + String(r);',
      })),
      fauxAssistantMessage(fauxText("done")),
    ]);
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const codemodeResults: { content?: { text?: string }[] }[] = [];
    const adapter = new PiAdapter((event) => {
      const payload = event.payload as { toolName?: string; result?: { content?: { text?: string }[] } } | undefined;
      if (event.type === "tool.completed" && payload?.toolName === "codemode") codemodeResults.push(payload.result ?? {});
    });
    Object.assign(adapter, { modelRuntime: runtime });
    (adapter as unknown as { configuredModelConfigs: ModelConfigInfo[] }).configuredModelConfigs = [{
      id: "qone-codemode-schema/test-model", provider: "qone-codemode-schema", model: "test-model", enabled: true, updatedAt: 1,
      config: { apiType: "openai-compatible", input: ["text"], output: ["text"] },
    }];
    await adapter.setCustomTools([tool]);
    try {
      await adapter.run("codemode-schema", "go", { cwd: process.cwd(), model: "qone-codemode-schema/test-model", permissionMode: "full" }, () => {});
      const text = codemodeResults[0]?.content?.map((part) => part.text).join("");
      // The script itself proves the nested call resolved to the structured object.
      expect(text).toContain("OBJECT-OK");
      expect(text).not.toContain("NOT-STRUCTURED");
    } finally {
      await adapter.disposeSession("codemode-schema");
    }
  });

  test("adaptTool forwards the abort signal to client.callTool", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    let abortRequest: (() => void) | undefined;
    let rejectedByAbort = false;
    const manager = new McpManager();
    const tool = (manager as unknown as {
      adaptTool(config: { id: string; name: string }, client: unknown, def: unknown): ToolDefinition;
    }).adaptTool({ id: "demo", name: "Demo" }, {
      callTool: async (_request: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        // Without a forwarded signal the in-flight call could never be cancelled.
        if (!options?.signal) throw new Error("missing request signal");
        const aborted = new Promise<never>((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => {
            rejectedByAbort = true;
            reject(new Error("request aborted"));
          }, { once: true });
        });
        // The request is in flight when the run is cancelled.
        abortRequest?.();
        await aborted;
        return { content: [{ type: "text", text: "unreachable" }] };
      },
    }, { name: "search", description: "Search", inputSchema: { type: "object", properties: {} } });

    const controller = new AbortController();
    abortRequest = () => controller.abort();
    const result = await runToolCall({ id: "call-1", name: tool.name, arguments: {} } as never, {
      tools: [tool as never],
      assistantMessage,
      context: { messages: [] },
      signal: controller.signal,
    });

    expect(signals).toEqual([controller.signal]);
    expect(signals[0]?.aborted).toBe(true);
    // The mock rejected from its abort listener, and Pi surfaced that rejection as the tool error.
    expect(rejectedByAbort).toBe(true);
    expect(result.isError).toBe(true);
    expect((result.result.content[0] as { text?: string }).text).toBe("request aborted");
  });
});