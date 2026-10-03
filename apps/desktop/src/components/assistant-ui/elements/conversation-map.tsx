"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { BookmarkIcon } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { useLocale } from "../../../localization";
import { cn } from "../../../lib/utils";
import { clamp } from "../utils/range";
import "./conversation-map.css";

export interface ConversationMapEntry { id: string; title: string; preview?: string }

const TICK = '[data-slot="conversation-map-tick"]';
// Codex Pli/$li. These are interaction delays, not an idle-hide timer.
const PREVIEW_OPEN_DELAY = 250;
const PREVIEW_LEAVE_DELAY = 100;
const bookmarkKey = (sessionId: string) => `qone:conversation-bookmarks:${sessionId}`;

function readBookmarks(sessionId?: string): Set<string> {
  if (!sessionId || typeof window === "undefined") return new Set();
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(bookmarkKey(sessionId)) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}

function saveBookmarks(sessionId: string, ids: ReadonlySet<string>) {
  try {
    if (ids.size) window.localStorage.setItem(bookmarkKey(sessionId), JSON.stringify([...ids]));
    else window.localStorage.removeItem(bookmarkKey(sessionId));
  } catch { /* The current view still retains the bookmark if storage is unavailable. */ }
}

type ConversationMapProps = Omit<ComponentProps<"nav">, "children" | "onSelect"> & {
  entries: readonly ConversationMapEntry[];
  activeId?: string;
  visibleIds?: readonly string[];
  onSelect?: (id: string, behavior?: ScrollBehavior) => void;
  side?: "left" | "right";
  sessionId?: string;
  renderPreview?: (entry: ConversationMapEntry) => ReactNode;
};

export function ConversationMap(props: ConversationMapProps) {
  if (props.entries.length < 4) return null;
  return <ConversationMapContent key={props.sessionId} {...props} />;
}

