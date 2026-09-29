import { useCallback, useEffect, useRef, type FC, type RefObject } from "react";
import { useAuiState, useThreadViewportStore } from "@assistant-ui/react";
import { useStore } from "../../store";
import { getThreadScrollState } from "../../lib/thread-scroll-state";

interface ThreadScrollFollowerProps {
  contentRef: RefObject<HTMLElement | null>;
}

export const ThreadScrollFollower: FC<ThreadScrollFollowerProps> = ({ contentRef }) => {
  const currentSessionId = useStore((state) => state.currentSessionId);
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const messageCount = useAuiState((s) => s.thread.messages.length);
  const threadViewportStore = useThreadViewportStore();

  const isFollowingBottomRef = useRef(true);
  const programmaticScrollRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastContentHeightRef = useRef(0);

  const getViewport = useCallback(() => {
    return threadViewportStore.getState().element.viewport;
  }, [threadViewportStore]);

  const isAtBottom = useCallback((viewport: HTMLElement) => {
    return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 48;
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

  // Handle wheel events: detect if user deliberately scrolled up
  useEffect(() => {
    const vp = getViewport();
    if (!vp) return;

    const handleWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) {
        // User scrolled up: pause auto-following
        isFollowingBottomRef.current = false;
      } else if (e.deltaY > 0) {
        // User scrolled down: if near bottom, resume following
        if (isAtBottom(vp)) {
          isFollowingBottomRef.current = true;
        }
      }
    };

    const handleTouchMove = () => {
      if (isAtBottom(vp)) {
        isFollowingBottomRef.current = true;
      }
    };

    vp.addEventListener("wheel", handleWheel, { passive: true });
    vp.addEventListener("touchmove", handleTouchMove, { passive: true });

    return () => {
      vp.removeEventListener("wheel", handleWheel);
      vp.removeEventListener("touchmove", handleTouchMove);
    };
  }, [getViewport, isAtBottom]);

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

      if (isAtBottom(vp)) {
        isFollowingBottomRef.current = true;
      } else if (currentScrollTop < lastScrollTopRef.current - 10) {
        // User scrolled up by more than 10px: pause following
        isFollowingBottomRef.current = false;
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    vp.addEventListener("scroll", handleScroll, { passive: true });
    return () => vp.removeEventListener("scroll", handleScroll);
  }, [getViewport, isAtBottom]);

  // Restore and persist scroll position per conversation
  useEffect(() => {
    const vp = getViewport();
    const state = getThreadScrollState(currentSessionId);

    if (vp && state?.current && typeof state.current.scrollTop === "number") {
      programmaticScrollRef.current = true;
      vp.scrollTo({ top: state.current.scrollTop, behavior: "instant" });
      lastScrollTopRef.current = state.current.scrollTop;
      isFollowingBottomRef.current = isAtBottom(vp);
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
  }, [currentSessionId, getViewport, isAtBottom]);

  // When run starts or new messages appear: ensure follow mode is active
  useEffect(() => {
    if (isRunning) {
      isFollowingBottomRef.current = true;
      scrollToBottom("instant");
    }
  }, [isRunning, scrollToBottom]);

  useEffect(() => {
    isFollowingBottomRef.current = true;
    scrollToBottom("instant");
  }, [messageCount, scrollToBottom]);

  // Listen for content height changes with ResizeObserver (handles tool expansions, collapsible triggers, markdown streams)
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    lastContentHeightRef.current = contentEl.scrollHeight;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? contentEl.scrollHeight;
        if (height !== lastContentHeightRef.current) {
          lastContentHeightRef.current = height;
          if (isFollowingBottomRef.current) {
            scrollToBottom("instant");
          }
        }
      }
    });

    resizeObserver.observe(contentEl);
    return () => resizeObserver.disconnect();
  }, [contentRef, scrollToBottom]);

  // Also listen on threadViewport onScrollToBottom (e.g. clicking the "Scroll to bottom" button)
  useEffect(() => {
    const unsubscribe = threadViewportStore.getState().onScrollToBottom(({ behavior }) => {
      isFollowingBottomRef.current = true;
      scrollToBottom(behavior);
    });
    return unsubscribe;
  }, [threadViewportStore, scrollToBottom]);

  return null;
};
