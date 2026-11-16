import { useRef, useState } from "react";
import type { ClaudeCodeSyncResult, ClaudeCodeSyncTarget } from "@qone/protocol";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { requestClaudeSync } from "../../lib/claude-code-sync";
import { localizeError } from "../../lib/error-localization";
import { CodexIcon } from "../ui/CodexIcon";
import syncIcon from "../../assets/codex-icons/arrows-clockwise-rotate-lg-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { NestedDialog } from "./nested-dialog";

export function ClaudeCodeSyncButton({ target, disabled, onBusyChange, onSynced }: { target: ClaudeCodeSyncTarget; disabled?: boolean; onBusyChange?: (busy: boolean) => void; onSynced?: () => void }) {
  const { t } = useLocale();
  const send = useStore(state => state.send);
  const [busy, setBusy] = useState<"sync" | "remove">();
  const lock = useRef(false);
  const [result, setResult] = useState<ClaudeCodeSyncResult>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const run = async (kind: "sync" | "remove", work: () => Promise<ClaudeCodeSyncResult>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(kind); onBusyChange?.(true); setError("");
    let awaitingConfirmation = false;
    try {
      const response = await work();
      awaitingConfirmation = response.status === "confirm";
      if (kind === "sync" && response.status === "complete") onSynced?.();
      setResult(response); setOpen(true);
    } catch (cause) { setError(localizeError(cause)); setOpen(true); }
    finally { lock.current = false; setBusy(undefined); if (!awaitingConfirmation) onBusyChange?.(false); }
  };
  const synchronize = (revision?: string) => run("sync", async () => {
    const response = await requestClaudeSync(target, send, revision);
    return response.status === "ready" && revision === undefined ? requestClaudeSync(target, send, response.revision) : response;
  });
  const remove = async () => {
    if (lock.current || !await confirmDestructiveAction(t("claudeSync.removeConfirm", { target: t(target === "mcp" ? "claudeSync.target.mcp" : "claudeSync.target.skills") }))) return;
    await run("remove", () => requestClaudeSync(target, send, undefined, true));
  };
  const close = () => { setOpen(false); onBusyChange?.(false); };
  const confirming = !error && result?.status === "confirm";
  return <>
    <div className="settings-sync-group" role="group">
      <button type="button" disabled={disabled || Boolean(busy)} aria-busy={busy === "sync"} onClick={() => void synchronize()}>
        <CodexIcon src={syncIcon} className={`size-3.5${busy === "sync" ? " animate-spin motion-reduce:animate-none" : ""}`} />{t(busy === "sync" ? "claudeSync.syncing" : "claudeSync.button")}
      </button>
      {target !== "prompt" && <button type="button" className="settings-sync-remove" disabled={disabled || Boolean(busy)} aria-busy={busy === "remove"} aria-label={t("claudeSync.remove")} title={t("claudeSync.remove")} onClick={() => void remove()}>
        <CodexIcon src={trashIcon} className={`size-3.5${busy === "remove" ? " animate-pulse motion-reduce:animate-none" : ""}`} />
      </button>}
    </div>
    <NestedDialog open={open} onOpenChange={value => { if (!busy && !value) close(); }} title={t("claudeSync.title")} footer={<>
      {confirming && <button type="button" className="settings-secondary-action" disabled={Boolean(busy)} onClick={close}>{t("common.cancel")}</button>}
      <button type="button" className="settings-primary-action" disabled={Boolean(busy)} onClick={() => confirming ? void synchronize(result!.revision) : close()}>{t(confirming ? "claudeSync.replace" : "claudeSync.done")}</button>
    </>}>
      {error ? <p role="alert">{error}</p> : result && <>
        <p role="status">{result.removed !== undefined && !result.failed ? t("claudeSync.removed", { count: result.removed }) : t(result.status === "complete" && result.failed ? "claudeSync.partial" : `claudeSync.status.${result.status}`)}</p>
        {confirming && <p>{result.conflicts.join("、") || t("claudeSync.changed")}</p>}
        {result.removed === undefined && (result.status === "complete" || result.status === "empty") && <p>{t("claudeSync.counts", { found: result.found, added: result.added, updated: result.updated, skipped: result.skipped, failed: result.failed })}</p>}
        {result.removed === undefined && result.status === "complete" && target === "mcp" && <p>{t("claudeSync.mcpHint")}</p>}
        {result.removed === undefined && result.status === "complete" && target === "skills" && <p>{t("claudeSync.skillsHint")}</p>}
        {result.issues.length > 0 && <ul className="space-y-2 text-xs text-muted-foreground">{result.issues.map((issue, index) => <li key={index}>{issue.name}：{t(`claudeSync.issue.${issue.code}`)}{issue.detail ? ` (${issue.detail})` : ""}</li>)}</ul>}
      </>}
    </NestedDialog>
  </>;
}
