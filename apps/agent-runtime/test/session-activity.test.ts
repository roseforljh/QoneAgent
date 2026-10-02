import { expect, test } from "bun:test";
import { isAssistantMessageActivity } from "../src/session-activity";

test("assistant message boundaries advance recency without waiting for the entire run", () => {
  for (const type of ["message.started", "message.completed"]) {
    expect(isAssistantMessageActivity({ type, payload: { message: { role: "assistant" } } })).toBe(true);
  }
});

test("streaming tokens, reasoning, tools, and user echoes do not repeatedly touch the session", () => {
  for (const type of ["message.delta", "message.reasoning.delta", "tool.completed", "agent.started"]) {
    expect(isAssistantMessageActivity({ type, payload: { message: { role: "assistant" } } })).toBe(false);
  }
  for (const payload of [undefined, null, {}, { message: { role: "user" } }, { message: { role: "toolResult" } }]) {
    expect(isAssistantMessageActivity({ type: "message.completed", payload })).toBe(false);
  }
});
