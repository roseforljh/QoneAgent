import { useCallback, useEffect, useRef } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey, $getSelection, $isRangeSelection, $setSelection,
  COMMAND_PRIORITY_HIGH, DELETE_CHARACTER_COMMAND, HISTORY_PUSH_TAG, KEY_BACKSPACE_COMMAND,
  type RangeSelection,
} from "lexical";
import { $deleteComposerToolBackward, $insertComposerCommand, $insertComposerQuote, $insertComposerTool, type ComposerCommand, type ComposerToolId } from "../../lib/composer-tool-editor";

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
  const aui = useAui();
  const quote = useAuiState((state) => state.composer.quote);
  const savedSelection = useRef<RangeSelection | null>(null);
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) savedSelection.current = selection.clone();
    });
  }), [editor]);

  /** Menus and selection actions steal focus; insert at the caret the user left, after any selected text. */
  const insertAtCaret = useCallback((insert: () => void) => {
    if (!editor.isEditable()) return;
    editor.update(() => {
      const saved = savedSelection.current;
      if (saved && $getNodeByKey(saved.anchor.key)?.isAttached() && $getNodeByKey(saved.focus.key)?.isAttached()) {
        $setSelection(saved.clone());
      }
      const selection = $getSelection();
      if ($isRangeSelection(selection) && !selection.isCollapsed()) {
        const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
        start.set(end.key, end.offset, end.type);
      }
      insert();
    }, { tag: HISTORY_PUSH_TAG });
    editor.focus();
  }, [editor]);

  const insertTool = useCallback<InsertComposerTool>((tool) => insertAtCaret(() => $insertComposerTool(tool)), [insertAtCaret]);

  // "Add to chat" sets assistant-ui's composer quote; it becomes a chip where the caret was.
  useEffect(() => {
    if (!quote?.text.trim() || !editor.isEditable()) return;
    aui.composer().setQuote(undefined);
    insertAtCaret(() => $insertComposerQuote(quote.text));
  }, [aui, quote, insertAtCaret]);

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

  // assistant-ui's composer root focuses the input with a plain DOM focus when
  // its blank area (padding, the space below a short draft, gaps between
  // actions) is clicked; a contenteditable then puts the caret at the start.
  // Handle that click here: focus through Lexical so the last caret, or the
  // end of the draft, is kept.
  useEffect(() => editor.registerRootListener((root) => {
    const composer = root?.closest<HTMLElement>(".aui-composer-root");
    if (!root || !composer) return;
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (event.button !== 0 || !(target instanceof Element) || root.contains(target) || target.closest(INTERACTIVE)) return;
      // Cancel the default focus, but let popovers observe the outside press.
      event.preventDefault();
      // Focus first, then let Lexical put its own selection back into the DOM.
      root.focus({ preventScroll: true });
      editor.focus();
    };
    composer.addEventListener("mousedown", onMouseDown);
    return () => composer.removeEventListener("mousedown", onMouseDown);
  }), [editor]);
  return null;
}

const INTERACTIVE = "a, button, input, textarea, select, label, summary, [tabindex], [contenteditable]";
