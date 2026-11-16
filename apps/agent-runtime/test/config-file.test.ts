import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigFile, McpServerRepo, ModelConfigRepo, PreferencesRepo } from "@qone/database";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "qone-config-files-")); roots.push(root);
  return new ConfigFile(path.join(root, "settings.json"));
}

test("the file keeps Claude Code's shape, never stores literal secrets and survives broken or deleted edits", () => {
  const settings = fixture();
  const repo = new McpServerRepo(settings);
  repo.upsert({ id: "remote", name: "Remote", url: "https://r.dev/sse", transport: "sse", headers: { Authorization: "$mcp.env:remote/header-authorization", Plain: "secret" }, connected: true, connecting: true, toolCount: 3 });
  expect(JSON.parse(readFileSync(settings.file, "utf8")).mcpServers.remote).toEqual({ name: "Remote", url: "https://r.dev/sse", type: "sse", headers: { Authorization: "$mcp.env:remote/header-authorization" } });
  expect(repo.list()[0]).toMatchObject({ id: "remote", transport: "sse" });
  const models = new ModelConfigRepo(settings);
  models.upsert({ id: "a", provider: "p", model: "a" }); models.upsert({ id: "b", provider: "p", model: "b" }); models.upsert({ id: "a", provider: "p", model: "a2" });
  expect(models.list().map(model => `${model.id}:${model.model}`)).toEqual(["a:a2", "b:b"]);

  const changes: unknown[] = [], errors: string[] = [];
  settings.onExternalChange((_previous, next) => changes.push(next));
  settings.onInvalid(error => errors.push(error.message));
  writeFileSync(settings.file, "{ \"mcpServers\": ");
  settings.reload();
  expect(errors).toHaveLength(1);
  expect(() => repo.upsert({ id: "x", name: "x", command: "x" })).toThrow("syntax error");
  expect(repo.list()).toHaveLength(1);
  writeFileSync(settings.file, JSON.stringify({ mcpServers: { local: { command: "npx", args: ["-y", "tool"] } } }));
  settings.reload();
  expect(changes).toHaveLength(1);
  expect(repo.list()).toEqual([{ id: "local", name: "local", command: "npx", args: ["-y", "tool"] }]);
  rmSync(settings.file);
  settings.reload();
  expect(JSON.parse(readFileSync(settings.file, "utf8")).mcpServers.local.command).toBe("npx");
  writeFileSync(settings.file, "");
  settings.reload();
  expect(repo.list()).toHaveLength(1);
  expect(settings.error).toBeDefined();
  expect(() => repo.delete("local")).toThrow("syntax error");
});

test("a UI save merges external changes before the watch debounce, and reads cannot mutate stored state", () => {
  const settings = fixture();
  const preferences = new PreferencesRepo(settings);
  preferences.set("first", 1);
  const external = JSON.parse(readFileSync(settings.file, "utf8"));
  external.preferences.external = 2;
  external.mcpServers = { local: { command: "tool" } };
  writeFileSync(settings.file, JSON.stringify(external));
  preferences.set("ui", 3);
  expect(JSON.parse(readFileSync(settings.file, "utf8"))).toMatchObject({ preferences: { first: 1, external: 2, ui: 3 }, mcpServers: { local: { command: "tool" } } });
  const copy = settings.read<Record<string, unknown>>("preferences")!;
  copy.first = "not saved";
  expect(preferences.get("first")).toBe(1);
});
