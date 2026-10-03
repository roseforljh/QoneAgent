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
      onAnimationStart={(event) => synchronizeDocumentAnimations(event.currentTarget)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <path
        opacity="0.3"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M18 12C18 8.68629 15.3137 6 12 6C8.68629 6 6 8.68629 6 12C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12ZM20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12Z"
      />
      <path
        fill="currentColor"
        d="M12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12H6C6 15.3137 8.68629 18 12 18C15.3137 18 18 15.3137 18 12C18 8.68629 15.3137 6 12 6V4Z"
      />
    </svg>
  );
};

export const SessionCompletionDot: FC = () => (
  <span className="q-session-completion-dot" aria-hidden="true" data-slot="q-session-completion-dot" />
);