function ConversationMapContent({ entries, activeId, visibleIds, onSelect, side = "right", sessionId, renderPreview, className, onKeyDown, ...props }: ConversationMapProps) {
  const { t } = useLocale();
  const railRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const scrubRef = useRef<{ pointerId: number; lastId: string; captureTarget: HTMLElement } | null>(null);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const previewLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const windowFocusedRef = useRef(true);
  const previewId = useId();
  const [scrubbedId, setScrubbedId] = useState<string | null>(null);
  const [scrollable, setScrollable] = useState(false);
  const [handle] = useState(() => PreviewCard.createHandle<ConversationMapEntry>());
  const [previewOpen, setPreviewOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [bookmarkState, setBookmarkState] = useState(() => ({ sessionId, ids: readBookmarks(sessionId) }));
  const bookmarkedIds = bookmarkState.sessionId === sessionId ? bookmarkState.ids : readBookmarks(sessionId);
  const activeIndex = entries.findIndex((entry) => entry.id === activeId);
  const scrubbedIndex = entries.findIndex((entry) => entry.id === scrubbedId);
  const visibleSet = useMemo(() => new Set(visibleIds), [visibleIds]);
  const tabbableIndex = clamp(focusedIndex ?? Math.max(0, activeIndex), 0, Math.max(0, entries.length - 1));

  const toggleBookmark = useCallback((id: string) => {
    if (!sessionId) return;
    const next = new Set(bookmarkedIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveBookmarks(sessionId, next);
    setBookmarkState({ sessionId, ids: next });
  }, [bookmarkedIds, sessionId]);

  const endScrub = useCallback(() => {
    const scrub = scrubRef.current;
    if (!scrub) return;
    scrubRef.current = null;
    setScrubbedId(null);
    if (scrub.captureTarget.hasPointerCapture(scrub.pointerId)) scrub.captureTarget.releasePointerCapture(scrub.pointerId);
  }, []);

  const cancelPreviewLeave = useCallback(() => {
    clearTimeout(previewLeaveTimerRef.current);
    previewLeaveTimerRef.current = undefined;
  }, []);

  useEffect(() => {
    const dismiss = () => {
      windowFocusedRef.current = false;
      cancelPreviewLeave();
      endScrub();
      // Also cancels Base UI's pending hover opening, even before it is visible.
      handle.close();
    };
    const focus = () => { windowFocusedRef.current = true; };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelPreviewLeave();
        handle.close();
      }
    };
    window.addEventListener("blur", dismiss);
    window.addEventListener("focus", focus);
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("focus", focus);
      window.removeEventListener("keydown", escape, true);
      endScrub();
      clearTimeout(suppressClickTimerRef.current);
      cancelPreviewLeave();
    };
  }, [endScrub, handle, cancelPreviewLeave]);

  useEffect(() => {
    if (scrubRef.current) return;
    const list = listRef.current;
    const tick = list?.querySelectorAll<HTMLElement>(TICK)[activeIndex];
    if (!list || !tick) return;
    if (tick.offsetTop < list.scrollTop) list.scrollTop = tick.offsetTop;
    else if (tick.offsetTop + tick.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = tick.offsetTop + tick.offsetHeight - list.clientHeight;
  }, [activeIndex, entries.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => setScrollable(list.scrollHeight > list.clientHeight);
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    measure();
    return () => observer.disconnect();
  }, [entries.length]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const ticks = railRef.current?.querySelectorAll<HTMLElement>(TICK);
    if (!ticks?.length) return;
    const current = Array.prototype.indexOf.call(ticks, event.target);
    if (current === -1) return;
    const next = { ArrowUp: current - 1, ArrowDown: current + 1, Home: 0, End: ticks.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    ticks[clamp(next, 0, ticks.length - 1)]?.focus();
  }, [onKeyDown]);

  const tickAt = (element: Element | null) => {
    const tick = element?.closest<HTMLElement>(TICK);
    return tick && listRef.current?.contains(tick) ? tick : null;
  };

  const stopScrub = (event: PointerEvent<HTMLDivElement>) => {
    const scrub = scrubRef.current;
    if (scrub?.pointerId !== event.pointerId) return;
    endScrub();
    const bounds = listRef.current?.getBoundingClientRect();
    if (event.type === "pointercancel" || !bounds || event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) handle.close();
    clearTimeout(suppressClickTimerRef.current);
    suppressClickTimerRef.current = setTimeout(() => { suppressClickRef.current = false; }, 0);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const tick = tickAt(event.target instanceof Element ? event.target : null);
    const id = tick?.dataset["entryId"];
    if (!tick || !id) return;
    cancelPreviewLeave();
    clearTimeout(suppressClickTimerRef.current);
    suppressClickRef.current = false;
    scrubRef.current = { pointerId: event.pointerId, lastId: id, captureTarget: tick };
    setScrubbedId(id);
    handle.open(tick.id);
    tick.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const scrub = scrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    if (!(event.buttons & 1)) { stopScrub(event); return; }
    const list = listRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, clamp(event.clientY, bounds.top + 1, bounds.bottom - 1));
    const tick = tickAt(target);
    const id = tick?.dataset["entryId"];
    if (!tick || !id || id === scrub.lastId) return;
    scrub.lastId = id;
    suppressClickRef.current = true;
    setScrubbedId(id);
    handle.open(tick.id);
    onSelect?.(id, "instant");
  };

  return <nav ref={railRef} aria-label={t("chat.conversationMapLabel")} onKeyDown={handleKeyDown} className={cn("q-conversation-nav", className)} {...props}>
    <div ref={listRef} className="q-conversation-list" data-scrubbing={scrubbedId !== null ? "" : undefined} data-scrollable={scrollable ? "" : undefined}
      onPointerEnter={cancelPreviewLeave}
      onPointerDownCapture={onPointerDown} onPointerMove={onPointerMove} onPointerUp={stopScrub} onPointerCancel={stopScrub} onLostPointerCapture={stopScrub}>
      {entries.map((entry, index) => {
        const current = index === activeIndex;
        const bookmarked = bookmarkedIds.has(entry.id);
        const distance = scrubbedIndex < 0 ? -1 : Math.abs(scrubbedIndex - index);
        return <PreviewCard.Trigger key={entry.id} id={`${previewId}-${entry.id}`} handle={handle} payload={entry} delay={PREVIEW_OPEN_DELAY} closeDelay={PREVIEW_LEAVE_DELAY} render={<button type="button" />}
          data-slot="conversation-map-tick" data-entry-id={entry.id} data-active={current ? "" : undefined}
          data-in-view={current || visibleSet.has(entry.id) ? "" : undefined} data-scrub-target={scrubbedId === entry.id ? "" : undefined}
          data-neighbor-distance={distance > 0 && distance <= 3 ? distance : undefined}
          aria-label={t(bookmarked ? "chat.conversationMapJumpBookmarked" : "chat.conversationMapJump", { position: index + 1 })}
          aria-current={current ? "true" : undefined} tabIndex={index === tabbableIndex ? 0 : -1}
          onFocus={(event) => { cancelPreviewLeave(); setFocusedIndex(index); handle.open(event.currentTarget.id); }}
          onClick={(event) => { if (!suppressClickRef.current) { cancelPreviewLeave(); handle.open(event.currentTarget.id); onSelect?.(entry.id); } }}
          onContextMenu={() => handle.close()}
          className="q-conversation-tick">
          <span className="q-conversation-marker"><span className="q-conversation-marker-line" />{bookmarked && <span className="q-conversation-bookmark-dot" aria-hidden />}</span>
        </PreviewCard.Trigger>;
      })}
    </div>
    <PreviewCard.Root handle={handle} open={previewOpen} onOpenChange={(open, details) => {
      // Captured scrubbing keeps the preview open until that gesture ends.
      if (open ? !windowFocusedRef.current : scrubRef.current !== null) { details.cancel(); return; }
      cancelPreviewLeave();
      setPreviewOpen(open);
    }}>{({ payload }) => <PreviewCard.Portal>
      <PreviewCard.Positioner side={side} sideOffset={0}>
        <PreviewCard.Popup className="q-conversation-preview" onPointerEnter={cancelPreviewLeave}
          onPointerLeave={(event) => {
            cancelPreviewLeave();
            if (event.relatedTarget instanceof Node && railRef.current?.contains(event.relatedTarget)) return;
            // Base UI only closes hover-opened popups here; handle.open (scrub/click/focus)
            // needs the same leave lifecycle. sideOffset=0 keeps popup and ticks adjacent.
            previewLeaveTimerRef.current = setTimeout(() => { previewLeaveTimerRef.current = undefined; handle.close(); }, PREVIEW_LEAVE_DELAY);
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget) && !railRef.current?.contains(event.relatedTarget)) {
              cancelPreviewLeave();
              handle.close();
            }
          }}>
          <div className="q-conversation-preview-heading">
            <span className="q-conversation-preview-title">{payload?.title || t("chat.conversationMapEmpty")}</span>
            {payload && sessionId && <button type="button" className="q-conversation-bookmark-button"
              aria-label={t(bookmarkedIds.has(payload.id) ? "chat.conversationMapRemoveBookmark" : "chat.conversationMapBookmark")}
              aria-pressed={bookmarkedIds.has(payload.id)} onClick={(event) => { event.stopPropagation(); toggleBookmark(payload.id); }}>
              <BookmarkIcon size={16} strokeWidth={1.7} fill={bookmarkedIds.has(payload.id) ? "currentColor" : "none"} />
            </button>}
          </div>
          {payload && (renderPreview ? renderPreview(payload) : payload.preview && <div className="q-conversation-preview-body"><ReactMarkdown skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ children }) => <span>{children}</span> }}>{payload.preview}</ReactMarkdown></div>)}
        </PreviewCard.Popup>
      </PreviewCard.Positioner>
    </PreviewCard.Portal>}</PreviewCard.Root>
  </nav>;
}
