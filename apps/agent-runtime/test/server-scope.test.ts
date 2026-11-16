import { expect, test } from "bun:test";
import type { ServerInfo } from "@qone/protocol";
import { ServerService } from "../src/servers/server-service";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { PiAdapter } from "../src/pi-adapter";
import { hostname } from "node:os";

function environment(messages: unknown[]) {
  let section: string | undefined;
  for (const message of messages) {
    const value = message as { role?: string; sections?: Record<string, string | null> };
    if (value.role === "system" && value.sections && "execution_environment" in value.sections) section = value.sections.execution_environment ?? undefined;
  }
  if (!section) throw new Error("execution environment was not sent to the model");
  expect(section).toContain("ask one concise question");
  expect(section).toContain("lastKnownStatus is not a live connection check");
  return JSON.parse(section.slice(section.lastIndexOf("\n{") + 1, section.lastIndexOf("\n</execution_environment>")));
}

const server = (id: string): ServerInfo => ({ id, name: id, host: `${id}.example`, port: 22, username: "root", auth: { kind: "agent" }, status: "ready", createdAt: 0 });

test("SSH tools expose only selected servers and reject foreign terminals and deleted targets", async () => {
  const values = new Map<string, unknown>([["servers.list", [server("a"), server("b")]]]);
  const service = new ServerService({ get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, value) } as never, () => {}, async () => {});
  expect(service.tools(".")).toEqual([]);
  const tools = service.tools(".", ["a"]);
  const exec = tools.find(tool => tool.name === "server_exec")!;
  expect(JSON.stringify(exec.parameters)).toContain('"a"');
  expect(JSON.stringify(exec.parameters)).not.toContain('"b"');
  await expect(exec.execute("test", { server: "b", command: "uptime" }, undefined, undefined)).rejects.toThrow();
  const terminal = tools.find(tool => tool.name === "server_terminal")!;
  service.sessions.terminal = (() => ({ id: "foreign", serverId: "b" })) as never;
  for (const action of ["read", "write", "resize", "close"]) {
    await expect(terminal.execute("test", { action, terminal_id: "foreign" }, undefined, undefined)).rejects.toThrow();
  }
  values.set("servers.list", []);
  await expect(exec.execute("test", { server: "a", command: "uptime" }, undefined, undefined)).rejects.toThrow();
  service.dispose();
});

test("Pi rebuilds A → B → empty server scopes without losing conversation history", async () => {
  const values = new Map<string, unknown>([["servers.list", [server("a"), server("b")]]]);
  const service = new ServerService({ get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, value) } as never, () => {}, async () => {});
  const faux = fauxProvider({ provider: "server-scope", models: [{ id: "test" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const history: any[] = [];
  const adapter = new PiAdapter(event => {
    if (event.type === "message.completed") {
      const rawMessage = (event.payload as any).message;
      history.push({ role: rawMessage.role, content: "", rawMessage, createdAt: Date.now() });
    }
  }, { serverTools: (cwd, ids) => service.tools(cwd, ids), serverSummary: ids => service.summary(ids), serverTargets: ids => service.executionTargets(ids) }, undefined, () => history);
  Object.assign(adapter, { modelRuntime: runtime });
  faux.setResponses([
    context => {
      const current = environment(context.messages);
      expect(current.local).toMatchObject({ hostname: hostname(), platform: process.platform, cwd: process.cwd() });
      expect(current.local.tools).toContain("powershell");
      expect(current.serverTools).toContain("server_exec");
      expect(current.servers.map((server: ServerInfo) => server.id)).toEqual(["a"]);
      expect(JSON.stringify(context.messages)).not.toContain("b.example");
      return fauxAssistantMessage(fauxText("first answer"));
    },
    context => {
      expect(JSON.stringify(context.messages)).toContain("first answer");
      expect(environment(context.messages).servers.map((server: ServerInfo) => server.id)).toEqual(["b"]);
      return fauxAssistantMessage(fauxText("second answer"));
    },
    context => {
      expect(JSON.stringify(context.messages)).toContain("second answer");
      expect(environment(context.messages).servers).toEqual([]);
      expect(environment(context.messages).serverTools).toEqual([]);
      return fauxAssistantMessage(fauxText("done"));
    },
  ]);
  try {
    for (const serverIds of [["a"], ["b"], []]) await adapter.run("scope", "inspect", { model: "server-scope/test", cwd: process.cwd(), permissionMode: "full", serverIds }, () => {});
    expect(history.filter(message => message.role === "user")).toHaveLength(3);
  } finally { await adapter.disposeSession("scope"); service.dispose(); }
});

test("retained main, side and child sessions keep separate targets and refresh live server metadata", async () => {
  const values = new Map<string, unknown>([["servers.list", [server("a"), server("b")]]]);
  const service = new ServerService({ get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, value) } as never, () => {}, async () => {});
  const faux = fauxProvider({ provider: "environment-isolation", models: [{ id: "test" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const adapter = new PiAdapter(() => {}, { serverTools: (cwd, ids) => service.tools(cwd, ids), serverTargets: ids => service.executionTargets(ids) });
  Object.assign(adapter, { modelRuntime: runtime });
  adapter.setSideConversationResolver(id => id === "side");
  const request = (sessionId: string, serverIds: string[], subagentDepth = 0) => adapter.run(sessionId, "inspect", {
    cwd: process.cwd(), model: "environment-isolation/test", permissionMode: "full", serverIds,
    subagentDepth, ...(subagentDepth ? { subagentRunId: "child-run" } : {}),
  }, () => {});
  try {
    faux.setResponses([context => {
      expect(environment(context.messages).servers.map((server: ServerInfo) => server.id)).toEqual(["a"]);
      return fauxAssistantMessage(fauxText("main"));
    }]);
    await request("main", ["a"]);
    const mainSession = (adapter as any).sessions.get("main");
    expect(mainSession).toBeDefined();
    service.registry.update("a", { status: "offline", name: "Updated a" });
    faux.setResponses([context => {
      expect(environment(context.messages).servers.map((server: ServerInfo) => server.id)).toEqual(["b"]);
      return fauxAssistantMessage(fauxText("side"));
    }]);
    await request("side", ["b"]);
    faux.setResponses([context => {
      expect(environment(context.messages).servers.map((server: ServerInfo) => server.id)).toEqual(["b"]);
      return fauxAssistantMessage(fauxText("child"));
    }]);
    await request("child", ["b"], 1);
    faux.setResponses([context => {
      expect(environment(context.messages).servers).toEqual([{ id: "a", name: "Updated a", host: "a.example", port: 22,
        username: "root", lastKnownStatus: "offline" }]);
      expect((adapter as any).sessions.get("main")).toBe(mainSession);
      return fauxAssistantMessage(fauxText("refreshed"));
    }]);
    await request("main", ["a"]);
  } finally {
    await Promise.all(["main", "side", "child"].map(id => adapter.disposeSession(id)));
    service.dispose();
  }
});
