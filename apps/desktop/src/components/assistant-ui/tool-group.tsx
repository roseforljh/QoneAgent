import { memo, useCallback, useRef, useState, type FC, type PropsWithChildren } from "react";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";
import { useScrollLock } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { cn } from "../../lib/utils";

const ANIMATION_DURATION = 200;

type ToolGroupVariant = "outline" | "ghost" | "muted";

const toolGroupVariants: Record<ToolGroupVariant, string> = {
  outline: "rounded-lg border py-3",
  ghost: "",
  muted: "border-muted-foreground/30 bg-muted/30 rounded-lg border py-3",
};

export type ToolGroupRootProps = Omit<React.ComponentProps<typeof Collapsible>, "open" | "onOpenChange"> & {
  variant?: ToolGroupVariant;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
};

function ToolGroupRoot({ className, variant, open: controlledOpen, onOpenChange: controlledOnOpenChange, defaultOpen = false, children, ...props }: ToolGroupRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION);

  const isControlled = controlledOpen !== undefined;
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen;

  const handleOpenChange = useCallback((open: boolean) => {
    lockScroll();
    if (!isControlled) setUncontrolledOpen(open);
    controlledOnOpenChange?.(open);
  }, [lockScroll, isControlled, controlledOnOpenChange]);

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-group-root"
      data-variant={variant ?? "outline"}
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn("aui-tool-group-root group/tool-group w-full", toolGroupVariants[variant ?? "outline"], "group/tool-group-root", className)}
      style={{ "--animation-duration": `${ANIMATION_DURATION}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </Collapsible>
  );
}

function ToolGroupTrigger({ count, active = false, className, ...props }: React.ComponentProps<typeof CollapsibleTrigger> & { count: number; active?: boolean }) {
  const label = `${count} tool ${count === 1 ? "call" : "calls"}`;
  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        "aui-tool-group-trigger group/trigger flex origin-left items-center gap-2 text-sm transition-[color,scale] active:scale-[0.98]",
        "group-data-[variant=ghost]/tool-group-root:text-muted-foreground group-data-[variant=ghost]/tool-group-root:hover:text-foreground group-data-[variant=ghost]/tool-group-root:py-1.5",
        "group-data-[variant=outline]/tool-group-root:w-full group-data-[variant=outline]/tool-group-root:px-4",
        "group-data-[variant=muted]/tool-group-root:w-full group-data-[variant=muted]/tool-group-root:px-4",
        className,
      )}
      {...props}
    >
      {active && <LoaderIcon data-slot="tool-group-trigger-loader" className="aui-tool-group-trigger-loader size-3 shrink-0 animate-spin [animation-duration:0.6s]" />}
      <span
        data-slot="tool-group-trigger-label"
        className={cn(
          "aui-tool-group-trigger-label-wrapper inline-block text-start text-xs leading-none font-medium",
          "group-data-[variant=ghost]/tool-group-root:font-normal",
          "group-data-[variant=outline]/tool-group-root:grow",
          "group-data-[variant=muted]/tool-group-root:grow",
          active && "shimmer motion-reduce:animate-none",
        )}
      >
        {label}
      </span>
      <ChevronDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn("aui-tool-group-trigger-chevron size-3 shrink-0", "transition-transform ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none animation-duration-200", "-rotate-90", "group-data-open/trigger:rotate-0")}
      />
    </CollapsibleTrigger>
  );
}

function ToolGroupContent({ className, children, ...props }: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
      className={cn("aui-tool-group-content relative overflow-hidden text-sm outline-none", "group/collapsible-content data-open:animate-collapsible-down data-closed:animate-collapsible-up data-closed:pointer-events-none", className)}
      {...props}
    >
      <div
        className={cn(
          "mt-2 flex flex-col gap-2",
          "group-data-[variant=ghost]/tool-group-root:mt-1 group-data-[variant=ghost]/tool-group-root:gap-1",
          "group-data-[variant=outline]/tool-group-root:mt-3 group-data-[variant=outline]/tool-group-root:border-t group-data-[variant=outline]/tool-group-root:px-4 group-data-[variant=outline]/tool-group-root:pt-3",
          "group-data-[variant=muted]/tool-group-root:mt-3 group-data-[variant=muted]/tool-group-root:border-t group-data-[variant=muted]/tool-group-root:px-4 group-data-[variant=muted]/tool-group-root:pt-3",
          "[&>*]:animate-in [&>*]:fade-in-0 [&>*]:slide-in-from-top-1 [&>*]:animation-duration-200",
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  );
}

const ToolGroupImpl: FC<PropsWithChildren<{ startIndex: number; endIndex: number }>> = ({ children, startIndex, endIndex }) => {
  const toolCount = endIndex - startIndex + 1;
  return (
    <ToolGroupRoot>
      <ToolGroupTrigger count={toolCount} />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  );
};

const ToolGroup = memo(ToolGroupImpl);
ToolGroup.displayName = "ToolGroup";

export { ToolGroup, ToolGroupRoot, ToolGroupTrigger, ToolGroupContent };
