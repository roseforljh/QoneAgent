import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RuntimeEvent } from "@qone/protocol";
import { McpElicitations } from "../src/mcp-elicitation";
import { SecretInputs } from "../src/secret-input";

test("a typed secret reaches its file and shell env without entering tool output", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-secret-"));
  const events: RuntimeEvent[] = [];
  const elicitations = new McpElicitations((event) => events.push(event));
  const secrets = new SecretInputs(elicitations);
  try {
    await writeFile(path.join(directory, ".env"), "TOKEN=__QONE_TOKEN__\n");
    const tool = secrets.tool("session-1", directory);
    const running = tool.execute("call-1", { name: "GH_TOKEN", message: "GitHub token", env: true, file: ".env", placeholder: "__QONE_TOKEN__" }, undefined, undefined, undefined as never);
    while (!events.length) await new Promise((resolve) => setTimeout(resolve, 5));
    const open = events.at(-1) as Extract<RuntimeEvent, { type: "mcp.elicitations" }>;
    const request = open.requests[0]!;
    expect(request).toMatchObject({ sessionId: "session-1", secretTarget: { env: "GH_TOKEN", file: path.join(directory, ".env") } });
    elicitations.respond({ type: "mcp.elicitation.respond", requestId: "r", elicitationId: request.id, action: "accept", content: { value: " ghp_se\"cret \n" } });

    const result = JSON.stringify(await running);
    expect(result).not.toContain("ghp_se");
    expect(await readFile(path.join(directory, ".env"), "utf8")).toBe("TOKEN=ghp_se\"cret\n");
    expect(secrets.env("session-1")).toEqual({ GH_TOKEN: "ghp_se\"cret" });
    expect(secrets.env("session-2")).toEqual({});

    const reader = secrets.wrap({ name: "read", label: "read", description: "", parameters: {} as never,
      execute: async () => ({ content: [{ type: "text", text: "TOKEN=ghp_se\"cret" }], details: {} }) });
    expect(await reader.execute("call-2", {}, undefined, undefined, undefined as never)).toEqual({ content: [{ type: "text", text: "TOKEN=[secret:GH_TOKEN]" }], details: {} });
    // Server output is JSON text inside the tool result, so the value appears escaped there.
    const nested = secrets.wrap({ name: "exec", label: "exec", description: "", parameters: {} as never,
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify({ stdout: "ghp_se\"cret" }) }], details: {} }) });
    expect(JSON.stringify(await nested.execute("call-3", {}, undefined, undefined, undefined as never))).not.toContain("ghp_se");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing placeholder fails before the person is asked", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-secret-"));
  const events: RuntimeEvent[] = [];
  const secrets = new SecretInputs(new McpElicitations((event) => events.push(event)));
  try {
    await writeFile(path.join(directory, "config.json"), "{}");
    await expect(secrets.tool("s", directory).execute("c", { name: "KEY", message: "m", file: "config.json", placeholder: "__KEY__" }, undefined, undefined, undefined as never)).rejects.toThrow("Placeholder not found");
    expect(events).toHaveLength(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
