import { forwardRef, type ComponentPropsWithRef } from "react";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
};

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  ({ children, tooltip, side = "bottom", className, ...rest }, ref) => (
    <Button
      variant="ghost"
      size="icon"
      title={tooltip}
      aria-label={tooltip}
      {...rest}
      className={cn("aui-button-icon size-6 p-1 active:scale-90", className)}
      ref={ref}
    >
      {children}
      <span className="sr-only">{tooltip}</span>
    </Button>
  ),
);
TooltipIconButton.displayName = "TooltipIconButton";
