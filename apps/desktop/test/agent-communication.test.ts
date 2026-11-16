import { expect, test } from "bun:test";
import { isAgentCommunicationMessage, isAgentCommunicationThreadMessage, lastUserTurn } from "../src/lib/agent-communication";
import { pairMessageIds } from "../src/components/assistant-ui/message-pairing";
import { threadPhase } from "../src/lib/thread-scroll-policy";
import { insertChatRunErrorMessage } from "../src/lib/chat-run-error-message";
import { getCombinedComposerHistory } from "../src/lib/composer-history";
import type { ChatMessage } from "../src/store";

const communication = { fromId: "main", fromTitle: "Main", toId: "child", toTitle: "Child" };

test("agent communication rows are recognized by store and thread markers", () => {
  expect(isAgentCommunicationMessage({ communication })).toBe(true);
  expect(isAgentCommunicationMessage({})).toBe(false);
  expect(isAgentCommunicationThreadMessage({ metadata: { custom: { qoneAgentCommunication: communication } } })).toBe(true);
  expect(isAgentCommunicationThreadMessage({ metadata: { custom: {} } })).toBe(false);
});

test("last user turn skips agent communication rows", () => {
  const messages = [
    { id: "u1", role: "user", content: "typed" },
    { id: "c1", role: "user", content: "agent says", communication },
  ];
  expect(lastUserTurn(messages)?.id).toBe("u1");
  expect(lastUserTurn([{ id: "c1", role: "user", content: "agent", communication }])).toBeUndefined();
});

test("pairing leaves an agent communication bubble visible instead of folding it into a turn", () => {
  const messages = [
    { id: "u1", role: "user", parentId: null },
    { id: "c1", role: "user", parentId: "u1", metadata: { custom: { qoneAgentCommunication: communication } } },
    { id: "a1", role: "assistant", parentId: "c1", status: { type: "complete" } },
  ];
  const pairs = pairMessageIds(messages);
  expect(pairs.get("a1")).toBeUndefined();
  const typed = pairMessageIds([
    { id: "u1", role: "user", parentId: null },
    { id: "a1", role: "assistant", parentId: "u1", status: { type: "complete" } },
  ]);
  expect(typed.get("a1")).toBe("u1");
});

test("thread phase reads the reply across an agent communication row", () => {
  const threadMessage = (id: string, role: "user" | "assistant", text: string, custom: Record<string, unknown> = {}) => ({
    id, role, createdAt: new Date(1), metadata: { custom },
    content: [{ type: "text" as const, text, parentId: "pi:phase:final_answer:1" }],
  });
  const messages = [
    threadMessage("u1", "user", "typed"),
    threadMessage("c1", "user", "agent", { qoneAgentCommunication: communication }),
    threadMessage("a1", "assistant", "answer"),
  ] as never;
  expect(threadPhase(true, messages)).toBe("final_answer");
});

test("run error lands after the real turn, not before an agent communication row", () => {
  const messages: ChatMessage[] = [
    { id: "u1", role: "user", content: "typed" },
    { id: "c1", role: "user", content: "agent", communication },
    { id: "a1", role: "assistant", content: "partial" },
  ];
  const next = insertChatRunErrorMessage(messages, { sessionId: "s", userMessageId: "u1", detail: "boom" }, "failed");
  expect(next.map((message) => message.id)).toEqual(["u1", "c1", "a1", "run-error:u1"]);
});

test("composer history ignores agent communication text", () => {
  const sessionId = `communication-history-${crypto.randomUUID()}`;
  expect(getCombinedComposerHistory(sessionId, ["typed prompt"])).toEqual(["typed prompt"]);
});
