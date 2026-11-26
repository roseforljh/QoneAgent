import { expect, test } from "bun:test";
import { configFields, fieldComplete, isPlaceholder, parseMcpInput, splitCommandLine } from "../src/lib/mcp-command";

test("pasted MCP install commands, URLs and JSON become server configurations", () => {
  expect(parseMcpInput("npx -y @upstash/context7-mcp@latest")).toEqual([{ name: "context7", command: "npx", args: ["-y", "@upstash/context7-mcp@latest"], env: {}, headers: {} }]);
  expect(parseMcpInput("EXA_API_KEY=abc npx -y exa-mcp-server")[0]).toMatchObject({ name: "exa", env: { EXA_API_KEY: "abc" } });
  expect(parseMcpInput("uvx mcp-server-time --local-timezone=Asia/Shanghai")[0]).toMatchObject({ name: "time", command: "uvx", args: ["mcp-server-time", "--local-timezone=Asia/Shanghai"] });
  expect(parseMcpInput("npx -y @modelcontextprotocol/server-memory")[0]!.name).toBe("memory");
  expect(parseMcpInput("claude mcp add -s user -e KEY=\"a b\" mine -- npx -y some-mcp --flag")[0]).toEqual({ name: "mine", command: "npx", args: ["-y", "some-mcp", "--flag"], env: { KEY: "a b" }, headers: {} });
  expect(parseMcpInput("claude mcp add --transport http notion https://mcp.notion.com/mcp -H 'Authorization: Bearer t'")[0]).toMatchObject({ name: "notion", url: "https://mcp.notion.com/mcp", transport: "http" });
  expect(parseMcpInput("claude mcp add --transport sse -H \"X-Key: v\" remote https://example.com/sse")[0]).toMatchObject({ transport: "sse", headers: { "X-Key": "v" } });
  expect(parseMcpInput("codex mcp add docs --env TOKEN=1 -- npx docs-mcp")[0]).toMatchObject({ name: "docs", command: "npx", args: ["docs-mcp"], env: { TOKEN: "1" } });
  expect(parseMcpInput("claude mcp add-json weather '{\"type\":\"stdio\",\"command\":\"weather-cli\",\"env\":{\"K\":\"v\"}}'")[0]).toMatchObject({ name: "weather", command: "weather-cli", env: { K: "v" } });
  expect(parseMcpInput("https://mcp.supabase.com/mcp")[0]).toMatchObject({ name: "supabase", url: "https://mcp.supabase.com/mcp", transport: "http" });
  expect(parseMcpInput("https://example.com/sse")[0]!.transport).toBe("sse");
  const json = parseMcpInput('{ "mcpServers": { "a": { "command": "npx", "args": ["-y", "a-mcp"] }, "b": { "type": "sse", "url": "https://b.dev/sse", "headers": { "K": "v" } } } }');
  expect(json.map(item => item.name)).toEqual(["a", "b"]);
  expect(json[1]).toMatchObject({ transport: "sse", headers: { K: "v" } });
  expect(parseMcpInput('{ "command": "npx", "args": ["-y", "@playwright/mcp@latest"] }')[0]!.name).toBe("playwright");
  expect(parseMcpInput("npx -y \\\n  some-mcp")[0]!.args).toEqual(["-y", "some-mcp"]);
  expect(splitCommandLine(`a "b \\"c\\"" 'd e' ""`)).toEqual(["a", 'b "c"', "d e", ""]);
  expect(() => parseMcpInput("npx 'unclosed")).toThrow();
  expect(() => parseMcpInput("claude mcp add onlyname")).toThrow();
});

test("README placeholders are asked for while real values pass through", () => {
  for (const value of ["YOUR_API_KEY", "your-api-key", "<token>", "${EXA_API_KEY}", "xxxxxxxx", "Bearer YOUR_TOKEN", "sk-...", "api_key"]) expect(isPlaceholder(value)).toBe(true);
  for (const value of ["", "sk-live-123abc", "Asia/Shanghai", "mcp-server-mysql", "-y", "$mcp.env:a/b", "Bearer abc.def", "my-service", "my_org", "todo-app", "https://api.example.com/.../v1"]) expect(isPlaceholder(value)).toBe(false);
  const items = parseMcpInput('{"mcpServers":{"exa":{"command":"npx","args":["-y","exa-mcp-server","--root","<path>"],"env":{"EXA_API_KEY":"your-api-key","MODE":"fast","OPTIONAL":""}},"web":{"url":"https://w.dev/mcp","headers":{"Authorization":"Bearer YOUR_TOKEN"}}}}');
  const fields = configFields(items);
  // Every key is shown for review; only example values are required, empty optional ones may stay empty.
  expect(fields.map(field => `${field.server}:${field.label}:${field.required}`)).toEqual(["exa:EXA_API_KEY:true", "exa:MODE:false", "exa:OPTIONAL:false", "web:Authorization:true", "exa:<path>:true"].sort((a, b) => fields.findIndex(f => a.startsWith(`${f.server}:${f.label}:`)) - fields.findIndex(f => b.startsWith(`${f.server}:${f.label}:`))));
  expect(fields.find(field => field.label === "MODE")!.prefill).toBe("fast");
  expect(fieldComplete(fields.find(field => field.label === "OPTIONAL")!, "")).toBe(true);
  expect(fieldComplete(fields.find(field => field.label === "EXA_API_KEY")!, "")).toBe(false);
  const auth = fields.find(field => field.label === "Authorization")!;
  expect(auth.prefill).toBe("Bearer ");
  expect(fieldComplete(auth, "Bearer ")).toBe(false);
  expect(fieldComplete(auth, "Bearer real-token")).toBe(true);
  auth.apply(items[1]!, "Bearer real-token"); expect(items[1]!.headers.Authorization).toBe("Bearer real-token");
});
