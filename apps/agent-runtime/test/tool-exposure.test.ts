import { expect, test } from "bun:test";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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
  expect(loadout.catalog).toContain("server_exec");
  expect(usedToolNames([null, { content: "text" }, { content: [{ type: "toolCall", name: "server_exec" }, { type: "text", text: "read" }] }])).toEqual(new Set(["server_exec"]));
  expect([...usedToolNames([{ role: "toolResult", toolName: "tool_search", details: { loaded: ["qone_app_list", "server_exec"] } }, { content: [{ type: "toolCall", name: "server_exec" }, { type: "toolCall", name: "qone_rss_read" }] }])]).toEqual(["qone_app_list", "server_exec", "qone_rss_read"]);
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
