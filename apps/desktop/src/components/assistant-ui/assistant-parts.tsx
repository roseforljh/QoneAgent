import { useConversationStore, useConversationStoreApi } from "../../lib/conversation-context";
import { Fragment, useMemo, type FC } from "react";
import { MessagePrimitive, useAuiState, type PartState } from "@assistant-ui/react";
import { MarkdownText } from "./markdown-text";
import { GenerativeUIPresentation, SessionTimeline } from "./session-timeline";
import { assistantPartRanges, assistantRangeSections, executionDisplayBlocks, hasVisibleAnswer, type AssistantPartRange } from "./assistant-part-ranges";
import { AssistantExecution } from "./assistant-execution";
import { executionStatusAtStart } from "./execution-disclosure-state";
import { RunFileChangesAttachment } from "./run-file-changes-attachment";
import { Image } from "./elements/image";
import { ImageGallery } from "./elements/image-gallery";
import { ImageGeneration } from "./elements/image-generation";
import { SubagentMedia } from "./subagent-view";
import { Reasoning } from "./reasoning";
import { ContextCompactionMarker } from "./context-compaction-marker";
import { compactionDisplayIndex, positionedAssistantRanges, type PositionedCompaction } from "./compaction-ranges";
import { executionActivityItems } from "./execution-activity-items";
import { createPartToolsSelector, messageById, runById } from "../../lib/store-indexes";
import { assistantWaitingPhase } from "./assistant-waiting-phase";
import { AssistantWaiting } from "./assistant-waiting";
import { useLocale } from "../../localization";
import type { ExecutionPhase } from "../../store";

function regenerateCurrentTurn(messageId: string, owner: ReturnType<typeof useConversationStoreApi>): void {
  const state = owner.getState();
  const messageIndex = messageId === "streaming" ? state.messages.length : state.messages.findIndex((message) => message.id === messageId);
  const source = state.messages.slice(0, messageIndex < 0 ? state.messages.length : messageIndex).reverse().find((message) => message.role === "user");
  if (source) state.runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId), undefined, source.quote);
}

type VisibleImagePart = Extract<PartState, { type: "image" }>;

const AssistantImageGallery: FC<{ parts: VisibleImagePart[] }> = ({ parts }) => {
  return <ImageGallery
    images={parts.map((part, index) => ({ id: `${index}-${part.image.slice(-24)}`, src: part.image, alt: part.filename || `Generated image ${index + 1}`, filename: part.filename }))}
  />;
};

const PendingImageGeneration: FC = () => {
  const owner = useConversationStoreApi();
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
  return <ImageGeneration prompt={generation.prompt} error={generation.error} generating={!generation.error} onRegenerate={() => regenerateCurrentTurn(messageId, owner)} />;
};

