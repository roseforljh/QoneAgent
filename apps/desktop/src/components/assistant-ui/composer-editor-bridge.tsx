import { useCallback, useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey, $getSelection, $isRangeSelection, $isTextNode, $setSelection,
  COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, HISTORY_PUSH_TAG, KEY_BACKSPACE_COMMAND,
  type RangeSelection,
} from "lexical";
import { $deleteComposerToolBackward, $insertComposerCommand, $insertComposerTool, type ComposerCommand, type ComposerToolId } from "../../lib/composer-tool-editor";

export type InsertComposerTool = (tool: { id: ComposerToolId; label: string }) => void;
export type InsertComposerCommand = (command: ComposerCommand) => void;
export type ComposerMentionControls = { open: () => void; cancel: () => boolean };
type InsertedMention = { key: string; offset: number; prefix: string };

function $removeButtonMention(marker: InsertedMention): boolean {
  const node = $getNodeByKey(marker.key);
  if (!$isTextNode(node) || !node.isAttached()) return false;
  const text = node.getTextContent();
  if (!text.startsWith(marker.prefix) || text[marker.offset] !== "@") return false;
  node.spliceText(marker.offset, 1, "");
  const selection = $getSelection();
  if ($isRangeSelection(selection) && selection.isCollapsed()
    && selection.anchor.key === marker.key
    && selection.anchor.offset >= marker.offset
    && selection.anchor.offset <= marker.offset + 1) {
    node.select(marker.offset, marker.offset);
  }
  return true;
}

export function ComposerEditorBridge({
  onReady,
  onCommandReady,
  onMentionToggleReady,
}: {
  onReady?: (insert: InsertComposerTool | null) => void;
  onCommandReady?: (insert: InsertComposerCommand | null) => void;
  onMentionToggleReady?: (controls: ComposerMentionControls | null) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const savedSelection = useRef<RangeSelection | null>(null);
  const insertedMention = useRef<InsertedMention | null>(null);
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const marker = insertedMention.current;
      if (marker) {
        const node = $getNodeByKey(marker.key);
        if (!$isTextNode(node) || !node.isAttached()
          || !node.getTextContent().startsWith(marker.prefix)
          || node.getTextContent()[marker.offset] !== "@") {
          insertedMention.current = null;
        }
      }
      const selection = $getSelection();
      if ($isRangeSelection(selection)) savedSelection.current = selection.clone();
    });
  }), [editor]);

  const insertTool = useCallback<InsertComposerTool>((tool) => {
    if (!editor.isEditable()) return;
    editor.update(() => {
      const saved = savedSelection.current;
      if (saved && $getNodeByKey(saved.anchor.key)?.isAttached() && $getNodeByKey(saved.focus.key)?.isAttached()) {
        $setSelection(saved.clone());
      }
      $insertComposerTool(tool);
    }, { tag: HISTORY_PUSH_TAG });
    editor.focus();
  }, [editor]);

  const insertCommand = useCallback<InsertComposerCommand>((command) => {
    if (!editor.isEditable()) return;
    editor.update(() => {
      $insertComposerCommand(command);
    }, { tag: HISTORY_PUSH_TAG });
    editor.focus();
  }, [editor]);

  const cancelMention = useCallback(() => {
    const marker = insertedMention.current;
    insertedMention.current = null;
    if (!marker) return false;
    let removed = false;
    editor.update(() => {
      removed = $removeButtonMention(marker);
    }, { tag: HISTORY_PUSH_TAG });
    return removed;
  }, [editor]);

  const openMention = useCallback(() => {
    if (!editor.isEditable()) return;
    editor.update(() => {
      // A previous button-opened trigger can survive an editor reset or a
      // popover dismissal. Never let it accumulate with the next one.
      const previous = insertedMention.current;
      insertedMention.current = null;
      const removedPrevious = previous ? $removeButtonMention(previous) : false;
      const saved = savedSelection.current;
      if (!removedPrevious && saved && $getNodeByKey(saved.anchor.key)?.isAttached() && $getNodeByKey(saved.focus.key)?.isAttached()) {
        $setSelection(saved.clone());
      }
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return;
      if (!selection.isCollapsed()) {
        const end = selection.isBackward() ? selection.anchor : selection.focus;
        selection.anchor.set(end.key, end.offset, end.type);
        selection.focus.set(end.key, end.offset, end.type);
      }
      selection.insertText("@");
      const after = $getSelection();
      if (!$isRangeSelection(after) || !after.isCollapsed()) return;
      const node = after.anchor.getNode();
      const offset = after.anchor.offset - 1;
      if ($isTextNode(node) && node.getTextContent()[offset] === "@") {
        insertedMention.current = { key: node.getKey(), offset, prefix: node.getTextContent().slice(0, offset) };
      }
    }, { tag: HISTORY_PUSH_TAG });
    editor.focus();
  }, [editor]);

  useEffect(() => {
    const unregisterKey = editor.registerCommand(KEY_BACKSPACE_COMMAND, (event) => {
      if (editor.isComposing() || event?.isComposing || event?.ctrlKey || event?.altKey || event?.metaKey) return false;
      if (!$deleteComposerToolBackward()) return false;
      event?.preventDefault();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const unregisterDelete = editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward) =>
      !editor.isComposing() && backward && $deleteComposerToolBackward(), COMMAND_PRIORITY_HIGH);
    onReady?.(insertTool);
    onCommandReady?.(insertCommand);
    onMentionToggleReady?.({ open: openMention, cancel: cancelMention });
    return () => {
      unregisterKey();
      unregisterDelete();
      onReady?.(null);
      onCommandReady?.(null);
      onMentionToggleReady?.(null);
    };
  }, [editor, insertTool, insertCommand, onMentionToggleReady, onReady, onCommandReady, openMention, cancelMention]);
  return null;
}
