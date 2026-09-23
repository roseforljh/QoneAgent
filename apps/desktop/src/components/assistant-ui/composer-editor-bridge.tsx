import { useCallback, useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey, $getSelection, $isRangeSelection, $setSelection,
  COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, HISTORY_PUSH_TAG, KEY_BACKSPACE_COMMAND,
  type RangeSelection,
} from "lexical";
import { $deleteComposerToolBackward, $insertComposerTool, type ComposerToolId } from "../../lib/composer-tool-editor";

export type InsertComposerTool = (tool: { id: ComposerToolId; label: string }) => void;

export function ComposerEditorBridge({ onReady }: { onReady?: (insert: InsertComposerTool | null) => void }) {
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
      $insertComposerTool(tool);
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
    return () => { unregisterKey(); unregisterDelete(); onReady?.(null); };
  }, [editor, insertTool, onReady]);
  return null;
}
