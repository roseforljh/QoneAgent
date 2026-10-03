import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { AssistantParts } from "../src/components/assistant-ui/assistant-parts";
import { ACTIVITY_TITLE_TOOL } from "@qone/protocol";
import { useStore } from "../src/store";

function Fixture({ content, running = false }: { content: ThreadMessageLike["content"]; running?: boolean }) {
  const messages: ThreadMessageLike[] = [{ id: "activity-phases", role: "assistant", status: running ? { type: "running" } : { type: "complete", reason: "stop" }, content }];
  const runtime = useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><AssistantParts /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

const read = (id: string) => ({ type: "tool-call" as const, toolName: "read", toolCallId: id, args: { path: `src/${id}.ts` }, result: "done" });
const stage = (id: string, title: string) => ({ type: "tool-call" as const, toolName: ACTIVITY_TITLE_TOOL, toolCallId: id, args: { title }, result: { title } });

test("authored stages start collapsed and show their purpose", () => {
  const content: ThreadMessageLike["content"] = [stage("inspect", "排查生命周期为何被覆盖"), read("source"),
    { type: "tool-call", toolName: "powershell", toolCallId: "verify", args: { command: "bun test" }, result: "passed" }];
  const active = renderToStaticMarkup(<Fixture running content={content} />);
  expect(active).toContain('title="排查生命周期为何被覆盖"');
  expect(active).not.toContain("src/source.ts");
  expect(active).not.toContain("bun test");
  expect(active).not.toContain(ACTIVITY_TITLE_TOOL);
  expect(active).toContain('aria-expanded="false"');
  const completed = renderToStaticMarkup(<Fixture content={content} />);
  expect(completed).toContain('title="排查生命周期为何被覆盖"');
  expect(completed).not.toContain("已读取文件，运行了一个命令");
});

test("a running authored stage shows the latest operation and settles on its purpose", () => {
  const content: ThreadMessageLike["content"] = [
    stage("inspect", "排查命令执行安全"),
    read("source"),
    { type: "tool-call", toolName: "powershell", toolCallId: "verify", args: { command: "bun test" } },
  ];
  const serverState = useStore.getInitialState();
  const previous = serverState.toolCalls;
  try {
    serverState.toolCalls = [{ toolCallId: "verify", toolName: "powershell", runId: "run", status: "running", args: { command: "bun test" } }];
    const running = renderToStaticMarkup(<Fixture running content={content} />);
    expect(running).toMatch(/<button[^>]+title="[^"]*bun test/);

    serverState.toolCalls = [{ toolCallId: "verify", toolName: "powershell", runId: "run", status: "success", args: { command: "bun test" } }];
    const completed = renderToStaticMarkup(<Fixture content={content} />);
    expect(completed).toContain('title="排查命令执行安全"');
  } finally {
    serverState.toolCalls = previous;
  }
});

test("a purpose is visible immediately and the next declaration creates the next stage", () => {
  const pending = renderToStaticMarkup(<Fixture running content={[stage("inspect", "排查生命周期状态")]}/>);
  expect(pending).toContain('title="排查生命周期状态"');
  expect(pending).toContain("disabled");
  expect(pending).not.toContain('data-slot="tool-disclosure-chevron"');
  expect(pending).not.toContain(ACTIVITY_TITLE_TOOL);
  const historyContent: ThreadMessageLike["content"] = [
    stage("inspect", "排查生命周期状态"), read("source"),
    stage("verify", "验证清理后的状态"), read("tests"),
  ];
  const history = renderToStaticMarkup(<Fixture content={historyContent}/>);
  expect(history.match(/data-slot="tool-timeline"/g)).toHaveLength(2);
  expect(history.indexOf('title="排查生命周期状态"')).toBeLessThan(history.indexOf('title="验证清理后的状态"'));
  const final = renderToStaticMarkup(<Fixture content={[...historyContent, { type: "text", text: "Final answer" }]}/>);
  expect(final).toContain("Final answer");
  expect(final).toMatch(/(?:运行了 2 个工具|Ran 2 tools)/);
});

