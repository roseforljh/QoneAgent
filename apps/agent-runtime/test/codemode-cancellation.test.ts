import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAdapter } from "../src/pi-adapter";
import { withPermission, ApprovalQueue } from "../src/permissions";
import { serverOperationCancelled } from "@qone/protocol";
import { Type } from "typebox";

test("a nested tool abort keeps the cancellation marker instead of becoming a failure", async () => {
  const tool = withPermission({ name: "mcp_fixture_fetch", label: "MCP fixture", description: "Wait until aborted", parameters: Type.Object({}),
    execute: async (_id, _params, signal) => {
      if (!signal) throw new Error("fetch failed");
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      signal.throwIfAborted();
      return { content: [], details: {} };
    },
  }, { queue: new ApprovalQueue(), mode: () => "full", emitApproval: () => {} });
  const controller = new AbortController();
  const run = tool.execute("child-1", {}, controller.signal, undefined, {} as never);
  controller.abort();
  expect(serverOperationCancelled(await run)).toBe(true);
  await expect(tool.execute("child-2", {}, undefined, undefined, {} as never)).rejects.toThrow("fetch failed");
});

// A codemode script that never yields must be killed by its own deadline, and
// the sandbox must stay usable for the next script (worker slot released).
test("a timed-out codemode script does not poison the next codemode call", async () => {
  const faux = fauxProvider({ provider: "qone-codemode-timeout", models: [{ id: "test" }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", {
      code: '// @options: {"timeout_ms": 800}\nwhile (true) {}\nreturn "unreachable";',
    })),
    fauxAssistantMessage(fauxText("first done")),
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'return "second-ok";' })),
    fauxAssistantMessage(fauxText("second done")),
  ]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const results: { text: string; isError: boolean }[] = [];
  const adapter = new PiAdapter((event) => {
    const payload = event.payload as { toolName?: string; isError?: boolean; result?: { content?: { text?: string }[] } } | undefined;
    if (event.type !== "tool.completed" && event.type !== "tool.failed") return;
    if (payload?.toolName !== "codemode") return;
    results.push({ text: payload.result?.content?.map((part) => part.text).join("") ?? "", isError: Boolean(payload.isError) });
  });
  Object.assign(adapter, { modelRuntime: runtime });
  const options = { cwd: process.cwd(), model: "qone-codemode-timeout/test", permissionMode: "full" as const };
  try {
    await adapter.run("codemode-timeout", "run the endless script", options, () => {});
    await adapter.run("codemode-timeout", "run a normal script", options, () => {});
    expect(results).toHaveLength(2);
    expect(results[0]!.text).toContain("Script failed");
    expect(results[0]!.text).toContain("timed out");
    expect(results[1]!.text).toContain("second-ok");
    expect(results[1]!.isError).toBe(false);
  } finally {
    await adapter.disposeSession("codemode-timeout");
  }
}, 60_000);