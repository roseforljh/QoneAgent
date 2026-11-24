import { useCallback, useEffect, useRef } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { $isDirectiveNode, type DirectiveNode } from "@assistant-ui/react-lexical";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getNodeByKey, $getRoot, $getSelection, $isElementNode, $isRangeSelection, $isTextNode, $setSelection,
  CLICK_COMMAND, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_LOW, DELETE_CHARACTER_COMMAND, HISTORY_PUSH_TAG,
  KEY_BACKSPACE_COMMAND, SELECTION_CHANGE_COMMAND,
  type LexicalEditor, type RangeSelection,
} from "lexical";
import { $deleteComposerToolBackward, $insertComposerCommand, $insertComposerQuote, $insertComposerTool, type ComposerCommand, type ComposerToolId } from "../../lib/composer-tool-editor";

export type InsertComposerTool = (tool: { id: ComposerToolId; label: string }) => void;
export type InsertComposerCommand = (command: ComposerCommand) => void;

function $restoreOrSelectEnd(saved: RangeSelection | null) {
  if (saved && $getNodeByKey(saved.anchor.key)?.isAttached() && $getNodeByKey(saved.focus.key)?.isAttached()) {
    $setSelection(saved.clone());
  } else {
    $getRoot().selectEnd();
  }
}

function $leadingDirectiveAtCaret(selection: RangeSelection): DirectiveNode | null {
  if (!selection.isCollapsed()) return null;
  const { anchor } = selection;
  const node = anchor.getNode();
  const candidate = $isElementNode(node)
    ? node.getChildAtIndex(anchor.offset)
    : $isTextNode(node) && anchor.offset === node.getTextContentSize()
      ? node.getNextSibling()
      : null;
  return $isDirectiveNode(candidate) && candidate.isInline() ? candidate : null;
}

function getDecoratorRect(dom: HTMLElement): DOMRect {
  const rect = dom.getBoundingClientRect();
  const childRect = dom.firstElementChild?.getBoundingClientRect();
  return childRect && childRect.width > rect.width ? childRect : rect;
}

