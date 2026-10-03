"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAuiState, useThreadViewport } from "@assistant-ui/react";
import type { ThreadMessage } from "@assistant-ui/react";
import { cn } from "../../../lib/utils";
import { useStore } from "../../../store";
import { hasConversationRailSpaceInViewport } from "../../../lib/conversation-rail-layout";
import { observeConversationRail } from "../../../lib/conversation-rail-observer";
import { ConversationMap, type ConversationMapEntry } from "./conversation-map";
import { createMessageStructureSelector } from "../../../lib/thread-message-structure";
import ReactMarkdown from "react-markdown";

const TOP_TOLERANCE = 1;

/** Use the viewport's own top inset for both navigation and the active tick. */
const visibleTop = (viewport: HTMLElement) => {
  const view = viewport.getBoundingClientRect();
  const inset = Number.parseFloat(getComputedStyle(viewport).scrollPaddingTop) || 0;
  return Math.min(view.bottom, view.top + inset);
};

const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * The line a message has to cross to count as the one being read. It sits at
 * the top of the viewport for most of a thread, then slides to the bottom
 * across the final screenful: a message that starts within one viewport height
 * of the end can never reach the top, so a fixed line leaves the last screen's
 * worth of ticks permanently unreachable.
 */

const partsOf = (message: ThreadMessage) => [...message.content];

const messageText = new WeakMap<ThreadMessage, string>();
const textOf = (message: ThreadMessage) => {
  const cached = messageText.get(message);
  if (cached !== undefined) return cached;
  const text = partsOf(message)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
  messageText.set(message, text);
  return text;
};

const labelOf = (message: ThreadMessage) => {
  const parts = partsOf(message);
  const tools = parts.flatMap((part) =>
    part.type === "tool-call" ? [part.toolName] : [],
  );
  if (tools.length === 1) return tools[0]!;
  if (tools.length > 1) return `${tools.length} tool calls`;
  // A composer submission carries its files in `attachments` and leaves
  // `content` empty, so both places decide an attachment-only turn's label.
  const carriers = [...parts, ...(message.attachments ?? [])];
  if (carriers.some((carrier) => carrier.type === "image")) return "Image";
  if (carriers.some((carrier) => carrier.type === "file")) return "File";
  if (carriers.length > 0) return "Attachment";
  return message.role === "user" ? "Message" : "Response";
};

