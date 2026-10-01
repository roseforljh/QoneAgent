import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type FC, type ReactNode, type RefObject } from "react";
import { useAuiState, useThreadViewport, useThreadViewportStore } from "@assistant-ui/react";
import { useConversationStore } from "../../lib/conversation-context";
import { getThreadScrollState } from "../../lib/thread-scroll-state";
import { mountThreadScrollController, type ThreadScrollTurn } from "../../lib/thread-scroll-controller";
import { threadPhase } from "../../lib/thread-scroll-policy";
export { userMessageRevealScrollTop } from "../../lib/thread-scroll-policy";

// Kept as a small public predicate for existing scroll tests and integrations.
export const shouldFollowThreadContent = (running: boolean, followingBottom: boolean, topAnchorActive: boolean, contentBottom: number, availableBottom: number) =>
  running && followingBottom && !topAnchorActive && contentBottom > availableBottom + 8;

interface ThreadBottomControl { show: boolean; scrollToBottom: () => void }
const ThreadBottomContext = createContext<ThreadBottomControl | null>(null);

export function useThreadBottomControl() {
  const control = useContext(ThreadBottomContext);
  if (!control) throw new Error("Thread bottom navigation requires ThreadScrollFollower");
  return control;
}

/** Share the scroll owner with footer navigation; the primitive owns top anchoring/restoration. */
export const ThreadScrollFollower: FC<{ contentRef: RefObject<HTMLElement | null>; children: ReactNode }> = ({ contentRef, children }) => {
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const running = useAuiState((state) => state.thread.isRunning);
  const phase = useAuiState((state) => threadPhase(state.thread.isRunning, state.thread.messages));
  const turnId = useAuiState((state) => [...state.thread.messages].reverse().find((message) => message.role === "user")?.id);
  const viewportStore = useThreadViewportStore();
  const controller = useRef<ReturnType<typeof mountThreadScrollController> | null>(null);
  const currentTurn = useRef<ThreadScrollTurn>({ turnId, running, phase });
  currentTurn.current = { turnId, running, phase };
  const previousTurn = useRef({ sessionId, turnId });
  const [controllerShow, setControllerShow] = useState(false);
  // assistant-ui updates this store when its viewport ref and footer inset are
  // registered. It is the safe fallback during the first layout measurement.
  const isAtBottom = useThreadViewport((state) => state.isAtBottom);
  const show = controllerShow || !isAtBottom;

  useLayoutEffect(() => {
    const viewport = viewportStore.getState().element.viewport;
    const content = contentRef.current;
    const footer = viewport?.querySelector<HTMLElement>("[data-thread-scroll-footer]");
    if (!viewport || !content || !footer) return;
    const restoration = getThreadScrollState(sessionId);
    const owner = mountThreadScrollController({
      viewport, content, footer,
      endContent: viewport.querySelector<HTMLElement>("[data-thread-end-content]"),
      turn: currentTurn.current,
      restored: restoration?.follow,
      hasRestoration: restoration?.current != null,
      onVisibility: setControllerShow,
      onSave: (follow) => { if (restoration) restoration.follow = follow; },
    });
    controller.current = owner;
    const unsubscribe = viewportStore.getState().onScrollToBottom(owner.scrollToBottom);
    return () => {
      unsubscribe();
      owner.dispose();
      if (controller.current === owner) controller.current = null;
    };
  }, [contentRef, sessionId, viewportStore]);

  useLayoutEffect(() => {
    controller.current?.sync({ turnId, running, phase });
  }, [turnId, running, phase]);

  // Sending can precede agent.started, particularly in a narrowed side conversation.
  useLayoutEffect(() => {
    const previous = previousTurn.current;
    previousTurn.current = { sessionId, turnId };
    if (previous.sessionId !== sessionId || previous.turnId === turnId || !turnId) return;
    const message = [...(contentRef.current?.querySelectorAll<HTMLElement>(".q-message-user[data-message-id]") ?? [])]
      .find((element) => element.dataset.messageId === turnId);
    if (message) controller.current?.reveal(message);
  }, [sessionId, turnId, contentRef]);

  const scrollToBottom = useCallback(() => {
    if (controller.current) controller.current.scrollToBottom();
    else viewportStore.getState().scrollToBottom({ behavior: "instant" });
  }, [viewportStore]);
  const control = useMemo(() => ({ show, scrollToBottom }), [show, scrollToBottom]);
  return <ThreadBottomContext.Provider value={control}>{children}</ThreadBottomContext.Provider>;
};
