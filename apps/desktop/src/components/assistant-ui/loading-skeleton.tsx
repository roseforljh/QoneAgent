import type { FC } from "react";
import { cn } from "../../lib/utils";
import { Skeleton } from "../ui/skeleton";
import "./composer-queue.css";

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
      className="animate-in fade-in-0 min-h-0 grow overflow-hidden pt-8 duration-150"
    >
      <div className="q-thread-content mx-auto flex w-full flex-col gap-8">
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
      className="q-composer-shell animate-in fade-in-0 flex w-full shrink-0 flex-col gap-0 rounded-(--composer-radius) bg-(--composer-bg) p-0 duration-150"
    >
      {/* Match the empty attachment slot, editor and action row of Composer. */}
      <div aria-hidden="true" className="pb-1.5 pt-2" />
      <div className="min-h-11 w-full px-3">
        <Skeleton className="h-5 w-[68%] rounded-md" />
      </div>
      <div className="mt-1 flex min-h-7 items-center justify-between gap-2 px-2 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <Skeleton className="h-4 w-28 min-w-0" />
        </div>
        <Skeleton className="size-7 shrink-0 rounded-full" />
      </div>
    </div>
  );
};
