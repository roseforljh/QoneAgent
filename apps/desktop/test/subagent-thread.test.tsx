import { expect, test } from "bun:test";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReadonlyThreadProvider, ThreadPrimitive, useAuiState, useThreadViewport } from "@assistant-ui/react";
import { SubagentThread } from "../src/components/assistant-ui/subagent-thread";
import { subagentMessages } from "../src/lib/subagent-messages";
import type { SubagentRunInfo } from "@qone/protocol";

const worker: SubagentRunInfo = {
  id: "child", parentSessionId: "session", parentRunId: "parent", toolCallId: "delegate",
  title: "Review", task: "Review scrolling", status: "running", startedAt: 1000,
  content: "", parts: [], streaming: "Latest output",
};

test("subagent detail uses the official bottom-following viewport including trailing content", () => {
  const messages = subagentMessages(worker);
  const children = createElement("p", null, "Trailing media or error");
  const frame = SubagentThread({ messages, children }) as ReactElement<ComponentProps<typeof ReadonlyThreadProvider>>;
  expect(frame.type).toBe(ReadonlyThreadProvider);
  expect(frame.props.messages).toBe(messages);
  const viewport = frame.props.children as ReactElement<ComponentProps<typeof ThreadPrimitive.Viewport>>;
  expect(viewport.type).toBe(ThreadPrimitive.Viewport);
  expect(viewport.props).toMatchObject({
    className: "q-subagent-panel-scroll",
    turnAnchor: "bottom",
    autoScroll: true,
    scrollToBottomOnInitialize: true,
    scrollToBottomOnRunStart: true,
    scrollToBottomOnThreadSwitch: true,
  });
  // Re-entry must not restore a previous reading position.
  expect(viewport.props.scrollRestoration).toBeUndefined();
  expect(viewport.props.children).toBe(children);
});

function ThreadProbe() {
  const messages = useAuiState((state) => state.thread.messages);
  const anchor = useThreadViewport((state) => state.turnAnchor);
  return <p data-anchor={anchor}>{messages.at(-1)?.content.map((part) => part.type === "text" ? part.text : "").join("")}</p>;
}

test("subagent bottom anchoring is isolated from the parent thread's top anchoring", () => {
  const markup = renderToStaticMarkup(
    <ReadonlyThreadProvider messages={subagentMessages({ ...worker, id: "parent", streaming: "Parent output" })}>
      <ThreadPrimitive.Viewport turnAnchor="top">
        <ThreadProbe />
        <SubagentThread messages={subagentMessages(worker)}><ThreadProbe /></SubagentThread>
        <ThreadProbe />
      </ThreadPrimitive.Viewport>
    </ReadonlyThreadProvider>,
  );
  expect(markup).toContain('<p data-anchor="bottom">Latest output</p>');
  expect(markup.match(/<p data-anchor="top">Parent output<\/p>/g)).toHaveLength(2);
});

test("opening completed or failed history still initializes a bottom viewport", () => {
  for (const status of ["completed", "failed"] as const) {
    const markup = renderToStaticMarkup(
      <SubagentThread messages={subagentMessages({ ...worker, status, streaming: undefined, content: "Final output" })}>
        <ThreadProbe />
        <p>Last detail</p>
      </SubagentThread>,
    );
    expect(markup).toContain('class="q-subagent-panel-scroll"');
    expect(markup).toContain('<p data-anchor="bottom">Final output</p><p>Last detail</p>');
  }
});
