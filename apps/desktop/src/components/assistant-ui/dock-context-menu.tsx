"use client";

import { ContextMenu } from "radix-ui";
import { useRef, useState, type ReactElement } from "react";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { localizeError } from "../../lib/error-localization";
import { contextMenuSelection, openContextMenuFromKeyboard, preserveLinkedImageMenu } from "../../lib/context-menu";
import { externalBrowserUrl, openBrowserInDock } from "../../lib/browser-dock";
import { resolveFileReferencePath } from "../../lib/workspace-file-navigation";
import { CodexIcon } from "../ui/CodexIcon";
import copyIcon from "../../assets/codex-icons/square-on-square-light-16.svg";
import externalIcon from "../../assets/codex-icons/arrow-up-right-md-light-16.svg";
import fileIcon from "../../assets/codex-icons/document-text-light-16.svg";
import folderIcon from "../../assets/codex-icons/folder-open-light-16.svg";
import closeIcon from "../../assets/codex-icons/xmark-md-light-16.svg";
import browserIcon from "../../assets/codex-icons/composer-globe-26-928.svg";
import downloadIcon from "../../assets/codex-icons/arrow-down-open-base-light-16.svg";
import "./sidebar-menu.css";

async function copyText(value: string): Promise<void> {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    useStore.setState({ lastError: localizeError(error) });
  }
}

function reportFileActionError(error: unknown): void {
  useStore.setState({ lastError: localizeError(error) });
}

export function DockTabContextMenu({
  children,
  onClose,
  onCloseOther,
  onCloseRight,
  filePath,
}: {
  children: ReactElement;
  onClose: () => void;
  onCloseOther?: () => void;
  onCloseRight?: () => void;
  filePath?: string;
}) {
  const { t } = useLocale();
  const absoluteFilePath = filePath ? resolveFileReferencePath(filePath) : undefined;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild onKeyDown={openContextMenuFromKeyboard} data-dock-tab-context-menu-trigger>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="q-sidebar-menu" data-dock-tab-context-menu>
          {filePath && <>
            <WorkspacePathMenuItems path={filePath} onOpenExternal={absoluteFilePath ? () => void openPath(absoluteFilePath).catch(reportFileActionError) : undefined} />
            <ContextMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />
          </>}
          <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onClose}>
            <CodexIcon src={closeIcon} className="size-4" />
            <span>{t("dock.tabClose")}</span>
          </ContextMenu.Item>
          {onCloseOther && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onCloseOther}>
            <CodexIcon src={closeIcon} className="size-4" />
            <span>{t("dock.closeOtherTabs")}</span>
          </ContextMenu.Item>}
          {onCloseRight && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onCloseRight}>
            <CodexIcon src={closeIcon} className="size-4" />
            <span>{t("dock.closeTabsRight")}</span>
          </ContextMenu.Item>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

interface WorkspacePathMenuProps {
  path: string;
  onOpen?: () => void;
  onReview?: () => void;
  onOpenExternal?: () => void;
  onReveal?: (() => void) | false;
}

function WorkspacePathMenuItems({
  path,
  onOpen,
  onReview,
  onOpenExternal,
  onReveal,
}: WorkspacePathMenuProps) {
  const { t } = useLocale();
  const absolutePath = resolveFileReferencePath(path);
  const reveal = onReveal === false ? undefined : onReveal ?? (absolutePath ? () => {
    void revealItemInDir(absolutePath).catch(reportFileActionError);
  } : undefined);
  return <>
    {onReview && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onReview}>
      <CodexIcon src={fileIcon} className="size-4" />
      <span>{t("dock.viewChanges")}</span>
    </ContextMenu.Item>}
    {onOpen && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onOpen}>
      <CodexIcon src={fileIcon} className="size-4" />
      <span>{t("dock.openFile")}</span>
    </ContextMenu.Item>}
    {onOpenExternal && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onOpenExternal}>
      <CodexIcon src={externalIcon} className="size-4" />
      <span>{t("dock.fileOpenExternal")}</span>
    </ContextMenu.Item>}
    {(onOpen || onReview || onOpenExternal) && <ContextMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />}
    <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => void copyText(path)}>
      <CodexIcon src={copyIcon} className="size-4" />
      <span>{t("dock.copyPath")}</span>
    </ContextMenu.Item>
    {reveal && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={reveal}>
      <CodexIcon src={folderIcon} className="size-4" />
      <span>{t("dock.revealInFolder")}</span>
    </ContextMenu.Item>}
  </>;
}

