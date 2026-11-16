import { memo, useEffect, useMemo, useState } from "react";
import { useConversationStore, useConversationStoreApi } from "../../lib/conversation-context";
import { useServerStore } from "../../lib/server-state";
import { createServerCallIdsSelector, createServerCallSummarySelector, createServerIdsSelector, createServerSummarySelector, operationRootRun, operationRound, operationActive, UNRESOLVED_SERVER } from "../../lib/server-operations";
import { toolCallById, subagentsForTree } from "../../lib/store-indexes";
import { useLocale, type MessageKey } from "../../localization";
import type { ToolCall as Operation } from "../../store";
import { formatDuration } from "../../lib/utils";
import { CodexArrowLeftIcon, CodexCheckIcon, CodexChevronRightIcon, CodexClock3Icon, CodexLoader2Icon, CodexTerminalIcon, CodexXIcon } from "./execution-icons";
import { ToolCall } from "./elements/tool-call";
import { ToolResultView } from "./elements/tool-result";
import { FadeScroll } from "./elements/surfaces";
import { detectToolPresentation, toolArg } from "./tool-presentation";
import { formatToolPayload } from "./tool-call-display";
import "./subagent-view.css";
import "./server-operations-panel.css";

const EMPTY_IDS: readonly string[] = [];
const labels: Record<string, MessageKey> = {
  server_exec: "servers.view.exec", server_read_file: "servers.view.read_file", server_write_file: "servers.view.write_file", server_edit: "servers.view.edit",
  server_terminal: "servers.view.terminal", server_upload: "servers.view.upload", server_download: "servers.view.download", server_open_port: "servers.view.open_port",
};
const statusKeys: Record<Operation["status"], MessageKey> = { running: "servers.view.running", waiting: "servers.view.waiting", success: "servers.view.success", failed: "servers.view.failed", cancelled: "servers.view.cancelled" };

function StatusIcon({ status }: { status?: Operation["status"] }) {
  return status === "running" ? <CodexLoader2Icon className="size-3.5 animate-spin text-sky-600 motion-reduce:animate-none dark:text-sky-300" />
    : status === "waiting" ? <CodexClock3Icon className="size-3.5 text-amber-600 dark:text-amber-300" />
      : status === "success" ? <CodexCheckIcon className="size-3.5 text-emerald-600 dark:text-emerald-300" />
        : status === "failed" ? <CodexXIcon className="size-3.5 text-destructive" /> : <CodexTerminalIcon className="size-3.5 text-foreground/40" />;
}

