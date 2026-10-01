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

test("live child reasoning and the following answer remain visible", () => {
  const item: SubagentRunInfo = { ...worker, parts: [{ type: "reasoning", text: "分析", messageSequence: 1 }], streaming: "答案",
    messages: [{ id: "user", role: "user", sequence: 0, content: "任务", createdAt: 1 }] };
  const live = subagentMessages(item).at(-1)!;
  expect(live.content.map(p => p.type)).toEqual(["reasoning", "text"]);
});

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

test("internal runtime inputs are hidden while task and literal follow-ups remain intact", () => {
  const followUp = "解释 <parent-context> 标签，不要删除它";
  const messages = subagentMessages({ ...worker, status: "completed", parts: [], streaming: undefined,
    messages: [
      { id: "task", role: "user", sequence: 0, content: "expanded task", createdAt: 1 },
      { id: "system", role: "system", sequence: 1, content: "system", createdAt: 2 },
      { id: "expanded", role: "user", sequence: 2, content: "runtime prompt and parent history", internal: true, createdAt: 3 },
      { id: "answer", role: "assistant", sequence: 3, content: "检查完成", createdAt: 4 },
      { id: "follow", role: "user", sequence: 4, content: followUp, createdAt: 5 },
    ],
  });
  expect(messages.map(message => message.id)).toEqual(["task", "answer", "follow"]);
  expect(messages[0]!.content[0]).toMatchObject({ text: worker.task });
  expect(messages[2]!.content[0]).toMatchObject({ text: followUp });
});

test("streamed child text and reasoning reuse saved messages while changed tasks and results refresh", () => {
  const saved = {
    id: "saved", role: "assistant" as const, sequence: 1, content: "saved answer", createdAt: 2,
    parts: [{ type: "tool-call" as const, toolCallId: "read", toolName: "read", args: {}, result: "old", messageSequence: 1 }],
  };
  const item = { ...worker, parts: saved.parts, messages: [
    { id: "user", role: "user" as const, sequence: 0, content: "expanded task", createdAt: 1 }, saved,
  ] };
  const before = subagentMessages(item);
  const after = subagentMessages({ ...item, streaming: "next delta", parts: [
    ...saved.parts, { type: "reasoning", text: "live thinking", messageSequence: 2 },
  ] });
  expect(after[0]).toBe(before[0]);
  expect(after[1]).toBe(before[1]);
  expect(after.at(-1)).not.toBe(before.at(-1));
  const changedTask = subagentMessages({ ...item, task: "new task" });
  expect(changedTask[0]!.content[0]).toMatchObject({ text: "new task" });
  expect(changedTask[1]).toBe(before[1]);
  const changedResult = subagentMessages({ ...item, messages: [item.messages[0]!, { ...saved, parts: [{ ...saved.parts[0]!, result: "new" }] }] });
  expect(changedResult[1]).not.toBe(before[1]);
  expect(changedResult[1]!.content[0]).toMatchObject({ result: "new" });
});
