import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import { SessionTimeline } from "../src/components/assistant-ui/session-timeline";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { ToolResultView } from "../src/components/assistant-ui/elements/tool-result";
import { useStore } from "../src/store";
import { toolIntegration } from "../src/components/assistant-ui/tool-integration";
import { assistantPartRanges } from "../src/components/assistant-ui/assistant-part-ranges";

function Fixture() {
  const messages: ThreadMessageLike[] = [{
    id: "group-summary", role: "assistant", status: { type: "complete", reason: "stop" },
    content: ["read", "grep"].map((toolName) => ({
      type: "tool-call" as const, toolName, toolCallId: toolName, args: { path: "source.ts" }, result: "done",
    })),
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={2} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("completed timeline uses a category summary even when timing data is present", () => {
  const previous = useStore.getState().toolCalls;
  try {
    useStore.setState({ toolCalls: ["read", "grep"].map((toolName) => ({
      toolCallId: toolName, toolName, runId: "test", status: "success", startedAt: 1000, completedAt: 2000,
    })) });
    const html = renderToStaticMarkup(<Fixture />);
    expect(html).toContain('data-slot="tool-timeline"');
    expect(html).toMatch(/已读取文件|Read files/);
    expect(html).not.toMatch(/读取 1 项|Read ×1|搜索 1 项|Search ×1/);
    expect(html).not.toMatch(/耗时|Worked for/);
    expect(html).not.toMatch(/data-slot="tool-call"[\s\S]*?data-slot="codex-icon"/);
  } finally {
    useStore.setState({ toolCalls: previous });
  }
});

function PartlyFailedFixture() {
  const messages: ThreadMessageLike[] = [{
    id: "partly-failed", role: "assistant", status: { type: "complete", reason: "stop" },
    content: [
      { type: "tool-call", toolName: "edit", toolCallId: "edited", args: { path: "src/App.tsx" }, result: "done" },
      { type: "tool-call", toolName: "powershell", toolCallId: "failed", args: { command: "./gradlew test" }, result: "failed", isError: true },
    ],
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={2} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("failed command changes the group title without erasing successful edits", () => {
  const html = renderToStaticMarkup(<PartlyFailedFixture />);
  expect(html).toMatch(/编辑了一个文件，一个操作失败|Edited a file and an action failed/);
  expect(html).not.toMatch(/编辑了一个文件，运行了一个命令|Edited a file and ran a command/);
});

function RunningGroupFixture() {
  const messages: ThreadMessageLike[] = [{
    id: "running-group", role: "assistant", status: { type: "running" },
    content: [
      { type: "tool-call", toolName: "edit", toolCallId: "edited", args: { path: "src/App.tsx" }, result: "done" },
      { type: "tool-call", toolName: "powershell", toolCallId: "running-command", args: { command: "./gradlew test" } },
    ],
  }];
  const runtime = useExternalStoreRuntime({ messages, isRunning: true, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={2} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("the active tool group starts collapsed and uses the running command as its title", () => {
  const previous = useStore.getState().toolCalls;
  try {
    useStore.setState({ toolCalls: [{ toolCallId: "running-command", toolName: "powershell", runId: "run", status: "running" }] });
    const html = renderToStaticMarkup(<RunningGroupFixture />);
    expect(html).toContain('data-slot="tool-timeline"');
    expect(html).toMatch(/data-slot="tool-timeline"[^>]*data-state="closed"|data-state="closed"[^>]*data-slot="tool-timeline"/);
    expect(html).toMatch(/title="[^"]*gradlew test/);
  } finally {
    useStore.setState({ toolCalls: previous });
  }
});

function IntegrationFixture() {
  const messages: ThreadMessageLike[] = [{
    id: "context7-call", role: "assistant", status: { type: "complete", reason: "stop" },
    content: [{
      type: "tool-call", toolName: "mcp:mcp-context7:resolve-library-id", toolCallId: "context7-call",
      args: { libraryName: "assistant-ui" }, result: "done",
    }],
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={1} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("MCP execution rows use the configured integration title and logo", () => {
  const previousServers = useStore.getState().mcpServers;
  const previousCalls = useStore.getState().toolCalls;
  try {
    useStore.setState({
      mcpServers: [{ id: "mcp-context7", name: "Context7", connected: true }],
      toolCalls: [{ toolCallId: "context7-call", toolName: "mcp:mcp-context7:resolve-library-id", runId: "test", status: "success" }],
    });
    expect(useStore.getState().mcpServers[0]?.name).toBe("Context7");
    expect(toolIntegration("mcp:mcp-context7:resolve-library-id", useStore.getState().mcpServers)?.name).toBe("Context7");
    const html = renderToStaticMarkup(<IntegrationFixture />);
    expect(html).toMatch(/已使用 Context7 集成|Used Context7 integration/);
    expect(html).toContain("context7-logo");
  } finally {
    useStore.setState({ mcpServers: previousServers, toolCalls: previousCalls });
  }
});

function FailedFixture() {
  const messages: ThreadMessageLike[] = [{
    id: "failed-command", role: "assistant", status: { type: "complete", reason: "stop" },
    content: [{ type: "tool-call", toolName: "powershell", toolCallId: "failed-command-tool", args: { command: "./gradlew test" }, result: "Gradle failed", isError: true }],
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={1} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("failed commands use the compact tool row instead of a separate card", () => {
  const html = renderToStaticMarkup(<FailedFixture />);
  expect(html).toContain('data-slot="tool-call"');
  expect(html).toContain('data-status="failed"');
  expect(html).not.toContain('data-slot="tool-error"');
  expect(html).not.toContain("xmark");
  expect(html).not.toContain("text-destructive");
});

test("expanded failed command has one result frame and a bounded output area", () => {
  const html = renderToStaticMarkup(<ToolCall
    label="运行"
    activeLabel="运行中"
    query="./gradlew test"
    result={<ToolResultView presentation={{ kind: "terminal", output: "Gradle failed" }} />}
    resultHasOwnFrame
    running={false}
    failed
    open
    onOpenChange={() => {}}
  />);
  expect(html).toContain('data-slot="tool-terminal-result"');
  expect(html).toContain('data-slot="tool-result-panel" class="mt-1.5"');
  expect(html).toContain('max-h-[min(16rem,38dvh)]');
  expect(html).not.toContain('max-h-[min(22rem,60dvh)]');
});

function ToolRows() {
  const parts = useAuiState((state) => state.message.parts);
  return <MessagePrimitive.Root>{assistantPartRanges(parts).map((range) => range.type === "tools"
    ? <SessionTimeline key={range.startIndex} startIndex={range.startIndex} endIndex={range.endIndex} /> : null)}</MessagePrimitive.Root>;
}

function ToolRowsFixture({ content, running = false }: { content: ThreadMessageLike["content"]; running?: boolean }) {
  const messages: ThreadMessageLike[] = [{ id: "individual-rows", role: "assistant", status: running ? { type: "running" } : { type: "complete", reason: "stop" }, content }];
  const runtime = useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{ AssistantMessage: ToolRows }} /></AssistantRuntimeProvider>;
}

test("single reads use an action and real filename instead of the group summary", () => {
  const html = renderToStaticMarkup(<ToolRowsFixture content={[
    { type: "tool-call", toolName: "read", toolCallId: "single-read", args: { path: "src/tool-group-summary.ts" }, result: "done" },
  ]} />);
  expect(html).toMatch(/title="(?:已读取|Read) src\/tool-group-summary.ts"/);
  expect(html).not.toMatch(/读取了文件|已读取文件|Read files/);
  expect(html).toContain("tool-group-summary.ts");
});

test("reasoning and a failed command keep separate reads ordered with specific titles", () => {
  const html = renderToStaticMarkup(<ToolRowsFixture content={[
    { type: "reasoning", text: "Inspect summaries" },
    { type: "tool-call", toolName: "read", toolCallId: "before-failure", args: { path: "src/tool-group-summary.ts" }, result: "done" },
    { type: "reasoning", text: "Inspect labels" },
    { type: "tool-call", toolName: "read", toolCallId: "second-read", args: { path: "src/tool-action-summary.ts" }, result: "done" },
    { type: "tool-call", toolName: "powershell", toolCallId: "boundary-failure", args: { command: "bun test" }, result: "failed", isError: true },
    { type: "reasoning", text: "Investigate failure" },
    { type: "tool-call", toolName: "read", toolCallId: "after-failure", args: { path: "src/session-timeline.tsx" }, result: "done" },
  ]} />);
  const titles = [...html.matchAll(/<button[^>]+title="([^"]+)"/g)].map((match) => match[1]);
  expect(titles).toHaveLength(4);
  expect(titles[0]).toMatch(/^(?:已读取|Read) src\/tool-group-summary.ts$/);
  expect(titles[1]).toMatch(/^(?:已读取|Read) src\/tool-action-summary.ts$/);
  expect(titles[2]).toMatch(/^(?:运行失败|Run failed) bun test$/);
  expect(titles[3]).toMatch(/^(?:已读取|Read) src\/session-timeline.tsx$/);
  expect(html).toContain('data-status="failed"');
  expect(html).not.toMatch(/读取了文件|已读取文件|Read files/);
});

test("single search and directory listing use their own action labels", () => {
  for (const [toolName, args, title] of [
    ["grep", { pattern: "toolGroupSummary", path: "src" }, /title="(?:已搜索|Searched) toolGroupSummary in src"/],
    ["ls", { path: "src" }, /title="(?:已列出|Listed) src"/],
  ] as const) {
    const html = renderToStaticMarkup(<ToolRowsFixture content={[
      { type: "tool-call", toolName, toolCallId: `single-${toolName}`, args, result: "done" },
    ]} />);
    expect(html).toMatch(title);
    expect(html).not.toMatch(/读取了文件|已读取文件|Read files/);
  }
});

test("argument generation shows the action without a fabricated read target", () => {
  const html = renderToStaticMarkup(<ToolRowsFixture running content={[
    { type: "tool-call", toolName: "read", toolCallId: "generating-read", args: {} },
  ]} />);
  expect(html).toMatch(/title="(?:正在准备读取|Preparing to read)"/);
  expect(html).not.toContain('font-mono text-xs tracking-tight text-current');
});

test("running reads use present tense and historical reads stay completed", () => {
  // Zustand's server snapshot reads initial state, not getState().
  const serverState = useStore.getInitialState();
  const previous = serverState.toolCalls;
  try {
    serverState.toolCalls = [{ toolCallId: "active-read", toolName: "read", runId: "test", status: "running", args: { path: "src/summary.ts" } }];
    const html = renderToStaticMarkup(<ToolRowsFixture running content={[
      { type: "tool-call", toolName: "read", toolCallId: "historical-read", args: { path: "src/finished.ts" }, result: "done" },
      { type: "reasoning", text: "Continue" },
      { type: "tool-call", toolName: "read", toolCallId: "active-read", args: {} },
    ]} />);
    expect(html).toMatch(/title="(?:已读取|Read) src\/finished.ts"/);
    expect(html).toMatch(/title="(?:正在读取|Reading) src\/summary.ts"/);
    expect(html).toContain('data-status="running"');
  } finally {
    serverState.toolCalls = previous;
  }
});

test("web tool rows use a source title and the built-in globe icon", () => {
  const html = renderToStaticMarkup(<ToolRowsFixture content={[
    { type: "tool-call", toolName: "qone_web_read", toolCallId: "web-source", args: { url: "https://example.com" }, result: "page content" },
  ]} />);
  expect(html).toMatch(/title="(?:已使用 网页|Used Web) https:\/\/example.com"/);
  expect(html).toContain("globe-light-16.svg");
  expect(html).not.toMatch(/网页 集成|Web integration/);
});

test("preparing an MCP call uses the integration name instead of its protocol identifier", () => {
  const html = renderToStaticMarkup(<ToolRowsFixture running content={[
    { type: "tool-call", toolName: "mcp:mcp-context7:resolve-library-id", toolCallId: "preparing-context7", args: {} },
  ]} />);
  expect(html).toMatch(/title="(?:正在准备使用 Context7|Preparing to use Context7)"/);
  expect(html).toContain("context7-logo");
  expect(html).not.toMatch(/title="[^"]*mcp:/);
});

test("registered web search rows describe their actual actions", () => {
  const search = renderToStaticMarkup(<ToolRowsFixture content={[
    { type: "tool-call", toolName: "web_search", toolCallId: "web-search", args: { query: "assistant-ui" }, result: "found" },
  ]} />);
  expect(search).toMatch(/title="(?:已搜索网页|Searched the web) assistant-ui"/);
});

function HeaderFixture() {
  const messages: ThreadMessageLike[] = [{
    id: "group-with-diff-and-aux", role: "assistant", status: { type: "complete", reason: "stop" },
    content: [
      { type: "tool-call", toolName: "edit", toolCallId: "edit-1", args: { path: "src/App.tsx" }, result: "done" },
      { type: "tool-call", toolName: "read", toolCallId: "read-1", args: { path: "src/index.ts" }, result: "done" },
    ],
  }];
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Messages components={{
    AssistantMessage: () => <MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={2} /></MessagePrimitive.Root>,
  }} /></AssistantRuntimeProvider>;
}

test("tool group header does not render line change indicators or red failure icon", () => {
  const html = renderToStaticMarkup(<HeaderFixture />);
  expect(html).toContain('data-slot="tool-timeline"');
  // Group header trigger should not have diff counter (+8 -7)
  const triggerHtml = html.split('data-slot="tool-timeline"')[1]?.split('</button>')[0] ?? "";
  expect(triggerHtml).not.toContain("text-emerald-600");
  expect(triggerHtml).not.toContain("text-rose-600");
  expect(triggerHtml).not.toContain("xmark");
});
