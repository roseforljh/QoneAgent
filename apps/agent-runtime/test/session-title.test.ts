import { expect, test } from "bun:test";
import { generatedSessionTitle, prepareTitlePrompt, provisionalSessionTitle } from "../src/session-title";

test("first message supplies a provisional title without a model response", () => {
  expect(provisionalSessionTitle("  帮我看看这个视频\nhttps://example.com  ")).toBe("帮我看看这个视频 https://example.com");
  expect(provisionalSessionTitle("  ")).toBe("New session");
});

test("a prose answer cannot replace the conversation title", () => {
  expect(generatedSessionTitle('{"title":"视频内容概览"}')).toBe("视频内容概览");
  expect(generatedSessionTitle("```json\n{\"title\": \"排查息屏断流原因\"}\n```")).toBe("排查息屏断流原因");
  expect(generatedSessionTitle("```\n{\"title\": \"“JumpJump 服务器分析”\"}\n```")).toBe("JumpJump 服务器分析");
  expect(generatedSessionTitle("json {\"title\":\"修复代理启动失败\"}")).toBe("修复代理启动失败");
  expect(generatedSessionTitle("这是一个制作极其精良、在AI与科技圈内非常知名的硬核同人音乐视频，接下来我会详细介绍它的背景和制作过程")).toBeUndefined();
  expect(generatedSessionTitle('{"title":"这是一个制作极其精良、在AI与科技圈内非常知名的硬核同人音乐视频，接下来我会详细介绍它的背景和制作过程"}')).toBeUndefined();
  expect(generatedSessionTitle("**视频内容概览**")).toBeUndefined();
});

test("prepareTitlePrompt keeps normal prompts intact and bounds giant pastes", () => {
  expect(prepareTitlePrompt("  排查息屏断流原因  ")).toBe("排查息屏断流原因");
  const giant = `${"A".repeat(3200)}MIDDLE${"Z".repeat(1200)}`;
  const prepared = prepareTitlePrompt(giant);
  expect(prepared.startsWith("A".repeat(100))).toBe(true);
  expect(prepared.endsWith("Z".repeat(100))).toBe(true);
  expect(prepared).toContain("\n...\n");
  expect(prepared.length).toBeLessThan(giant.length);
});
