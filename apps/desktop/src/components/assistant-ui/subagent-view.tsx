import { CodexArrowLeftIcon as ArrowLeftIcon, CodexCheckIcon as CheckIcon, CodexChevronRightIcon as ChevronRightIcon, CodexXIcon as XIcon, CodexLoader2Icon, CodexClock3Icon } from "./execution-icons";
import { useEffect, useMemo, useState, type FC } from "react";
import { MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import type { SubagentRunInfo } from "@qone/protocol";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { subagentMessages } from "../../lib/subagent-messages";
import { subagentImageGenerations } from "../../lib/subagent-image-generations";
import { SubagentLogo } from "../settings/subagent-logo";
import { AssistantParts } from "./assistant-parts";
import { SubagentThread } from "./subagent-thread";
import { ImageGeneration } from "./elements/image-generation";
import { GeneratedMediaArtifacts } from "./generated-media-artifacts";
import { subagentsForAssistantMessage } from "./subagent-message-ownership";
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
  const activeRunId = useStore((state) => state.activeRunId);
  const messageRunId = useStore((state) => state.messages.find((message) => message.id === messageId)?.runId);
  const messages = useStore((state) => state.messages);
  const allSubagents = useStore((state) => state.subagents);
  const models = useStore((state) => state.modelConfigs);
  const runId = messageId === "streaming" ? activeRunId : messageRunId;
  // Media belongs to the message that dispatched the child, even after later turns reuse it.
  const subagents = useMemo(
    () => subagentsForAssistantMessage(allSubagents, messages, runId, messageId, messageParts),
    [allSubagents, messages, runId, messageId, messageParts],
  );
  const childRunIds = useMemo(() => {
    if (!runId) return [];
    const descendants = new Set(subagents.map((item) => item.id));
    for (let changed = true; changed;) {
      changed = false;
      for (const item of allSubagents) if (descendants.has(item.parentRunId) && !descendants.has(item.id)) {
        descendants.add(item.id);
        changed = true;
      }
    }
    return [...descendants];
  }, [allSubagents, runId, subagents]);
  const imageGenerations = useMemo(() => subagentImageGenerations(subagents, runId, models), [subagents, runId, models]);
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

const SubagentTranscript: FC = () => {
  return <ThreadPrimitive.Messages>
      {({ message }) => message.role === "user"
        ? <MessagePrimitive.Root className="q-subagent-task rounded-lg border border-border/50 bg-foreground/[0.03] px-3 py-2 text-xs text-foreground/65">
            <MessagePrimitive.Parts />
          </MessagePrimitive.Root>
        : <MessagePrimitive.Root className="q-subagent-transcript space-y-3 text-sm">
            <AssistantParts />
          </MessagePrimitive.Root>}
    </ThreadPrimitive.Messages>;
};

export const SubagentPanel: FC<{ selectedId?: string; onSelect: (id?: string) => void; onClose: () => void }> = ({ selectedId, onSelect, onClose }) => {
  const { locale } = useLocale();
  const subagents = useStore((state) => state.subagents);
  const subagentConfig = useStore((state) => state.subagentConfig);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const now = useClock(subagents.some((item) => active(item.status)));
  const selected = subagents.find((item) => item.id === selectedId);
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
      {subagents.length === 0 ? <p className="q-subagent-empty">{locale === "zh-CN" ? "暂无子代理" : "No subagents yet"}</p> : subagents.map((item) => <button
        type="button" key={item.id} className="q-subagent-row" onClick={() => onSelect(item.id)}
      >
        <SubagentLogo logo={subagentConfig.profiles.find((profile) => profile.id === item.profileId)?.logo} name={item.title} size={24} />
        {item.status === "completed" ? <CheckIcon size={13} className="shrink-0 text-foreground/60" aria-hidden="true" />
          : item.status === "created" || item.status === "waiting_approval" || item.status === "paused" ? <CodexClock3Icon className="size-3.5 shrink-0" />
          : active(item.status) ? <CodexLoader2Icon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : <XIcon size={14} />}
        <span className="min-w-0 flex-1 truncate text-start">{item.title}</span>
        <span className="q-subagent-elapsed">{duration(item)}</span>
        <ChevronRightIcon size={14} aria-hidden="true" />
      </button>)}
    </div>}
  </div>;
};
