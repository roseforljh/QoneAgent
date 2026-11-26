import { useEffect, useState } from "react";
import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { NestedDialog } from "../nested-dialog";
import type { ServerCandidate, ServerGroupInfo, ServerInfo, ServerSetupStage, ServerTunnelInfo } from "@qone/protocol";
import { useStore } from "../../../store";
import { cn } from "../../../lib/utils";
import { invoke } from "../../../lib/desktop-bridge";
import { openBrowserInDock } from "../../../lib/browser-dock";
import { confirmAction, confirmDestructiveAction } from "../../../lib/confirm-action";
import { sendServerCommand, useServerStore } from "../../../lib/server-state";
import { useLocale } from "../../../localization";
import { QoneSelect } from "../../ui/Select";

type Run = (command: Parameters<typeof sendServerCommand>[0]) => Promise<boolean>;
type AuthMode = "password" | "key" | "agent";
const STAGES: ServerSetupStage[] = ["host-key", "authenticating", "inspecting", "securing"];
const confirmTrust = (t: ReturnType<typeof useLocale>["t"]) => confirmAction({ message: t("servers.trustConfirm"), confirmLabel: t("servers.trust"), destructive: true });

/** The one server page: adds a server, or shows and edits `server` when given. */
export function ServerFormDialog({ open, onOpenChange, prefill, groupId, server, groups, tunnels, run, onTerminal, onRemove }: {
  open: boolean; onOpenChange: (open: boolean) => void; prefill?: ServerCandidate; groupId?: string; server?: ServerInfo; groups: ServerGroupInfo[];
  tunnels: ServerTunnelInfo[]; run: Run; onTerminal: (server: ServerInfo) => void; onRemove: (server: ServerInfo) => void;
}) {
  const { t } = useLocale();
  const setup = useServerStore((state) => state.setup);
  const error = useServerStore((state) => state.error);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [mode, setMode] = useState<AuthMode>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [busy, setBusy] = useState(false);
  // Live status: an edit that hits a changed host key marks the saved server.
  const live = useServerStore((state) => server && state.servers.find((item) => item.id === server.id));
  const trustNeeded = Boolean(server && live?.status === "host-key-changed" && host.trim() === server.host && Number(port) === server.port);
  // A dedicated key keeps working when the password is left blank.
  const keepsDedicatedKey = server?.auth.kind === "key" && server.auth.dedicated;
  useEffect(() => {
    if (!open) return;
    if (server) {
      setHost(server.host); setPort(String(server.port)); setUsername(server.username); setName(server.name);
      setGroup(server.groupId ?? ""); setPassword("");
      setKeyPath(server.auth.kind === "key" && !server.auth.dedicated ? server.auth.keyPath : "");
      setMode(server.auth.kind === "agent" ? "agent" : server.auth.dedicated ? "password" : "key");
    } else {
      setHost(prefill?.host ?? ""); setPort(String(prefill?.port ?? 22)); setUsername(prefill?.username ?? "root"); setName(prefill?.alias ?? "");
      setGroup(groupId ?? ""); setPassword(""); setKeyPath(prefill?.identityFile && prefill.identityFile !== "agent" ? prefill.identityFile : "");
      setMode(prefill?.identityFile && prefill.identityFile !== "agent" ? "key" : "password");
    }
    useServerStore.setState({ error: undefined });
  }, [open, prefill, groupId, server]);

  const valid = Boolean(host.trim() && username.trim() && Number(port) > 0 && Number(port) < 65_536 && (mode === "agent" || (mode === "password" ? password || keepsDedicatedKey : keyPath)));
  const pickKey = async () => {
    const files = await invoke<{ path: string }[]>("pick_attachment_files", { title: t("servers.pickKey") }).catch(() => []);
    if (files[0]) setKeyPath(files[0].path);
  };
  const submit = async () => {
    if (!valid || busy) return;
    if (trustNeeded && !await confirmTrust(t)) return;
    setBusy(true);
    const fields = { host: host.trim(), port: Number(port), username: username.trim(), name: name.trim() || undefined, groupId: group || undefined,
      ...(mode === "password" ? password ? { password } : {} : mode === "key" ? { keyPath } : { useAgent: true }) };
    const ok = await run(server ? { type: "servers.update", id: server.id, ...fields, ...(trustNeeded ? { trustHostKey: true } : {}) } : { type: "servers.add", ...fields });
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  const stageIndex = setup ? STAGES.indexOf(setup.stage) : -1;
  const stages = STAGES.filter((stage) => stage !== "securing" || (mode === "password" && password));
  const statusNote = live && (live.status === "offline" || live.status === "auth-failed" || live.status === "error")
    ? `${t(`servers.status.${live.status}`)}${live.statusDetail ? `：${live.statusDetail}` : ""}` : undefined;

  return (
    <NestedDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}
      title={server ? <span className="server-dialog-title"><span className={cn("servers-dot", `is-${live?.status ?? server.status}`)} />{server.name}</span> : t("servers.add")}
      description={t(server ? "servers.editDescription" : "servers.addDescription")}
      footer={<>
        {server && <>
          <button type="button" className="servers-button is-danger" disabled={busy} onClick={() => onRemove(server)}>{t("servers.delete")}</button>
          <span className="server-dialog-spacer" />
          <button type="button" className="servers-button" disabled={busy || live?.status === "host-key-changed"} onClick={() => onTerminal(server)}>{t("servers.openTerminal")}</button>
        </>}
        <button type="button" className="servers-button is-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy && <LoaderCircle className="animate-spin" size={14} />}{t(server ? trustNeeded ? "servers.trustAndSave" : "servers.save" : "servers.connect")}</button>
      </>}>
      <form className="servers-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="servers-field-row">
          <label className="servers-field is-grow"><span>{t("servers.host")}</span><input value={host} onChange={(event) => setHost(event.target.value)} placeholder="203.0.113.10" autoFocus spellCheck={false} disabled={busy} /></label>
          <label className="servers-field is-port"><span>{t("servers.port")}</span><input value={port} onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))} inputMode="numeric" disabled={busy} /></label>
          <label className="servers-field is-user"><span>{t("servers.username")}</span><input value={username} onChange={(event) => setUsername(event.target.value)} spellCheck={false} disabled={busy} /></label>
        </div>
        <div className="servers-field">
          <span>{t("servers.auth")}</span>
          <div className="servers-segment" role="radiogroup" aria-label={t("servers.auth")}>
            {(["password", "key", "agent"] as const).map((value) => (
              <button key={value} type="button" role="radio" aria-checked={mode === value} disabled={busy} className={cn(mode === value && "is-active")} onClick={() => setMode(value)}>{t(`servers.auth.${value}`)}</button>
            ))}
          </div>
        </div>
        {mode === "password" && <label className="servers-field"><span>{t("servers.password")}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={keepsDedicatedKey ? t("servers.passwordKeep") : undefined} autoComplete="off" disabled={busy} /><small>{t("servers.passwordHint")}</small></label>}
        {mode === "key" && <div className="servers-field"><span>{t("servers.keyFile")}</span><div className="servers-key"><input value={keyPath} onChange={(event) => setKeyPath(event.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" spellCheck={false} disabled={busy} /><button type="button" className="servers-button" disabled={busy} onClick={() => void pickKey()}>{t("servers.browse")}</button></div></div>}
        {mode === "agent" && <p className="servers-hint">{t("servers.agentHint")}</p>}
        <div className="servers-field-row">
          <label className="servers-field is-grow"><span>{t("servers.name")}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={host || t("servers.namePlaceholder")} disabled={busy} /></label>
          {groups.length > 0 && <div className="servers-field is-grow"><span>{t("servers.group")}</span>
            <QoneSelect value={group} onChange={setGroup} options={[{ value: "", label: t("servers.ungrouped") }, ...groups.map((item) => ({ value: item.id, label: item.name }))]} ariaLabel={t("servers.group")} className="servers-select" triggerClassName="servers-select-trigger" />
          </div>}
        </div>
        {busy && (
          <ol className="servers-steps">
            {stages.map((stage, index) => (
              <li key={stage} className={cn(index < stageIndex && "is-done", index === stageIndex && "is-active")}>
                {index < stageIndex ? <Check size={13} /> : index === stageIndex ? <LoaderCircle className="animate-spin" size={13} /> : <span className="servers-step-dot" />}
                {t(`servers.stage.${stage}`)}
              </li>
            ))}
          </ol>
        )}
        {trustNeeded && !busy ? <div className="servers-banner is-danger"><p>{t("servers.hostKeyChanged", { fingerprint: live?.statusDetail ?? "" })}</p></div>
          : error && !busy ? <p className="servers-error">{error}</p>
          : statusNote && !busy && <div className="servers-banner"><p>{statusNote}</p></div>}
        {server && tunnels.length > 0 && <section className="server-tunnels">
          <h3>{t("servers.tunnels")}</h3>
          {tunnels.map((tunnel) => (
            <div key={tunnel.localPort} className="server-tunnel">
              <span><strong>{t("servers.tunnel", { remote: tunnel.remotePort })}</strong><small>{tunnel.url}</small></span>
              <button type="button" className="servers-icon-button" onClick={() => openBrowserInDock(tunnel.url, useStore.getState().currentSessionId)} aria-label={t("servers.openBrowser")} title={t("servers.openBrowser")}><ExternalLink size={14} /></button>
              <button
                type="button"
                className="servers-icon-button"
                onClick={async () => {
                  if (!await confirmDestructiveAction(t("servers.tunnelCloseConfirm", { port: String(tunnel.localPort) }))) return;
                  await run({ type: "servers.tunnel.close", serverId: server.id, localPort: tunnel.localPort });
                }}
                aria-label={t("common.close")}
              ><X size={14} /></button>
            </div>
          ))}
        </section>}
        <button type="submit" hidden />
      </form>
    </NestedDialog>
  );
}
