import { expect, test } from "bun:test";
import type { SubagentRunInfo } from "@qone/protocol";
import { subagentResultForModel, subagentWorkflowResultForModel } from "../src/subagent-result";

test("model-facing subagent result never includes the saved transcript", () => {
  const child = {
    id: "child", status: "completed", content: "latest", parts: [],
    messages: [
      { sequence: 1, role: "user", content: "question" },
      { sequence: 2, role: "assistant", content: "earlier reply", parts: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
    ],
  } as unknown as SubagentRunInfo;
  const result = subagentResultForModel(child);
  expect(result.details).not.toHaveProperty("messages");
  expect(result.content[0]!.text).toContain('"result":"latest"');
  expect(result.content[0]!.text).not.toContain("earlier reply");
  expect(result.content[0]!.text).not.toContain("base64");
});

test("model-facing subagent result selects the final answer from a multi-turn process", () => {
  const child = {
    id: "child-final", status: "completed", content: "过程：读取文件、调用工具、整理中间结果", parts: [
      { type: "text", text: "我先检查项目结构。", phase: "commentary", messageSequence: 1 },
      { type: "tool-call", toolCallId: "tool-1", toolName: "read", args: {}, messageSequence: 1 },
      { type: "text", text: "最终总结：问题已修复，测试已通过。", phase: "final_answer", messageSequence: 2 },
    ],
    messages: [
      { sequence: 1, role: "assistant", content: "我先检查项目结构。" },
      { sequence: 2, role: "assistant", content: "最终总结：问题已修复，测试已通过。" },
    ],
  } as unknown as SubagentRunInfo;
  const result = subagentResultForModel(child);
  expect(result.details.result).toBe("最终总结：问题已修复，测试已通过。");
  expect(result.content[0]!.text).not.toContain("读取文件");
  expect(result.content[0]!.text).not.toContain("检查项目结构");
  expect(subagentWorkflowResultForModel([child]).content[0]!.text).toContain("最终总结：问题已修复，测试已通过。");
});

test("provider messages remain the fallback when final-answer phase metadata is absent", () => {
  const result = subagentResultForModel({
    id: "child-provider", status: "completed", content: "最终总结：已完成。", parts: [
      { type: "text", text: "调用工具前的说明。", messageSequence: 1 },
    ],
    messages: [
      { sequence: 1, role: "assistant", content: "调用工具前的说明。" },
      { sequence: 2, role: "assistant", content: "最终总结：已完成。" },
    ],
  } as unknown as SubagentRunInfo);
  expect(result.details.result).toBe("最终总结：已完成。");
  expect(result.content[0]!.text).not.toContain("调用工具前的说明");
});

test("generated image reaches the parent as an image block without base64 in text", () => {
  const image = "data:image/png;base64," + "AAAA".repeat(100_000);
  const child = {
    id: "child-1", status: "completed", content: "", parts: [
      { type: "image", image, filename: "generated-1.png", messageSequence: 1 },
      { type: "tool-call", toolCallId: "tool-1", toolName: "write", args: {}, result: image, messageSequence: 1 },
    ],
  } as SubagentRunInfo;
  const result = subagentResultForModel(child);
  expect(result.content[0]).toMatchObject({ type: "text" });
  expect(result.content[0]!.text.length).toBeLessThan(500);
  expect(result.content[0]!.text).toContain("generated-1.png");
  expect(result.content[1]).toEqual({ type: "image", mimeType: "image/png", data: "AAAA".repeat(100_000) });
  const workflow = subagentWorkflowResultForModel([child]);
  expect(workflow.content[0]!.text.length).toBeLessThan(500);
  expect(workflow.content[1]).toEqual(result.content[1]);
});
