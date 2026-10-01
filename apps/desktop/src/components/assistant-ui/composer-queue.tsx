import { ComposerPrimitive, QueueItemPrimitive, useAui, useAuiState, type AppendMessage, type QueueItemState } from "@assistant-ui/react";
import { Loader2Icon } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Fragment, type ReactNode } from "react";
import moreIcon from "../../assets/codex-icons/ellipsis-horizontal-light-16.svg";
import pencilIcon from "../../assets/codex-icons/pencil-light-16.svg";
import steerIcon from "../../assets/codex-icons/arrow-curved-right-large-typographic-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import sideChatIcon from "../../assets/codex-icons/plus-chat-bubble-right-light-16.svg";
import { openQueuedSideConversation } from "../../lib/side-conversation";
import { sessionStore } from "../../lib/session-execution-state";
import { localizeError } from "../../lib/error-localization";
import { useAttachmentPreviewSrc } from "../../hooks/use-attachment-src";
import { getDraftComposer } from "../../lib/composer-draft-runtime";
import { getQoneMessageQueue } from "../../lib/qone-message-queue";
import { beginQueueComposerEdit } from "../../lib/queue-composer-edit";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { Button } from "../ui/Button";
import { CodexIcon } from "../ui/CodexIcon";
import { CodexQueueIcon } from "./composer-queue-icons";
import { TooltipIconButton } from "./tooltip-icon-button";
import "./sidebar-menu.css";

type QueueRowProps = {
  itemId: string;
  queueItem: QueueItemState;
  message?: AppendMessage;
  steering?: boolean;
  editing?: boolean;
  detached?: boolean;
  onSteer?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onOpenSideChat?: () => void;
  transferring?: boolean;
};

function QueueItemRow({ itemId, queueItem, message, steering = false, editing = false, detached = false, onSteer, onEdit, onDelete, onOpenSideChat, transferring = false }: QueueRowProps) {
  const { t } = useLocale();
  const queueing = useStore((state) => state.followUpQueueMode === "queue");
  const setMode = useStore((state) => state.setFollowUpQueueMode);
  const image = message?.attachments?.find((attachment) => attachment.type === "image");
  const nativePath = (image?.file as File & { qoneLocalPath?: string } | undefined)?.qoneLocalPath;
  const previewSrc = useAttachmentPreviewSrc({
    localPath: nativePath,
    file: nativePath ? undefined : image?.file,
    src: image?.content.find((part) => part.type === "image")?.image,
  });
  const attachmentSummary = message?.attachments?.map((attachment) => attachment.name).join(", ") ?? "";
  const title = queueItem.prompt || attachmentSummary;
  const removeButton = <TooltipIconButton
    tooltip={t("chat.queueRemove")}
    disabled={steering}
    onClick={detached ? onDelete : undefined}
    className="size-7 rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
  ><CodexIcon src={trashIcon} className="size-4" /></TooltipIconButton>;

  return <div
    role="listitem"
    data-queue-item-id={itemId}
    data-queue-editing={editing || undefined}
    className={cn("q-composer-queue-item group flex min-w-0 items-center justify-between gap-2 px-2.5 py-0.5 text-sm text-foreground/85 transition-colors", (editing || steering) && "opacity-60")}
  >
    <div className="flex min-h-7 min-w-0 flex-1 items-center gap-2" title={title}>
      {steering || transferring
        ? <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground/70" aria-hidden="true" />
        : <CodexQueueIcon />}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden py-1 leading-5">
        {previewSrc && <img src={previewSrc} alt={image?.name || t("attachment.imageAlt")} draggable={false} className="size-6 shrink-0 rounded border border-border object-cover" />}
        {detached || !queueItem.prompt
          ? <span className="min-w-0 flex-1 truncate select-none">{title}</span>
          : <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate select-none" />}
      </div>
    </div>
    {transferring ? <span className="shrink-0 text-xs text-muted-foreground" role="status">{t("chat.queueOpeningSideChat")}</span> : <div className="q-composer-queue-actions flex shrink-0 items-center gap-1 text-muted-foreground">
      {steering ? <span className="sr-only" role="status">{t("chat.steerPending")}</span> : <Button
        variant="ghost"
        size="icon-sm"
        title={t("chat.queueSteer")}
        aria-label={t("chat.queueSteer")}
        disabled={editing}
        onClick={onSteer}
        className="q-composer-queue-steer h-7 w-auto gap-1 rounded-lg px-1.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
      ><CodexIcon src={steerIcon} className="size-4 shrink-0" /><span>{t("chat.queueSteer")}</span></Button>}
      {detached ? removeButton : <QueueItemPrimitive.Remove asChild>{removeButton}</QueueItemPrimitive.Remove>}
      {!steering && <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button type="button" title={t("chat.queueMore")} aria-label={t("chat.queueMore")} disabled={editing}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50">
            <CodexIcon src={moreIcon} className="size-4" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="q-sidebar-menu" side="top" align="end" sideOffset={6}>
            <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onEdit}>
              <CodexIcon src={pencilIcon} className="size-4 text-muted-foreground" /><span>{t("chat.queueEdit")}</span>
            </DropdownMenu.Item>
            {onOpenSideChat && <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onOpenSideChat}>
              <CodexIcon src={sideChatIcon} className="size-4 text-muted-foreground" /><span>{t("chat.queueOpenSideChat")}</span>
            </DropdownMenu.Item>}
            <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={() => setMode(queueing ? "steer" : "queue")}>
              <CodexQueueIcon className="size-4 text-muted-foreground" /><span>{t(queueing ? "chat.queueDisable" : "chat.queueEnable")}</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>}
    </div>}
  </div>;
}

