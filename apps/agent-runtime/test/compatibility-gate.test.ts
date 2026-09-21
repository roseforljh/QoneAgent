import { describe, expect, test } from "bun:test";
import {
  createAgentSession,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createPowerShellTool,
  createReadTool,
  createWriteTool,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

describe("Pi Bun compatibility gate", () => {
  test("creates and disposes a session with the complete Windows tool set", async () => {
    const cwd = process.cwd();
    const tools = [
      createReadTool(cwd),
      createPowerShellTool(cwd),
      createEditTool(cwd),
      createWriteTool(cwd),
      createGrepTool(cwd),
      createFindTool(cwd),
      createLsTool(cwd),
    ];
    const { session } = await createAgentSession({
      cwd,
      sessionManager: SessionManager.inMemory(cwd),
      tools: tools.map((tool) => tool.name),
      customTools: tools,
    });
    try {
      expect(session.getActiveToolNames()).toEqual(expect.arrayContaining([
        "read", "powershell", "edit", "write", "grep", "find", "ls",
      ]));
      expect(session.getToolDefinition("read")).toBeDefined();
      expect(session.getToolDefinition("powershell")).toBeDefined();
    } finally {
      await session.dispose();
    }
  });
});
