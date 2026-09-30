import { expect, test } from "bun:test";
import { chatRunErrorMessageId, insertChatRunErrorMessage } from "../src/lib/chat-run-error-message";
import type { ChatMessage, ChatRunError } from "../src/store";

const error: ChatRunError = { sessionId: "session-1", userMessageId: "user-1", detail: "Model returned no assistant response" };
const user: ChatMessage = { id: "user-1", role: "user", content: "请回答", createdAt: 10 };

test("failed answer appears after its user message", () => {
  const result = insertChatRunErrorMessage([user], error, `回答失败\n${error.detail}`);
  expect(result.map((message) => message.id)).toEqual(["user-1", chatRunErrorMessageId("user-1")]);
  expect(result[1]).toMatchObject({ role: "assistant", content: `回答失败\n${error.detail}` });
});

test("failed answer follows existing assistant text without changing it", () => {
  const answer: ChatMessage = { id: "answer-1", role: "assistant", content: "已有回答", createdAt: 20 };
  const nextUser: ChatMessage = { id: "user-2", role: "user", content: "下一轮", createdAt: 30 };
  const messages = [user, answer, nextUser];
  const result = insertChatRunErrorMessage(messages, error, "回答失败");
  expect(result.map((message) => message.id)).toEqual(["user-1", "answer-1", chatRunErrorMessageId("user-1"), "user-2"]);
  expect(result[1]).toEqual(answer);
  expect(messages).toEqual([user, answer, nextUser]);
});

test("missing user does not create an orphaned failed answer", () => {
  expect(insertChatRunErrorMessage([], error, "回答失败")).toEqual([]);
});