test("failures remain visible in collapsed stages during and after work", () => {
  const content: ThreadMessageLike["content"] = [stage("inspect", "验证生命周期清理"), read("source"),
    { type: "tool-call", toolName: "powershell", toolCallId: "failed", args: { command: "bun test" }, result: "failed", isError: true }];
  const collapsed = renderToStaticMarkup(<Fixture content={content} />);
  expect(collapsed).toContain('data-status="failed"');
  expect(collapsed).toMatch(/aria-label="(?:1 个操作失败|1 actions failed)"/);
  expect(collapsed).toContain('title="验证生命周期清理"');
  const active = renderToStaticMarkup(<Fixture running content={content} />);
  expect(active).toMatch(/aria-label="(?:1 个操作失败|1 actions failed)"/);
  expect(active.match(/data-slot="tool-timeline"/g)).toHaveLength(1);
});

test("model-authored captions are rendered as escaped plain text", () => {
  const html = renderToStaticMarkup(<Fixture content={[stage("markup", "Inspect <img src=x onerror=alert(1)>"), read("source")]}/>);
  expect(html).toContain("Inspect &lt;img");
  expect(html).not.toContain("<img src=x");
});

test("the real message renderer shows one phase header across reasoning and multiple reads", () => {
  const content: ThreadMessageLike["content"] = [
    { type: "reasoning", text: "Inspect first" }, read("first"),
    { type: "reasoning", text: "Inspect second" }, read("second"),
  ];
  const html = renderToStaticMarkup(<Fixture content={content} />);
  expect(html.match(/data-slot="tool-timeline"/g)).toHaveLength(1);
  expect(html).toMatch(/title="(?:已读取文件|Read files)"/);
  const active = renderToStaticMarkup(<Fixture running content={[
    ...content, { type: "reasoning", text: "Evaluate", status: { type: "running" } },
  ]} />);
  expect(active).toContain('title="Evaluate"');
  expect(active).not.toContain('data-slot="reasoning"');
  expect(active).toContain('aria-expanded="false"');
});

test("the phase title switches to thinking after its tools complete", () => {
  const html = renderToStaticMarkup(<Fixture running content={[
    read("first"), read("second"), { type: "reasoning", text: "Evaluate results", status: { type: "running" } },
  ]} />);
  expect(html).toContain('title="Evaluate results"');
  expect(html).toMatch(/data-slot="tool-timeline"[^>]*data-state="closed"|data-state="closed"[^>]*data-slot="tool-timeline"/);
  expect(html).toContain('q-shine-text');
  expect(html).not.toContain('data-slot="reasoning"');
});

test("a failed command stays between the preceding and following phase summaries", () => {
  const html = renderToStaticMarkup(<Fixture content={[
    read("before-a"), read("before-b"),
    { type: "tool-call", toolName: "powershell", toolCallId: "failed-command", args: { command: "bun test" }, result: "failed", isError: true },
    { type: "reasoning", text: "Investigate failure" }, read("after-a"), read("after-b"),
  ]} />);
  expect(html.match(/data-slot="tool-timeline"/g)).toHaveLength(2);
  expect(html.match(/data-status="failed"/g)).toHaveLength(1);
  const firstPhase = html.indexOf('data-slot="tool-timeline"');
  const failedRow = html.indexOf('data-status="failed"');
  const secondPhase = html.lastIndexOf('data-slot="tool-timeline"');
  expect(firstPhase).toBeGreaterThan(-1);
  expect(firstPhase).toBeLessThan(failedRow);
  expect(failedRow).toBeLessThan(secondPhase);
});

test("mixed tools have one semantic summary and final content remains outside execution", () => {
  const html = renderToStaticMarkup(<Fixture content={[
    read("source"),
    { type: "tool-call", toolName: "powershell", toolCallId: "test-command", args: { command: "bun test" }, result: "passed" },
    { type: "text", text: "Phase result" },
    read("followup-a"), read("followup-b"),
  ]} />);
  expect(html.match(/data-slot="tool-timeline"/g)).toHaveLength(2);
  expect(html).toMatch(/title="(?:已读取文件，运行了一个命令|Read files and ran a command)"/);
  expect(html).toContain("Phase result");
  const final = renderToStaticMarkup(<Fixture content={[read("a"), read("b"), { type: "text", text: "Final answer" }]} />);
  expect(final).toContain("Final answer");
  expect(final.indexOf('data-slot="assistant-execution"')).toBeLessThan(final.indexOf("Final answer"));
});
