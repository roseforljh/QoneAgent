import { expect, test } from "bun:test";
import type { SubagentRunInfo } from "@qone/protocol";
import { subagentMessages } from "../src/lib/subagent-messages";

const worker: SubagentRunInfo = {
  id: "child-1", parentSessionId: "session", parentRunId: "parent", toolCallId: "delegate-1",
  title: "检查启动", task: "检查启动流程", model: "provider/fast", status: "running", startedAt: 1000,
  content: "", parts: [
    { type: "text", text: "读取配置", messageSequence: 1 },
    { type: "tool-call", toolCallId: "read-1", toolName: "read", args: { path: "config" }, result: "配置有效", messageSequence: 2 },
  ], streaming: "继续检查",
};

test("nested subagent messages retain task, ordered tool result, and live text", () => {
  const messages = subagentMessages(worker);
  expect(messages[0]?.role).toBe("user");
  expect(messages[0]?.content[0]).toMatchObject({ type: "text", text: "检查启动流程" });
  expect(messages[1]?.role).toBe("assistant");
  expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
  expect(messages[2]?.content[0]).toMatchObject({ toolCallId: "read-1", result: "配置有效" });
  expect(messages[3]?.content[0]).toMatchObject({ type: "text", text: "继续检查" });
  expect(messages[3]?.status?.type).toBe("running");
});

test("a failed worker settles its nested thread on reload", () => {
  const messages = subagentMessages({ ...worker, status: "failed", streaming: undefined, error: "model failed" });
  expect(messages.at(-1)?.status).toMatchObject({ type: "incomplete", reason: "error" });
});
