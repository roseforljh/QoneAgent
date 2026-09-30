import { Fragment, useMemo, type FC } from "react";
import { MessagePrimitive, useAuiState, type PartState } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";
import { GenerativeUIPresentation, SessionTimeline } from "./session-timeline";
import { assistantRangeSections, hasVisibleAnswer, visibleAssistantPartRanges, type AssistantPartRange } from "./assistant-part-ranges";
import { AssistantExecution } from "./assistant-execution";
import { Image } from "./elements/image";
import { ImageGallery } from "./elements/image-gallery";
import { ImageGeneration } from "./elements/image-generation";
import { useStore } from "../../store";
import { SubagentCapsule } from "./subagent-view";
import { Reasoning } from "./reasoning";
import { ContextCompactionMarker } from "./context-compaction-marker";
import { compactionDisplayIndex, compactionRangeSegments, type PositionedCompaction } from "./compaction-ranges";

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
  const sections = useMemo(() => assistantRangeSections(ranges), [ranges]);
  const messageId = useAuiState((state) => state.message.id);
  const runId = useStore((state) => messageId === "streaming" ? state.activeRunId : state.messages.find((message) => message.id === messageId)?.runId);
  const isStreamingMessage = messageId === "streaming";
  const streamingText = useStore((state) => isStreamingMessage ? state.streaming : "");
  const toolCalls = useStore((state) => state.toolCalls);
  const hasActiveTools = toolCalls.some((call) => call.runId === runId && (call.status === "running" || call.status === "waiting"));
  const streamingAnswerStarted = isStreamingMessage && Boolean(streamingText.trim()) && !hasActiveTools;
  const finalAnswerStarted = hasVisibleAnswer(parts, sections.answer) || streamingAnswerStarted;
  const compactions = useStore((state) => state.compactions);
  const pending = useStore((state) => state.currentSessionId ? state.autoCompactionStatuses[state.currentSessionId] : undefined);
  const segments = useMemo(() => {
    const markers: PositionedCompaction[] = compactions.flatMap((marker) => marker.runId === runId && marker.partIndex !== undefined
      ? [{ ...marker, partIndex: marker.partIndex, startedAt: marker.createdAt }] : []);
    if (pending?.runId === runId && pending?.partIndex !== undefined) markers.push({ ...pending, partIndex: pending.partIndex, status: "running", source: "automatic" });
    return compactionRangeSegments(ranges, markers.map((marker) => ({ ...marker, partIndex: compactionDisplayIndex(parts, marker.partIndex) })));
  }, [ranges, parts, compactions, pending, runId]);

  const renderRange = (range: AssistantPartRange) => {
    if (range.type === "reasoning") return <MessagePrimitive.PartByIndex key={`reasoning-${range.index}`} index={range.index} components={{ Reasoning }} />;
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
    {segments.map((segment) => {
      const group = assistantRangeSections(segment.ranges);
      return <Fragment key={segment.marker?.id ?? "tail"}>
        {group.leading.map(renderRange)}
        {group.activity.length > 0 && (
          <AssistantExecution ranges={group.activity} finalAnswerStarted={finalAnswerStarted}>
            {group.activity.map(renderRange)}
          </AssistantExecution>
        )}
        {group.persistent.map(renderRange)}
        {group.answer.map(renderRange)}
        {segment.marker && <ContextCompactionMarker {...segment.marker} />}
      </Fragment>;
    })}
  </>;
};
