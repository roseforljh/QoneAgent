import {
  createContext,
  forwardRef,
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

const CollapsibleContext = createContext<{ open: boolean; onOpenChange: (open: boolean) => void }>({
  open: false,
  onOpenChange: () => {},
});

interface CollapsibleProps extends Omit<ComponentPropsWithoutRef<"div">, "onChange"> {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: ReactNode;
}

export const Collapsible = forwardRef<HTMLDivElement, CollapsibleProps>(
  ({ open = false, onOpenChange, children, ...props }, ref) => (
    <CollapsibleContext.Provider value={{ open, onOpenChange: onOpenChange ?? (() => {}) }}>
      <div ref={ref} data-state={open ? "open" : "closed"} {...(open ? { "data-open": "" } : { "data-closed": "" })} {...props}>
        {children}
      </div>
    </CollapsibleContext.Provider>
  ),
);
Collapsible.displayName = "Collapsible";

export const CollapsibleTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(
  ({ onClick, ...props }, ref) => {
    const { open, onOpenChange } = useContext(CollapsibleContext);
    return (
      <button
        ref={ref}
        type="button"
        data-state={open ? "open" : "closed"}
        {...(open ? { "data-open": "" } : { "data-closed": "" })}
        onClick={(e) => { onClick?.(e); if (!e.defaultPrevented) onOpenChange(!open); }}
        {...props}
      />
    );
  },
);
CollapsibleTrigger.displayName = "CollapsibleTrigger";

export const CollapsibleContent = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(
  (props, ref) => {
    const { open } = useContext(CollapsibleContext);
    return (
      <div
        ref={ref}
        data-state={open ? "open" : "closed"}
        {...(open ? { "data-open": "" } : { "data-closed": "" })}
        hidden={!open}
        {...props}
      />
    );
  },
);
CollapsibleContent.displayName = "CollapsibleContent";
