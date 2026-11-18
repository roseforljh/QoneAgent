import { expect, test } from "bun:test";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { PiAdapter } from "../src/pi-adapter";
import { applyToolExposure, usedToolNames } from "../src/tool-exposure";

test("durable session rebuilding preserves discovered tools without duplicating the tool catalog", async () => {
  const faux = fauxProvider({ provider: "tool-exposure-restore", models: [{ id: "model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const history: { role: string; content: string; createdAt: number; rawMessage: unknown }[] = [];
  const adapter = new PiAdapter(event => {
    if (event.type !== "message.completed") return;
    const rawMessage = (event.payload as { message: { role: string; content: unknown } }).message;
    if (["user", "assistant", "toolResult"].includes(rawMessage.role)) history.push({ role: rawMessage.role, content: "", rawMessage, createdAt: Date.now() });
  }, { serverTools: () => [makeTool(async () => ({ content: [{ type: "text", text: "result" }], details: {} }))] }, undefined, () => history);
  Object.assign(adapter, { modelRuntime: runtime });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("tool_search", { query: "SSH server execute command" })),
    fauxAssistantMessage(fauxToolCall("server_exec", { command: "read only" })),
    fauxAssistantMessage(fauxText("first result")),
    context => {
      expect((adapter as any).sessions.get("restore").getActiveToolNames()).toContain("server_exec");
      const user = context.messages.findLast(message => message.role === "user");
      expect(JSON.stringify(user?.content)).not.toContain("on-demand-tools");
      expect(JSON.stringify(context.messages)).toContain("first result");
      return fauxAssistantMessage(fauxText("restored result"));
    },
  ]);
  const options = { model: "tool-exposure-restore/model", cwd: process.cwd(), permissionMode: "full" as const };
  try {
    await adapter.run("restore", "discover a tool", options, () => {});
    expect(adapter.hasSession("restore")).toBe(false);
    await adapter.run("restore", "continue", options, () => {});
    expect(adapter.hasSession("restore")).toBe(false);
  } finally { await adapter.disposeSession("restore"); }
});

const makeTool = (execute: ToolDefinition["execute"]): ToolDefinition => ({
  name: "server_exec", label: "SSH command", description: "Execute an SSH server command",
  parameters: Type.Object({ command: Type.String() }), execute,
});

test("integrations defer their schemas and restore only tools used in history", () => {
  const tool = makeTool(async () => ({ content: [], details: {} }));
  const loadout = applyToolExposure([tool, { ...tool, name: "read" }], { name: "servers", description: "SSH servers" });
  expect(loadout.tools[0]!.exposure).toBe("deferred");
  expect(loadout.tools[1]!.exposure).toBeUndefined();
  expect(loadout.catalog).toContain("- servers: SSH servers");
  expect(loadout.catalog).not.toContain("server_exec");
  const mcpTool = { ...tool, name: "mcp_fixture_read_record", qoneToolName: "mcp:fixture:read_record" };
  const mcp = applyToolExposure([mcpTool]);
  expect(mcp.catalog).toContain("- mcp_fixture: MCP server fixture");
  expect(mcp.catalog).toContain("MCP server fixture, connected. Execute an SSH server command");
  expect(mcp.catalog).not.toContain(mcpTool.name);
  expect(applyToolExposure([mcpTool, { ...mcpTool, name: "mcp_fixture_search", qoneToolName: "mcp:fixture:search" }]).catalog).toBe(mcp.catalog);
  expect(usedToolNames([null, { content: "text" }, { content: [{ type: "toolCall", name: "server_exec" }, { type: "text", text: "read" }] }])).toEqual(new Set(["server_exec"]));
  expect([...usedToolNames([{ role: "toolResult", toolName: "tool_search", details: { loaded: ["qone_app_list", "server_exec"] } }, { content: [{ type: "toolCall", name: "server_exec" }, { type: "toolCall", name: "qone_rss_read" }] }])]).toEqual(["qone_app_list", "server_exec", "qone_rss_read"]);
});

test("Codemode discovers a deferred MCP tool and filters a batch in one model round trip", async () => {
  const faux = fauxProvider({ provider: "qone-batch", models: [{ id: "model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {});
  Object.assign(adapter, { modelRuntime: runtime });
  const ids = [1, 2, 3];
  const tool = {
    name: "mcp_fixture_read_record", qoneToolName: "mcp:fixture:read_record", label: "Read record",
    description: "Read a fixture record by numeric ID", parameters: Type.Object({ id: Type.Number() }),
    execute: async (_callId: string, { id }: { id: number }) => ({
      content: [{ type: "text" as const, text: JSON.stringify({ key: `record-${id}`, notes: "background-note ".repeat(200) }) }],
    }),
  };
  await adapter.setCustomTools([tool]);
  const calls = ids.map(id => fauxToolCall(tool.name, { id }));
  const discover = () => fauxAssistantMessage(fauxToolCall("tool_search", { query: "read fixture record" }));
  const batch = fauxAssistantMessage(fauxToolCall("codemode", { code: `
    const [tool] = await searchTools("read fixture record", { namespace: "mcp_fixture", limit: 1 });
    const rows = await Promise.all(${JSON.stringify(ids)}.map(id => tools[tool.name]({ id })));
    return rows.map(row => JSON.parse(row).key);
  ` }));
  const reports = [];
  for (const [mode, steps] of Object.entries({
    serial: [discover(), ...calls.map(call => fauxAssistantMessage(call))],
    parallel: [discover(), fauxAssistantMessage(calls)],
    codemode: [batch],
  })) {
    const requests: string[] = [];
    faux.setResponses([
      ...steps.map<FauxResponseFactory>((step, index) => context => {
        const messages = JSON.stringify(context.messages);
        if (index === 0) expect(messages).not.toContain(tool.name);
        requests.push(messages);
        return step;
      }),
      context => {
        const messages = JSON.stringify(context.messages);
        for (const id of ids) expect(messages).toContain(`record-${id}`);
        expect(messages.includes("background-note")).toBe(mode !== "codemode");
        requests.push(messages);
        return fauxAssistantMessage(fauxText("done"));
      },
    ]);
    try {
      await adapter.run(mode, "Find the keys of fixture records 1, 2 and 3", { model: "qone-batch/model", cwd: process.cwd(), permissionMode: "full" }, () => {});
    } finally { await adapter.disposeSession(mode); }
    reports.push({ mode, requests: requests.length, messageBytes: requests.reduce((sum, request) => sum + Buffer.byteLength(request), 0) });
  }
  expect(reports.map(report => report.requests)).toEqual([5, 3, 2]);
  expect(reports[2]!.messageBytes).toBeLessThan(reports[1]!.messageBytes);
  console.info("Tool batch fixture (serialized model messages):", JSON.stringify(reports));
});

test("tool_search loads deferred tools; scripts use live Qone approval modes", async () => {
  const faux = fauxProvider({ provider: "qone-tool-exposure", models: [{ id: "test" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  let executions = 0;
  let approvals = 0;
  let reject = false;
  const failures: string[] = [];
  const scripts: string[] = [];
  let adapter: PiAdapter;
  adapter = new PiAdapter((event) => {
    const payload = event.payload as any;
    if (event.type === "approval.requested") {
      approvals++;
      expect(payload.toolName).toBe("server_exec");
      // Changing the composer's mode must release an already waiting nested call.
      if (reject) adapter.reject(payload.approvalId);
      else adapter.setPermissionMode("exposure", "full");
    }
    if (event.type === "tool.failed") failures.push(JSON.stringify(payload));
    if (event.type === "tool.completed" && payload.toolName === "codemode") scripts.push(JSON.stringify(payload.result));
  }, { serverTools: () => [makeTool(async () => { executions++; return { content: [{ type: "text", text: "executed" }], details: {} }; })] });
  Object.assign(adapter, { modelRuntime: runtime });
  const active = () => (adapter as any).sessions.get("exposure").getActiveToolNames() as string[];
  faux.setResponses([
    () => {
      expect(active()).toContain("tool_search");
      expect(active()).toContain("codemode");
      expect(active()).not.toContain("server_exec");
      return fauxAssistantMessage(fauxToolCall("codemode", { code: 'return await tools.server_exec({command: "restart service"});' }));
    },
    fauxAssistantMessage(fauxText("script done")),
    () => {
      expect(active()).not.toContain("server_exec");
      return fauxAssistantMessage(fauxToolCall("tool_search", { query: "SSH server execute command" }));
    },
    () => {
      expect(active()).toContain("server_exec");
      return fauxAssistantMessage(fauxToolCall("server_exec", { command: "restart service" }));
    },
    fauxAssistantMessage(fauxText("search done")),
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'return await tools.server_exec({command: "restart service"});' })),
    fauxAssistantMessage(fauxText("auto done")),
  ]);
  const options = { cwd: process.cwd(), model: "qone-tool-exposure/test" };
  try {
    await adapter.run("exposure", "execute in script", { ...options, permissionMode: "ask" }, () => {});
    expect(approvals).toBe(1);
    expect(executions).toBe(1);
    await adapter.run("exposure", "find SSH tool", { ...options, permissionMode: "full" }, () => {});
    expect(approvals).toBe(1);
    expect(executions).toBe(2);
    await adapter.run("exposure", "execute again", { ...options, permissionMode: "auto" }, () => {});
    expect(approvals).toBe(2);
    expect(executions).toBe(3);
    expect(scripts).toHaveLength(2);
    expect(scripts.every((result) => result.includes("executed"))).toBe(true);
    expect(failures).toEqual([]);
    reject = true;
    faux.appendResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code: 'return await tools.server_exec({command: "restart service"});' })),
      fauxAssistantMessage(fauxText("rejected")),
    ]);
    await adapter.run("exposure", "reject this call", { ...options, permissionMode: "ask" }, () => {});
    expect(approvals).toBe(3);
    expect(executions).toBe(3);
  } finally {
    await adapter.disposeSession("exposure");
  }
}, 60_000);