/** Chromium/Lexical 点击内联 DecoratorNode 右侧或其同空白行区域时可能误回退到标签左侧，按点击坐标修正到标签右侧。 */
function $moveSelectionAfterClickedDirective(editor: LexicalEditor, click: { x: number; y: number }): boolean {
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return false;
  const directive = $leadingDirectiveAtCaret(selection);
  if (!directive) return false;
  const dom = editor.getElementByKey(directive.getKey());
  if (!dom) return false;
  const rect = getDecoratorRect(dom);
  if (rect.width <= 0 || click.y < rect.top - 6 || click.y > rect.bottom + 6 || click.x * 2 <= rect.left + rect.right) {
    return false;
  }
  const next = directive.getNextSibling();
  if ($isTextNode(next)) {
    const offset = click.x >= rect.right && next.getTextContent().startsWith(" ") ? 1 : 0;
    next.select(offset, offset);
  } else {
    directive.selectNext(0, 0);
  }
  return true;
}

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
  const focusingFromBridge = useRef(false);
  const pendingClick = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => editor.registerUpdateListener(({ editorState }) => {
    if (focusingFromBridge.current) return;
    editorState.read(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) savedSelection.current = selection.clone();
    });
  }), [editor]);

  /** 聚焦输入框并同步恢复目标选区，避免原生 contenteditable.focus() 把光标重置到行首标签左侧。 */
  const focusWithSelection = useCallback((target: RangeSelection | null) => {
    const root = editor.getRootElement();
    if (!root || !editor.isEditable()) return;
    if (root.ownerDocument.activeElement !== root) {
      focusingFromBridge.current = true;
      try {
        root.focus({ preventScroll: true });
      } finally {
        focusingFromBridge.current = false;
      }
    }
    editor.update(() => $restoreOrSelectEnd(target), { discrete: true });
  }, [editor]);

  /** Menus and selection actions steal focus; insert at the caret the user left, after any selected text. */
  const insertAtCaret = useCallback((insert: () => void) => {
    if (!editor.isEditable()) return;
    const saved = savedSelection.current;
    let nextSelection: RangeSelection | null = null;
    // Chromium 在 setBaseAndExtent 写入新选区时会同步触发 root 的 focus（早于 updateListener），
    // 需在插入提交期间屏蔽 onRootFocus，并直接记录插入后的目标选区。
    focusingFromBridge.current = true;
    try {
      editor.update(() => {
        $restoreOrSelectEnd(saved);
        const selection = $getSelection();
        if ($isRangeSelection(selection) && !selection.isCollapsed()) {
          const [start, end] = selection.isBackward() ? [selection.focus, selection.anchor] : [selection.anchor, selection.focus];
          start.set(end.key, end.offset, end.type);
        }
        insert();
        const after = $getSelection();
        if ($isRangeSelection(after)) nextSelection = after.clone();
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
      if (nextSelection) savedSelection.current = nextSelection;
    } finally {
      focusingFromBridge.current = false;
    }
    focusWithSelection(nextSelection ?? savedSelection.current);
  }, [editor, focusWithSelection]);

  const insertTool = useCallback<InsertComposerTool>((tool) => insertAtCaret(() => $insertComposerTool(tool)), [insertAtCaret]);

  // "Add to chat" sets assistant-ui's composer quote; it becomes a chip where the caret was.
  useEffect(() => {
    if (!quote?.text.trim() || !editor.isEditable()) return;
    aui.composer().setQuote(undefined);
    insertAtCaret(() => $insertComposerQuote(quote.text));
  }, [aui, quote, insertAtCaret]);

  const insertCommand = useCallback<InsertComposerCommand>((command) => {
    if (!editor.isEditable()) return;
    let nextSelection: RangeSelection | null = null;
    focusingFromBridge.current = true;
    try {
      editor.update(() => {
        $insertComposerCommand(command);
        const after = $getSelection();
        if ($isRangeSelection(after)) nextSelection = after.clone();
      }, { discrete: true, tag: HISTORY_PUSH_TAG });
      if (nextSelection) savedSelection.current = nextSelection;
    } finally {
      focusingFromBridge.current = false;
    }
    focusWithSelection(nextSelection ?? savedSelection.current);
  }, [editor, focusWithSelection]);

  useEffect(() => {
    const unregisterKey = editor.registerCommand(KEY_BACKSPACE_COMMAND, (event) => {
      if (editor.isComposing() || event?.isComposing || event?.ctrlKey || event?.altKey || event?.metaKey) return false;
      if (!$deleteComposerToolBackward()) return false;
      event?.preventDefault();
      return true;
    }, COMMAND_PRIORITY_HIGH);
    const unregisterDelete = editor.registerCommand(DELETE_CHARACTER_COMMAND, (backward) =>
      !editor.isComposing() && backward && $deleteComposerToolBackward(), COMMAND_PRIORITY_HIGH);
    const unregisterSelection = editor.registerCommand(SELECTION_CHANGE_COMMAND, () => {
      if (pendingClick.current && $moveSelectionAfterClickedDirective(editor, pendingClick.current)) {
        pendingClick.current = null;
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
    const unregisterClick = editor.registerCommand(CLICK_COMMAND, () => {
      if (pendingClick.current) {
        $moveSelectionAfterClickedDirective(editor, pendingClick.current);
        pendingClick.current = null;
      }
      return false;
    }, COMMAND_PRIORITY_LOW);
    onReady?.(insertTool);
    onCommandReady?.(insertCommand);
    return () => {
      unregisterKey();
      unregisterDelete();
      unregisterSelection();
      unregisterClick();
      onReady?.(null);
      onCommandReady?.(null);
    };
  }, [editor, insertTool, insertCommand, onReady, onCommandReady]);

  // assistant-ui's composer root focuses the input with a plain DOM focus when
  // its blank area (padding, the space below a short draft, gaps between
  // actions) is clicked; a contenteditable then puts the caret at the start.
  // Handle both blank clicks and non-pointer focus (Tab, programmatic focus,
  // window reactivation) so the last caret, or the end of the draft, is kept.
  useEffect(() => editor.registerRootListener((root) => {
    const composer = root?.closest<HTMLElement>(".aui-composer-root");
    if (!root || !composer) return;
    const ownerDoc = root.ownerDocument;
    let pointerInsideRoot = false;
    const onRootPointerDown = () => { pointerInsideRoot = true; };
    const clearPointerInsideRoot = () => { pointerInsideRoot = false; };
    const onRootMouseDown = (event: MouseEvent) => {
      if (!editor.isEditable() || event.button !== 0 || event.shiftKey || event.defaultPrevented) {
        pendingClick.current = null;
        return;
      }
      pendingClick.current = { x: event.clientX, y: event.clientY };
    };
    const clearPendingClick = () => { pendingClick.current = null; };
    const onRootFocus = () => {
      if (!editor.isEditable() || focusingFromBridge.current || pointerInsideRoot) return;
      const target = editor.getEditorState().read(() => {
        const current = $getSelection();
        return $isRangeSelection(current) ? current.clone() : null;
      }) ?? savedSelection.current;
      queueMicrotask(() => {
        if (!editor.isEditable() || pointerInsideRoot || ownerDoc.activeElement !== root) return;
        editor.update(() => $restoreOrSelectEnd(target), { discrete: true });
      });
    };
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!editor.isEditable() || event.button !== 0 || !(target instanceof Element) || root.contains(target)) return;
      const interactive = target.closest(INTERACTIVE);
      if (interactive && composer.contains(interactive)) return;
      // Cancel the default focus, but let popovers observe the outside press.
      event.preventDefault();
      focusWithSelection(savedSelection.current);
    };
    composer.addEventListener("mousedown", onMouseDown);
    root.addEventListener("pointerdown", onRootPointerDown, true);
    root.addEventListener("mousedown", onRootMouseDown);
    root.addEventListener("focus", onRootFocus);
    root.addEventListener("keydown", clearPendingClick);
    root.addEventListener("blur", clearPendingClick);
    ownerDoc.addEventListener("pointerup", clearPointerInsideRoot, true);
    ownerDoc.addEventListener("pointercancel", clearPointerInsideRoot, true);
    return () => {
      composer.removeEventListener("mousedown", onMouseDown);
      root.removeEventListener("pointerdown", onRootPointerDown, true);
      root.removeEventListener("mousedown", onRootMouseDown);
      root.removeEventListener("focus", onRootFocus);
      root.removeEventListener("keydown", clearPendingClick);
      root.removeEventListener("blur", clearPendingClick);
      ownerDoc.removeEventListener("pointerup", clearPointerInsideRoot, true);
      ownerDoc.removeEventListener("pointercancel", clearPointerInsideRoot, true);
    };
  }), [editor, focusWithSelection]);
  return null;
}

const INTERACTIVE = "a, button, input, textarea, select, label, summary, [tabindex], [contenteditable]";