export const AssistantParts: FC = () => {
  const { t } = useLocale();
  const parts = useAuiState((state) => state.message.parts);
  const hasImage = parts.some((part) => part.type === "image");
  const ranges = useMemo(() => assistantPartRanges(parts), [parts]);
  const messageId = useAuiState((state) => state.message.id);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const runId = useConversationStore((state) => messageId === "streaming" ? state.activeRunId : messageById(state.messages, messageId)?.runId);
  const runStatus = useConversationStore((state) => runById(state.runs, runId)?.status);
  const compactions = useConversationStore((state) => state.compactions);
  const pending = useConversationStore((state) => state.currentSessionId ? state.autoCompactionStatuses[state.currentSessionId] : undefined);
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
  const statusAtStart = executionStatusAtStart(finalAnswerStarted, runStatus, messageRunning);
  const selectTools = useMemo(createPartToolsSelector, []);
  const toolCalls = useConversationStore((state) => selectTools(state.toolCalls, parts));
  const toolCallsById = useMemo(() => new Map(toolCalls.map((call) => [call.toolCallId, call])), [toolCalls]);
  const activityItems = useMemo(() => {
    return displayBlocks.map((block) => executionActivityItems(block.ranges, parts, toolCallsById));
  }, [displayBlocks, parts, toolCallsById]);
  const requestStartedAt = useConversationStore((state) => state.modelRequest?.runId === runId ? state.modelRequest?.startedAt : undefined);
  const executionPhase = useConversationStore((state) => state.executionPhase?.runId === runId ? state.executionPhase?.phase : undefined);
  const lastToolName = toolCalls.filter((call) => call.runId === runId).at(-1)?.toolName;
  const imageGeneration = useAuiState((state) => Boolean(state.message.metadata?.custom?.qoneImageGeneration));
  // Earlier commentary/reasoning must not hide the gap after a completed tool.
  let latestVisiblePart: PartState | undefined;
  for (const part of parts) {
    if ((part.type !== "text" && part.type !== "reasoning") || part.text.trim()) latestVisiblePart = part;
  }
  const waitingPhase = imageGeneration ? undefined : assistantWaitingPhase({
    messageRunning,
    compacting: Boolean(pending && pending.runId === runId),
    hasCurrentText: finalAnswerStarted || latestVisiblePart?.type === "text" || latestVisiblePart?.type === "image"
      || latestVisiblePart?.type === "tool-call" && latestVisiblePart.toolName === "present" && !latestVisiblePart.isError,
    hasReasoning: latestVisiblePart?.type === "reasoning" && latestVisiblePart.status.type === "running",
    parts, toolCallsById, requestStartedAt,
  });
  const executionDetail = executionPhase ? ({
    preparing: t("chat.executionPreparing"),
    downloading: t("chat.executionDownloading"),
    "media-attachment": t("chat.executionMediaAttachment"),
    "provider-processing": t("chat.executionProviderProcessing"),
    "model-generation": t("chat.executionModelGeneration"),
    "external-tool": t("chat.executionExternalTool"),
  } satisfies Record<ExecutionPhase, string>)[executionPhase]
    + (lastToolName && executionPhase !== "preparing" ? ` · ${t("chat.executionLastTool", { name: lastToolName })}` : "") : undefined;

  const renderRange = (range: AssistantPartRange) => {
    if (range.type === "reasoning") return <MessagePrimitive.PartByIndex key={`reasoning-${range.index}`} index={range.index} components={{ Reasoning }} />;
    if (range.type === "text") return (
      <div className="q-assistant-text text-foreground" data-aui-quote-selectable="true" key={`text-${range.index}`}>
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
    if (range.type !== "tools") return null;
    return <SessionTimeline key={`tools-${range.startIndex}`} startIndex={range.startIndex} endIndex={range.endIndex} />;
  };

  return <>
    {!hasImage && <PendingImageGeneration />}
    {sections.leading.map(renderRange)}
    {displayBlocks.map((block, index) => block.kind === "persistent"
      ? <Fragment key={`persistent-${index}`}>{block.ranges.map(renderRange)}</Fragment>
      : <AssistantExecution key={`activity-${index}`} ranges={block.ranges} statusRanges={sections.activity} finalAnswerStarted={finalAnswerStarted} disclosureStartIndex={disclosureStartIndex} showStatus={index === (statusAtStart ? 0 : lastActivityBlockIndex)} statusAtStart={statusAtStart}>
          {activityItems[index]?.map((item) => item.kind === "part" ? renderRange(item.range)
            : <SessionTimeline key={`activity-${item.startIndex}`} startIndex={item.startIndex} endIndex={item.endIndex} activityRanges={item.ranges} title={item.title} />)}
        </AssistantExecution>)}
    {sections.answer.map(renderRange)}
    {waitingPhase && <AssistantWaiting phase={waitingPhase} detail={executionDetail} />}
    <SubagentMedia />
    <RunFileChangesAttachment messageId={messageId} runId={runId} />
  </>;
};
