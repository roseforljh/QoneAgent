import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BrainIcon, ChevronDownIcon } from "lucide-react";
import { useScrollLock, type ReasoningMessagePartComponent } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../../lib/utils";
import { MarkdownText } from "./markdown-text";

const ANIMATION_DURATION = 200;

const ReasoningPreviewContext = createContext(false);

type ReasoningVariant = "outline" | "ghost" | "muted";

const reasoningVariants: Record<ReasoningVariant, string> = {
  outline: "rounded-lg border px-3 py-2",
  ghost: "",
  muted: "bg-muted/50 rounded-lg px-3 py-2",
};

export type ReasoningRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  variant?: ReasoningVariant;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  streaming?: boolean;
  onAnimationStart?: () => void;
};

function ReasoningRootBase({ className, variant, open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen = false, streaming, onAnimationStart, children, ...props }: ReasoningRootProps) {
  const [initialOpen] = useState(defaultOpen);
  const [userOpen, setUserOpen] = useState<boolean | null>(null);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : (userOpen ?? (streaming || initialOpen));
  const isPreview = streaming === true && isOpen;

  const prevStreamingRef = useRef(streaming);
  useLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return;
    prevStreamingRef.current = streaming;
    if (!isControlled && userOpen === null && !initialOpen) onAnimationStart?.();
  }, [streaming, isControlled, userOpen, initialOpen, onAnimationStart]);

  const handleOpenChange = useCallback((open: boolean) => {
    onAnimationStart?.();
    if (!isControlled) setUserOpen(open);
    controlledOnOpenChange?.(open);
  }, [onAnimationStart, isControlled, controlledOnOpenChange]);

  return (
    <Collapsible
      data-slot="reasoning-root"
      data-variant={variant}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("group/reasoning-root", "aui-reasoning-root mb-4 w-full", reasoningVariants[variant ?? "outline"], className)}
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>{children}</ReasoningPreviewContext.Provider>
    </Collapsible>
  );
}

function ReasoningRoot({ onAnimationStart, ...props }: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement | null>(null);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);
  const handleAnimationStart = useCallback(() => {
    lockScroll();
    onAnimationStart?.();
  }, [lockScroll, onAnimationStart]);
  return <ReasoningRootBase ref={collapsibleRef} onAnimationStart={handleAnimationStart} {...props} />;
}

function ReasoningFade({ side = "bottom", className, ...props }: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 z-10 h-8",
        side === "top" ? "top-0 bg-[linear-gradient(to_bottom,var(--color-background),transparent)]" : "bottom-0 bg-[linear-gradient(to_top,var(--color-background),transparent)]",
        "fade-in-0 animate-in animation-duration-200",
        className,
      )}
      {...props}
    />
  );
}

function ReasoningTrigger({ active, duration, className, ...props }: React.ComponentProps<typeof CollapsibleTrigger> & { active?: boolean; duration?: number }) {
  const durationText = duration ? ` (${duration}s)` : "";
  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn("aui-reasoning-trigger group/trigger text-muted-foreground hover:text-foreground flex max-w-[75%] origin-left items-center gap-2 py-1.5 text-sm transition-[color,scale] active:scale-[0.98]", className)}
      {...props}
    >
      <BrainIcon data-slot="reasoning-trigger-icon" className="aui-reasoning-trigger-icon size-4 shrink-0" />
      <span data-slot="reasoning-trigger-label" className={cn("aui-reasoning-trigger-label-wrapper inline-block leading-none tabular-nums", active && "shimmer motion-reduce:animate-none")}>
        Reasoning{durationText}
      </span>
      <ChevronDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cn("aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0", "transition-transform ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none animation-duration-200", "-rotate-90", "group-data-open/trigger:rotate-0")}
      />
    </CollapsibleTrigger>
  );
}

function ReasoningContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext);
  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn("aui-reasoning-content text-muted-foreground relative overflow-hidden text-sm outline-none", "data-open:animate-collapsible-down data-closed:animate-collapsible-up data-closed:pointer-events-none", className)}
      {...props}
    >
      <ReasoningFade side="top" />
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  );
}

function ReasoningText({ className, children, ...props }: React.ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isPreview) return;
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return;

    let pinned = true;
    let lastScrollTop = scrollEl.scrollTop;
    let lastScrollHeight = scrollEl.scrollHeight;
    const isAtBottom = () =>
      Math.abs(scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight;

    const pin = () => { if (pinned) scrollEl.scrollTop = scrollEl.scrollHeight; };
    const onScroll = () => {
      if (isAtBottom()) pinned = true;
      else if (scrollEl.scrollTop < lastScrollTop && scrollEl.scrollHeight === lastScrollHeight) pinned = false;
      lastScrollTop = scrollEl.scrollTop;
      lastScrollHeight = scrollEl.scrollHeight;
    };

    pin();
    scrollEl.addEventListener("scroll", onScroll);
    const observer = new ResizeObserver(pin);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [isPreview]);

  return (
    <div ref={scrollRef} data-slot="reasoning-text" className={cn("aui-reasoning-text relative z-0 max-h-64 overflow-y-auto ps-6 pt-2 pb-2 leading-relaxed text-pretty", className)} {...props}>
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />;

const Reasoning = memo(ReasoningImpl) as unknown as ReasoningMessagePartComponent & {
  Root: typeof ReasoningRoot;
  Trigger: typeof ReasoningTrigger;
  Content: typeof ReasoningContent;
  Text: typeof ReasoningText;
  Fade: typeof ReasoningFade;
};

Reasoning.displayName = "Reasoning";
Reasoning.Root = ReasoningRoot;
Reasoning.Trigger = ReasoningTrigger;
Reasoning.Content = ReasoningContent;
Reasoning.Text = ReasoningText;
Reasoning.Fade = ReasoningFade;

export { Reasoning, ReasoningRoot, ReasoningTrigger, ReasoningContent, ReasoningText, ReasoningFade };
