import type { FC } from "react";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";

const threadWidths = ["w-[88%]", "w-[74%]", "w-[93%]", "w-[61%]"];

export const SidebarLoadingSkeleton: FC<{ layout: "project" | "list" }> = ({ layout }) => {
  return (
    <div
      data-slot="sidebar-loading-skeleton"
      aria-busy="true"
      className="animate-in fade-in-0 space-y-3 px-1.5 pt-3 duration-150"
    >
      {layout === "project" ? (
        <>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-full rounded-md" />
          <Skeleton className="h-9 w-[91%] rounded-md" />
          <Skeleton className="mt-4 h-3 w-14" />
          <Skeleton className="h-9 w-[84%] rounded-md" />
          <Skeleton className="h-9 w-full rounded-md" />
        </>
      ) : (
        <>
          <Skeleton className="h-3 w-14" />
          {threadWidths.map((width) => (
            <Skeleton key={width} className={cn("h-8 rounded-md", width)} />
          ))}
        </>
      )}
    </div>
  );
};

export const ConversationLoadingSkeleton: FC = () => {
  return (
    <div
      data-slot="conversation-loading-skeleton"
      aria-busy="true"
      className="animate-in fade-in-0 min-h-0 grow overflow-hidden px-4 pt-8 duration-150"
    >
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <Skeleton className="ml-auto h-10 w-36 rounded-[18px]" />
        <div className="flex flex-col items-start gap-3">
          <Skeleton className="h-4 w-24" />
          <div className="flex w-full flex-col gap-2">
            <Skeleton className="h-4 w-[88%]" />
            <Skeleton className="h-4 w-[76%]" />
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[58%]" />
          </div>
        </div>
      </div>
    </div>
  );
};

export const ComposerLoadingSkeleton: FC = () => {
  return (
    <div
      data-slot="composer-loading-skeleton"
      aria-busy="true"
      className="animate-in fade-in-0 flex w-full flex-col gap-3 rounded-(--composer-radius) border border-foreground/10 bg-(--composer-bg) p-(--composer-padding) duration-150"
    >
      <Skeleton className="h-5 w-[68%] rounded-md" />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-full" />
          <Skeleton className="h-4 w-28" />
        </div>
        <Skeleton className="size-7 rounded-full" />
      </div>
    </div>
  );
};
