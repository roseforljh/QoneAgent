import { Fragment, useMemo, type FC } from "react";
import { MessagePrimitive, useAuiState, type PartState } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";
import { GenerativeUIPresentation, SessionTimeline } from "./session-timeline";
import { assistantPartRanges, assistantRangeSections, executionDisplayBlocks, hasVisibleAnswer, type AssistantPartRange } from "./assistant-part-ranges";
import { AssistantExecution } from "./assistant-execution";
import { RunFileChangesAttachment } from "./run-file-changes-attachment";
import { Image } from "./elements/image";
import { ImageGallery } from "./elements/image-gallery";
import { ImageGeneration } from "./elements/image-generation";
import { useStore } from "../../store";
import { SubagentMedia } from "./subagent-view";
import { Reasoning } from "./reasoning";
import { ContextCompactionMarker } from "./context-compaction-marker";
import { compactionDisplayIndex, positionedAssistantRanges, type PositionedCompaction } from "./compaction-ranges";

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

export const AssistantParts: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const hasImage = parts.some((part) => part.type === "image");
  const ranges = useMemo(() => assistantPartRanges(parts), [parts]);
  const messageId = useAuiState((state) => state.message.id);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const runId = useStore((state) => messageId === "streaming" ? state.activeRunId : state.messages.find((message) => message.id === messageId)?.runId);
  const runStatus = useStore((state) => state.runs.find((run) => run.id === runId)?.status);
  const compactions = useStore((state) => state.compactions);
  const pending = useStore((state) => state.currentSessionId ? state.autoCompactionStatuses[state.currentSessionId] : undefined);
  const positionedRanges = useMemo(() => {
    const markers: PositionedCompaction[] = compactions.flatMap((marker) => marker.runId === runId && marker.partIndex !== undefined
      ? [{ ...marker, partIndex: marker.partIndex, startedAt: marker.createdAt }] : []);
    if (pending?.runId === runId && pending?.partIndex !== undefined) markers.push({ ...pending, partIndex: pending.partIndex, status: "running", source: "automatic" });
    return positionedAssistantRanges(ranges, markers.map((marker) => ({ ...marker, partIndex: compactionDisplayIndex(parts, marker.partIndex) })));
  }, [ranges, parts, compactions, pending, runId]);
  const sections = useMemo(() => assistantRangeSections(positionedRanges), [positionedRanges]);
  const displayBlocks = useMemo(() => executionDisplayBlocks(sections.process), [sections.process]);
  const lastActivityBlockIndex = displayBlocks.reduce((last, block, index) => block.kind === "activity" ? index : last, -1);
  const finalAnswerStarted = hasVisibleAnswer(parts, sections.answer);
  const firstActivityRange = sections.activity[0];
  const disclosureStartIndex = firstActivityRange && ("index" in firstActivityRange ? firstActivityRange.index : firstActivityRange.startIndex);
  const statusAtStart = finalAnswerStarted && runStatus !== "cancelled" && runStatus !== "interrupted"
    || runStatus === "created" || runStatus === "running" || runStatus === "paused" || runStatus === "waiting_approval"
    || !runStatus && messageRunning;

  const renderRange = (range: AssistantPartRange) => {
    if (range.type === "reasoning") return <MessagePrimitive.PartByIndex key={`reasoning-${range.index}`} index={range.index} components={{ Reasoning }} />;
    if (range.type === "text") return (
      <div className="q-assistant-text text-foreground" key={`text-${range.index}`}>
        <MessagePrimitive.PartByIndex index={range.index} components={{ Text: MarkdownText }} />
      </div>
    );
    if (range.type === "image") return <MessagePrimitive.PartByIndex key={`image-${range.index}`} index={range.index} components={{ Image }} />;
    if (range.type === "compaction") return <ContextCompactionMarker key={range.marker.id} {...range.marker} />;
    if (range.type === "images") {
      const imageParts = parts.slice(range.startIndex, range.endIndex).filter((part): part is VisibleImagePart => part.type === "image");
      return <AssistantImageGallery key={`images-${range.startIndex}`} parts={imageParts} />;
    }
    if (range.type === "presentation") return <GenerativeUIPresentation key={`present-${range.index}`} index={range.index} />;
    return <SessionTimeline key={`tools-${range.startIndex}`} startIndex={range.startIndex} endIndex={range.endIndex} />;
  };

  return <>
    {!hasImage && <PendingImageGeneration />}
    {sections.leading.map(renderRange)}
    {displayBlocks.map((block, index) => block.kind === "persistent"
      ? <Fragment key={`persistent-${index}`}>{block.ranges.map(renderRange)}</Fragment>
      : <AssistantExecution key={`activity-${index}`} ranges={block.ranges} statusRanges={sections.activity} finalAnswerStarted={finalAnswerStarted} disclosureStartIndex={disclosureStartIndex} showStatus={index === (statusAtStart ? 0 : lastActivityBlockIndex)} statusAtStart={statusAtStart}>
          {block.ranges.map(renderRange)}
        </AssistantExecution>)}
    {sections.answer.map(renderRange)}
    <SubagentMedia />
    <RunFileChangesAttachment messageId={messageId} runId={runId} />
  </>;
};
