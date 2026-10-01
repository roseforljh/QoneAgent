import { expect, test } from "bun:test";
import { toolIntegration } from "../src/components/assistant-ui/tool-integration";

test("MCP tool names resolve to the configured server and its built-in logo", () => {
  const integration = toolIntegration("mcp:mcp-context7:resolve-library-id", [{
    id: "mcp-context7", name: "Context7", connected: true,
  }]);
  expect(integration?.id).toBe("mcp-context7");
  expect(integration?.name).toBe("Context7");
  expect(integration?.logo).toContain("context7-logo");
});

test("unknown MCP servers still get a stable generic integration", () => {
  expect(toolIntegration("mcp:custom-server:search", [])).toEqual({
    id: "custom-server", name: "custom-server", logo: expect.stringContaining("mcp"),
  });
});

test("built-in public integrations have semantic names", () => {
  expect(toolIntegration("qone_github_public", [])?.name).toBe("GitHub");
  expect(toolIntegration("qone_web_read", [])?.name).toBe("网页");
});
