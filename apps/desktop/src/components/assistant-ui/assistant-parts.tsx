import { useMemo, type FC } from "react";
import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";
import { GenerativeUIPresentation, SessionTimeline } from "./session-timeline";
import { assistantPartRanges, type AssistantPartRange } from "./assistant-part-ranges";
import { AssistantExecution } from "./assistant-execution";

export const AssistantParts: FC<{ hideSubagentCalls?: boolean }> = ({ hideSubagentCalls = false }) => {
  const parts = useAuiState((state) => state.message.parts);
  const ranges = useMemo(() => assistantPartRanges(parts).flatMap((range) => {
    if (!hideSubagentCalls || range.type !== "tools") return [range];
    const visible: typeof range[] = [];
    let start = -1;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const part = parts[index];
      if (part?.type === "tool-call" && part.toolName === "dispatch_subagent") {
        if (start >= 0) visible.push({ ...range, startIndex: start, endIndex: index });
        start = -1;
      } else if (start < 0) start = index;
    }
    if (start >= 0) visible.push({ ...range, startIndex: start, endIndex: range.endIndex });
    return visible;
  }), [hideSubagentCalls, parts]);

  const firstToolRange = ranges.findIndex((range) => range.type === "tools");
  let lastToolRange = -1;
  for (let index = ranges.length - 1; index >= 0; index--) {
    if (ranges[index]?.type === "tools") {
      lastToolRange = index;
      break;
    }
  }
  const beforeExecutionRanges = firstToolRange >= 0 ? ranges.slice(0, firstToolRange) : ranges;
  const executionRanges = firstToolRange >= 0
    ? ranges.slice(firstToolRange, lastToolRange + 1)
    : [];
  const summaryRanges = firstToolRange >= 0 ? ranges.slice(lastToolRange + 1) : [];

  const renderRange = (range: AssistantPartRange) => {
    if (range.type === "text") return (
      <div className="q-assistant-text text-foreground" key={`text-${range.index}`}>
        <MessagePrimitive.PartByIndex index={range.index} components={{ Text: MarkdownText }} />
      </div>
    );
    if (range.type === "presentation") return <GenerativeUIPresentation key={`present-${range.index}`} index={range.index} />;
    return <SessionTimeline key={`tools-${range.startIndex}`} startIndex={range.startIndex} endIndex={range.endIndex} />;
  };

  return <>
    {beforeExecutionRanges.map(renderRange)}
    {executionRanges.length > 0 && (
      <AssistantExecution ranges={executionRanges}>
        {executionRanges.map(renderRange)}
      </AssistantExecution>
    )}
    {summaryRanges.map(renderRange)}
  </>;
};
