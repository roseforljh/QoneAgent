import { expect, test } from "bun:test";
import { openDb, openConfigDb, openMcpDb, ModelConfigRepo, McpServerRepo, PermissionRepo, SettingsRepo, SessionRepo } from "@qone/database";
import { moveDomainData } from "../src/domain-data";

test("configuration and MCP move to separate stores while conversation state stays in the runtime", () => {
  const runtime = openDb(":memory:"), config = openConfigDb(":memory:"), mcp = openMcpDb(":memory:");
  try {
    const session = new SessionRepo(runtime).create("Keep conversation");
    new ModelConfigRepo(runtime).upsert({ id: "model", provider: "test", model: "test" });
    new McpServerRepo(runtime).upsert({ id: "server", name: "Server", command: "tool", env: { API_KEY: "never persist", SAFE: "$ENV" } });
    new PermissionRepo(runtime).set("builtin", "filesystem.read", "allow");
    const settings = new SettingsRepo(runtime);
    settings.set("compaction.settings", { autoCompactionEnabled: false });
    settings.set("subagents.config", { profiles: [] });
    settings.set(`queue:${session.id}`, ["keep runtime state"]);
    moveDomainData(runtime, config, mcp);
    expect(new SessionRepo(runtime).get(session.id)?.title).toBe("Keep conversation");
    expect(settings.get(`queue:${session.id}`)).toEqual(["keep runtime state"]);
    expect(settings.get("compaction.settings")).toBeUndefined();
    expect(new SettingsRepo(config).get("compaction.settings")).toEqual({ autoCompactionEnabled: false });
    expect(new ModelConfigRepo(config).list()).toHaveLength(1);
    expect(new PermissionRepo(config).get("builtin", "filesystem.read")).toBe("allow");
    expect(new McpServerRepo(mcp).list()[0]?.env).toEqual({ SAFE: "$ENV" });
    expect(new ModelConfigRepo(runtime).list()).toEqual([]);
    expect(new McpServerRepo(runtime).list()).toEqual([]);
    expect(new PermissionRepo(runtime).list()).toEqual([]);
    expect(config.$client.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([
      { name: "model_configs" }, { name: "permission_rules" }, { name: "settings" },
    ]);
    expect(mcp.$client.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: "mcp_servers" }]);
    moveDomainData(runtime, config, mcp);
    expect(new ModelConfigRepo(config).list()).toHaveLength(1);
  } finally { runtime.$client.close(); config.$client.close(); mcp.$client.close(); }
});

test("a failed move preserves source data and a retry never overwrites newer destination configuration", () => {
  const runtime = openDb(":memory:"), config = openConfigDb(":memory:");
  let mcp = openMcpDb(":memory:");
  try {
    new ModelConfigRepo(runtime).upsert({ id: "model", provider: "test", model: "old" });
    new McpServerRepo(runtime).upsert({ id: "server", name: "Server", command: "tool" });
    mcp.$client.close();
    expect(() => moveDomainData(runtime, config, mcp)).toThrow();
    expect(new ModelConfigRepo(runtime).list()).toHaveLength(1);
    expect(new McpServerRepo(runtime).list()).toHaveLength(1);
    config.$client.query("UPDATE model_configs SET model=?, updated_at=updated_at+1000").run("newer");
    mcp = openMcpDb(":memory:");
    moveDomainData(runtime, config, mcp);
    expect(new ModelConfigRepo(config).list()[0]?.model).toBe("newer");
    expect(new ModelConfigRepo(runtime).list()).toEqual([]);
    expect(new McpServerRepo(mcp).list()).toHaveLength(1);
  } finally { runtime.$client.close(); config.$client.close(); mcp.$client.close(); }
});
