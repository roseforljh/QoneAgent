import { useEffect, useState } from "react";
import { Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { NestedDialog } from "../nested-dialog";
import type { ServerCandidate, ServerGroupInfo, ServerInfo, ServerSetupStage, ServerTunnelInfo } from "@qone/protocol";
import { useStore } from "../../../store";
import { cn } from "../../../lib/utils";
import { invoke } from "../../../lib/desktop-bridge";
import { openBrowserInDock } from "../../../lib/browser-dock";
import { confirmDestructiveAction } from "../../../lib/confirm-action";
import { sendServerCommand, useServerStore } from "../../../lib/server-state";
import { useLocale } from "../../../localization";
import { QoneSelect } from "../../ui/Select";
import { serverAddress } from "./server-card";

type Run = (command: Parameters<typeof sendServerCommand>[0]) => Promise<boolean>;
type AuthMode = "password" | "key" | "agent";
const STAGES: ServerSetupStage[] = ["host-key", "authenticating", "inspecting", "securing"];

export function AddServerDialog({ open, onOpenChange, prefill, groupId, groups, run }: {
  open: boolean; onOpenChange: (open: boolean) => void; prefill?: ServerCandidate; groupId?: string; groups: ServerGroupInfo[]; run: Run;
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
  useEffect(() => {
    if (!open) return;
    setHost(prefill?.host ?? ""); setPort(String(prefill?.port ?? 22)); setUsername(prefill?.username ?? "root"); setName(prefill?.alias ?? "");
    setGroup(groupId ?? ""); setPassword(""); setKeyPath(prefill?.identityFile && prefill.identityFile !== "agent" ? prefill.identityFile : "");
    setMode(prefill?.identityFile && prefill.identityFile !== "agent" ? "key" : "password");
    useServerStore.setState({ error: undefined });
  }, [open, prefill, groupId]);

  const valid = Boolean(host.trim() && username.trim() && Number(port) > 0 && Number(port) < 65_536 && (mode === "agent" || (mode === "password" ? password : keyPath)));
  const pickKey = async () => {
    const files = await invoke<{ path: string }[]>("pick_attachment_files", { title: t("servers.pickKey") }).catch(() => []);
    if (files[0]) setKeyPath(files[0].path);
  };
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = await run({ type: "servers.add", host: host.trim(), port: Number(port), username: username.trim(), name: name.trim() || undefined, groupId: group || undefined,
      ...(mode === "password" ? { password } : mode === "key" ? { keyPath } : { useAgent: true }) });
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  const stageIndex = setup ? STAGES.indexOf(setup.stage) : -1;
  const stages = STAGES.filter((stage) => stage !== "securing" || mode === "password");

  return (
    <NestedDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} title={t("servers.add")} description={t("servers.addDescription")}
      footer={<button type="button" className="servers-button is-primary" disabled={!valid || busy} onClick={() => void submit()}>{busy && <LoaderCircle className="animate-spin" size={14} />}{t("servers.connect")}</button>}>
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
        {mode === "password" && <label className="servers-field"><span>{t("servers.password")}</span><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" disabled={busy} /><small>{t("servers.passwordHint")}</small></label>}
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
        {error && !busy && <p className="servers-error">{error}</p>}
        <button type="submit" hidden />
      </form>
    </NestedDialog>
  );
}

export function ServerDetailDialog({ server, tunnels, onOpenChange, run, onTerminal, onRemove }: {
  server?: ServerInfo; tunnels: ServerTunnelInfo[]; onOpenChange: (open: boolean) => void; run: Run;
  onTerminal: (server: ServerInfo) => void; onRemove: (server: ServerInfo) => void;
}) {
  const { t, locale } = useLocale();
  const busy = useServerStore((state) => state.pending > 0);
  const [name, setName] = useState("");
  useEffect(() => setName(server?.name ?? ""), [server?.id, server?.name]);
  if (!server) return null;
  const time = (at?: number) => at ? new Date(at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : t("servers.never");
  const auth = server.auth.kind === "agent" ? "SSH Agent" : server.auth.dedicated ? t("servers.authDedicated") : server.auth.keyPath;
  const rename = () => { if (name.trim() && name.trim() !== server.name) void run({ type: "servers.rename", id: server.id, name }); };

  return (
    <NestedDialog open onOpenChange={onOpenChange} wide
      title={<span className="server-dialog-title"><span className={cn("servers-dot", `is-${server.status}`)} />
        <input value={name} onChange={(event) => setName(event.target.value)} onBlur={rename} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} aria-label={t("servers.name")} /></span>}
      description={serverAddress(server)}
      footer={<>
        <button type="button" className="servers-button is-danger" onClick={() => onRemove(server)}>{t("servers.delete")}</button>
        <span className="server-dialog-spacer" />
        <button type="button" className="servers-button" disabled={busy} onClick={() => void run({ type: "servers.test", id: server.id })}>{busy && <LoaderCircle className="animate-spin" size={14} />}{t("servers.test")}</button>
        <button type="button" className="servers-button is-primary" disabled={server.status === "host-key-changed"} onClick={() => onTerminal(server)}>{t("servers.openTerminal")}</button>
      </>}>
      {server.status === "host-key-changed" && (
        <div className="servers-banner is-danger">
          <p>{t("servers.hostKeyChanged", { fingerprint: server.statusDetail ?? "" })}</p>
          <button type="button" className="servers-button" disabled={busy} onClick={async () => {
            if (await confirmDestructiveAction(t("servers.trustConfirm"))) await run({ type: "servers.trust-host-key", id: server.id });
          }}>{t("servers.trust")}</button>
        </div>
      )}
      {(server.status === "offline" || server.status === "auth-failed" || server.status === "error") && <div className="servers-banner"><p>{t(`servers.status.${server.status}`)}{server.statusDetail ? `：${server.statusDetail}` : ""}</p></div>}
      <dl className="servers-info">
        <div><dt>{t("servers.system")}</dt><dd>{server.system ?? "—"}</dd></div>
        <div><dt>{t("servers.auth")}</dt><dd>{auth}</dd></div>
        <div><dt>{t("servers.fingerprint")}</dt><dd className="is-mono" title={server.hostKey}>{server.hostKey ?? "—"}</dd></div>
        <div><dt>{t("servers.lastConnected")}</dt><dd><span className={cn("servers-dot", `is-${server.status}`)} />{t(`servers.status.${server.status}`)} · {time(server.lastConnectedAt)}</dd></div>
      </dl>
      {tunnels.length > 0 && <section className="server-tunnels">
        <h3>{t("servers.tunnels")}</h3>
        {tunnels.map((tunnel) => (
          <div key={tunnel.localPort} className="server-tunnel">
            <span><strong>{t("servers.tunnel", { remote: tunnel.remotePort })}</strong><small>{tunnel.url}</small></span>
            <button type="button" className="servers-icon-button" onClick={() => openBrowserInDock(tunnel.url, useStore.getState().currentSessionId)} aria-label={t("servers.openBrowser")} title={t("servers.openBrowser")}><ExternalLink size={14} /></button>
            <button type="button" className="servers-icon-button" onClick={() => void run({ type: "servers.tunnel.close", serverId: server.id, localPort: tunnel.localPort })} aria-label={t("common.close")}><X size={14} /></button>
          </div>
        ))}
      </section>}
      <p className="servers-hint">{t("servers.aiHint", { name: server.name })}</p>
    </NestedDialog>
  );
}
