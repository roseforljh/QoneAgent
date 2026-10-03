import { useConversationStore } from "../../lib/conversation-context";
import { CodexArrowLeftIcon as ArrowLeftIcon, CodexCheckIcon as CheckIcon, CodexChevronRightIcon as ChevronRightIcon, CodexXIcon as XIcon, CodexLoader2Icon, CodexClock3Icon } from "./execution-icons";
import { memo, useEffect, useMemo, useState, type FC } from "react";
import { MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import type { SubagentConfigInfo, SubagentRunInfo } from "@qone/protocol";
import type { ThreadMessage } from "@assistant-ui/react";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { subagentMessages } from "../../lib/subagent-messages";
import { createSubagentMediaSelector, subagentImageGenerations } from "../../lib/subagent-image-generations";
import { SubagentLogo } from "../settings/subagent-logo";
import { AssistantParts } from "./assistant-parts";
import { SubagentThread } from "./subagent-thread";
import { ImageGeneration } from "./elements/image-generation";
import { GeneratedMediaArtifacts } from "./generated-media-artifacts";
import { createOwnedSubagentSelector } from "./subagent-message-ownership";
import { createSubagentIdsSelector, createSubagentSummarySelector, messageById, subagentById, subagentsForTree } from "../../lib/store-indexes";
import "./subagent-view.css";

const active = (status: SubagentRunInfo["status"]) => ["created", "running", "waiting_approval", "paused"].includes(status);

function useClock(running: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export const SubagentMedia: FC = () => {
  const { t } = useLocale();
  const messageId = useAuiState((state) => state.message.id);
  const messageParts = useAuiState((state) => state.message.parts);
  const activeRunId = useConversationStore((state) => state.activeRunId);
  const messageRunId = useConversationStore((state) => messageById(state.messages, messageId)?.runId);
  const runId = messageId === "streaming" ? activeRunId : messageRunId;
  const selectOwnedSubagents = useMemo(createOwnedSubagentSelector, []);
  const selectMedia = useMemo(createSubagentMediaSelector, []);
  // Media belongs to the message that dispatched the child, even after later turns reuse it.
  const media = useConversationStore((state) => {
    const owned = selectOwnedSubagents(subagentsForTree(state.subagents, runId), state.messages, runId, messageId, messageParts);
    return selectMedia(subagentImageGenerations(owned.subagents, runId, state.modelConfigs), owned.childRunIds);
  });
  const childRunIds = media.childRunIds;
  const imageGenerations = media.generations;
  if (imageGenerations.length === 0 && childRunIds.length === 0) return null;
  return <div className="flex w-full flex-col gap-2 py-1">
    {imageGenerations.map((generation) => <ImageGeneration
      key={generation.id}
      prompt={generation.prompt}
      generating={generation.generating}
      error={generation.missingImage ? t("subagent.noImageGenerated") : generation.error}
      onRegenerate={!generation.generating ? () => useStore.getState().send({ type: "subagent.control", requestId: crypto.randomUUID(), runId: generation.id, action: "retry" }) : undefined}
    />)}
    <GeneratedMediaArtifacts runIds={childRunIds} />
  </div>;
};

function statusLabel(item: SubagentRunInfo, locale: string) {
  const zh = locale === "zh-CN";
  if (item.status === "completed") return zh ? "已完成" : "Completed";
  if (item.status === "failed") return zh ? "失败" : "Failed";
  if (item.status === "cancelled") return zh ? "已取消" : "Cancelled";
  if (item.status === "interrupted") return zh ? "已中断" : "Interrupted";
  if (item.status === "waiting_approval") return zh ? "等待批准" : "Waiting for approval";
  return zh ? "运行中" : "Running";
}

const renderSubagentMessage = ({ message }: { message: ThreadMessage }) => message.role === "user"
        ? <MessagePrimitive.Root className="q-subagent-task rounded-lg border border-border/50 bg-foreground/[0.03] px-3 py-2 text-xs text-foreground/65">
            <MessagePrimitive.Parts />
          </MessagePrimitive.Root>
        : <MessagePrimitive.Root className="q-subagent-transcript space-y-3 text-sm">
            <AssistantParts />
          </MessagePrimitive.Root>;

const SubagentTranscript: FC = memo(() => <ThreadPrimitive.Messages>{renderSubagentMessage}</ThreadPrimitive.Messages>);

export const SubagentPanel: FC<{ selectedId?: string; onSelect: (id?: string) => void; onClose: () => void }> = ({ selectedId, onSelect, onClose }) => {
  const { locale } = useLocale();
  const selectIds = useMemo(createSubagentIdsSelector, []);
  const subagentIdList = useConversationStore((state) => selectIds(state.subagents));
  const selected = useConversationStore((state) => subagentById(state.subagents, selectedId));
  const subagentConfig = useConversationStore((state) => state.subagentConfig);
  const modelConfigs = useConversationStore((state) => state.modelConfigs);
  const hasActiveSubagent = useConversationStore((state) => state.subagents.some((item) => active(item.status)));
  const now = useClock(hasActiveSubagent);
  const messages = useMemo(() => selected ? subagentMessages(selected) : [], [selected]);
  const title = locale === "zh-CN" ? "子代理" : "Subagents";
  const duration = (item: SubagentRunInfo) => formatDuration(((item.completedAt ?? now) - item.startedAt) / 1000, locale);
  const model = (id?: string) => modelConfigs.find((config) => config.id === id)?.model ?? id ?? (locale === "zh-CN" ? "默认模型" : "Default model");

  return <div className="q-subagent-panel">
    <div className="q-subagent-panel-header">
      {selected && <button type="button" onClick={() => onSelect(undefined)} aria-label={locale === "zh-CN" ? "返回子代理列表" : "Back to subagent list"}><ArrowLeftIcon size={16} /></button>}
      <strong>{title}</strong>
      <button type="button" className="ms-auto" onClick={onClose} aria-label={locale === "zh-CN" ? "关闭子代理侧边栏" : "Close subagent panel"}><XIcon size={16} /></button>
    </div>
    {selected ? <SubagentThread key={selected.id} messages={messages}>
      <h2 className="q-subagent-detail-title">{selected.title}</h2>
      <div className="q-subagent-detail-meta"><span>{statusLabel(selected, locale)}</span><span>·</span><span>{model(selected.model)}</span><span>·</span><span>{duration(selected)}</span></div>
      <SubagentTranscript />
      <GeneratedMediaArtifacts runIds={[selected.id]} />
      {selected.error && <p className="q-subagent-error">{selected.error}</p>}
    </SubagentThread> : <div className="q-subagent-panel-scroll">
      {subagentIdList.length === 0 ? <p className="q-subagent-empty">{locale === "zh-CN" ? "暂无子代理" : "No subagents yet"}</p> : subagentIdList.map((id) => <SubagentRow key={id} id={id} onSelect={onSelect} now={now} locale={locale} profiles={subagentConfig.profiles} />)}
    </div>}
  </div>;
};

const SubagentRow: FC<{ id: string; onSelect: (id?: string) => void; now: number; locale: Parameters<typeof formatDuration>[1]; profiles: SubagentConfigInfo["profiles"] }> = memo(({ id, onSelect, now, locale, profiles }) => {
  const selectSummary = useMemo(createSubagentSummarySelector, []);
  const item = useConversationStore((state) => selectSummary(state.subagents, id));
  if (!item) return null;
  return <button type="button" className="q-subagent-row" onClick={() => onSelect(item.id)}>
    <SubagentLogo logo={profiles.find((profile) => profile.id === item.profileId)?.logo} name={item.title} size={24} />
    {item.status === "completed" ? <CheckIcon size={13} className="shrink-0 text-foreground/60" aria-hidden="true" />
      : item.status === "created" || item.status === "waiting_approval" || item.status === "paused" ? <CodexClock3Icon className="size-3.5 shrink-0" />
        : active(item.status) ? <CodexLoader2Icon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <XIcon size={14} />}
    <span className="min-w-0 flex-1 truncate text-start">{item.title}</span>
    <span className="q-subagent-elapsed">{formatDuration(((item.completedAt ?? now) - item.startedAt) / 1000, locale)}</span>
    <ChevronRightIcon size={14} aria-hidden="true" />
  </button>;
});
