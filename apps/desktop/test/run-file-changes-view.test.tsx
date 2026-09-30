import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useStore } from "../src/store";
import { RunFileChangesCard } from "../src/components/assistant-ui/elements/run-file-tree";
import { RunFileChangesAttachment } from "../src/components/assistant-ui/run-file-changes-attachment";
import { RunChangesPanel } from "../src/components/assistant-ui/run-changes-panel";
import type { RunFileChanges } from "../src/components/assistant-ui/run-file-changes";

const changes: RunFileChanges = { nodes: [{ path: "src/A.ts", name: "A.ts", depth: 0, kind: "file", changeKind: "edited", additions: 18, deletions: 4, presentations: [] }], totalAdditions: 18, totalDeletions: 4 };

test("completed summary is a resource card, not repeated activity disclosures", () => {
  const markup = renderToStaticMarkup(<RunFileChangesCard changes={changes} onReview={() => {}} />);
  expect(markup).toContain('data-slot="run-file-changes"');
  expect(markup).toContain("Edited A.ts");
  expect(markup).toContain("View changes");
  expect(markup).toContain("+18");
  expect(markup).toContain("−4");
  expect(markup).not.toContain("aria-expanded");
  expect(markup).not.toContain("tool-target-link");
  expect(markup.match(/<button/g)).toHaveLength(2);
});

test("multiple files have review rows and clickable line counts", () => {
  const multiple = { ...changes, nodes: [...changes.nodes, { ...changes.nodes[0]!, path: "src/B.ts", name: "B.ts" }] };
  const markup = renderToStaticMarkup(<RunFileChangesCard changes={multiple} onReview={() => {}} />);
  expect(markup).toContain("Edited 2 files");
  expect(markup).toContain('aria-label="View changes: src/A.ts"');
  expect(markup).toContain('aria-label="View changes: src/B.ts"');
  expect(markup.match(/data-slot="run-file-change"/g)).toHaveLength(2);
  expect(markup).not.toContain("Show diff");
});

test("no files produces no attachment", () => {
  expect(renderToStaticMarkup(<RunFileChangesCard changes={{ nodes: [], totalAdditions: 0, totalDeletions: 0 }} />)).toBe("");
});

test("saved empty file creation has an explicit panel message", () => {
  const empty: RunFileChanges = { nodes: [{ ...changes.nodes[0]!, changeKind: "created", additions: 0, deletions: 0, presentations: [{ kind: "diff", name: "src/A.ts", oldFile: { content: "" }, newFile: { content: "" } }] }], totalAdditions: 0, totalDeletions: 0 };
  const markup = renderToStaticMarkup(<RunChangesPanel target={{ sessionId: "session", runId: "run", changes: empty }} />);
  expect(markup).toContain("Created an empty file");
});

test("missing saved diff displays a message rather than a blank panel", () => {
  const markup = renderToStaticMarkup(<RunChangesPanel target={{ sessionId: "session", runId: "run", changes }} />);
  expect(markup).toContain("No saved diff content");
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
