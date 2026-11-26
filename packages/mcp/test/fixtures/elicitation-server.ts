// MCP server that asks the client questions (elicitation/create) from inside tool calls.
// Also usable by hand: add it to Qone's MCP servers to see each kind of question.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "qone-elicitation-test", version: "1.0.0" });
const reply = (answer: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(answer) }] });

server.registerTool("ask_name", { description: "Asks the person for a name", inputSchema: {} }, async () => reply(await server.server.elicitInput({
  message: "Which name should be used?",
  requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } }, required: ["name"] },
})));

server.registerTool("fill_form", { description: "Asks the person to fill a form with every field type", inputSchema: {} }, async () => reply(await server.server.elicitInput({
  message: "Configure the deployment.",
  requestedSchema: {
    type: "object",
    properties: {
      region: { type: "string", title: "Region", oneOf: [{ const: "hk", title: "Hong Kong" }, { const: "sg", title: "Singapore" }, { const: "us", title: "US West" }] },
      replicas: { type: "integer", title: "Replicas", minimum: 1, maximum: 10, default: 2 },
      email: { type: "string", title: "Notify email", format: "email" },
      features: { type: "array", title: "Features", items: { anyOf: [{ const: "cdn", title: "CDN" }, { const: "waf", title: "Firewall" }, { const: "logs", title: "Logs" }] } },
      confirm: { type: "boolean", title: "Deploy now", default: false },
    },
    required: ["region", "replicas"],
  },
})));

server.registerTool("open_page", { description: "Asks the person to open a web page", inputSchema: {} }, async () => reply(await server.server.elicitInput({
  mode: "url", elicitationId: crypto.randomUUID(), url: "https://example.com/authorize", message: "Sign in to continue.",
})));

await server.connect(new StdioServerTransport());
