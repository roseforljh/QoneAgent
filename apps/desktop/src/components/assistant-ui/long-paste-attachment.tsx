"use client";

import { useEffect } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  COMMAND_PRIORITY_HIGH,
  PASTE_COMMAND,
  type PasteCommandType,
} from "lexical";
import { useAui } from "@assistant-ui/react";
import { getPastedTextFileName, shouldConvertLongPaste } from "../../lib/long-paste";

function getPlainText(event: PasteCommandType): string | null {
  if (!("clipboardData" in event) || !event.clipboardData) return null;
  return event.clipboardData.getData("text/plain");
}

/** Turns large clipboard text into a normal assistant-ui file attachment. */
export function LongPasteAttachmentPlugin() {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();

  useEffect(() => editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      const text = getPlainText(event);
      if (!text || !shouldConvertLongPaste(text)) return false;
      if (!aui.thread.getState().capabilities.attachments) return false;

      event.preventDefault();
      const file = new globalThis.File(
        [text],
        getPastedTextFileName(text),
        { type: "text/plain" },
      );
      void aui.composer.addAttachment(file).catch(() => {
        // assistant-ui emits composer.attachmentAddError for rejected files.
      });
      return true;
    },
    COMMAND_PRIORITY_HIGH,
  ), [aui, editor]);

  return null;
}
