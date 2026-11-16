import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

test("real runtime NDJSON sync waits for native storage and restores configuration after restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-claude-e2e-"));
  const claude = path.join(root, "claude"); const data = path.join(root, "qone");
  mkdirSync(claude); mkdirSync(data);
  writeFileSync(path.join(claude, "CLAUDE.md"), "Imported global instructions");
  writeFileSync(path.join(data, "Qone.md"), "");
  const skillFile = path.join(claude, "skills", "removable", "SKILL.md");
  mkdirSync(path.dirname(skillFile), { recursive: true });
  writeFileSync(skillFile, "---\nname: removable\ndescription: removal e2e\n---\nkeep source");
  writeFileSync(path.join(claude, ".claude.json"), JSON.stringify({ mcpServers: { fixture: { command: "must-not-execute-qone-test", env: { KEY: "native-only-secret" } } } }));
  const start = () => Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/index.ts")], { cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, QONE_DATA_DIR: data, CLAUDE_CONFIG_DIR: claude, QONE_DB: path.join(data, "runtime", "qone.db"), QONE_LOG_DIR: path.join(data, "logs") }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let child = start(); let reader = child.stdout.getReader(); let buffer = "";
  const events: RuntimeEvent[] = []; const decoder = new TextDecoder();
  const request = async (command: RuntimeCommand, type: RuntimeEvent["type"]) => {
    child.stdin.write(JSON.stringify(command) + "\n");
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([
      (async () => {
        while (true) {
          const end = buffer.indexOf("\n");
          if (end < 0) { const chunk = await reader.read(); if (chunk.done) throw new Error("Runtime exited early"); buffer += decoder.decode(chunk.value, { stream: true }); continue; }
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          const decoded = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
          for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
            if (event.type === "claude-code.credentials") {
              expect(event.values).toEqual(expect.objectContaining({ [Object.keys(event.values)[0]!]: "native-only-secret" }));
              child.stdin.write(JSON.stringify({ type: "claude-code.credentials.saved", requestId: event.requestId, saved: true }) + "\n");
              continue;
            }
            events.push(event);
            if (event.type === "error") throw new Error(event.message);
            if (event.type === type) return event;
          }
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Sync runtime timed out")), 12_000); }),
    ]); } finally { clearTimeout(timer!); }
  };
  const stop = async () => { child.kill(); await child.exited; await reader.cancel(); };
  try {
    for (const target of ["prompt", "mcp", "skills"] as const) {
      const preview = await request({ type: "claude-code.sync", requestId: `preview-${target}`, target }, "claude-code.synced");
      if (preview.type !== "claude-code.synced") throw new Error();
      expect(preview.result.status).toBe("ready");
      const completed = await request({ type: "claude-code.sync", requestId: `apply-${target}`, target, apply: true, revision: preview.result.revision }, "claude-code.synced");
      if (completed.type !== "claude-code.synced") throw new Error();
      expect(completed.result).toMatchObject({ added: 1, failed: 0, status: "complete" });
    }
    const deleted = await request({ type: "skills.delete", requestId: "delete", skillId: "removable" }, "skills.deleted");
    expect(deleted).toMatchObject({ type: "skills.deleted", skillId: "removable" });
    expect(existsSync(skillFile)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(data, "config", "claude-code-skills.json"), "utf8")).skills).toEqual([]);
    expect(readFileSync(path.join(data, "Qone.md"), "utf8")).toBe("Imported global instructions");
    expect(events.filter(event => event.type === "mcp.connected")).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain("native-only-secret");
    await stop(); child = start(); reader = child.stdout.getReader(); buffer = "";
    const restored = await request({ type: "mcp.list", requestId: "restored" }, "mcp.list");
    if (restored.type !== "mcp.list") throw new Error();
    const remaining = await request({ type: "skills.list", requestId: "remaining" }, "skills.list");
    expect(remaining.type === "skills.list" && remaining.skills.some(skill => skill.id === "removable")).toBe(false);
    expect(restored.servers).toHaveLength(1);
    expect(restored.servers[0]).toMatchObject({ name: "fixture", command: "must-not-execute-qone-test", connected: false });
    expect(JSON.stringify(restored)).not.toContain("native-only-secret");
  } finally { await stop(); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}, 30_000);
