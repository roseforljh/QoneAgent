import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronRight, FolderPlus, LoaderCircle, Plus, ScanSearch, X } from "lucide-react";
import type { ServerCandidate, ServerGroupInfo, ServerInfo } from "@qone/protocol";
import { useStore } from "../../../store";
import { cn } from "../../../lib/utils";
import { confirmDestructiveAction } from "../../../lib/confirm-action";
import { openServerTerminal, sendServerCommand, useServerStore } from "../../../lib/server-state";
import { useLocale } from "../../../localization";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui/collapsible";
import { CodexIcon } from "../../ui/CodexIcon";
import folderIcon from "../../../assets/codex-icons/folder-light-16.svg";
import folderOpenIcon from "../../../assets/codex-icons/folder-open-light-16.svg";
import moreIcon from "../../../assets/codex-icons/ellipsis-horizontal-light-16.svg";
import { SectionHeader, SettingsPageHeader } from "../settings-chrome";
import { GroupMenu, SERVER_DRAG_TYPE, ServerCard, serverAddress, type ServerActions } from "./server-card";
import { ServerFormDialog } from "./server-dialogs";
import "./servers.css";

const COLLAPSED_KEY = "qone-server-groups-collapsed";
const loadCollapsed = (): string[] => { try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]; } catch { return []; } };

