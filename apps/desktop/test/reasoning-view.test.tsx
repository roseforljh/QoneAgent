import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, useExternalStoreRuntime, MessagePrimitive, ThreadPrimitive, type ThreadMessageLike } from "@assistant-ui/react";
import { Reasoning } from "../src/components/assistant-ui/reasoning";
import { AssistantParts } from "../src/components/assistant-ui/assistant-parts";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import type { AssistantMessagePart } from "@qone/protocol";

function Fixture({ running, complete, text = "**分析**视频", grouped = false }: { running: boolean; complete: boolean; text?: string; grouped?: boolean }) {
  const messages: ThreadMessageLike[] = [{
    id: "reasoning-test", role: "assistant",
    content: [
      { type: "reasoning", text, status: { type: complete ? "complete" : "running" } },
      ...(grouped && complete ? [{ type: "text" as const, text: "最终答案" }] : []),
    ],
    status: running ? { type: "running" } : { type: "complete", reason: "stop" },
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: running, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root>{grouped ? <AssistantParts /> : <MessagePrimitive.Parts components={{ Reasoning }} />}</MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("active reasoning shows scrollable content with only the disclosure icon", () => {
  const html = renderToStaticMarkup(<Fixture running complete={false} />);
  expect(html).toContain('data-slot="reasoning"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain('data-slot="codex-icon"');
  expect(html.match(/data-slot="codex-icon"/g)).toHaveLength(1);
  expect(html).not.toContain("brain-light");
  expect(html).toContain('role="region"');
  expect(html).toContain("overflow-y-auto");
  expect(html).toContain("分析视频");
  expect(html).not.toContain("<strong");
  expect(html).not.toContain('role="dialog"');
});

test("long reasoning retains its beginning and ending inside the bounded scroll area", () => {
  const text = "开头保留\n\n" + "完整思考内容。".repeat(500) + "\n\n末尾保留";
  const html = renderToStaticMarkup(<Fixture running complete={false} text={text} />);
  expect(html).toContain("开头保留");
  expect(html).toContain("末尾保留");
  expect(html).toContain("max-h-[min(22rem,60dvh)]");
});

test("block completion collapses the preview while the answer is still running", () => {
  const html = renderToStaticMarkup(<Fixture running complete />);
  expect(html).toContain('data-slot="reasoning"');
  expect(html).toContain('aria-expanded="false"');
});

test("finished and interrupted messages keep their collapsed reasoning header", () => {
  for (const complete of [true, false]) {
    const html = renderToStaticMarkup(<Fixture running={false} complete={complete} />);
    expect(html).toContain('data-slot="reasoning"');
    expect(html).toContain('aria-expanded="false"');
  }
});

test("reasoning disclosure chevron stays inside the interactive trigger", () => {
  const html = renderToStaticMarkup(<Fixture running={false} complete />);
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("q-reasoning-trigger");
  expect(html).toContain("q-reasoning-chevron");
  expect(html.indexOf("q-reasoning-trigger")).toBeLessThan(html.indexOf("q-reasoning-chevron"));
});

test("empty reasoning does not create a disclosure", () => {
  expect(renderToStaticMarkup(<Fixture running complete={false} text=" " />)).not.toContain('data-slot="reasoning"');
});

test("the real message renderer nests active reasoning under the execution disclosure", () => {
  const html = renderToStaticMarkup(<Fixture running complete={false} grouped />);
  expect(html).toContain('data-slot="assistant-execution"');
  expect(html.indexOf('data-slot="assistant-execution"')).toBeLessThan(html.indexOf('data-slot="reasoning"'));
  expect(html).toContain("分析视频");
  expect(html).not.toContain('aria-label="Expand or collapse execution details"');
});

test("completed reasoning folds with the outer execution region while the answer remains visible", () => {
  for (const running of [true, false]) {
    const html = renderToStaticMarkup(<Fixture running={running} complete grouped />);
    expect(html).toContain('data-slot="assistant-execution"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Expand or collapse execution details"');
    expect(html).not.toContain('data-slot="reasoning"');
    expect(html).toContain("最终答案");
  }
});

function PhaseFixture({ content, running = false }: { content: ThreadMessageLike["content"]; running?: boolean }) {
  const messages: ThreadMessageLike[] = [{
    id: "phase-test", role: "assistant", content,
    status: running ? { type: "running" } : { type: "complete", reason: "stop" },
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: running, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><AssistantParts /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("assistant-ui preserves the pending phase after a tool and does not expose the outer toggle", () => {
  const parts: AssistantMessagePart[] = [
    { type: "text", text: "先查", messageSequence: 1, phase: "commentary" },
    { type: "tool-call", toolName: "read", toolCallId: "phase-read", args: {}, result: "ok", messageSequence: 1 },
  ];
  const content = assistantMessageContent({ content: "继续分析", parts }, [], true);
  const html = renderToStaticMarkup(<PhaseFixture content={content} running />);
  expect(html).toContain('data-slot="assistant-execution"');
  expect(html).toContain("先查");
  expect(html).toContain("继续分析");
  expect(html).not.toContain('aria-label="Expand or collapse execution details"');
  expect(html.indexOf('border-b border-border/50 pb-2')).toBeLessThan(html.indexOf("先查"));
});

test("a completed process without a final answer keeps its status after the activity", () => {
  const parts: AssistantMessagePart[] = [
    { type: "text", text: "处理过程", messageSequence: 1, phase: "commentary" },
    { type: "tool-call", toolName: "read", toolCallId: "completed-read", args: {}, result: "ok", messageSequence: 1 },
  ];
  const html = renderToStaticMarkup(<PhaseFixture content={assistantMessageContent({ content: "", parts }, [], false)} />);
  expect(html.indexOf("处理过程")).toBeLessThan(html.indexOf('border-b border-border/50 pb-2'));
});

test("the execution divider follows commentary and precedes the final answer", () => {
  const parts: AssistantMessagePart[] = [
    { type: "text", text: "正在检查", messageSequence: 1, phase: "commentary" },
    { type: "tool-call", toolName: "read", toolCallId: "final-read", args: {}, result: "ok", messageSequence: 1 },
    { type: "text", text: "检查完成", messageSequence: 2, phase: "final_answer" },
  ];
  const html = renderToStaticMarkup(<PhaseFixture content={assistantMessageContent({ content: "检查完成", parts }, [], false)} />);
  expect(html).toContain('aria-label="Expand or collapse execution details"');
  expect(html.indexOf('border-b border-border/50 pb-2')).toBeLessThan(html.indexOf("检查完成"));
  expect(html).not.toContain("正在检查");
});

test("opening execution reveals its content below the toggle", () => {
  const parts: AssistantMessagePart[] = [
    { type: "text", text: "展开后的过程", messageSequence: 1, phase: "commentary" },
    { type: "tool-call", toolName: "read", toolCallId: "expand-read", args: {}, messageSequence: 1 },
    { type: "text", text: "展开后的答案", messageSequence: 2, phase: "final_answer" },
  ];
  const html = renderToStaticMarkup(<PhaseFixture content={assistantMessageContent({ content: "展开后的答案", parts }, [], false)} running />);
  const toggleIndex = html.indexOf('aria-label="Expand or collapse execution details"');
  expect(toggleIndex).toBeGreaterThan(-1);
  expect(toggleIndex).toBeLessThan(html.indexOf("展开后的过程"));
  expect(html.indexOf("展开后的过程")).toBeLessThan(html.indexOf("展开后的答案"));
});
