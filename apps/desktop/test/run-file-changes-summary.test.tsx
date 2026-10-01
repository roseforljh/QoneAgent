import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore } from "../src/store";
import { RunFileChangesSummary } from "../src/components/assistant-ui/run-file-changes-summary";

test("current run file changes summary ignores historical runs and uses net counts", () => {
  const serverState = useStore.getInitialState();
  const original = { ...serverState };
  try {
    Object.assign(serverState, {
      currentSessionId: "session",
      activeRunId: "run-2",
      running: true,
      runs: [{ id: "run-2", sessionId: "session", status: "running" }],
      messages: [],
      toolCalls: [
        { toolCallId: "one", runId: "run-1", toolName: "edit", status: "success", result: { details: { fileChanges: [{ path: "src/A.ts", oldContent: "old\n", newContent: "new\n" }] } } },
        { toolCallId: "two", runId: "run-2", toolName: "edit", status: "success", result: { details: { fileChanges: [{ path: "src/B.ts", oldContent: "before\n", newContent: "after\n" }] } } },
      ],
    });
    const markup = renderToStaticMarkup(<RunFileChangesSummary />);
    expect(markup).toContain('data-slot="run-file-changes-summary"');
    expect(markup).toContain("1 files changed");
    expect(markup).toContain("+1");
    expect(markup).toContain("−1");
    expect(markup).not.toContain("2 files changed");
    expect(markup).toContain("View changed files");
  } finally { Object.assign(serverState, original); }
});

test("current run file changes summary stays hidden without an active run", () => {
  const serverState = useStore.getInitialState();
  const original = { ...serverState };
  try {
    Object.assign(serverState, {
      currentSessionId: "session",
      activeRunId: undefined,
      runs: [{ id: "run", sessionId: "session", status: "completed" }],
      messages: [],
      toolCalls: [{ toolCallId: "one", runId: "run", toolName: "edit", status: "success", result: { details: { fileChanges: [{ path: "src/A.ts", oldContent: "old\n", newContent: "new\n" }] } } }],
    });
    expect(renderToStaticMarkup(<RunFileChangesSummary />)).toBe("");
  } finally { Object.assign(serverState, original); }
});

test("current run file changes summary stays hidden after the run ends", () => {
  const serverState = useStore.getInitialState();
  const original = { ...serverState };
  try {
    Object.assign(serverState, {
      currentSessionId: "session",
      activeRunId: "run",
      running: false,
      runs: [{ id: "run", sessionId: "session", status: "completed" }],
      messages: [],
      toolCalls: [{ toolCallId: "one", runId: "run", toolName: "edit", status: "success", result: { details: { fileChanges: [{ path: "src/A.ts", oldContent: "old\n", newContent: "new\n" }] } } }],
    });
    expect(renderToStaticMarkup(<RunFileChangesSummary />)).toBe("");
  } finally { Object.assign(serverState, original); }
});

test("current run file changes summary follows the Codex run lifecycle", () => {
  const serverState = useStore.getInitialState();
  const original = { ...serverState };
  const change = { toolCallId: "one", runId: "run", toolName: "edit", status: "success", result: { details: { fileChanges: [{ path: "src/A.ts", oldContent: "old\n", newContent: "new\n" }] } } };
  try {
    Object.assign(serverState, { currentSessionId: "session", activeRunId: "run", running: true, messages: [], toolCalls: [change] });
    for (const status of ["created", "running", "waiting_approval", "paused"] as const) {
      serverState.running = true;
      serverState.runs = [{ id: "run", sessionId: "session", status }];
      expect(renderToStaticMarkup(<RunFileChangesSummary />)).toContain('data-slot="run-file-changes-summary"');
    }
    for (const status of ["completed", "failed", "cancelled", "interrupted"] as const) {
      serverState.running = false;
      serverState.runs = [{ id: "run", sessionId: "session", status }];
      expect(renderToStaticMarkup(<RunFileChangesSummary />)).toBe("");
    }
  } finally { Object.assign(serverState, original); }
});
