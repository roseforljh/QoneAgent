import { expect, test } from "bun:test";
import { generatedSessionTitle, provisionalSessionTitle } from "../src/session-title";

test("first message supplies a provisional title without a model response", () => {
  expect(provisionalSessionTitle("  帮我看看这个视频\nhttps://example.com  ")).toBe("帮我看看这个视频 https://example.com");
  expect(provisionalSessionTitle("  ")).toBe("New session");
});

test("a prose answer cannot replace the conversation title", () => {
  expect(generatedSessionTitle('{"title":"视频内容概览"}')).toBe("视频内容概览");
  expect(generatedSessionTitle("这是一个制作极其精良、在AI与科技圈内非常知名的硬核同人音乐视频，接下来我会详细介绍它的背景和制作过程")).toBeUndefined();
  expect(generatedSessionTitle('{"title":"这是一个制作极其精良、在AI与科技圈内非常知名的硬核同人音乐视频，接下来我会详细介绍它的背景和制作过程"}')).toBeUndefined();
  expect(generatedSessionTitle("**视频内容概览**")).toBeUndefined();
});