export function ServerOperationsPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const selectIds = useMemo(createServerIdsSelector, []);
  const ids = useConversationStore(state => selectIds(state.toolCalls, (state.currentSessionId ? state.runOptionsBySession[state.currentSessionId] : state.draftRunOptions)?.serverIds ?? EMPTY_IDS));
  const sessionId = useConversationStore(state => state.currentSessionId);
  const canStop = useConversationStore(state => state.running || state.toolCalls.some(call => Boolean(call.sourceSubagentId) && operationActive(call)));
  const running = useConversationStore(state => state.running);
  const send = useConversationStore(state => state.send);
  const store = useConversationStoreApi();
  const stop = useConversationStore(state => state.stopAgent);
  const [selected, setSelected] = useState<string>();
  const stopping = useConversationStore(state => state.stoppingRunId !== undefined);
  const [stoppingChildren, setStoppingChildren] = useState(false);
  const stopTurn = () => {
    if (running) { stop(sessionId); return; }
    const state = store.getState();
    const active = state.toolCalls.slice().reverse().find(call => call.sourceSubagentId && operationActive(call));
    if (!active) return;
    const rootRunId = operationRootRun(active, state.subagents);
    const activeChildren = subagentsForTree(state.subagents, rootRunId).filter(child => ["created", "running", "waiting_approval", "paused"].includes(child.status));
    const activeIds = new Set(activeChildren.map(child => child.id));
    const children = activeChildren.filter(child => !activeIds.has(child.parentRunId)).map(child => child.id);
    if (!children.length && active.sourceSubagentId) children.push(active.sourceSubagentId);
    setStoppingChildren(true);
    void Promise.all(children.map(runId => send({ type: "subagent.control", requestId: crypto.randomUUID(), runId, action: "stop" })))
      .then(results => { if (results.some(sent => !sent)) setStoppingChildren(false); });
  };
  useEffect(() => { if (!canStop) setStoppingChildren(false); }, [canStop]);
  const selectedId = selected !== undefined && ids.includes(selected) ? selected : ids.length === 1 ? ids[0] : undefined;
  useEffect(() => { setSelected(undefined); }, [sessionId]);
  return <section className="q-subagent-panel q-server-panel" aria-label={t("servers.title")}>
    <header className="q-subagent-panel-header">
      {selectedId !== undefined && ids.length > 1 && <button type="button" onClick={() => setSelected(undefined)} aria-label={t("servers.view.back")}><CodexArrowLeftIcon size={16} /></button>}
      <CodexTerminalIcon className="size-4 text-sky-600 dark:text-sky-300" /><strong>{t("servers.title")}</strong>
      {canStop && <button type="button" className="q-server-stop ms-auto" title={t("servers.view.stopHint")} onClick={stopTurn}>
        {(stopping || stoppingChildren) && <CodexLoader2Icon className="size-3 animate-spin motion-reduce:animate-none" />}{t(stopping || stoppingChildren ? "servers.view.forceStop" : "servers.view.stop")}
      </button>}
      <button type="button" className={canStop ? undefined : "ms-auto"} onClick={onClose} aria-label={t("dock.closePanel")}><CodexXIcon size={16} /></button>
    </header>
    {selectedId !== undefined ? <ServerDetail key={selectedId} id={selectedId} /> : <FadeScroll className="q-subagent-panel-scroll">
      {ids.length ? ids.map(id => <ServerRow key={id} id={id} onSelect={setSelected} />) : <p className="q-subagent-empty">{t("servers.view.empty")}</p>}
    </FadeScroll>}
  </section>;
}

const ServerRow = memo(function ServerRow({ id, onSelect }: { id: string; onSelect: (id: string) => void }) {
  const { t } = useLocale();
  const servers = useServerStore(state => state.servers);
  const selector = useMemo(createServerSummarySelector, []);
  const summary = useConversationStore(state => selector(state.toolCalls, servers, id));
  return <button type="button" className="q-subagent-row q-server-row" onClick={() => onSelect(id)}>
    <span className="q-server-avatar"><CodexTerminalIcon className="size-4" /></span>
    <span className="min-w-0 flex-1 text-start"><span className="block truncate">{summary.name ?? (id === UNRESOLVED_SERVER ? t("servers.view.unknown") : id)}</span>
      <span className="mt-1 flex items-center gap-1.5 text-[11px] text-foreground/45"><StatusIcon status={summary.status} />{summary.status ? t(statusKeys[summary.status]) : t("servers.view.selected")}<span>·</span>{t("servers.view.count", { count: summary.count })}</span>
    </span><CodexChevronRightIcon size={14} />
  </button>;
});

function ServerDetail({ id }: { id: string }) {
  const { t } = useLocale();
  const servers = useServerStore(state => state.servers);
  const selectSummary = useMemo(createServerSummarySelector, []);
  const selectCalls = useMemo(createServerCallIdsSelector, []);
  const summary = useConversationStore(state => selectSummary(state.toolCalls, servers, id));
  const callIds = useConversationStore(state => selectCalls(state.toolCalls, id));
  const [limit, setLimit] = useState(40);
  return <FadeScroll className="q-subagent-panel-scroll" autoScrollToBottom={summary.status === "running"}>
    <h2 className="q-subagent-detail-title">{summary.name ?? (id === UNRESOLVED_SERVER ? t("servers.view.unknown") : id)}</h2>
    <p className="q-subagent-detail-meta">{t("servers.view.count", { count: summary.count })}</p>
    {callIds.length > limit && <button type="button" className="q-server-more" onClick={() => setLimit(value => value + 40)}>{t("servers.view.more")}</button>}
    {callIds.slice(-limit).map(callId => <ServerOperationRow key={callId} id={callId} />)}
    {!callIds.length && <p className="q-subagent-empty">{t("servers.view.empty")}</p>}
  </FadeScroll>;
}

