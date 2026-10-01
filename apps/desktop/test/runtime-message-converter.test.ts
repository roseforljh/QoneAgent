import { expect, test } from "bun:test";
import type { ChatMessage, ToolCall } from "../src/store";
import { createMessageConverter, type MessageConversionContext } from "../src/lib/runtime-message-converter";
import { subagentImagesByRun } from "../src/lib/subagent-images";
import type { SubagentRunInfo } from "@qone/protocol";

const context = (): MessageConversionContext => ({
  imagePreviews: {}, toolCallsByRun: new Map(), imageWindows: new Map(), childImagesByRun: new Map(),
  running: false, imageModel: false,
});
const answer = (id = "saved", runId = "run"): ChatMessage => ({
  id, runId, role: "assistant", content: "answer", createdAt: 10,
  parts: [{ type: "text", text: "answer", messageSequence: 1 }],
});

test("streaming and unrelated tool updates reuse saved history conversions", () => {
  const convert = createMessageConverter();
  const saved = answer();
  const before = convert(saved, context());
  const active = { ...answer("streaming", "active"), content: "delta" };
  const next = { ...context(), running: true, toolCallsByRun: new Map<string, ToolCall[]>([["active", [{
    toolCallId: "tool", toolName: "read", runId: "active", status: "running",
  }]]]) };
  expect(convert(saved, next)).toBe(before);
  expect(convert(active, next)).toMatchObject({ status: { type: "running" } });
  expect(convert({ ...active, content: "new delta" }, next)).not.toBe(convert(active, next));
});

test("an empty streamed segment after steering does not replay tools from an earlier segment of the same run", () => {
  const convert = createMessageConverter();
  const previous: ChatMessage = { id: "before-steer", role: "assistant", runId: "run", content: "", parts: [
    { type: "tool-call", toolName: "read", toolCallId: "old-tool", args: {}, result: "done", messageSequence: 1 },
  ] };
  const next = { ...context(), running: true, toolCallsByRun: new Map<string, ToolCall[]>([["run", [
    { toolCallId: "old-tool", toolName: "read", runId: "run", status: "success", result: "done" },
  ]]]) };
  expect(convert(previous, next).content).toMatchObject([{ type: "tool-call", toolCallId: "old-tool" }]);
  expect(convert({ id: "streaming", role: "assistant", runId: "run", content: "", parts: [] }, next).content).toEqual([]);
});

test("local preview resolution updates only the owning user message", () => {
  const convert = createMessageConverter();
  const image: ChatMessage = { id: "image", role: "user", content: "", attachments: [{
    id: "attachment", type: "image", name: "selected.png", mimeType: "image/png", data: "", localPath: "C:/selected.png",
  }] };
  const saved = answer();
  const before = convert(image, context());
  const oldSaved = convert(saved, context());
  expect(before.content).toMatchObject([{ type: "file", filename: "selected.png" }]);
  const next = { ...context(), imagePreviews: { "C:/selected.png": "asset://selected.png" } };
  expect(convert(image, next)).not.toBe(before);
  expect(convert(image, next).content).toMatchObject([{ type: "image", image: "asset://selected.png" }]);
  expect(convert(saved, next)).toBe(oldSaved);
});

test("legacy tool results invalidate their run and unchanged regrouped calls remain cached", () => {
  const convert = createMessageConverter();
  const legacy = { ...answer(), parts: undefined };
  const other = { ...answer("other", "other-run"), parts: undefined };
  const call: ToolCall = { toolCallId: "tool", toolName: "read", runId: "run", status: "running" };
  const initial = { ...context(), toolCallsByRun: new Map([["run", [call]]]) };
  const before = convert(legacy, initial);
  const oldOther = convert(other, initial);
  expect(convert(legacy, { ...initial, toolCallsByRun: new Map([["run", [call]]]) })).toBe(before);
  const next = { ...context(), toolCallsByRun: new Map([["run", [{ ...call, status: "success" as const, result: "loaded" }]]]) };
  expect(convert(legacy, next)).not.toBe(before);
  expect(convert(legacy, next).content).toMatchObject([
    { type: "tool-call", result: "loaded" }, { type: "text", text: "answer" },
  ]);
  expect(convert(other, next)).toBe(oldOther);
});

test("child images and segment window changes refresh their owning saved answer", () => {
  const convert = createMessageConverter();
  const saved = answer();
  const other = answer("other", "other-run");
  const before = convert(saved, context());
  const oldOther = convert(other, context());
  const child: SubagentRunInfo = {
    id: "child", parentSessionId: "session", parentRunId: "run", depth: 1, toolCallId: "child",
    title: "child", task: "generate", status: "completed", startedAt: 5, content: "", turnCount: 1, retryCount: 0,
    parts: [{ type: "image", image: "data:image/png;base64,A", messageSequence: 1 }],
  };
  const next = { ...context(), childImagesByRun: subagentImagesByRun([child]) };
  expect(convert(saved, next)).not.toBe(before);
  expect(convert(saved, next).content).toMatchObject([
    { type: "text", text: "answer" }, { type: "image", image: "data:image/png;base64,A" },
  ]);
  expect(convert(other, next)).toBe(oldOther);
  expect(convert(saved, { ...next, childImagesByRun: subagentImagesByRun([{ ...child, streaming: "text only" }]) })).toBe(convert(saved, next));
  const later = { ...next, imageWindows: new Map([["saved", { after: 5, through: 10 }]]) };
  expect(convert(saved, later).content).toEqual(before.content);
});

test("image generation state and error details stay live without invalidating completed history", () => {
  const convert = createMessageConverter();
  const live: ChatMessage = { id: "streaming", role: "assistant", content: "" };
  const next = { ...context(), running: true, imageModel: true };
  expect(convert(live, next).metadata?.custom).toMatchObject({ qoneImageGeneration: { generating: true } });
  expect(convert(live, { ...next, running: false })).toMatchObject({ metadata: undefined, status: { type: "complete" } });
  const failed: ChatMessage = { id: "image-error:user", role: "assistant", content: "" };
  const error = { ...context(), imageGenerationError: { content: "prompt" }, chatRunErrorDetail: "failed" };
  expect(convert(failed, error).metadata?.custom).toMatchObject({ qoneImageGeneration: { prompt: "prompt", error: "failed" } });
  expect(convert(failed, { ...error, chatRunErrorDetail: "retry failed" }).metadata?.custom).toMatchObject({ qoneImageGeneration: { error: "retry failed" } });
});