export function WorkspacePathContextMenu({ children, ...props }: WorkspacePathMenuProps & { children: ReactElement }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild onKeyDown={openContextMenuFromKeyboard} data-workspace-path-context-menu-trigger>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="q-sidebar-menu" data-workspace-path-context-menu>
          <WorkspacePathMenuItems {...props} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function CodeContextMenu({
  children,
  path,
  relativePath,
}: {
  children: ReactElement;
  path?: string;
  relativePath?: string;
}) {
  const { t } = useLocale();
  const [selection, setSelection] = useState("");
  const triggerRef = useRef<HTMLSpanElement>(null);
  return (
    <ContextMenu.Root onOpenChange={(open) => { if (open) setSelection(contextMenuSelection(triggerRef.current)); }}>
      <ContextMenu.Trigger ref={triggerRef} asChild onKeyDown={openContextMenuFromKeyboard} data-code-context-menu-trigger>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="q-sidebar-menu" data-code-context-menu>
          <ContextMenu.Item
            className="q-sidebar-menu-item"
            disabled={!selection}
            onSelect={() => void copyText(selection)}
          >
            <CodexIcon src={copyIcon} className="size-4" />
            <span>{t("dock.copySelection")}</span>
          </ContextMenu.Item>
          {path && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => void copyText(path)}>
            <CodexIcon src={copyIcon} className="size-4" />
            <span>{t("dock.copyPath")}</span>
          </ContextMenu.Item>}
          {relativePath && relativePath !== path && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => void copyText(relativePath)}>
            <CodexIcon src={copyIcon} className="size-4" />
            <span>{t("dock.copyRelativePath")}</span>
          </ContextMenu.Item>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function WebLinkContextMenu({ children, href }: { children: ReactElement; href: string }) {
  const { t } = useLocale();
  const url = externalBrowserUrl(href.startsWith("//") ? `https:${href}` : href);
  if (!url) return children;
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild onKeyDown={openContextMenuFromKeyboard} onContextMenuCapture={preserveLinkedImageMenu} data-web-link-context-menu-trigger>
      {children}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="q-sidebar-menu" data-web-link-context-menu>
        <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => openBrowserInDock(url, useStore.getState().currentSessionId)}>
          <CodexIcon src={browserIcon} className="size-4" /><span>{t("dock.openLinkInBrowser")}</span>
        </ContextMenu.Item>
        <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => void openUrl(url).catch(reportFileActionError)}>
          <CodexIcon src={externalIcon} className="size-4" /><span>{t("dock.openLinkExternal")}</span>
        </ContextMenu.Item>
        <ContextMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />
        <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => void copyText(href.startsWith("//") ? `https:${href}` : href)}>
          <CodexIcon src={copyIcon} className="size-4" /><span>{t("dock.copyLink")}</span>
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}

export function ImageContextMenu({ children, src, onSave }: { children: ReactElement; src: string; onSave: () => void }) {
  const { t } = useLocale();
  const address = externalBrowserUrl(src);
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild onKeyDown={openContextMenuFromKeyboard} data-image-context-menu-trigger>
      {children}
    </ContextMenu.Trigger>
    <ContextMenu.Portal>
      <ContextMenu.Content className="q-sidebar-menu" data-image-context-menu>
        {address && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => void copyText(address)}>
          <CodexIcon src={copyIcon} className="size-4" /><span>{t("image.copyAddress")}</span>
        </ContextMenu.Item>}
        <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onSave}>
          <CodexIcon src={downloadIcon} className="size-4" /><span>{t("image.saveAs")}</span>
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
