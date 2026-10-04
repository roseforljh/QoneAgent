import { expect, test } from "bun:test";
import { Type } from "typebox";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PiAdapter } from "../src/pi-adapter";
import { buildSubagentNotificationPrompt, SUBAGENT_NOTIFICATION_MARKER } from "../src/subagent-notifications";
import type { SubagentNotificationInfo } from "@qone/protocol";

for (const kind of ["completed", "failed"] as const) {
  test(`${kind} child notification reaches the next model request before later tools and the final answer`, async () => {
    const sessionId = `boundary-${kind}`;
    const faux = fauxProvider({ provider: sessionId, models: [{ id: "model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const order: string[] = [];
    const acknowledgement = kind === "completed" ? "已收到配置检查完成通知，接下来继续验证。" : "已收到配置检查失败通知，接下来检查影响。";
    const finals: string[] = [];
    const adapter = new PiAdapter(() => {}, { onAssistantFinal: (_session, _run, text) => { finals.push(text); } });
    (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
    const notice: SubagentNotificationInfo = {
      id: "notice", sessionId, subagentRunId: "child", version: 1, kind, status: "pending", title: "配置检查", createdAt: 1,
    };
    const prompt = buildSubagentNotificationPrompt([notice]);
    await adapter.setCustomTools([{
      name: "qone_boundary_probe", label: "Boundary probe", description: "Record a test step.",
      parameters: Type.Object({ step: Type.String() }), executionMode: "sequential",
      execute: async (_id, args, signal) => {
        const { step } = args as { step: string };
        order.push(step);
        if (step === "first") expect(adapter.queueSubagentUpdateNow(sessionId, prompt, "parent")).toBe(true);
        expect(signal?.aborted).not.toBe(true);
        return { content: [{ type: "text", text: "done" }], details: {} };
      },
    }]);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("qone_boundary_probe", { step: "first" }), fauxToolCall("qone_boundary_probe", { step: "second" })]),
      async (context) => {
        // The whole original tool batch completes before delivery; follow_up would miss this request.
        expect(order).toEqual(["first", "second"]);
        const notificationIndex = context.messages.findIndex((message) => message.role === "user" && JSON.stringify(message).includes(SUBAGENT_NOTIFICATION_MARKER));
        expect(notificationIndex).toBeGreaterThan(0);
        expect(context.messages.slice(0, notificationIndex).filter((message) => message.role === "toolResult")).toHaveLength(2);
        order.push("receipt");
        return fauxAssistantMessage([fauxText(acknowledgement), fauxToolCall("qone_boundary_probe", { step: "next" })]);
      },
      fauxAssistantMessage(fauxText("最终结论：验证结束。")),
    ]);
    try {
      await adapter.run(sessionId, "完成检查和验证", { runId: "parent", cwd: process.cwd(), model: `${sessionId}/model`, permissionMode: "full" }, () => {});
      expect(order).toEqual(["first", "second", "receipt", "next"]);
      expect(finals).toEqual([acknowledgement, "最终结论：验证结束。"]);
    } finally { await adapter.disposeSession(sessionId); }
  });
}

test("inspect returns an identifiable final summary with the model-facing acknowledgement contract", async () => {
  const faux = fauxProvider({ provider: "inspect-receipt", models: [{ id: "model" }] });
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const output: string[] = [];
  const adapter = new PiAdapter(() => {}, { onAssistantFinal: (_session, _run, text) => output.push(text) });
  (adapter as unknown as { modelRuntime: ModelRuntime }).modelRuntime = runtime;
  adapter.setSubagentController({ query: () => ({
    id: "child", parentSessionId: "inspect-session", title: "配置检查", status: "completed", content: "private process",
    parts: [{ type: "text", text: "最后总结：配置已核验。", phase: "final_answer", messageSequence: 2 }],
  }), acknowledge: () => {} } as never);
  faux.setResponses([
    async (context) => {
      expect(JSON.stringify(context.messages)).toContain("After reading, briefly tell the user what was actually returned");
      const inspect = context.messages.flatMap((message) => message.role === "system" ? message.toolsAdded ?? [] : []).find((tool) => tool.name === "inspect_subagent");
      expect(inspect?.description).toContain("compact result");
      expect(inspect?.description).not.toContain("streaming output");
      return fauxAssistantMessage(fauxToolCall("inspect_subagent", { runId: "child" }));
    },
    async (context) => {
      const result = context.messages.findLast((message) => message.role === "toolResult");
      expect(JSON.stringify(result)).toContain("配置检查");
      expect(JSON.stringify(result)).toContain("最后总结：配置已核验。");
      expect(JSON.stringify(result)).not.toContain("private process");
      return fauxAssistantMessage(fauxText("已读取配置检查的最后总结，接下来核对改动。"));
    },
  ]);
  try {
    await adapter.run("inspect-session", "读取检查结果", { cwd: process.cwd(), model: "inspect-receipt/model", permissionMode: "full" }, () => {});
    expect(output).toEqual(["已读取配置检查的最后总结，接下来核对改动。"]);
  } finally { await adapter.disposeSession("inspect-session"); }
});
