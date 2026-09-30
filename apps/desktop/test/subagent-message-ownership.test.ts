import { expect, test } from "bun:test";
import type { SubagentRunInfo } from "@qone/protocol";
import { subagentsForAssistantMessage } from "../src/components/assistant-ui/subagent-message-ownership";

const child: SubagentRunInfo = {
  id: "child", parentSessionId: "session", parentRunId: "parent-run", toolCallId: "dispatch-1",
  title: "Review", task: "Review", status: "completed", startedAt: 1, content: "Done", parts: [],
};

test("a completed child stays with the dispatch segment when a later user turn reuses its run id", () => {
  const messages = [
    { id: "dispatch", role: "assistant", runId: "parent-run", parts: [{ type: "tool-call", toolCallId: "dispatch-1" }] },
    { id: "follow-up-user", role: "user", runId: "parent-run" },
    { id: "follow-up-answer", role: "assistant", runId: "parent-run", parts: [{ type: "text" }] },
  ];
  expect(subagentsForAssistantMessage([child], messages, "parent-run", "dispatch", messages[0]!.parts!)).toEqual([child]);
  expect(subagentsForAssistantMessage([child], messages, "parent-run", "follow-up-answer", messages[2]!.parts!)).toEqual([]);
});