export function ComposerQueue({ sessionId: ownerSessionId, allowSideChat = true }: { sessionId?: string; allowSideChat?: boolean } = {}) {
  const aui = useAui();
  const { t } = useLocale();
  const selectedSessionId = useStore((state) => state.currentSessionId);
  const sessionId = ownerSessionId ?? selectedSessionId;
  const editingQueueItem = useStore((state) => state.currentSessionId === sessionId ? state.editingQueueItem : state.backgroundSessions[sessionId ?? ""]?.editingQueueItem);
  const transfers = useStore((state) => state.sideChatTransfers);
  const queueItems = useAuiState((state) => state.composer.queue);
  const conversationMessages = useAuiState((state) => state.thread.messages);
  const queue = sessionId ? getQoneMessageQueue(sessionId) : undefined;
  // Hide an in-flight input only once its identity is displayed in this conversation.
  const steeringIds = new Set(queue?.adapter.steerItems.filter((item) => conversationMessages.some(
    (message) => message.id === queue.getPersistentId(item.id),
  )).map((item) => item.id));
  const visibleQueueItems = queueItems.filter((item) => !steeringIds.has(item.id));
  const snapshotById = new Map(queue?.getSnapshot().map((item) => [item.id, item]));
  const item = editingQueueItem && editingQueueItem.sessionId === sessionId ? queue?.getItem(editingQueueItem.id) : undefined;
  // getItem resolves surviving neighbors. Once saving reinserts the item, it
  // is queued again; a stale store edit marker must not render a second copy.
  const recovery = item?.status === "scheduled" ? item : undefined;
  const recoveryRow = recovery ? <QueueItemRow
    key={recovery.id}
    itemId={recovery.id}
    queueItem={{ id: recovery.id, prompt: recovery.text, parts: recovery.text ? [{ type: "text", text: recovery.text }] : [] }}
    message={queue?.getMessage(queue.getLocalId(recovery.id)!)}
    editing
    detached
    onDelete={() => {
      const localId = queue?.getLocalId(recovery.id);
      if (!queue || !localId) return;
      queue.remove(localId);
      sessionStore(useStore, sessionId).setState({ editingQueueItem: undefined });
      void aui.composer().reset();
    }}
  /> : null;

  const transferring = Object.values(transfers).filter((entry) => entry.sessionId === sessionId).map((entry) => snapshotById.get(entry.id) ?? entry);
  // Positions include every detached and in-flight item. Anchor each static
  // row to the next visible durable item rather than subtracting hidden counts.
  const insertions = new Map<string | undefined, ReactNode[]>();
  const detachedRows = [
    ...(recovery ? [{ position: recovery.position, row: recoveryRow }] : []),
    ...transferring.map((entry) => ({ position: entry.position, row: <QueueItemRow
      key={entry.id} itemId={entry.id}
      queueItem={{ id: entry.id, prompt: entry.text, parts: [] }}
      message={queue?.getMessage(queue.getLocalId(entry.id)!)} detached transferring
    /> })),
  ].sort((left, right) => left.position - right.position);
  const visiblePositions = visibleQueueItems.map((candidate) => ({
    id: candidate.id,
    position: snapshotById.get(queue?.getPersistentId(candidate.id) ?? "")?.position,
  }));
  for (const { position, row } of detachedRows) {
    const before = visiblePositions.find((candidate) => candidate.position !== undefined && candidate.position > position)?.id;
    const rows = insertions.get(before) ?? [];
    rows.push(row);
    insertions.set(before, rows);
  }
  if (!visibleQueueItems.length && !recovery && !transferring.length) return null;
  return <div className="q-composer-rail" data-composer-rail data-composer-rail-placement="above">
    <div className="q-composer-rail-item" data-composer-rail-item>
      <div className="q-composer-queue" role="list" aria-label={t("chat.queueLabel")}>
        <ComposerPrimitive.Queue>
          {({ queueItem }) => steeringIds.has(queueItem.id) ? null : <Fragment>
            {insertions.get(queueItem.id)}
            <QueueItemRow
              itemId={queue?.getPersistentId(queueItem.id) ?? queueItem.id}
              queueItem={queueItem}
              message={queue?.getMessage(queueItem.id)}
              steering={queue?.adapter.steerItems.some((item) => item.id === queueItem.id)}
              onSteer={() => queue?.steerNow(queueItem.id)}
              onEdit={() => {
                if (!queue) return;
                if (!aui.composer().getState().isEmpty) {
                  useStore.setState({ lastError: t("chat.queueEditDraftBlocked") });
                  return;
                }
                const thread = aui.thread().__internal_getRuntime?.();
                if (!thread) return;
                const editing = beginQueueComposerEdit(queue, queueItem.id, getDraftComposer({ thread }));
                if (editing) sessionStore(useStore, sessionId).setState({ editingQueueItem: editing });
              }}
              onOpenSideChat={allowSideChat && sessionId ? () => {
                if (queue) void queue.transfer(queueItem.id, openQueuedSideConversation).catch((error) => useStore.setState({ lastError: localizeError(error) }));
              } : undefined}
            />
          </Fragment>}
        </ComposerPrimitive.Queue>
        {insertions.get(undefined)}
      </div>
    </div>
  </div>;
}
