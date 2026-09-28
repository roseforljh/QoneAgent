"use client";

import { ImageOffIcon, RefreshCwIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "../../../lib/utils";

const DOTS = Array.from({ length: 64 }, (_, index) => index);

/** Assistant-ui's generation placeholder, styled to match Qone's dark surfaces. */
export function ImageGeneration({ prompt, generating, error, onRegenerate, className, ...props }: Omit<ComponentProps<"div">, "children"> & { prompt: string; generating: boolean; error?: string; onRegenerate?: () => void }) {
  return (
    <div data-slot="image-generation" className={cn("flex w-64 flex-col gap-2.5", className)} {...props}>
      <div className="relative aspect-square w-full overflow-hidden rounded-2xl border border-foreground/10 bg-foreground/[0.04]">
        {error && <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-background/90 p-6 text-center text-foreground/60"><ImageOffIcon className="size-8" /><span className="text-xs">图像生成失败</span><span className="text-[11px] text-foreground/45">{error}</span></div>}
        <div className="absolute inset-0 grid grid-cols-8 place-items-center p-6" aria-hidden>
          {DOTS.map((dot) => {
            const row = Math.floor(dot / 8);
            const col = dot % 8;
            return <span key={dot} className={cn("size-1 rounded-full bg-foreground/20 transition-opacity", generating ? "animate-pulse" : "opacity-0")} style={{ animationDelay: `${(row + col) * 90}ms` }} />;
          })}
        </div>
        <div className={cn("absolute inset-0 transition-[opacity,filter] duration-1000", generating ? "opacity-0 blur-xl" : "opacity-100 blur-0")} style={{ background: "radial-gradient(120% 90% at 20% 100%, rgb(37 99 235 / .45), transparent 55%), radial-gradient(110% 80% at 85% 90%, rgb(168 85 247 / .55), transparent 60%), linear-gradient(to top, rgb(30 41 59), rgb(120 53 15))" }} />
        <span className="absolute end-2.5 top-2.5 text-xs tabular-nums text-white/65">1024 × 1024</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 truncate text-xs text-foreground/55">{generating ? "正在生成图像…" : prompt}</p>
        {onRegenerate && <button type="button" aria-label="Regenerate image" disabled={generating} onClick={onRegenerate} className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/60 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"><RefreshCwIcon className="size-3.5" /></button>}
      </div>
    </div>
  );
}
