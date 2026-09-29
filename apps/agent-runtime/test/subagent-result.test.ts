import { expect, test } from "bun:test";
import type { SubagentRunInfo } from "@qone/protocol";
import { subagentResultForModel, subagentWorkflowResultForModel } from "../src/subagent-result";

test("inspection can retrieve previous replies without serializing transcript media parts", () => {
  const child = {
    id: "child", status: "completed", content: "latest", parts: [],
    messages: [
      { sequence: 1, role: "user", content: "question" },
      { sequence: 2, role: "assistant", content: "earlier reply", parts: [{ type: "image", image: "data:image/png;base64,AAAA" }] },
    ],
  } as unknown as SubagentRunInfo;
  expect(subagentResultForModel(child).details).not.toHaveProperty("messages");
  const result = subagentResultForModel(child, true);
  expect(result.details.messages).toEqual([
    { sequence: 1, role: "user", content: "question" },
    { sequence: 2, role: "assistant", content: "earlier reply" },
  ]);
  expect(result.content[0]!.text).not.toContain("base64");
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
