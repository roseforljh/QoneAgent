import { expect, test } from "bun:test";
import { parseMcpCommand } from "@qone/protocol";
import { expandComposerCommand } from "../src/lib/composer-command";

test("MCP selection decodes the server ID and leaves the task text", () => {
  expect(parseMcpCommand("  /mcp:server%20id  analyze this"))
    .toEqual({ serverId: "server id", text: "analyze this" });
});

test("ordinary message text and malformed commands are left alone", () => {
  expect(parseMcpCommand("use /mcp:server in this example")).toBeUndefined();
  expect(parseMcpCommand("/mcp:bad% input")).toBeUndefined();
});

test("serialized command chips become leading runtime commands", () => {
  expect(expandComposerCommand(":qone-command[skill:example-skill] review this"))
    .toBe("/skill:example-skill review this");
  expect(expandComposerCommand(":qone-command[mcp:server%20id] analyze this"))
    .toBe("/mcp:server%20id analyze this");
  expect(expandComposerCommand("quote :qone-command[mcp:server%20id]"))
    .toBe("quote :qone-command[mcp:server%20id]");
});
