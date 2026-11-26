import { MessagePrimitive, TextMessagePartProvider, useAuiState, useMessagePartText, useMessageQuote } from "@assistant-ui/react";
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import type { UrlTransform } from "react-markdown";
import { Popover } from "radix-ui";
import { cn } from "../../lib/utils";
import { memo } from "react";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import annotationIcon from "../../assets/codex-icons/text-bubble-light-16.svg";
import { File } from "./elements/file";
import { UserImageThumbnail } from "./elements/user-image-thumbnail";
import { UserMessageActions } from "./message-actions";
import { MarkdownText } from "./markdown-text";
import { MarkdownLink } from "./markdown-link";
import { InlineQuoteChip } from "./composer-quote";
import { AgentCommunication, useAgentCommunication } from "./agent-communication";
import { hasInlineQuote, INLINE_QUOTE_HREF, inlineQuotesToMarkdown } from "../../lib/inline-quote";
import { markdownUrlTransform } from "../../lib/markdown-file-reference";

// Inline selected-text tags reach Markdown as qone-quote:N links and render as chips.
const InlineQuotes = createContext<readonly string[]>([]);
function QuoteOrLink(props: ComponentProps<"a"> & { node?: unknown }) {
  const quotes = useContext(InlineQuotes);
  const quote = props.href?.startsWith(INLINE_QUOTE_HREF) ? quotes[Number(props.href.slice(INLINE_QUOTE_HREF.length))] : undefined;
  return quote === undefined ? <MarkdownLink {...props} /> : <InlineQuoteChip text={quote} />;
}
const quoteComponents = { a: QuoteOrLink };
const quoteUrlTransform: UrlTransform = (url, key, node) => url.startsWith(INLINE_QUOTE_HREF) ? url : markdownUrlTransform(url, key, node);

function UserMarkdownText() {
  const { text } = useMessagePartText();
  const inline = useMemo(() => hasInlineQuote(text) ? inlineQuotesToMarkdown(text) : undefined, [text]);
  if (!inline) return <MarkdownText />;
  return <InlineQuotes.Provider value={inline.quotes}>
    <TextMessagePartProvider text={inline.markdown}>
      <MarkdownText components={quoteComponents} urlTransform={quoteUrlTransform} />
    </TextMessagePartProvider>
  </InlineQuotes.Provider>;
}

/** Codex collapses long user text and offers Show more. The line budget lives
 * in CSS so the clamp and this measurement cannot drift apart. */
export const USER_MESSAGE_COLLAPSED_LINES = 20;

export function userMessageNeedsCollapse(contentHeight: number, lineHeight: number, lines = USER_MESSAGE_COLLAPSED_LINES): boolean {
  return lineHeight > 0 && contentHeight > lineHeight * lines + 1;
}

function UserMessageText({ paired = false }: { paired?: boolean }) {
  const { t } = useLocale();
  const parts = useAuiState((state) => state.message.parts);
  const textPartIndexes = parts.flatMap((part, index) => part.type === "text" && part.text.length > 0 ? [index] : []);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return undefined;
    // scrollHeight stays the full height while the clamp is applied, so the
    // toggle keeps its state after expansion.
    const measure = () => {
      const style = getComputedStyle(content);
      const lines = Number.parseFloat(style.getPropertyValue("--q-user-message-collapse-lines")) || USER_MESSAGE_COLLAPSED_LINES;
      setOverflows(userMessageNeedsCollapse(content.scrollHeight, Number.parseFloat(style.lineHeight) || 0, lines));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  if (textPartIndexes.length === 0) return null;
  return <>
    <div data-aui-quote-selectable="true" className={cn("q-user-message-bubble w-fit min-w-0 break-words text-start", paired ? "q-user-message-bubble-paired max-w-[70%]" : "max-w-[70%]")}>
      <div ref={contentRef} className={cn(overflows && !expanded && "q-user-message-content-collapsed")}>
        {textPartIndexes.map((index) => <MessagePrimitive.PartByIndex key={index} index={index} components={{ Text: UserMarkdownText }} />)}
      </div>
    </div>
    {overflows && <button type="button" className="q-user-message-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {t(expanded ? "chat.showLess" : "chat.showMore")}
    </button>}
  </>;
}

function UserMessageAnnotation() {
  const { t } = useLocale();
  const quote = useMessageQuote();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const show = () => { cancelClose(); setOpen(true); };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 100); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  if (!quote) return null;
  return <Popover.Root open={open} onOpenChange={(next) => { cancelClose(); setOpen(next); }}>
    <div className="q-message-annotation" onMouseEnter={show} onMouseLeave={scheduleClose}>
      <Popover.Trigger asChild>
        <button type="button" className="q-message-annotation-trigger" aria-label={t("chat.annotationLabel")} onClick={(event) => { event.preventDefault(); show(); }}>
          <CodexIcon src={annotationIcon} className="size-4 shrink-0" />
          <span>{t("chat.annotationLabel")}</span>
        </button>
      </Popover.Trigger>
    </div>
    <Popover.Portal>
      <Popover.Content className="q-message-annotation-preview" aria-label={t("chat.selectedText")}
        side="top" align="end" sideOffset={4} collisionPadding={8}
        onMouseEnter={show} onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
        <span>{quote.text}</span>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export const UserMessage = memo(function UserMessage() {
  const communication = useAgentCommunication();
  if (communication) return <AgentCommunication communication={communication} />;
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user q-user-message-group relative mx-auto flex w-full q-thread-content flex-col items-end gap-1">
      <UserMessageAnnotation />
      <UserMessageAttachments />
      <UserMessageText />
      <div className="q-user-message-action-slot"><UserMessageActions /></div>
    </MessagePrimitive.Root>
  );
});

export function UserMessageContent() {
  const communication = useAgentCommunication();
  if (communication) return <AgentCommunication communication={communication} />;
  return (
    // The top-anchor measures this root; keep the attachment and bubble in it.
    <MessagePrimitive.Root className="q-message-root q-message-user relative flex w-full flex-col items-end gap-1 self-end">
      <UserMessageAnnotation />
      <UserMessageAttachments />
      <UserMessageText paired />
    </MessagePrimitive.Root>
  );
}

export function UserMessageAttachments() {
  const hasAttachments = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "file" || part.type === "image",
  ));
  if (!hasAttachments) return null;
  return (
    <div className="q-message-user-attachments flex w-fit max-w-full min-w-0 flex-wrap items-end justify-end gap-2 self-end">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "file") return <File {...part} />;
          if (part.type === "image") return <UserImageThumbnail {...part} />;
          return null;
        }}
      </MessagePrimitive.Parts>
    </div>
  );
}
