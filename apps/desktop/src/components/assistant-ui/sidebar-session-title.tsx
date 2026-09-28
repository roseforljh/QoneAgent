import { useLayoutEffect, useRef, useState, type CSSProperties, type FC, type ReactNode } from "react";

interface SidebarSessionTitleProps {
  children: ReactNode;
  title: string;
}

export const SidebarSessionTitle: FC<SidebarSessionTitleProps> = ({ children, title }) => {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState({ distance: 0, duration: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let disposed = false;

    const measure = () => {
      if (disposed) return;
      const distance = Math.max(0, content.getBoundingClientRect().width - viewport.getBoundingClientRect().width);
      const fontSize = Number.parseFloat(getComputedStyle(content).fontSize);
      const duration = fontSize > 0 ? distance / (fontSize * 2) : 0;
      setOverflow((previous) => previous.distance === distance && previous.duration === duration
        ? previous : { distance, duration });
    };

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(content);
    measure();
    void document.fonts.ready.then(measure);
    return () => { disposed = true; observer.disconnect(); };
  }, [title]);

  const style = {
    "--q-sidebar-title-distance": `${overflow.distance}px`,
    "--q-sidebar-title-duration": `${overflow.duration}s`,
  } as CSSProperties;

  return (
    <span ref={viewportRef} className="q-sidebar-session-title" data-overflowing={overflow.distance >= 1 || undefined} style={style}>
      <span className="q-sidebar-session-title-track">
        <span ref={contentRef} className="q-sidebar-session-title-content" dir="auto">{children}</span>
      </span>
    </span>
  );
};
