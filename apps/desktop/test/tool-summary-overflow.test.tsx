import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolTimeline } from "../src/components/assistant-ui/elements/tool-timeline";
import { ToolCall } from "../src/components/assistant-ui/elements/tool-call";
import { CodexFileSearchIcon } from "../src/components/assistant-ui/execution-icons";
import { toolTarget } from "../src/components/assistant-ui/tool-action-summary";
import { toolGroupSummary } from "../src/components/assistant-ui/tool-group-summary";

const longCommand = `Get-Content ${"very-long-directory/".repeat(15)}source.ts; Get-ChildItem`;
const summary = `读取 2 项 (${longCommand}) · 查找 2 项 (**/*dock*、**/*Terminal*)`;
const steps = [{ verb: "读取", chip: longCommand, icon: CodexFileSearchIcon }];

test("summary text is constrained independently from the disclosure icon", () => {
  const html = renderToStaticMarkup(<ToolTimeline
    steps={steps} visibleSteps={1} stats={[]} streaming={false} open={false}
    onOpenChange={() => {}} restingLabel={summary} activeLabel="正在运行"
    fullSummary="完整路径 source.ts" headerIcon={CodexFileSearchIcon}
  />);
  expect(html).toContain(summary);
  expect(html).toContain('title="完整路径 source.ts"');
  expect(html).toContain('data-slot="overflow-fade"');
  expect(html).toContain("inline-flex min-w-0 max-w-full");
  expect(html).toContain("focus-visible:ring-2");
  expect(html).toContain("group-focus-visible/trigger:opacity-100");
  const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
  expect(controls).toBeDefined();
  expect(html).toContain(`id="${controls}"`);
  expect(html).toContain('aria-expanded="false"');
});
test("active summary retains the full target even when its display uses a basename", () => {
  const html = renderToStaticMarkup(<ToolTimeline
    steps={steps} visibleSteps={1} stats={[]} streaming open={false}
    onOpenChange={() => {}} restingLabel="已完成" activeLabel="正在读取 source.ts"
    fullActiveLabel={`正在读取 ${longCommand}`}
  />);
  expect(html).toContain(`title="正在读取 ${longCommand}"`);
});
test("individual calls use container width, preserve full targets and keep diff counts separate", () => {
  const html = renderToStaticMarkup(<ToolCall
    label="读取" activeLabel="正在读取" query={longCommand} fullTarget={`C:/${longCommand}`}
    result="result" stat={{ added: 20, removed: 4 }} running={false} open
    onOpenChange={() => {}}
  />);
  expect(html).toContain(longCommand);
  expect(html).toContain(`title="C:/${longCommand}"`);
  expect(html).toContain("shrink-0 text-start font-medium");
  expect(html).toContain("+20");
  expect(html).toContain("−4");
  expect(html).not.toContain("28rem,65vw");
  expect(html).toContain('aria-expanded="true"');
});
test("no character limit or three-target cutoff can discard data before rendering", () => {
  expect(toolTarget({ toolName: "powershell", args: { command: longCommand } })).toBe(longCommand);
  const files = Array.from({ length: 5 }, (_, i) => ({ verb: "Read", target: `file-${i}.ts`, fullTarget: `src/file-${i}.ts` }));
  expect(toolGroupSummary(files, "en")).toBe("Read ×5 (file-0.ts, file-1.ts, file-2.ts, file-3.ts, file-4.ts)");
  expect(toolGroupSummary(files, "en", { fullTargets: true })).toContain("src/file-4.ts");
});
