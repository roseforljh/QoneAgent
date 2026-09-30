import { useCallback, useEffect, useLayoutEffect, useRef, type FC, type RefObject } from "react";
import { useAuiState, useThreadViewportStore } from "@assistant-ui/react";
import { useStore } from "../../store";
import { getThreadScrollState } from "../../lib/thread-scroll-state";

interface ThreadScrollFollowerProps {
  contentRef: RefObject<HTMLElement | null>;
}

export const shouldFollowThreadContent = (running: boolean, followingBottom: boolean, topAnchorActive: boolean, contentBottom: number, availableBottom: number) =>
  running && followingBottom && !topAnchorActive && contentBottom > availableBottom + 8;

export const userMessageRevealScrollTop = (
  scrollTop: number,
  messageTop: number,
  messageBottom: number,
  visibleTop: number,
  visibleBottom: number,
) => {
  if (messageTop < visibleTop || messageBottom - messageTop > visibleBottom - visibleTop) {
    return scrollTop + messageTop - visibleTop;
  }
  if (messageBottom > visibleBottom) return scrollTop + messageBottom - visibleBottom;
  return null;
};

export const ThreadScrollFollower: FC<ThreadScrollFollowerProps> = ({ contentRef }) => {
  const currentSessionId = useStore((state) => state.currentSessionId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const latestUserMessageId = useAuiState((s) => {
    const last = s.thread.messages.at(-1);
    const previous = s.thread.messages.at(-2);
    return (last?.role === "user" ? last : previous?.role === "user" ? previous : undefined)?.id;
  });
  const threadViewportStore = useThreadViewportStore();

  const previousUserMessageRef = useRef({ sessionId: currentSessionId, messageId: latestUserMessageId });
  const isFollowingBottomRef = useRef(true);
  const topAnchorActiveRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastContentHeightRef = useRef(0);

  const getViewport = useCallback(() => {
    return threadViewportStore.getState().element.viewport;
  }, [threadViewportStore]);

  const isNearBottom = useCallback((viewport: HTMLElement) => {
    return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 64;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "instant") => {
    const vp = getViewport();
    if (!vp) return;
    programmaticScrollRef.current = true;
    vp.scrollTo({ top: vp.scrollHeight, behavior });
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      if (vp) lastScrollTopRef.current = vp.scrollTop;
    });
  }, [getViewport]);

  // A submitted user message can precede agent.started. Reveal it immediately,
  // even when a side panel has reduced the viewport and bottom following is idle.
  useLayoutEffect(() => {
    const previous = previousUserMessageRef.current;
    previousUserMessageRef.current = { sessionId: currentSessionId, messageId: latestUserMessageId };
    if (previous.sessionId !== currentSessionId || previous.messageId === latestUserMessageId || !latestUserMessageId) return;

    const viewport = getViewport();
    const content = contentRef.current;
    const message = [...(content?.querySelectorAll<HTMLElement>(".q-message-user[data-message-id]") ?? [])]
      .find((element) => element.dataset.messageId === latestUserMessageId);
    if (!viewport || !message) return;

    const viewportRect = viewport.getBoundingClientRect();
    const footerTop = viewport.querySelector(".q-chat-footer")?.getBoundingClientRect().top ?? viewportRect.bottom;
    const messageRect = message.getBoundingClientRect();
    const target = userMessageRevealScrollTop(
      viewport.scrollTop, messageRect.top, messageRect.bottom, viewportRect.top, footerTop,
    );
    if (target === null) return;
    programmaticScrollRef.current = true;
    viewport.scrollTo({ top: target, behavior: "instant" });
    requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
      lastScrollTopRef.current = viewport.scrollTop;
    });
  }, [currentSessionId, latestUserMessageId, contentRef, getViewport]);

  // Handle wheel events: detect if user deliberately scrolled up to read history
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolled up: pause auto-following
        isFollowingBottomRef.current = false;
      } else if (e.deltaY > 0) {
        // User scrolled down: resume following if near bottom
        if (isNearBottom(vp)) {
          topAnchorActiveRef.current = false;
          isFollowingBottomRef.current = true;
        }
      }
    };

    const handleTouchMove = () => {
      if (isNearBottom(vp)) {
        topAnchorActiveRef.current = false;
        isFollowingBottomRef.current = true;
      }
    };

    vp.addEventListener("wheel", handleWheel, { passive: true });
    vp.addEventListener("touchmove", handleTouchMove, { passive: true });

    return () => {
      vp.removeEventListener("wheel", handleWheel);
      vp.removeEventListener("touchmove", handleTouchMove);
    };
  }, [getViewport, isNearBottom]);

  // Handle scroll events: check scroll direction and bottom proximity
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;

    lastScrollTopRef.current = vp.scrollTop;

    const handleScroll = () => {
      const currentScrollTop = vp.scrollTop;

      if (programmaticScrollRef.current) {
        lastScrollTopRef.current = currentScrollTop;
        return;
      }

      if (!topAnchorActiveRef.current && isNearBottom(vp)) {
        isFollowingBottomRef.current = true;
      } else if (currentScrollTop < lastScrollTopRef.current - 12) {
        // User scrolled up by more than 12px: pause following
        isFollowingBottomRef.current = false;
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    vp.addEventListener("scroll", handleScroll, { passive: true });
    return () => vp.removeEventListener("scroll", handleScroll);
  }, [getViewport, isNearBottom]);

  // Restore and persist scroll position per conversation
  useEffect(() => {
    const vp = getViewport();
    const state = getThreadScrollState(currentSessionId);

    if (vp && state?.current && typeof state.current.scrollTop === "number") {
      programmaticScrollRef.current = true;
      vp.scrollTo({ top: state.current.scrollTop, behavior: "instant" });
      lastScrollTopRef.current = state.current.scrollTop;
      isFollowingBottomRef.current = isNearBottom(vp);
      requestAnimationFrame(() => {
        programmaticScrollRef.current = false;
      });
    } else if (vp) {
      isFollowingBottomRef.current = true;
    }

    return () => {
      const currentVp = getViewport();
      if (currentVp && state) {
        state.current = {
          scrollTop: currentVp.scrollTop,
          topAnchorTurn: null,
        };
      }
    };
  }, [currentSessionId, getViewport, isNearBottom]);

  // A new turn stays anchored at its user message until the user follows it.
  useEffect(() => {
    if (isRunning) {
      topAnchorActiveRef.current = true;
      isFollowingBottomRef.current = false;
    }
  }, [isRunning]);

  // Pause auto-following when user interacts with collapsible execution details
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;

    const handlePointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-slot="collapsible"], [data-slot="collapsible-trigger"], [data-slot="assistant-execution"], [data-slot="tool-timeline"], [data-slot="tool-call"], [data-slot="reasoning"], [data-slot="sources"]')) {
        isFollowingBottomRef.current = false;
      }
    };

    vp.addEventListener("pointerdown", handlePointerDown, { passive: true });
    return () => vp.removeEventListener("pointerdown", handlePointerDown);
  }, [getViewport]);

  // Listen for content height changes with ResizeObserver.
  // CRITICAL: Respect initial top-anchoring of new user messages.
  // Only scroll down when content actually overflows the visible area of the viewport.
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    lastContentHeightRef.current = contentEl.scrollHeight;

    const checkAndFollowBottom = () => {
      const vp = getViewport();
      if (!vp) return;

      const vpRect = vp.getBoundingClientRect();
      const footer = vp.querySelector(".q-chat-footer");
      const footerRect = footer?.getBoundingClientRect();
      const availableBottom = footerRect ? footerRect.top : vpRect.bottom;
      const contentBottom = contentEl.getBoundingClientRect().bottom;

      // Only scroll when content actually exceeds the available viewport area (plus a small threshold)
      if (shouldFollowThreadContent(isRunning, isFollowingBottomRef.current, topAnchorActiveRef.current, contentBottom, availableBottom)) {
        scrollToBottom("instant");
      }
    };

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? contentEl.scrollHeight;
        if (height !== lastContentHeightRef.current) {
          lastContentHeightRef.current = height;
          checkAndFollowBottom();
        }
      }
    });

    resizeObserver.observe(contentEl);
    return () => resizeObserver.disconnect();
  }, [contentRef, getViewport, scrollToBottom, isRunning]);

  // Also listen on threadViewport onScrollToBottom (e.g. clicking the "Scroll to bottom" button)
  useEffect(() => {
    const unsubscribe = threadViewportStore.getState().onScrollToBottom(({ behavior }) => {
      topAnchorActiveRef.current = false;
      isFollowingBottomRef.current = true;
      scrollToBottom(behavior);
    });
    return unsubscribe;
  }, [threadViewportStore, scrollToBottom]);

  return null;
};
