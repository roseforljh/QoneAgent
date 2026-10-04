import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ArtifactRepo, McpServerRepo, closeDb, openDb } from "@qone/database";
import { qoneProjectDir, qoneSessionDir } from "@qone/shared";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

test("the real sidecar creates, restores and deletes project/session resources without moving source files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-layout-test-"));
  const data = path.join(root, "data");
  const source = path.join(root, "source");
  mkdirSync(source);
  writeFileSync(path.join(source, "source.txt"), "preserve source");
  const dbPath = path.join(data, "runtime", "qone.db");
  const start = () => Bun.spawn([Bun.which("bun")!, path.resolve(import.meta.dir, "../src/index.ts")], {
    env: { ...Bun.env, QONE_DATA_DIR: data, QONE_DB: dbPath, QONE_LOG_DIR: path.join(data, "logs") },
    stdin: "pipe", stdout: "pipe", stderr: "ignore",
  });
  let child = start();
  let reader = child.stdout.getReader();
  let buffer = "";
  const decoder = new TextDecoder();
  const request = async (command: RuntimeCommand, expected: RuntimeEvent["type"]): Promise<RuntimeEvent> => {
    child.stdin.write(`${JSON.stringify(command)}\n`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          while (true) {
            const end = buffer.indexOf("\n");
            if (end >= 0) {
              const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
              const output = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
              for (const event of Array.isArray(output) ? output : [output]) {
                if (event.type === "error") throw new Error(event.message);
                if (event.type === expected) return event;
              }
              continue;
            }
            const chunk = await reader.read();
            if (chunk.done) throw new Error("Sidecar exited before response");
            buffer += decoder.decode(chunk.value, { stream: true });
          }
        })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Layout request timed out")), 8000); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const stop = async () => { child.kill(); await child.exited; await reader.cancel(); };
  try {
    const projectEvent = await request({ type: "workspace.upsert", requestId: "project", name: "Project", path: source }, "workspace.updated");
    if (projectEvent.type !== "workspace.updated") throw new Error("Missing project");
    const project = projectEvent.workspace;
    const skills = await request({ type: "skills.list", requestId: "skills", cwd: source }, "skills.list");
    if (skills.type !== "skills.list") throw new Error("Missing skills");
    expect(skills.skills).toContainEqual(expect.objectContaining({ id: "ponytail", builtin: true, enabled: true }));
    expect(skills.skills.filter((skill) => skill.builtin).map((skill) => skill.name)).toEqual([
      "ponytail", "ponytail-review", "ponytail-audit", "ponytail-debt", "ponytail-gain", "ponytail-help",
    ]);
    const disabled = await request({ type: "skills.builtin.set-enabled", requestId: "disable", skillId: "ponytail", enabled: false }, "skills.builtin.changed");
    if (disabled.type !== "skills.builtin.changed") throw new Error("Missing skill change");
    expect(disabled.skill.enabled).toBe(false);
    const projects = path.join(data, "projects");
    expect(JSON.parse(readFileSync(path.join(qoneProjectDir(project.id, projects), "project.json"), "utf8"))).toMatchObject({ id: project.id, path: source });
    const created = await request({ type: "session.create", requestId: "create", workspaceId: project.id, title: "First" }, "session.created");
    if (created.type !== "session.created") throw new Error("Missing session");
    const session = created.session;
    const directory = qoneSessionDir(project.id, session.id, projects);
    for (const name of ["session.json", "attachments", "artifacts"]) expect(existsSync(path.join(directory, name))).toBe(true);
    await request({ type: "session.rename", requestId: "rename", sessionId: session.id, title: "Renamed" }, "session.renamed");
    expect(JSON.parse(readFileSync(path.join(directory, "session.json"), "utf8")).title).toBe("Renamed");
    expect(existsSync(path.join(data, "Qone.md"))).toBe(true);
    expect(existsSync(path.join(data, "config", "settings.db"))).toBe(true);
    expect(existsSync(path.join(data, "mcp", "servers.db"))).toBe(true);
    expect(existsSync(path.join(data, "agent.db"))).toBe(false);
    await stop();
    const db = openDb(dbPath);
    try {
      const media = path.join(directory, "artifacts", "saved.mp3");
      writeFileSync(media, new Uint8Array([1]));
      new ArtifactRepo(db).add({ sessionId: session.id, type: "audio", name: "saved.mp3", path: media });
      new McpServerRepo(db).upsert({ id: "fixture", name: "Fixture", command: "unused-test-tool" });
    } finally { closeDb(db); }
    child = start(); reader = child.stdout.getReader(); buffer = "";
    const restoredSkills = await request({ type: "skills.list", requestId: "restored-skills", cwd: source }, "skills.list");
    if (restoredSkills.type !== "skills.list") throw new Error("Missing restored skills");
    expect(restoredSkills.skills).toContainEqual(expect.objectContaining({ id: "ponytail", builtin: true, enabled: false }));
    await request({ type: "skills.builtin.set-enabled", requestId: "enable", skillId: "ponytail", enabled: true }, "skills.builtin.changed");
    const restored = await request({ type: "session.list", requestId: "restore" }, "session.list");
    if (restored.type !== "session.list") throw new Error("Missing restored sessions");
    expect(restored.sessions).toContainEqual(expect.objectContaining({ id: session.id, title: "Renamed" }));
    const servers = await request({ type: "mcp.list", requestId: "servers" }, "mcp.list");
    if (servers.type !== "mcp.list") throw new Error("Missing MCP servers");
    expect(servers.servers).toContainEqual(expect.objectContaining({ id: "fixture", connected: false }));
    await request({ type: "session.delete", requestId: "delete", sessionId: session.id }, "pong");
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(path.join(source, "source.txt"), "utf8")).toBe("preserve source");
  } finally {
    await stop();
    if (path.dirname(path.resolve(root)) !== path.resolve(tmpdir())) throw new Error("Unsafe test cleanup path");
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("resource IDs cannot escape the resource root or collide with reserved Windows names", () => {
  const root = path.join(tmpdir(), "qone-resource-ids");
  const encoded = qoneSessionDir("CON", "../../outside::subagent", root);
  expect(path.relative(root, encoded).startsWith("..")).toBe(false);
  expect(encoded).toContain("id-CON");
  expect(path.basename(encoded)).toContain("%2F");
  expect(() => qoneProjectDir("..", root)).toThrow();
});
