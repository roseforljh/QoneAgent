import { useEffect, useMemo, useRef, type FC } from "react";
import { useShallow } from "zustand/shallow";
import type { BackgroundShellJobInfo } from "@qone/protocol";
import { useStore } from "../../store";
import { useConversationStore } from "../../lib/conversation-context";
import { backgroundJobLinks, openBackgroundJob } from "../../lib/background-job-links";
import { useLocale, type MessageKey } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { Button } from "../ui/Button";
import { ToolCall } from "./elements/tool-call";
import { useClock } from "../../lib/use-clock";
import { CodexArrowLeftIcon as ArrowLeftIcon, CodexCheckIcon as CheckIcon, CodexChevronRightIcon as ChevronRightIcon, CodexLoader2Icon as LoaderIcon, CodexTerminalIcon as TerminalIcon, CodexXIcon as XIcon } from "./execution-icons";
import "./subagent-view.css";
import "./background-job-view.css";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

function statusText(job: Omit<BackgroundShellJobInfo, "output">, now: number, t: Translate, locale: Parameters<typeof formatDuration>[1]): string {
  const elapsed = formatDuration(((job.endedAt ?? now) - job.startedAt) / 1000, locale);
  if (job.status === "running") return t("backgroundJob.running", { elapsed });
  if (job.status === "exited") return t("backgroundJob.exited", { code: job.exitCode ?? "", elapsed });
  return t(job.status === "stopped" ? "backgroundJob.stopped" : "backgroundJob.ended", { elapsed });
}

const StatusIcon: FC<{ job?: BackgroundShellJobInfo }> = ({ job }) =>
  job?.status === "running" ? <LoaderIcon className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
    : job?.status === "exited" && job.exitCode === 0 ? <CheckIcon size={13} className="shrink-0 text-foreground/60" aria-hidden="true" />
      : job ? <XIcon size={14} className="shrink-0 text-foreground/60" aria-hidden="true" />
        : <TerminalIcon className="size-3.5 shrink-0 text-foreground/60" />;

/** Use the same single-line dock link as a subagent invocation. */
export function BackgroundJobRow({ jobId, command, showIcon = false }: { jobId: string; command?: string; showIcon?: boolean }) {
  const { t, locale } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const job = useStore(useShallow((state) => {
    const item = state.backgroundJobs.find((candidate) => candidate.id === jobId && candidate.sessionId === sessionId);
    if (!item) return undefined;
    const { output: _output, ...summary } = item;
    return summary;
  }));
  const running = job?.status === "running";
  const now = useClock(running);
  const label = job ? statusText(job, now, t, locale) : t("backgroundJob.title");
  const target = command ?? job?.command;
  const openLabel = t("backgroundJob.open");
  return <ToolCall icon={showIcon ? TerminalIcon : undefined} label={label} activeLabel={label} query="" fullTarget={target}
    targetAction={sessionId ? { label: target || openLabel, ariaLabel: target ? `${openLabel}: ${target}` : openLabel,
      onClick: () => openBackgroundJob(jobId, sessionId) } : undefined}
    result={null} canExpand={false} open={false} onOpenChange={() => {}}
    running={running} failed={job?.status === "ended" || (job?.status === "exited" && job.exitCode !== 0)} cancelled={job?.status === "stopped"}
    className="min-w-0 max-w-none flex-1" />;
}

export const BackgroundJobPanel: FC<{ selectedId?: string; onSelect: (id?: string) => void; onClose: () => void }> = ({ selectedId, onSelect, onClose }) => {
  const { t, locale } = useLocale();
  const sessionId = useStore((state) => state.currentSessionId);
  const allJobs = useStore((state) => state.backgroundJobs);
  const jobs = useMemo(() => allJobs.filter((job) => job.sessionId === sessionId).sort((a, b) => b.startedAt - a.startedAt), [allJobs, sessionId]);
  const selected = selectedId ? jobs.find((job) => job.id === selectedId) : undefined;
  const savedCommand = useStore((state) => selectedId && !selected ? backgroundJobLinks(state.toolCalls).byJobId.get(selectedId)?.command : undefined);
  const command = selected?.command ?? savedCommand;
  const now = useClock(selectedId ? selected?.status === "running" : jobs.some((job) => job.status === "running"));
  const output = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);
  useEffect(() => { stickToBottom.current = true; }, [selectedId]);
  useEffect(() => {
    const element = output.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [selectedId, selected?.output]);
  const stop = (jobId: string) => useStore.getState().send({ type: "background-shell.stop", requestId: crypto.randomUUID(), jobId });

  return <div className="q-subagent-panel">
    <div className="q-subagent-panel-header">
      {selectedId && <button type="button" onClick={() => onSelect(undefined)} aria-label={t("backgroundJob.back")}><ArrowLeftIcon size={16} /></button>}
      <strong>{t("backgroundJob.title")}</strong>
      <button type="button" className="ms-auto" onClick={onClose} aria-label={t("backgroundJob.close")}><XIcon size={16} /></button>
    </div>
    {selectedId ? <div className="q-background-job-detail">
      {command && <pre className="q-background-job-command">{command}</pre>}
      {selected ? <>
        <div className="q-background-job-meta">
          <StatusIcon job={selected} />
          <span>{statusText(selected, now, t, locale)}</span>
          {selected.status === "running" && <Button size="sm" variant="outline" className="ms-auto" onClick={() => stop(selected.id)}>{t("backgroundJob.stop")}</Button>}
        </div>
        <div className="q-background-job-output">
          <pre ref={output} className="q-background-job-output-scroll" onScroll={(event) => {
            const element = event.currentTarget;
            stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          }}>{selected.output || t("backgroundJob.noOutput")}</pre>
        </div>
      </> : <p className="q-subagent-empty">{t("backgroundJob.lost")}</p>}
    </div> : <div className="q-subagent-panel-scroll">
      {jobs.length === 0 ? <p className="q-subagent-empty">{t("backgroundJob.empty")}</p> : jobs.map((job) => <button key={job.id} type="button" className="q-subagent-row" onClick={() => onSelect(job.id)}>
        <StatusIcon job={job} />
        <span className="min-w-0 flex-1 truncate text-start font-mono">{job.command}</span>
        <span className="q-subagent-elapsed">{formatDuration(((job.endedAt ?? now) - job.startedAt) / 1000, locale)}</span>
        <ChevronRightIcon size={14} aria-hidden="true" />
      </button>)}
    </div>}
  </div>;
};
