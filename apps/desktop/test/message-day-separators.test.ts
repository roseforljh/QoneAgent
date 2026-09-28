import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DaySeparatorMarker } from "../src/components/assistant-ui/elements/day-separator";
import { messageDaySeparators, type DatedPairableMessage } from "../src/components/assistant-ui/message-day-separators";
import { pairMessageIds } from "../src/components/assistant-ui/message-pairing";

test("separators follow the last visible row of each past day and keep paired turns together", () => {
  const firstDay = new Date(2026, 8, 23, 23, 58);
  const secondDay = new Date(2026, 8, 24, 0, 2);
  const today = new Date(2026, 8, 25, 12);
  const messages: DatedPairableMessage[] = [
    { id: "user-1", role: "user", parentId: null, createdAt: firstDay },
    { id: "assistant-1", role: "assistant", parentId: "user-1", createdAt: secondDay },
    { id: "user-2", role: "user", parentId: "assistant-1", createdAt: secondDay },
    { id: "assistant-2", role: "assistant", parentId: "user-2", createdAt: secondDay },
    { id: "user-pending", role: "user", parentId: "assistant-2", createdAt: secondDay },
  ];

  expect([...messageDaySeparators(messages, pairMessageIds(messages), today)]).toEqual([
    ["assistant-1", firstDay],
    ["user-pending", secondDay],
  ]);
  expect([...messageDaySeparators(messages.slice(0, 1), pairMessageIds(messages.slice(0, 1)), today)]).toEqual([
    ["user-1", firstDay],
  ]);
});

test("today has no separator, while the preceding day's marker stays below its final turn", () => {
  const yesterday = new Date(2026, 8, 24, 23, 58);
  const today = new Date(2026, 8, 25, 0, 2);
  const messages: DatedPairableMessage[] = [
    { id: "user-1", role: "user", parentId: null, createdAt: yesterday },
    { id: "assistant-1", role: "assistant", parentId: "user-1", createdAt: today },
    { id: "user-2", role: "user", parentId: "assistant-1", createdAt: today },
    { id: "assistant-2", role: "assistant", parentId: "user-2", createdAt: today },
  ];

  expect([...messageDaySeparators(messages, pairMessageIds(messages), today)]).toEqual([
    ["assistant-1", yesterday],
  ]);
  expect([...messageDaySeparators(messages.slice(2), pairMessageIds(messages.slice(2)), today)]).toEqual([]);
});

test("official separator marker renders only the date line", () => {
  const html = renderToStaticMarkup(createElement(DaySeparatorMarker, { day: "2026年9月24日" }));
  expect(html).toContain('data-slot="day-separator"');
  expect(html).toContain("2026年9月24日");
  expect(html).not.toContain("message.text");
});
