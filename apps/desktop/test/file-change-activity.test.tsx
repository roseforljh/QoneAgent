import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileChangeActivityRow } from "../src/components/assistant-ui/file-change-activity";
import { toolFileActivities } from "../src/components/assistant-ui/file-change-activity-data";

const result = { details: { fileChanges: [{ path: "src/App.tsx", oldContent: "old\n", newContent: "new\n" }] } };

test("execution file evidence becomes one independent row with three independent click targets", () => {
  const activities = toolFileActivities("edit", result, { path: "src/App.tsx" }, "success");
  expect(activities).toHaveLength(1);
  expect(activities[0]?.changeKind).toBe("edited");
  const html = renderToStaticMarkup(<FileChangeActivityRow activity={activities[0]!} onOpenFile={() => {}} />);
  expect(html).toContain('data-slot="file-change-activity"');
  expect(html).toContain('data-slot="tool-target-link"');
  expect(html).toContain('aria-label="Open file: src/App.tsx"');
  expect(html).toContain("Edited");
  expect(html).toContain('data-slot="file-change-counts"');
  expect(html).toContain("+1");
  expect(html).toContain("−1");
  expect(html.match(/<button/g)).toHaveLength(3);
});

test("running edit uses the argument as a preview and completed write needs evidence", () => {
  const running = toolFileActivities("edit", undefined, { path: "src/App.tsx", oldText: "old", newText: "new" }, "running");
  expect(running).toHaveLength(1);
  expect(running[0]?.changeKind).toBeUndefined();
  expect(running[0]?.presentation?.kind).toBe("diff");
  expect(toolFileActivities("write", undefined, { path: "src/App.tsx", content: "new" }, "success")).toEqual([
    { path: "src/App.tsx", presentation: undefined },
  ]);
});

test("failed mutation evidence keeps the failed row without showing an applied diff", () => {
  const activities = toolFileActivities("edit", result, { path: "src/App.tsx" }, "failed");
  const html = renderToStaticMarkup(<FileChangeActivityRow activity={activities[0]!} status="failed" onOpenFile={() => {}} />);
  expect(html).toContain('data-status="failed"');
  expect(html).toContain('data-slot="tool-target-link"');
  expect(html).not.toContain('data-slot="aui-diff-viewer"');
});

test("successful deletion keeps path actions and diff disclosure without opening the removed file", () => {
  const activity = { path: "src/removed.ts", changeKind: "deleted" as const };
  const deleted = renderToStaticMarkup(<FileChangeActivityRow activity={activity} onOpenFile={() => {}} />);
  expect(deleted).not.toContain('data-slot="tool-target-link"');
  expect(deleted).toContain("data-workspace-path-context-menu-trigger");
  expect(deleted).toContain('tabindex="0"');
  expect(deleted).toContain('aria-label="Show diff for removed.ts"');
  const failed = renderToStaticMarkup(<FileChangeActivityRow activity={activity} status="failed" onOpenFile={() => {}} />);
  expect(failed).toContain('data-slot="tool-target-link"');
});