export function ServersSection({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const { servers, groups, tunnels, candidates, loaded, error, editingGroupId } = useServerStore();
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState<{ prefill?: ServerCandidate; groupId?: string; server?: ServerInfo }>();
  const [dragId, setDragId] = useState<string>();
  const [dropTarget, setDropTarget] = useState<string>();
  const [collapsed, setCollapsed] = useState<string[]>(loadCollapsed);
  const run = (command: Parameters<typeof sendServerCommand>[0]) => sendServerCommand(command, send);
  useEffect(() => { if (connected) void run({ type: "servers.list" }); }, [connected]);
  useEffect(() => { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed)); }, [collapsed]);

  const discover = async () => { setScanning(true); await run({ type: "servers.discover" }); setScanning(false); };
  const createGroup = async () => {
    if (!await run({ type: "servers.group.create", name: t("servers.newGroupName") })) return undefined;
    return useServerStore.getState().editingGroupId;
  };
  const actions: ServerActions = {
    open: (server) => setAdding({ server }),
    terminal: (server) => { openServerTerminal(server.id); onClose(); },
    test: (server) => void run({ type: "servers.test", id: server.id }),
    move: (server, groupId) => { if (server.groupId !== groupId) void run({ type: "servers.move", id: server.id, groupId }); },
    moveToNewGroup: async (server) => { const groupId = await createGroup(); if (groupId) void run({ type: "servers.move", id: server.id, groupId }); },
    remove: async (server) => {
      // A changed host key can't be trusted for the revocation, so only local cleanup is possible.
      const unreachable = server.status === "host-key-changed" && server.auth.kind === "key" && server.auth.dedicated;
      if (!await confirmDestructiveAction(t(unreachable ? "servers.forceDeleteConfirm" : "servers.deleteConfirm", { name: server.name }))) return;
      let ok = await run({ type: "servers.delete", id: server.id, force: unreachable });
      if (!ok && !unreachable && server.auth.kind === "key" && server.auth.dedicated && await confirmDestructiveAction(t("servers.forceDeleteConfirm", { name: server.name }))) {
        ok = await run({ type: "servers.delete", id: server.id, force: true });
      }
      if (ok) setAdding((current) => current?.server?.id === server.id ? undefined : current);
    },
  };
  const quickAdd = async (candidate: ServerCandidate) => {
    const ok = await run({ type: "servers.add", host: candidate.host, port: candidate.port, username: candidate.username ?? "root", name: candidate.alias,
      ...(candidate.identityFile === "agent" ? { useAgent: true } : { keyPath: candidate.identityFile }) });
    if (ok) useServerStore.setState((state) => ({ candidates: state.candidates?.filter((item) => item !== candidate) }));
  };

  /** Folders and the ungrouped area accept dropped cards. */
  const dropZone = (target: string, groupId?: string) => ({
    onDragOver: (event: DragEvent) => { if (!event.dataTransfer.types.includes(SERVER_DRAG_TYPE)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(target); },
    onDragLeave: (event: DragEvent) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget((current) => current === target ? undefined : current); },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      setDropTarget(undefined);
      const server = servers.find((item) => item.id === event.dataTransfer.getData(SERVER_DRAG_TYPE));
      if (server) actions.move(server, groupId);
      if (groupId) setCollapsed((current) => current.filter((id) => id !== groupId));
    },
  });

  const grid = (items: ServerInfo[]) => (
    <motion.div layout className="server-grid">
      <AnimatePresence initial={false}>
        {items.map((server) => (
          <motion.div key={server.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.16 }}>
            <ServerCard server={server} groups={groups} tunnels={tunnels.filter((item) => item.serverId === server.id).length} actions={actions} dragging={dragId === server.id} onDragState={setDragId} />
          </motion.div>
        ))}
      </AnimatePresence>
    </motion.div>
  );

  const ungrouped = servers.filter((server) => !server.groupId || !groups.some((group) => group.id === server.groupId));
  const empty = loaded && !servers.length && !groups.length;

  return (
    <>
      <SettingsPageHeader>
        <div className="servers-header">
          <SectionHeader eyebrow="Servers" title={t("servers.title")}>{t("servers.description")}</SectionHeader>
          <div className="servers-actions">
            <button type="button" className="servers-icon-button is-bordered" onClick={() => void createGroup()} aria-label={t("servers.newGroup")} title={t("servers.newGroup")}><FolderPlus size={15} /></button>
            <button type="button" className="servers-button" disabled={scanning} onClick={() => void discover()}>{scanning ? <LoaderCircle className="animate-spin" size={14} /> : <ScanSearch size={14} />}{t("servers.discover")}</button>
            <button type="button" className="servers-button is-primary" onClick={() => setAdding({})}><Plus size={14} />{t("servers.add")}</button>
          </div>
        </div>
      </SettingsPageHeader>
      {error && !adding && <p className="servers-error">{error}<button type="button" onClick={() => useServerStore.setState({ error: undefined })} aria-label={t("common.close")}><X size={13} /></button></p>}

      <div className="servers-page">
        <AnimatePresence initial={false}>
          {candidates && !scanning && (
            <motion.section className="servers-discovered" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
              <header>
                <span>{candidates.length ? t("servers.discoverFound", { count: candidates.length }) : t("servers.discoverNone")}</span>
                <button type="button" className="servers-icon-button" onClick={() => useServerStore.setState({ candidates: undefined })} aria-label={t("common.close")}><X size={14} /></button>
              </header>
              {candidates.map((candidate) => (
                <div key={`${candidate.host}:${candidate.port}:${candidate.alias ?? ""}`} className="servers-candidate">
                  <span className={cn("servers-dot", candidate.identityFile ? "is-ready" : "is-offline")} />
                  <span className="servers-candidate-text">
                    <strong>{candidate.alias ?? candidate.host}</strong>
                    <small>{serverAddress({ username: candidate.username ?? "root", host: candidate.host, port: candidate.port })} · {candidate.identityFile ? t("servers.keyWorks", { key: candidate.identityFile === "agent" ? "SSH Agent" : candidate.identityFile.split(/[\\/]/).at(-1)! }) : t("servers.needsPassword")}</small>
                  </span>
                  {candidate.identityFile
                    ? <button type="button" className="servers-button is-primary" onClick={() => void quickAdd(candidate)}>{t("servers.addOne")}</button>
                    : <button type="button" className="servers-button" onClick={() => setAdding({ prefill: candidate })}>{t("servers.fill")}</button>}
                </div>
              ))}
            </motion.section>
          )}
        </AnimatePresence>

        {!loaded ? <div className="servers-empty"><LoaderCircle className="animate-spin" size={18} /></div>
          : empty ? (
            <div className="servers-empty-state">
              <strong>{t("servers.emptyTitle")}</strong>
              <p>{t("servers.emptyDescription")}</p>
              <button type="button" className="servers-button" disabled={scanning} onClick={() => void discover()}><ScanSearch size={14} />{t("servers.discover")}</button>
            </div>
          ) : <>
            {groups.map((group) => (
              <GroupFolder key={group.id} group={group} count={servers.filter((server) => server.groupId === group.id).length}
                open={!collapsed.includes(group.id)} onOpenChange={(open) => setCollapsed((current) => open ? current.filter((id) => id !== group.id) : [...current, group.id])}
                editing={editingGroupId === group.id} onEditingDone={() => useServerStore.setState({ editingGroupId: undefined })}
                dropActive={dropTarget === group.id} dropProps={dropZone(group.id, group.id)}
                onRename={(name) => void run({ type: "servers.group.rename", id: group.id, name })}
                onAdd={() => setAdding({ groupId: group.id })}
                onDelete={async () => { if (await confirmDestructiveAction(t("servers.deleteGroupConfirm", { name: group.name }))) void run({ type: "servers.group.delete", id: group.id }); }}>
                {grid(servers.filter((server) => server.groupId === group.id))}
              </GroupFolder>
            ))}
            {(ungrouped.length > 0 || dragId) && (
              <section className={cn("servers-ungrouped", groups.length > 0 && "has-label", dropTarget === "" && "is-drop-target")} {...dropZone("")}>
                {groups.length > 0 && <h3>{t("servers.ungrouped")}</h3>}
                {ungrouped.length ? grid(ungrouped) : <p className="servers-drop-hint">{t("servers.dropToUngroup")}</p>}
              </section>
            )}
          </>}
      </div>

      <ServerFormDialog open={Boolean(adding)} onOpenChange={(open) => { if (!open) setAdding(undefined); }} prefill={adding?.prefill} groupId={adding?.groupId} server={adding?.server} groups={groups}
        tunnels={tunnels.filter((item) => item.serverId === adding?.server?.id)} run={run} onTerminal={actions.terminal} onRemove={actions.remove} />
    </>
  );
}

