import type { FC } from "react";
import { cn } from "../../lib/utils";
import "./morphing-spinner.css";

export const MorphingSpinner: FC<{ className?: string; label?: string; "data-slot"?: string }> = ({ className, label, "data-slot": slot }) => (
  <svg
    viewBox="0 0 24 24"
    data-slot={slot}
    className={cn("q-morphing-spinner size-3.5 shrink-0", className)}
    role={label ? "img" : undefined}
    aria-label={label}
    aria-hidden={label ? undefined : true}
  >
    <circle cx="12" cy="12" r="9" pathLength="100" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
  </svg>
);
