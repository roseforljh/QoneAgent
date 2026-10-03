import { useLayoutEffect, useRef, type FC } from "react";
import { synchronizeDocumentAnimations } from "../../lib/synchronized-animation";
import { cn } from "../../lib/utils";
import "./morphing-spinner.css";

export const MorphingSpinner: FC<{ className?: string; label?: string; "data-slot"?: string }> = ({ className, label, "data-slot": slot }) => {
  const ref = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const synchronize = () => synchronizeDocumentAnimations(element);
    synchronize();
    // CSS recreates the animations when reduced motion is switched off.
    const reducedMotion = element.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotion?.addEventListener("change", synchronize);
    return () => reducedMotion?.removeEventListener("change", synchronize);
  }, []);

  return (
    <svg
      ref={ref}
      viewBox="0 0 24 24"
      data-slot={slot}
      className={cn("q-morphing-spinner size-3.5 shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path
        opacity="0.3"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4178 20 20 16.4179 20 12C20 7.58172 16.4183 4 12 4ZM2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12Z"
      />
      <path
        fill="currentColor"
        d="M12.9995 2.04938C18.0529 2.55089 21.9993 6.81427 21.9995 11.9996C21.9995 17.5224 17.5224 21.9996 11.9995 21.9996C6.81421 21.9994 2.55083 18.053 2.04932 12.9996H4.06494C4.557 16.9458 7.92007 19.9994 11.9995 19.9996C16.4178 19.9996 19.9995 16.4179 19.9995 11.9996C19.9993 7.92009 16.9458 4.55604 12.9995 4.06403V2.04938Z"
      />
    </svg>
  );
};

export const SessionCompletionDot: FC = () => (
  <span className="q-session-completion-dot" aria-hidden="true" data-slot="q-session-completion-dot" />
);
