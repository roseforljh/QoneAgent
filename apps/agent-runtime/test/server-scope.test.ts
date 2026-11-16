import { expect, test } from "bun:test";
import type { ServerInfo } from "@qone/protocol";
import { ServerService } from "../src/servers/server-service";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { PiAdapter } from "../src/pi-adapter";

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
  }, { serverTools: (cwd, ids) => service.tools(cwd, ids), serverSummary: ids => service.summary(ids) }, undefined, () => history);
  Object.assign(adapter, { modelRuntime: runtime });
  faux.setResponses([
    context => { expect(JSON.stringify(context.messages)).toContain("a.example"); expect(JSON.stringify(context.messages)).not.toContain("b.example"); return fauxAssistantMessage(fauxText("first answer")); },
    context => { expect(JSON.stringify(context.messages)).toContain("first answer"); expect(JSON.stringify(context.messages)).toContain("b.example"); return fauxAssistantMessage(fauxText("second answer")); },
    context => { expect(JSON.stringify(context.messages)).toContain("second answer"); return fauxAssistantMessage(fauxText("done")); },
  ]);
  try {
    for (const serverIds of [["a"], ["b"], []]) await adapter.run("scope", "inspect", { model: "server-scope/test", cwd: process.cwd(), permissionMode: "full", serverIds }, () => {});
    expect(history.filter(message => message.role === "user")).toHaveLength(3);
  } finally { await adapter.disposeSession("scope"); service.dispose(); }
});
