import { useEffect, useMemo, useState, type FC } from "react";
import { MessagePrimitive, ReadonlyThreadProvider, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { ArrowLeftIcon, CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import type { SubagentRunInfo } from "@qone/protocol";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { subagentMessages } from "../../lib/subagent-messages";
import { subagentImageGenerations } from "../../lib/subagent-image-generations";
import { SubagentLogo } from "../settings/subagent-logo";
import { AssistantParts } from "./assistant-parts";
import { ImageGeneration } from "./elements/image-generation";
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

export const SubagentCapsule: FC = () => {
  const { locale, t } = useLocale();
  const messageId = useAuiState((state) => state.message.id);
  const activeRunId = useStore((state) => state.activeRunId);
  const messageRunId = useStore((state) => state.messages.find((message) => message.id === messageId)?.runId);
  const allSubagents = useStore((state) => state.subagents);
  const models = useStore((state) => state.modelConfigs);
  const maxConcurrent = useStore((state) => state.subagentConfig.runtime.maxConcurrent);
  const runId = messageId === "streaming" ? activeRunId : messageRunId;
  // 侧栏保留当前会话的历史；消息胶囊只反映当前这条主 Agent 消息启动的子代理。
  const subagents = useMemo(
    () => runId ? allSubagents.filter((item) => item.parentRunId === runId) : [],
    [allSubagents, runId],
  );
  const imageGenerations = useMemo(() => subagentImageGenerations(subagents, runId, models), [subagents, runId, models]);
  const running = subagents.filter((item) => active(item.status));
  const queued = subagents.filter((item) => item.status === "created");
  const executing = running.length - queued.length;
  const now = useClock(running.length > 0);
  if (subagents.length === 0) return null;
  const elapsed = running.length ? formatDuration((now - Math.min(...running.map((item) => item.startedAt))) / 1000, locale) : undefined;
  const label = locale === "zh-CN"
    ? running.length
      ? `共 ${subagents.length} 个 · ${executing} 运行中${queued.length ? ` · ${queued.length} 排队` : ""}`
      : `共 ${subagents.length} 个子代理`
    : running.length
      ? `${subagents.length} total · ${executing} running${queued.length ? ` · ${queued.length} queued` : ""}`
      : `${subagents.length} subagents`;
  const summary = locale === "zh-CN"
    ? `共 ${subagents.length} 个子代理，${executing} 个运行中${queued.length ? `，${queued.length} 个排队` : ""}，最大并发 ${maxConcurrent}`
    : `${subagents.length} subagents, ${executing} running${queued.length ? `, ${queued.length} queued` : ""}, concurrency limit ${maxConcurrent}`;
  return <div className="q-subagent-capsule-anchor w-full py-1">
    <button
      type="button"
      className="q-subagent-capsule"
      onClick={() => window.dispatchEvent(new Event("qone-open-subagents"))}
      aria-label={locale === "zh-CN" ? "打开子代理侧边栏" : "Open subagents"}
      title={summary}
    >
      <span className={`q-subagent-dot ${running.length ? "is-running" : "is-done"}`} aria-hidden="true" />
      <span>{label}</span>
      {elapsed && <span className="q-subagent-elapsed">· {elapsed}</span>}
      <ChevronRightIcon size={14} aria-hidden="true" />
    </button>
    {imageGenerations.map((generation) => <ImageGeneration
      key={generation.id}
      prompt={generation.prompt}
      generating={generation.generating}
      error={generation.missingImage ? t("subagent.noImageGenerated") : generation.error}
      onRegenerate={!generation.generating ? () => useStore.getState().send({ type: "subagent.control", requestId: crypto.randomUUID(), runId: generation.id, action: "retry" }) : undefined}
    />)}
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

const SubagentTranscript: FC<{ item: SubagentRunInfo }> = ({ item }) => {
  const messages = useMemo(() => subagentMessages(item), [item]);
  return <ReadonlyThreadProvider messages={messages}>
    <ThreadPrimitive.Messages>
      {({ message }) => message.role === "user"
        ? <MessagePrimitive.Root className="q-subagent-task rounded-lg border border-border/50 bg-foreground/[0.03] px-3 py-2 text-xs text-foreground/65">
            <MessagePrimitive.Parts />
          </MessagePrimitive.Root>
        : <MessagePrimitive.Root className="q-subagent-transcript space-y-3 text-sm">
            <AssistantParts />
          </MessagePrimitive.Root>}
    </ThreadPrimitive.Messages>
  </ReadonlyThreadProvider>;
};

export const SubagentPanel: FC<{ onClose: () => void }> = ({ onClose }) => {
  const { locale } = useLocale();
  const sessionId = useStore((state) => state.currentSessionId);
  const subagents = useStore((state) => state.subagents);
  const subagentConfig = useStore((state) => state.subagentConfig);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const [selectedId, setSelectedId] = useState<string>();
  const now = useClock(subagents.some((item) => active(item.status)));
  useEffect(() => setSelectedId(undefined), [sessionId]);
  const selected = subagents.find((item) => item.id === selectedId);
  const title = locale === "zh-CN" ? "子代理" : "Subagents";
  const duration = (item: SubagentRunInfo) => formatDuration(((item.completedAt ?? now) - item.startedAt) / 1000, locale);
  const model = (id?: string) => modelConfigs.find((config) => config.id === id)?.model ?? id ?? (locale === "zh-CN" ? "默认模型" : "Default model");

  return <div className="q-subagent-panel">
    <div className="q-subagent-panel-header">
      {selected && <button type="button" onClick={() => setSelectedId(undefined)} aria-label={locale === "zh-CN" ? "返回子代理列表" : "Back to subagent list"}><ArrowLeftIcon size={16} /></button>}
      <strong>{title}</strong>
      <button type="button" className="ms-auto" onClick={onClose} aria-label={locale === "zh-CN" ? "关闭子代理侧边栏" : "Close subagent panel"}><XIcon size={16} /></button>
    </div>
    {selected ? <div className="q-subagent-panel-scroll" key={selected.id}>
      <h2 className="q-subagent-detail-title">{selected.title}</h2>
      <div className="q-subagent-detail-meta"><span>{statusLabel(selected, locale)}</span><span>·</span><span>{model(selected.model)}</span><span>·</span><span>{duration(selected)}</span></div>
      <SubagentTranscript item={selected} />
      {selected.error && <p className="q-subagent-error">{selected.error}</p>}
    </div> : <div className="q-subagent-panel-scroll">
      {subagents.length === 0 ? <p className="q-subagent-empty">{locale === "zh-CN" ? "暂无子代理" : "No subagents yet"}</p> : subagents.map((item) => <button
        type="button" key={item.id} className="q-subagent-row" onClick={() => setSelectedId(item.id)}
      >
        <SubagentLogo logo={subagentConfig.profiles.find((profile) => profile.id === item.profileId)?.logo} name={item.title} size={24} />
        {item.status === "completed" ? <CheckIcon size={13} className="shrink-0 text-emerald-400" aria-hidden="true" />
          : <span className={`q-subagent-dot ${active(item.status) ? "is-running" : "is-failed"}`} aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate text-start">{item.title}</span>
        <span className="q-subagent-elapsed">{duration(item)}</span>
        <ChevronRightIcon size={14} aria-hidden="true" />
      </button>)}
    </div>}
  </div>;
};