const ServerOperationRow = memo(function ServerOperationRow({ id }: { id: string }) {
  const { t, locale } = useLocale();
  const selectSummary = useMemo(createServerCallSummarySelector, []);
  const call = useConversationStore(state => selectSummary(state.toolCalls, id));
  const round = useConversationStore(state => { const item = toolCallById(state.toolCalls, id); return item ? operationRound(state.toolCalls, state.subagents, item) : 1; });
  const [open, setOpen] = useState<boolean>();
  const expanded = open ?? Boolean(call && operationActive(call));
  const running = call?.status === "running";
  const label = t(call ? labels[call.toolName] ?? "servers.view.operations" : "servers.view.operations");
  if (!call) return null;
  const target = toolArg(call.args, "command") ?? toolArg(call.args, "path") ?? toolArg(call.args, "remote_path") ?? toolArg(call.args, "action") ?? "";
  return <article className="q-server-operation" data-status={call.status}>
    <div className="q-server-operation-meta"><span>{t("servers.view.round", { index: round })}</span><span>·</span><StatusIcon status={call.status} /><span>{t(statusKeys[call.status])}</span><span>·</span>
      <span>{t(call.sourceSubagentId ? "servers.view.child" : "servers.view.main")}</span>
      {call.parentToolCallId && <span>· {t("servers.view.script")}</span>}
      <OperationDuration call={call} locale={locale} />
    </div>
    <ToolCall icon={CodexTerminalIcon} label={label} activeLabel={label} query={target} fullTarget={target}
      running={running} waiting={call.status === "waiting"} failed={call.status === "failed"} cancelled={call.status === "cancelled"}
      open={expanded} onOpenChange={setOpen} resultHasOwnFrame
      result={expanded ? <OperationResult id={id} /> : null} />
  </article>;
});

function OperationDuration({ call, locale }: { call: Operation; locale: Parameters<typeof formatDuration>[1] }) {
  const [now, setNow] = useState(Date.now);
  const running = operationActive(call);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const duration = call.durationMs ?? (call.startedAt ? (call.completedAt ?? now) - call.startedAt : 0);
  return <span className="ms-auto tabular-nums">{formatDuration(Math.max(0, duration) / 1000, locale)}</span>;
}

function OperationResult({ id }: { id: string }) {
  const { t } = useLocale();
  const call = useConversationStore(state => toolCallById(state.toolCalls, id));
  const [copied, setCopied] = useState(false);
  const presentation = useMemo(() => detectToolPresentation(call?.toolName ?? "", call?.result, call?.args), [call?.toolName, call?.result, call?.args]);
  if (!call) return null;
  const text = presentation.kind === "terminal" ? [presentation.output, presentation.stderr].filter(Boolean).join("\n") : formatToolPayload(call.result);
  const progress = call.result as { content?: { type: string; text?: string }[] } | undefined;
  let phase: { phase?: string; bytes?: number; total?: number } | undefined;
  try { phase = JSON.parse(progress?.content?.find(block => block.type === "text")?.text ?? "null"); } catch { /* Non-JSON results use the normal tool presentation. */ }
  const stage = phase?.phase === "connecting" ? t("chat.connecting") : typeof phase?.bytes === "number" && typeof phase.total === "number" ? t("servers.view.progress", { bytes: phase.bytes, total: phase.total }) : undefined;
  return <div className="space-y-2">
    <details className="q-server-parameters"><summary>{t("servers.view.parameters")}</summary><pre>{formatToolPayload(call.args)}</pre></details>
    {stage ? <p role="status" className="px-2 py-1 text-xs text-foreground/55">{stage}</p> : call.result !== undefined && <ToolResultView presentation={presentation} running={operationActive(call)} emptyText={t("chat.toolResultPending")} />}
    {text && <button type="button" className="q-server-more" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false)); }}>{t(copied ? "servers.view.copied" : "servers.view.copy")}</button>}
  </div>;
}
