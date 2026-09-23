import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessagePair } from "../src/components/assistant-ui/elements/message-pair";
import { pairMessageIds, type PairableMessage } from "../src/components/assistant-ui/message-pairing";

test("each assistant answer takes its adjacent user message once", () => {
  const messages: PairableMessage[] = [
    { id: "user-1", role: "user", parentId: null },
    { id: "assistant-1", role: "assistant", parentId: "user-1" },
    { id: "user-2", role: "user", parentId: "assistant-1" },
    { id: "assistant-2", role: "assistant", parentId: "user-2" },
    { id: "user-pending", role: "user", parentId: "assistant-2" },
  ];
  expect([...pairMessageIds(messages)]).toEqual([
    ["assistant-1", "user-1"],
    ["assistant-2", "user-2"],
  ]);
  expect(pairMessageIds([...messages, { id: "extra-assistant", role: "assistant", parentId: "user-1" }]).has("extra-assistant")).toBe(false);
});

test("official MessagePair renders supplied message and action content once", () => {
  const html = renderToStaticMarkup(createElement(MessagePair, {
    userMessage: "",
    words: [],
    visibleWords: 0,
    streaming: false,
    userContent: createElement("span", null, "unique user bubble"),
    assistantContent: createElement("span", null, "unique assistant reply"),
    actions: createElement("button", { type: "button" }, "unique action"),
  }));
  expect(html.match(/data-slot="message-pair"/g)).toHaveLength(1);
  expect(html.match(/unique user bubble/g)).toHaveLength(1);
  expect(html.match(/unique assistant reply/g)).toHaveLength(1);
  expect(html.match(/unique action/g)).toHaveLength(1);
  expect(html).not.toContain("Copy response");
});
