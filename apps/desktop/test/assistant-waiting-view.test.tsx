import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { ACTIVITY_TITLE_TOOL } from "@qone/protocol";
import { AssistantParts } from "../src/components/assistant-ui/assistant-parts";
import { createMessageConverter } from "../src/lib/runtime-message-converter";
import { useStore, type AgentState } from "../src/store";

function Fixture({ message }: { message: ThreadMessageLike }) {
  const runtime = useExternalStoreRuntime({ messages: [message], isRunning: message.status?.type === "running",
    convertMessage: (value: ThreadMessageLike) => value, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><AssistantParts /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

function render(content: ThreadMessageLike["content"] = [], status: ThreadMessageLike["status"] = { type: "running" }, custom?: Record<string, unknown>) {
  return renderToStaticMarkup(<Fixture message={{ id: "streaming", role: "assistant", content, status, metadata: { custom } }} />);
}

function withState(patch: Partial<AgentState>, check: () => void) {
  const state = useStore.getInitialState();
  const previous = { ...state };
  Object.assign(state, patch);
  try { check(); } finally { Object.assign(state, previous); }
}

const read = { type: "tool-call" as const, toolName: "read", toolCallId: "read-file", args: { path: "file.ts" } };
const stage = { type: "tool-call" as const, toolName: ACTIVITY_TITLE_TOOL, toolCallId: "stage", args: { title: "对照诊断日志与源码定位清理超时原因" }, result: "recorded" };

test("submission renders feedback before a run id, model request or first token exists", () => {
  withState({ activeRunId: undefined, modelRequest: undefined, toolCalls: [] }, () => {
    const convert = createMessageConverter();
    const message = convert({ id: "streaming", role: "assistant", content: "", parts: [], createdAt: 1 }, {
      running: true, imageModel: false, imagePreviews: {}, toolCallsByRun: new Map(), imageWindows: new Map(), childImagesByRun: new Map(),
    });
    const html = renderToStaticMarkup(<Fixture message={message} />);
    expect(html.match(/data-slot="assistant-waiting"/g)).toHaveLength(1);
    expect(html).toContain('data-phase="preparing"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("q-shine-text");
    expect(html).not.toContain('data-slot="assistant-execution"');
  });
});

test("a model request preserves the same label and ignores a stale request from another run", () => {
  withState({ activeRunId: "current", modelRequest: { runId: "current", startedAt: 1 } }, () => {
    const html = render();
    expect(html).toContain('data-phase="waiting"');
    expect(html).toMatch(/(?:正在思考|Thinking)/);
  });
  withState({ activeRunId: "current", modelRequest: { runId: "old", startedAt: 1 } }, () => {
    expect(render()).toContain('data-phase="preparing"');
  });
});

test("provider media processing exposes the phase and the last tool", () => {
  withState({
    activeRunId: "current",
    modelRequest: { runId: "current", startedAt: 1 },
    executionPhase: { runId: "current", phase: "provider-processing", startedAt: 2 },
    toolCalls: [{ toolCallId: "media", runId: "current", toolName: "qone_video_use_file", status: "success" }],
  }, () => {
    const html = render([{ type: "tool-call", toolCallId: "media", toolName: "qone_video_use_file", args: {}, result: "done" }]);
    expect(html).toMatch(/(?:供应商正在处理媒体|Provider is processing media)/);
    expect(html).toMatch(/(?:最近工具：|Last tool: )qone_video_use_file/);
  });
});

test("empty text and reasoning blocks cannot suppress waiting feedback", () => {
  expect(render([{ type: "text", text: " " }, { type: "reasoning", text: "", status: { type: "running" } }]))
    .toContain('data-slot="assistant-waiting"');
});

test("the screenshot stage replaces the fallback immediately and keeps one shimmer after its tool completes", () => {
  const html = render([stage, { ...read, result: "done" }]);
  expect(html).toContain('title="对照诊断日志与源码定位清理超时原因"');
  expect(html).not.toContain('data-slot="assistant-waiting"');
  expect(html.match(/class="q-shine-text /g)).toHaveLength(1);
});

test("an unfinished control title cannot leave an invisible active tool owning feedback", () => {
  const pending = { ...stage, args: {}, result: undefined };
  withState({ toolCalls: [{ toolCallId: "stage", toolName: ACTIVITY_TITLE_TOOL, runId: "run", status: "running", args: {} }] }, () => {
    expect(render([pending])).toContain('data-slot="assistant-waiting"');
  });
});

test("ordinary pending, running and approval tools own feedback without a duplicate indicator", () => {
  withState({ toolCalls: [] }, () => {
    expect(render([read])).not.toContain('data-slot="assistant-waiting"');
  });
  for (const status of ["running", "waiting"] as const) {
    withState({ toolCalls: [{ toolCallId: read.toolCallId, toolName: read.toolName, runId: "run", status, args: read.args }] }, () => {
      expect(render([read])).not.toContain('data-slot="assistant-waiting"');
    });
  }
});

test("model thinking returns after completed tools even when earlier commentary remains", () => {
  const html = render([{ type: "text", text: "先检查文件" }, { ...read, result: "done" }]);
  expect(html).toContain('data-phase="thinking"');
  expect(html).toContain("先检查文件");
  expect(html.match(/data-slot="assistant-waiting"/g)).toHaveLength(1);
});

test("visible reasoning, answer and media replace the fallback", () => {
  for (const content of [
    [{ type: "reasoning" as const, text: "分析日志", status: { type: "running" as const } }],
    [{ type: "text" as const, text: "结论" }],
    [{ type: "image" as const, image: "data:image/png;base64,AA==" }],
  ]) expect(render(content)).not.toContain('data-slot="assistant-waiting"');
});

test("finished reasoning followed by a model gap still has waiting feedback", () => {
  expect(render([{ type: "reasoning", text: "分析完毕", status: { type: "complete" } }])).toContain('data-slot="assistant-waiting"');
});

test("automatic compaction and image generation use their own feedback", () => {
  withState({ activeRunId: "run", currentSessionId: "session", autoCompactionStatuses: {
    session: { id: "compact", runId: "run", throughMessageId: "user", partIndex: 0, startedAt: Date.now() },
  } }, () => {
    const html = render();
    expect(html).toContain('data-slot="context-compaction"');
    expect(html).not.toContain('data-slot="assistant-waiting"');
  });
  const image = render([], { type: "running" }, { qoneImageGeneration: { prompt: "一只猫", generating: true } });
  expect(image).not.toContain('data-slot="assistant-waiting"');
  expect(image).toContain('data-slot="image-generation"');
});

test("completion, cancellation and failure remove the waiting indicator", () => {
  for (const status of [
    { type: "complete", reason: "stop" },
    { type: "incomplete", reason: "cancelled" },
    { type: "incomplete", reason: "error", error: "request failed" },
  ] as const) expect(render([], status)).not.toContain('data-slot="assistant-waiting"');
});