const linesOf = (message: ThreadMessage) =>
  textOf(message)
    .split("\n")
    .map((line) => line.replace(/^[\s#>*`-]+/, "").trim())
    .filter(Boolean);

/** A user message and the assistant messages answering it. */
type Turn = {
  head: ThreadMessage;
  members: ThreadMessage[];
};

const groupIntoTurns = (messages: readonly ThreadMessage[]) => {
  const turns: Turn[] = [];

  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;

    const current = turns.at(-1);
    if (message.role === "user") {
      turns.push({ head: message, members: [message] });
      continue;
    }
    if (!current) continue;
    current.members.push(message);
  }

  return turns;
};

const describe = ({ head, members }: Turn): ConversationMapEntry => {
  const lines = linesOf(head);
  const first = lines[0] ?? "";
  const title = first;

  // What the turn asked names it; what it answered is the useful preview, and
  // a turn still being answered falls back to the rest of its own text.
  const answer = members.find((member) => member !== head && textOf(member));
  const preview = (
    answer
      ? linesOf(answer).join(" ")
      : lines.slice(1).join(" ")
  )
    .trim();

  return {
    id: head.id,
    title: title || labelOf(head),
    ...(preview ? { preview } : {}),
  };
};

export function ConversationMapAui({
  side = "left",
  className,
}: {
  side?: "left" | "right";
  className?: string;
}) {
  const messageStructure = useMemo(() => createMessageStructureSelector(true), []);
  const messages = useAuiState((s) => messageStructure(s.thread.messages));
  const sessionId = useStore((state) => state.currentSessionId);
  const viewport = useThreadViewport((s) => s.element.viewport);
  const viewportHeight = useThreadViewport((s) => s.height.viewport);
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [visibleIds, setVisibleIds] = useState<readonly string[]>([]);
  // Hidden until the first measurement so a narrow layout never flashes the rail.
  const [layout, setLayout] = useState<{ viewport: HTMLElement; sessionId: string | undefined; side: "left" | "right"; hasSpace: boolean }>();
  const scheduleRef = useRef<(() => void) | undefined>(undefined);
  const cancelNavigationRef = useRef<(() => void) | undefined>(undefined);

  const turns = useMemo(() => groupIntoTurns(messages), [messages]);
  const entries = useMemo(() => turns.map(describe), [turns]);

  const turnKey = turns.map((turn) => turn.head.id).join(" ");

  useEffect(() => {
    if (!viewport) return undefined;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const hasSpace = hasConversationRailSpaceInViewport(viewport, side);
      setLayout((previous) => previous?.viewport === viewport && previous.sessionId === sessionId && previous.side === side && previous.hasSpace === hasSpace
        ? previous : { viewport, sessionId, side, hasSpace });
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };

    const rail = observeConversationRail(viewport, ({ activeId, visibleIds }) => {
      setActiveId(activeId);
      setVisibleIds((previous) => sameIds(previous, visibleIds) ? previous : visibleIds);
    });
    scheduleRef.current = () => { rail.refresh(); schedule(); };
    schedule();
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const content = viewport.querySelector<HTMLElement>("[data-conversation-rail-content]");
    const messageList = content?.parentElement;
    const contentObserver = new MutationObserver(() => { rail.refresh(); schedule(); });
    if (messageList) contentObserver.observe(messageList, { childList: true });
    const layoutObserver = new MutationObserver(schedule);
    for (const element of [viewport, content, messageList]) {
      if (element) layoutObserver.observe(element, { attributes: true, attributeFilter: ["style", "class"] });
    }

    return () => {
      scheduleRef.current = undefined;
      if (frame) cancelAnimationFrame(frame);
      rail.dispose();
      window.removeEventListener("resize", schedule);
      observer.disconnect();
      contentObserver.disconnect();
      layoutObserver.disconnect();
      cancelNavigationRef.current?.();
    };
  }, [viewport, sessionId, side]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [turnKey]);

  useEffect(() => () => cancelNavigationRef.current?.(), []);

  const select = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      if (!viewport) return;
      cancelNavigationRef.current?.();
      const target = [...viewport.querySelectorAll<HTMLElement>("[data-turn-id]")]
        .find((block) => block.dataset["turnId"] === id);
      if (!target) return;

      // Align the actual turn below the visible header edge. Recalculate from
      // live rectangles because earlier turns may still use intrinsic sizes.
      const destination = () => Math.max(0, Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        viewport.scrollTop + target.getBoundingClientRect().top - visibleTop(viewport),
      ));
      const top = destination();
      if (behavior === "instant" || Math.abs(top - viewport.scrollTop) <= TOP_TOLERANCE) {
        viewport.scrollTo({ top, behavior: "instant" });
        return;
      }

      let frame = 0;
      let stableFrames = 0;
      const cancel = () => {
        if (frame) cancelAnimationFrame(frame);
        viewport.removeEventListener("scrollend", correct);
        viewport.removeEventListener("wheel", cancel);
        viewport.removeEventListener("touchstart", cancel);
        viewport.removeEventListener("pointerdown", cancel);
        viewport.removeEventListener("keydown", cancel);
        if (cancelNavigationRef.current === cancel) cancelNavigationRef.current = undefined;
      };
      const settle = () => {
        const next = destination();
        if (Math.abs(next - viewport.scrollTop) > TOP_TOLERANCE) {
          viewport.scrollTo({ top: next, behavior: "instant" });
          stableFrames = 0;
        } else {
          stableFrames++;
        }
        if (stableFrames < 2) frame = requestAnimationFrame(settle);
        else cancel();
      };
      const correct = () => {
        viewport.removeEventListener("scrollend", correct);
        frame = requestAnimationFrame(settle);
      };
      cancelNavigationRef.current = cancel;
      viewport.addEventListener("scrollend", correct, { once: true });
      viewport.addEventListener("wheel", cancel, { passive: true, once: true });
      viewport.addEventListener("touchstart", cancel, { passive: true, once: true });
      viewport.addEventListener("pointerdown", cancel, { once: true });
      viewport.addEventListener("keydown", cancel, { once: true });
      viewport.scrollTo({ top, behavior: "smooth" });
    },
    [viewport],
  );

  // Unmount the portal too: CSS visibility on the rail cannot hide a body portal.
  if (entries.length < 4 || !viewport?.parentElement || !layout || layout.viewport !== viewport || layout.sessionId !== sessionId || layout.side !== side || !layout.hasSpace) return null;

  // Like Codex Pt, portal beside the scroller; no flex gap or scroll offset changes.
  return createPortal(
    <div
      data-slot="conversation-map-rail"
      className={cn(
        "pointer-events-none absolute inset-x-0 top-0 z-10",
        className,
      )}
      style={{ height: viewportHeight }}
    >
      <div
        className={cn(
          "pointer-events-auto absolute top-0 h-full px-3 py-10",
          side === "right" ? "right-0" : "left-0",
        )}
      >
        <ConversationMap
          entries={entries}
          activeId={activeId}
          visibleIds={visibleIds}
          onSelect={select}
          sessionId={sessionId}
          side={side === "right" ? "left" : "right"}
          renderPreview={renderTurnPreview}
        />
      </div>
    </div>, viewport.parentElement,
  );
}

function TurnPreview({ id }: { id: string }) {
  const preview = useAuiState((state) => {
    const turn = groupIntoTurns(state.thread.messages).find((turn) => turn.head.id === id);
    return turn ? describe(turn).preview : undefined;
  });
  return preview ? <div className="q-conversation-preview-body"><ReactMarkdown skipHtml components={{ img: ({ alt }) => <span>{alt}</span>, a: ({ children }) => <span>{children}</span> }}>{preview}</ReactMarkdown></div> : null;
}

const renderTurnPreview = (entry: ConversationMapEntry) => <TurnPreview id={entry.id} />;
