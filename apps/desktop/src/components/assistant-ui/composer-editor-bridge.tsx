import { useCallback, useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey, $getSelection, $isRangeSelection, $setSelection,
  COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, HISTORY_PUSH_TAG, KEY_BACKSPACE_COMMAND,
  type RangeSelection,
} from "lexical";
import { $deleteComposerToolBackward, $insertComposerCommand, $insertComposerTool, type ComposerCommand, type ComposerToolId } from "../../lib/composer-tool-editor";

export type InsertComposerTool = (tool: { id: ComposerToolId; label: string }) => void;
export type InsertComposerCommand = (command: ComposerCommand) => void;

export function ComposerEditorBridge({
  onReady,
  onCommandReady,
}: {
  onReady?: (insert: InsertComposerTool | null) => void;
  onCommandReady?: (insert: InsertComposerCommand | null) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const savedSelection = useRef<RangeSelection | null>(null);
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
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
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        // Choosing a tool from a menu inserts after the selection, not in place of the draft.
        const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
        start.set(end.key, end.offset, end.type);
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
    return () => {
      unregisterKey();
      unregisterDelete();
      onReady?.(null);
      onCommandReady?.(null);
    };
  }, [editor, insertTool, insertCommand, onReady, onCommandReady]);
  return null;
}
