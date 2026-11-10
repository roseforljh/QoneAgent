// Local MCP stdio server fixture. Runs as a real child process so the client
// transport, protocol negotiation, listTools and callTool all go over a pipe.
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const logPath = process.env.QONE_MCP_TEST_LOG;
const record = (entry: Record<string, unknown>) => {
  if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\n");
};

const server = new McpServer({ name: "qone-test-mcp", version: "1.0.0" });

server.registerTool("echo", {
  description: "Echo text and a structured payload",
  inputSchema: { text: z.string() },
  outputSchema: { text: z.string(), length: z.number() },
}, async ({ text }) => {
  record({ event: "call", tool: "echo", text });
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { text, length: text.length },
  };
});

server.registerTool("fail", {
  description: "Always fails with an MCP tool error",
  inputSchema: {},
}, async () => {
  record({ event: "call", tool: "fail" });
  return { content: [{ type: "text" as const, text: "deliberate failure" }], isError: true };
});

server.registerTool("slow", {
  description: "Waits until the client cancels the request",
  inputSchema: {},
}, async (_args, extra) => {
  record({ event: "slow-start" });
  await new Promise<void>((resolve) => {
    if (extra.signal.aborted) return resolve();
    extra.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  record({ event: "slow-cancelled" });
  throw new Error("slow tool cancelled");
});

const transport = new StdioServerTransport();
await server.connect(transport);