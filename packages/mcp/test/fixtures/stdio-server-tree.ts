// Local MCP stdio server fixture that also spawns a grandchild. The tree-kill
// test needs a real descendant: killing only the direct child leaves the
// grandchild alive, which is exactly the Windows shim failure mode.
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const logPath = process.env.QONE_MCP_TEST_LOG;
const record = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};

// A long-lived grandchild. It prints its pid once so the test knows what to
// look for after the server is torn down. `detached: true` is deliberate: a
// plain child sits in the spawner's Windows job object and dies with it, which
// would make the assertion pass even without a tree kill. Detached children
// escape the job, so only `taskkill /T` reaps them — the same shape as an MCP
// server that daemonizes a helper.
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
  stdio: ["ignore", "pipe", "ignore"],
  detached: true,
  windowsHide: true,
});
grandchild.stdout?.once("data", () => record({ event: "grandchild", pid: grandchild.pid }));

const server = new McpServer({ name: "qone-test-mcp-tree", version: "1.0.0" });

server.registerTool("echo", {
  description: "Echo text",
  inputSchema: { text: z.string() },
}, async ({ text }) => {
  record({ event: "call", tool: "echo", text });
  return { content: [{ type: "text" as const, text }] };
});

server.registerTool("tree", {
  description: "Report the fixture's own process tree",
  inputSchema: {},
}, async () => {
  record({ event: "tree", pid: process.pid, grandchildPid: grandchild.pid });
  return { content: [{ type: "text" as const, text: String(grandchild.pid ?? "") }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);