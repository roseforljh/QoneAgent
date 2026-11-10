import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpManager, type McpServerConfig } from "../src/index";

const fixture = path.join(import.meta.dir, "fixtures", "stdio-server-tree.ts");
const workDir = mkdtempSync(path.join(os.tmpdir(), "qone-mcp-tree-"));
const logPath = path.join(workDir, "calls.ndjson");
const entries = (): { event: string; pid?: number; grandchildPid?: number }[] =>
  existsSync(logPath)
    ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];

const manager = new McpManager();
const config: McpServerConfig = {
  id: "tree-fixture",
  name: "Tree fixture",
  command: process.execPath,
  args: ["run", fixture],
  env: { QONE_MCP_TEST_LOG: logPath },
};

afterAll(async () => {
  await manager.disconnectAll();
  rmSync(workDir, { recursive: true, force: true });
});

/** True while the pid is still a live process. */
function isAlive(pid: number): boolean {
  if (process.platform === "win32") {
    const probe = Bun.spawnSync(["tasklist", "/FI", `PID eq ${pid}`, "/NH"], { stdout: "pipe", stderr: "ignore" });
    const out = probe.stdout.toString();
    return out.includes(String(pid)) && !out.toLowerCase().includes("no tasks");
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitGone(pid: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("disconnect kills the whole stdio process tree, not just the direct child", async () => {
  const tools = await manager.connect(config);
  const tree = tools.find((tool) => (tool as { qoneToolName?: string }).qoneToolName === "mcp:tree-fixture:tree")!;

  await tree.execute("call-tree", {}, undefined, undefined, {} as never);
  const deadline = Date.now() + 10_000;
  while (!entries().some((entry) => entry.event === "tree") && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const recorded = entries().find((entry) => entry.event === "tree");
  expect(recorded?.pid).toBeDefined();
  const grandchildPid = recorded!.grandchildPid!;
  expect(grandchildPid).toBeGreaterThan(0);
  // Both the server and its child are up before teardown, otherwise the
  // assertion below would pass for the wrong reason.
  expect(isAlive(grandchildPid)).toBe(true);

  await manager.disconnect(config.id);

  expect(await waitGone(recorded!.pid!)).toBe(true);
  expect(await waitGone(grandchildPid)).toBe(true);
}, 60_000);