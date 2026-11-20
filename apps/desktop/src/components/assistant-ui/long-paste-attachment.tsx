"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type LexicalEditor,
  type PasteCommandType,
} from "lexical";
import { useAui } from "@assistant-ui/react";
import { getPastedTextFileName, shouldConvertLongPaste } from "../../lib/long-paste";

function getPlainText(event: PasteCommandType): string | null {
  if (!("clipboardData" in event) || !event.clipboardData) return null;
  return event.clipboardData.getData("text/plain");
}

// 从剪贴板事件中提取文件/图片：优先读取 files（保留 Electron 文件路径引用），为空时兜底读取 items。
export function getPastedFiles(event: PasteCommandType): globalThis.File[] {
  if (!("clipboardData" in event) || !event.clipboardData) return [];
  const files = Array.from(event.clipboardData.files ?? []);
  if (files.length > 0) return files;
  return Array.from(event.clipboardData.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is globalThis.File => file !== null);
}

export interface PasteAttachmentCallbacks {
  canAttach: () => boolean;
  addAttachment: (file: globalThis.File) => Promise<unknown>;
}

/** 处理剪贴板粘贴的文件/图片以及超长纯文本，转为 composer 附件。 */
export function registerPasteAttachment(
  editor: LexicalEditor,
  { canAttach, addAttachment }: PasteAttachmentCallbacks,
): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      const files = getPastedFiles(event);
      if (files.length > 0) {
        if (!canAttach()) return false;
        event.preventDefault();
        for (const file of files) {
          void addAttachment(file).catch(() => {
            // assistant-ui 会在拒绝附件时触发 composer.attachmentAddError。
          });
        }
        return true;
      }

      const text = getPlainText(event);
      if (!text || !shouldConvertLongPaste(text)) return false;
      if (!canAttach()) return false;

      event.preventDefault();
      const file = new globalThis.File(
        [text],
        getPastedTextFileName(text),
        { type: "text/plain" },
      );
      void addAttachment(file).catch(() => {
        // assistant-ui 会在拒绝附件时触发 composer.attachmentAddError。
      });
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  );
}

/** 将剪贴板中的图片/文件或超长文本转为普通 assistant-ui 附件。 */
export function LongPasteAttachmentPlugin() {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();

  useEffect(() => registerPasteAttachment(editor, {
    canAttach: () => aui.thread.getState().capabilities.attachments,
    addAttachment: (file) => aui.composer.addAttachment(file),
  }), [aui, editor]);

  return null;
}
