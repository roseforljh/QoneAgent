import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore } from "../src/store";
import { RunFileTree } from "../src/components/assistant-ui/elements/run-file-tree";
import { RunFileChangesAttachment } from "../src/components/assistant-ui/run-file-changes-attachment";
import type { RunFileChanges } from "../src/components/assistant-ui/run-file-changes";

const changes: RunFileChanges = { nodes: [{ path: "src/A.ts", name: "A.ts", depth: 0, kind: "file", additions: 18, deletions: 4, presentations: [] }], totalAdditions: 18, totalDeletions: 4 };

test("file tree is a compact, keyboard-operable disclosure with no raw payload or mounted list by default", () => {
  const markup = renderToStaticMarkup(<RunFileTree changes={changes} onSelect={() => {}} />);
  expect(markup).toContain('data-slot="run-file-changes"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain('aria-controls=');
  expect(markup).toContain('+18');
  expect(markup).toContain('−4');
  expect(markup).not.toContain('data-slot="run-file-list"');
  expect(markup).not.toContain("A.ts");
  expect(markup).not.toContain("request");
});

test("no files produces no attachment", () => {
  expect(renderToStaticMarkup(<RunFileTree changes={{ nodes: [], totalAdditions: 0, totalDeletions: 0 }} onSelect={() => {}} />)).toBe("");
});

test("attachment only renders on the completed run's last assistant message, never in streaming or another run", () => {
  // Zustand's server rendering reads getInitialState, not the live snapshot.
  const serverState = useStore.getInitialState();
  const original = { ...serverState };
  try {
    Object.assign(serverState, {
      messages: [{ id: "activity", runId: "r1", role: "assistant", content: "Editing" }, { id: "final", runId: "r1", role: "assistant", content: "Done" }],
      runs: [{ id: "r1", sessionId: "session", status: "completed" }],
      activeRunId: undefined,
      toolCalls: [{ toolCallId: "one", runId: "r1", toolName: "custom", status: "success", result: { details: { fileChanges: [{ path: "src/A.ts", oldContent: "old\n", newContent: "new\n" }] } } }],
    });
    expect(renderToStaticMarkup(<RunFileChangesAttachment messageId="final" runId="r1" />)).toContain('data-slot="run-file-changes"');
    expect(renderToStaticMarkup(<RunFileChangesAttachment messageId="activity" runId="r1" />)).toBe("");
    expect(renderToStaticMarkup(<RunFileChangesAttachment messageId="streaming" runId="r1" />)).toBe("");
    expect(renderToStaticMarkup(<RunFileChangesAttachment messageId="final" runId="r2" />)).toBe("");
    serverState.activeRunId = "r1";
    expect(renderToStaticMarkup(<RunFileChangesAttachment messageId="final" runId="r1" />)).toBe("");
  } finally { Object.assign(serverState, original); }
});
