import { expect, test } from "bun:test";
import { memoizeConvertedMessages, type ConversionMemo } from "../src/lib/conversation-message-conversion";
import { createMessageConverter } from "../src/lib/runtime-message-converter";
import type { ChatMessage } from "../src/store";
import type { MessageConversionContext } from "../src/lib/runtime-message-converter";

const context = (overrides: Partial<MessageConversionContext> = {}): MessageConversionContext => ({
  imagePreviews: {}, toolCallsByRun: new Map(), imageWindows: new Map(), childImagesByRun: new Map(),
  running: true, imageModel: false, imageGenerationError: undefined, chatRunErrorDetail: undefined,
  ...overrides,
});
const dependencies = (value: MessageConversionContext) => [value.imagePreviews, value.toolCallsByRun, value.imageWindows,
  value.childImagesByRun, value.running, value.imageModel, value.imageGenerationError, value.chatRunErrorDetail];

function history(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m-${index}`, role: index % 2 === 0 ? "user" : "assistant", content: `history ${index}`, createdAt: index,
  }));
}

test("a streaming tail converts only itself while history identities are reused", () => {
  const convert = createMessageConverter();
  const memo: { current: ConversionMemo | undefined } = { current: undefined };
  const saved = history(300);
  let conversions = 0;
  const counted = (message: ChatMessage, ctx: MessageConversionContext) => { conversions++; return convert(message, ctx); };
  const ctx = context();
  const first = memoizeConvertedMessages([...saved, { id: "streaming", role: "assistant", content: "", createdAt: 300 }], ctx, dependencies(ctx), counted, memo);
  expect(conversions).toBe(301);
  const historyIdentities = first.slice(0, saved.length);

  conversions = 0;
  for (let index = 1; index <= 100; index++) {
    const next = memoizeConvertedMessages([...saved, { id: "streaming", role: "assistant", content: `delta-${index}`, createdAt: 300 }], ctx, dependencies(ctx), counted, memo);
    expect(next.slice(0, saved.length).every((message, position) => message === historyIdentities[position])).toBe(true);
  }
  // 100 flushes over a 300-row history: one conversion per flush, not 30,100.
  expect(conversions).toBe(100);
});

test("a context change rebuilds every row exactly once", () => {
  const convert = createMessageConverter();
  const memo: { current: ConversionMemo | undefined } = { current: undefined };
  const saved = history(200);
  let conversions = 0;
  const counted = (message: ChatMessage, ctx: MessageConversionContext) => { conversions++; return convert(message, ctx); };
  const first = context();
  memoizeConvertedMessages(saved, first, dependencies(first), counted, memo);
  expect(conversions).toBe(200);
  conversions = 0;
  const second = context({ running: false });
  memoizeConvertedMessages(saved, second, dependencies(second), counted, memo);
  expect(conversions).toBe(200);
});

test("editing or shrinking the middle moves the preserved suffix without stale rows", () => {
  const convert = createMessageConverter();
  const memo: { current: ConversionMemo | undefined } = { current: undefined };
  const saved = history(4);
  const ctx = context();
  const first = memoizeConvertedMessages(saved, ctx, dependencies(ctx), convert, memo);
  const replacement: ChatMessage = { id: "replacement", role: "user", content: "edited", createdAt: 1 };
  const shrunk = memoizeConvertedMessages([saved[0]!, replacement, saved[3]!], ctx, dependencies(ctx), convert, memo);
  expect(shrunk).toHaveLength(3);
  expect(shrunk[0]).toBe(first[0]);
  expect(shrunk[2]).toBe(first[3]);
  expect(shrunk[1]?.id).toBe("replacement");
  const expanded = memoizeConvertedMessages([saved[0]!, replacement, saved[1]!, saved[2]!, saved[3]!], ctx, dependencies(ctx), convert, memo);
  expect(expanded).toHaveLength(5);
  expect(expanded[4]).toBe(first[3]);
});

test("a fully identical pass returns the previous array", () => {
  const convert = createMessageConverter();
  const memo: { current: ConversionMemo | undefined } = { current: undefined };
  const saved = history(50);
  const ctx = context();
  const first = memoizeConvertedMessages(saved, ctx, dependencies(ctx), convert, memo);
  expect(memoizeConvertedMessages(saved, ctx, dependencies(ctx), convert, memo)).toBe(first);
});
