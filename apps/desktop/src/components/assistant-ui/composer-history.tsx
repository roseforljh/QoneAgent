import { useConversationStore } from "../../lib/conversation-context";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAui } from "@assistant-ui/react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import {
  $getRoot,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  type LexicalEditor,
} from "lexical";
import { getCombinedComposerHistory } from "../../lib/composer-history";

/**
 * 获取折叠选区在纯文本运行时的字符偏移量
 */
function $getCollapsedOffset(): number | undefined {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return undefined;
  }
  const anchor = selection.anchor;
  let offset = 0;
  const paragraphs = $getRoot().getChildren();
  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i];
    if (!$isElementNode(paragraph)) continue;
    if (anchor.type === "element" && anchor.key === paragraph.getKey()) {
      const children = paragraph.getChildren();
      const childIndex = Math.min(anchor.offset, children.length);
      for (let c = 0; c < childIndex; c++) {
        offset += children[c]!.getTextContent().length;
      }
      return offset;
    }
    for (const child of paragraph.getChildren()) {
      if (anchor.key === child.getKey()) {
        return offset + (anchor.type === "text" ? anchor.offset : 0);
      }
      offset += child.getTextContent().length;
    }
    if (i < paragraphs.length - 1) offset += 1;
  }
  return undefined;
}

/**
 * 判断当前光标和内容状态是否可以触发向上回溯
 */
function canTriggerHistoryUp(editor: LexicalEditor, currentText: string): boolean {
  // 1. 空白或空内容，直接可以回溯
  if (!currentText || currentText.trim().length === 0) {
    return true;
  }

  // 2. 检查选区位置：如果在整个文档的最开始（offset === 0）或全选，可以回溯
  let atStart = false;
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      if (selection.isCollapsed()) {
        const offset = $getCollapsedOffset();
        if (offset === 0) atStart = true;
      } else {
        const full = $getRoot().getTextContent();
        if (selection.getTextContent() === full) {
          atStart = true;
        }
      }
    }
  });

  if (atStart) return true;

  // 3. 单行文本中（没有换行符），在任意位置单击上方向键均触发回溯，并将当前输入作为草稿保存
  if (!currentText.includes("\n")) {
    return true;
  }

  return false;
}

/**
 * 监听键盘上、下方向键，在输入框中回溯历史发送消息及恢复草稿
 */
export function ComposerHistoryPlugin({ menuOpen }: { menuOpen: boolean }) {
  const [editor] = useLexicalComposerContext();
  const aui = useAui();

  const sessionId = useConversationStore((state) => state.currentSessionId);
  const messages = useConversationStore((state) => state.messages);
  const editingQueueItem = useConversationStore((state) => state.editingQueueItem);

  const historyIndexRef = useRef<number>(-1);
  const savedDraftRef = useRef<string>("");
  const isApplyingHistoryRef = useRef<boolean>(false);
  const lastAppliedTextRef = useRef<string | null>(null);

  // 提取当前会话中的历史用户消息
  const sessionUserMessages = useMemo(() => {
    return messages
      .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.trim().length > 0)
      .map((m) => m.content);
  }, [messages]);

  // 会话切换时重置回溯状态
  useEffect(() => {
    historyIndexRef.current = -1;
    savedDraftRef.current = "";
    lastAppliedTextRef.current = null;
  }, [sessionId]);

  // 监听发送开始事件，重置回溯指针
  useEffect(() => {
    return aui.on("thread.runStart", () => {
      historyIndexRef.current = -1;
      savedDraftRef.current = "";
      lastAppliedTextRef.current = null;
    });
  }, [aui]);

  // 将选中的历史消息应用到输入框，并将光标移动到末尾
  const applyHistory = useCallback((text: string) => {
    isApplyingHistoryRef.current = true;
    lastAppliedTextRef.current = text;
    aui.composer.setText(text);

    editor.update(() => {
      $getRoot().selectEnd();
    });
    editor.focus();

    // 在下一帧复位标志
    requestAnimationFrame(() => {
      isApplyingHistoryRef.current = false;
    });
  }, [aui, editor]);

  // 监听文本变化，如果用户在翻出历史后进行了手动编辑，退出纯浏览状态
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves, tags }) => {
      // 忽略 assistant-ui 内部同步引发的变更
      if (tags.has("aui-sync") || isApplyingHistoryRef.current) return;
      if (dirtyElements.size === 0 && dirtyLeaves.size === 0) return;

      editorState.read(() => {
        const currentText = $getRoot().getTextContent();
        if (
          historyIndexRef.current !== -1 &&
          lastAppliedTextRef.current !== null &&
          currentText !== lastAppliedTextRef.current
        ) {
          // 用户手动修改了内容，当前修改成为新的草稿，退出历史索引
          historyIndexRef.current = -1;
          savedDraftRef.current = currentText;
          lastAppliedTextRef.current = null;
        }
      });
    });
  }, [editor]);

  // 注册键盘命令
  useEffect(() => {
    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (!event || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return false;
        }
        if (menuOpen || editingQueueItem) return false;

        const history = getCombinedComposerHistory(sessionId, sessionUserMessages);
        if (history.length === 0) return false;

        // 已经处于回溯模式中
        if (historyIndexRef.current !== -1) {
          event.preventDefault();
          if (historyIndexRef.current > 0) {
            historyIndexRef.current -= 1;
            applyHistory(history[historyIndexRef.current]);
          }
          return true;
        }

        // 未处于回溯模式中，检测是否满足回溯条件
        const currentText = aui.composer.getState().text;
        if (!canTriggerHistoryUp(editor, currentText)) {
          return false;
        }

        event.preventDefault();
        savedDraftRef.current = currentText;
        historyIndexRef.current = history.length - 1;
        applyHistory(history[historyIndexRef.current]);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (!event || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return false;
        }
        if (menuOpen || editingQueueItem) return false;

        // 如果未处于回溯模式，放行下方向键原生行为
        if (historyIndexRef.current === -1) {
          return false;
        }

        const history = getCombinedComposerHistory(sessionId, sessionUserMessages);
        event.preventDefault();

        // 如果还可以继续向前翻到更新的历史
        if (historyIndexRef.current < history.length - 1) {
          historyIndexRef.current += 1;
          applyHistory(history[historyIndexRef.current]);
          return true;
        }

        // 已经到达最新的一条历史记录，再次按下下方向键时恢复用户原草稿
        historyIndexRef.current = -1;
        const draft = savedDraftRef.current;
        savedDraftRef.current = "";
        applyHistory(draft);
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        // 如果处于历史回溯模式，按 Escape 键恢复草稿并退出回溯
        if (historyIndexRef.current !== -1) {
          historyIndexRef.current = -1;
          const draft = savedDraftRef.current;
          savedDraftRef.current = "";
          applyHistory(draft);
          event?.preventDefault();
          return true;
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        if (!event || event.isComposing || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
          return false;
        }
        // 普通回车发送时，重置回溯指针
        historyIndexRef.current = -1;
        savedDraftRef.current = "";
        lastAppliedTextRef.current = null;
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    return () => {
      unregisterUp();
      unregisterDown();
      unregisterEscape();
      unregisterEnter();
    };
  }, [applyHistory, aui, editingQueueItem, editor, menuOpen, sessionUserMessages]);

  return null;
}
