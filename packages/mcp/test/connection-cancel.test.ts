import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager } from "../src/index";

test("disconnect cancels a silent stdio handshake and kills its unregistered process", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-mcp-pending-"));
  const pidFile = path.join(root, "pid");
  const manager = new McpManager();
  const config = { id: "silent", name: "Silent", command: process.execPath,
    args: ["-e", 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)', pidFile] };
  const connection = manager.connect(config).then(() => undefined, (error: Error) => error);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(pidFile) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const start = Date.now();
    await manager.disconnect(config.id);
    expect((await connection)?.message).toContain("disconnected during connect");
    expect(Date.now() - start).toBeLessThan(3000);
    expect(manager.isConnected(config.id)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await manager.disconnectAll(); rmSync(root, { recursive: true, force: true }); }
}, 8000);