function GroupFolder({ group, count, open, onOpenChange, editing, onEditingDone, dropActive, dropProps, onRename, onAdd, onDelete, children }: {
  group: ServerGroupInfo; count: number; open: boolean; onOpenChange: (open: boolean) => void;
  editing: boolean; onEditingDone: () => void; dropActive: boolean; dropProps: Record<string, (event: DragEvent) => void>;
  onRename: (name: string) => void; onAdd: () => void; onDelete: () => void; children: ReactNode;
}) {
  const { t } = useLocale();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(group.name);
  const input = useRef<HTMLInputElement>(null);
  const active = renaming || editing;
  useEffect(() => { if (active) { setName(group.name); requestAnimationFrame(() => { input.current?.focus(); input.current?.select(); }); } }, [active, group.name]);
  const commit = () => {
    if (name.trim() && name.trim() !== group.name) onRename(name.trim());
    setRenaming(false); onEditingDone();
  };
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className={cn("server-folder", dropActive && "is-drop-target")} {...dropProps}>
      <div className="server-folder-header">
        <CollapsibleTrigger className="server-folder-trigger" disabled={active}>
          <ChevronRight size={14} className="server-folder-chevron" />
          <CodexIcon src={open ? folderOpenIcon : folderIcon} className="size-4" />
          {!active && <span className="server-folder-name" onDoubleClick={(event) => { event.preventDefault(); setRenaming(true); }}>{group.name}</span>}
        </CollapsibleTrigger>
        {active && <input ref={input} className="server-folder-input" value={name} onChange={(event) => setName(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === "Enter") commit(); if (event.key === "Escape") { event.stopPropagation(); setRenaming(false); onEditingDone(); } }} aria-label={t("servers.renameGroup")} />}
        <span className="server-folder-count">{count}</span>
        <span className="server-folder-actions">
          <button type="button" className="servers-icon-button" onClick={onAdd} aria-label={t("servers.addToGroup")} title={t("servers.addToGroup")}><Plus size={14} /></button>
          <GroupMenu onRename={() => setRenaming(true)} onDelete={onDelete}>
            <button type="button" className="servers-icon-button" aria-label={t("servers.more")}><CodexIcon src={moreIcon} className="size-4" /></button>
          </GroupMenu>
        </span>
      </div>
      <CollapsibleContent className="server-folder-content">
        {count ? children : <p className="servers-drop-hint">{t("servers.emptyGroup")}</p>}
      </CollapsibleContent>
    </Collapsible>
  );
}
