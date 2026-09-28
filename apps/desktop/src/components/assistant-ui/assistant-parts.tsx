import { useMemo, type FC } from "react";
import { MessagePrimitive, useAuiState, type PartState } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";
import { GenerativeUIPresentation, SessionTimeline } from "./session-timeline";
import { visibleAssistantPartRanges, type AssistantPartRange } from "./assistant-part-ranges";
import { AssistantExecution } from "./assistant-execution";
import { Image } from "./elements/image";
import { ImageGallery } from "./elements/image-gallery";
import { ImageGeneration } from "./elements/image-generation";
import { useStore } from "../../store";
import { SubagentCapsule } from "./subagent-view";

function regenerateCurrentTurn(messageId: string): void {
  const state = useStore.getState();
  const messageIndex = messageId === "streaming" ? state.messages.length : state.messages.findIndex((message) => message.id === messageId);
  const source = state.messages.slice(0, messageIndex < 0 ? state.messages.length : messageIndex).reverse().find((message) => message.role === "user");
  if (source) state.runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId));
}

type VisibleImagePart = Extract<PartState, { type: "image" }>;

const AssistantImageGallery: FC<{ parts: VisibleImagePart[] }> = ({ parts }) => {
  return <ImageGallery
    images={parts.map((part, index) => ({ id: `${index}-${part.image.slice(-24)}`, src: part.image, alt: part.filename || `Generated image ${index + 1}`, filename: part.filename }))}
  />;
};

const PendingImageGeneration: FC = () => {
  const generation = useAuiState((state) => {
    const custom = state.message.metadata?.custom;
    if (!custom || typeof custom !== "object") return undefined;
    const value = (custom as Record<string, unknown>).qoneImageGeneration;
    if (!value || typeof value !== "object") return undefined;
    const prompt = (value as Record<string, unknown>).prompt;
    const error = (value as Record<string, unknown>).error;
    return typeof prompt === "string" ? { prompt, error: typeof error === "string" ? error : undefined } : undefined;
  });
  const messageId = useAuiState((state) => state.message.id);
  if (!generation) return null;
  return <ImageGeneration prompt={generation.prompt} error={generation.error} generating={!generation.error} onRegenerate={() => regenerateCurrentTurn(messageId)} />;
};

export const AssistantParts: FC<{ hideSubagentCalls?: boolean; showSubagentCapsule?: boolean }> = ({ hideSubagentCalls = false, showSubagentCapsule = false }) => {
  const parts = useAuiState((state) => state.message.parts);
  const hasImage = parts.some((part) => part.type === "image");
  const hasDispatch = parts.some((part) => part.type === "tool-call" && part.toolName === "dispatch_subagent");
  const ranges = useMemo(() => visibleAssistantPartRanges(parts, hideSubagentCalls, showSubagentCapsule), [hideSubagentCalls, parts, showSubagentCapsule]);

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
  const capsuleInExecution = executionRanges.some((range) => range.type === "subagents");

  const renderRange = (range: AssistantPartRange) => {
    if (range.type === "text") return (
      <div className="q-assistant-text text-foreground" key={`text-${range.index}`}>
        <MessagePrimitive.PartByIndex index={range.index} components={{ Text: MarkdownText }} />
      </div>
    );
    if (range.type === "image") return <MessagePrimitive.PartByIndex key={`image-${range.index}`} index={range.index} components={{ Image }} />;
    if (range.type === "subagents") return <SubagentCapsule key={`subagents-${range.index}`} />;
    if (range.type === "images") {
      const imageParts = parts.slice(range.startIndex, range.endIndex).filter((part): part is VisibleImagePart => part.type === "image");
      return <AssistantImageGallery key={`images-${range.startIndex}`} parts={imageParts} />;
    }
    if (range.type === "presentation") return <GenerativeUIPresentation key={`present-${range.index}`} index={range.index} />;
    return <SessionTimeline key={`tools-${range.startIndex}`} startIndex={range.startIndex} endIndex={range.endIndex} />;
  };

  return <>
    {!hasImage && <PendingImageGeneration />}
    {showSubagentCapsule && !hasDispatch && <SubagentCapsule />}
    {beforeExecutionRanges.map(renderRange)}
    {executionRanges.length > 0 && (
      <AssistantExecution ranges={executionRanges}>
        {executionRanges.filter((range) => range.type !== "subagents").map(renderRange)}
      </AssistantExecution>
    )}
    {capsuleInExecution && <SubagentCapsule />}
    {summaryRanges.map(renderRange)}
  </>;
};
