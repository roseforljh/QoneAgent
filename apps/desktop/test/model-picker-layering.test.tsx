import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useStore } from "../src/store";
import { RunFileChangesSummary } from "../src/components/assistant-ui/run-file-changes-summary";

test("RunFileChangesSummary does not assign elevated z-index that leaks across stacking contexts", () => {
  const serverState = useStore.getInitialState();
  const original = { ...serverState };
  try {
    Object.assign(serverState, {
      currentSessionId: "session-1",
      activeRunId: "run-1",
      running: true,
      runs: [{ id: "run-1", sessionId: "session-1", status: "running" }],
      messages: [],
      toolCalls: [
        { toolCallId: "call-1", runId: "run-1", toolName: "edit", status: "success", result: { details: { fileChanges: [{ path: "test.ts", oldContent: "a", newContent: "b" }] } } },
      ],
    });
    const markup = renderToStaticMarkup(<RunFileChangesSummary />);
    expect(markup).toContain('data-slot="run-file-changes-summary"');
    // Ensure no hardcoded elevated z-index like z-10 that would paint over popovers
    expect(markup).not.toMatch(/\bz-10\b/);
  } finally {
    Object.assign(serverState, original);
  }
});

test("ModelPicker renders Popover.Content inside Popover.Portal for root body stacking context", () => {
  const modelPickerSource = readFileSync(
    resolve(import.meta.dir, "../src/components/assistant-ui/model-picker.tsx"),
    "utf-8"
  );
  // Must wrap Popover.Content in Popover.Portal so it hovers above the viewport footer and file summaries
  expect(modelPickerSource).toContain("<Popover.Portal>");
  expect(modelPickerSource).toContain("</Popover.Portal>");
  const portalIndex = modelPickerSource.indexOf("<Popover.Portal>");
  const contentIndex = modelPickerSource.indexOf("<Popover.Content");
  const portalCloseIndex = modelPickerSource.indexOf("</Popover.Portal>");
  const contentCloseIndex = modelPickerSource.indexOf("</Popover.Content>");
  expect(portalIndex).toBeGreaterThan(-1);
  expect(contentIndex).toBeGreaterThan(portalIndex);
  expect(contentCloseIndex).toBeGreaterThan(contentIndex);
  expect(portalCloseIndex).toBeGreaterThan(contentCloseIndex);
});
