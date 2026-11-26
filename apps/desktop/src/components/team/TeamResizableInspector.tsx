import { useLayoutEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useLocale } from "../../localization";
import { usePaneResize } from "../../lib/use-pane-resize";
import { usePaneMotion } from "../../lib/use-pane-motion";
import { SIDEBAR_VISIBILITY_TRANSITION } from "../../lib/pane-motion";
import "../assistant-ui/pane-layout.css";

const MIN_INSPECTOR_WIDTH = 260;
const DEFAULT_INSPECTOR_WIDTH = 320;
const MAX_INSPECTOR_WIDTH = 520;
const MIN_STAGE_WIDTH = 320;
const STORAGE_KEY = "qone:team-inspector-width:px:v1";

function readSavedWidth(): number {
  if (typeof window === "undefined") return DEFAULT_INSPECTOR_WIDTH;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_INSPECTOR_WIDTH;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= MIN_INSPECTOR_WIDTH
      ? Math.min(MAX_INSPECTOR_WIDTH, Math.round(parsed))
      : DEFAULT_INSPECTOR_WIDTH;
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

function saveWidthToStorage(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  } catch {
    // 本地存储不可用时保持当前会话内宽度
  }
}

function inspectorBounds(shellWidth: number, reservedLeftWidth: number) {
  const maxByShell = Number.isFinite(shellWidth)
    ? shellWidth - reservedLeftWidth - MIN_STAGE_WIDTH
    : MAX_INSPECTOR_WIDTH;
  const maximum = Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, maxByShell));
  return { minimum: MIN_INSPECTOR_WIDTH, maximum };
}

function clampWidth(width: number, shellWidth: number, reservedLeftWidth: number): number {
  const { minimum, maximum } = inspectorBounds(shellWidth, reservedLeftWidth);
  return Math.round(Math.min(maximum, Math.max(minimum, Number.isFinite(width) ? width : DEFAULT_INSPECTOR_WIDTH)));
}

interface TeamResizableInspectorProps {
  reservedLeftWidth?: number;
  children: ReactNode;
}

/** 团队右侧详情栏容器：常驻展开，仅支持拖拽竖线调整宽度并在最小宽度处锁定。 */
export function TeamResizableInspector({
  reservedLeftWidth = 0,
  children,
}: TeamResizableInspectorProps) {
  const { t } = useLocale();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [shellWidth, setShellWidth] = useState(() => (typeof window === "undefined" ? Infinity : window.innerWidth));
  const [preferredWidth, setPreferredWidth] = useState(readSavedWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const shell = element?.parentElement;
    if (!shell) return;
    const measure = () => setShellWidth(shell.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    measure();
    return () => observer.disconnect();
  }, [element]);

  const width = clampWidth(dragWidth ?? preferredWidth, shellWidth, reservedLeftWidth);
  const { minimum, maximum } = inspectorBounds(shellWidth, reservedLeftWidth);

  const commitWidth = (rawWidth: number) => {
    const clamped = clampWidth(rawWidth, Infinity, 0);
    setPreferredWidth(clamped);
    saveWidthToStorage(clamped);
  };

  const { dragging, startResize, cancelResize } = usePaneResize({
    direction: -1,
    getSize: () => width,
    // 拖动竖线仅调整宽度并在最小宽度处锁死，不允许闭合。
    onSize: (rawWidth) => {
      setDragWidth(clampWidth(rawWidth, shellWidth, reservedLeftWidth));
    },
    onEnd: (rawWidth) => {
      commitWidth(clampWidth(rawWidth, shellWidth, reservedLeftWidth));
    },
    onFinish: () => setDragWidth(undefined),
  });

  const animatedWidth = usePaneMotion({
    open: true,
    size: width,
    transition: SIDEBAR_VISIBILITY_TRANSITION,
    immediate: Boolean(reduceMotion),
    animateSize: !dragging,
  });

  return (
    <div
      ref={setElement}
      className="team-inspector-pane relative flex h-full shrink-0"
      data-resizing={dragging || undefined}
    >
      <motion.div className="relative h-full shrink-0" style={{ width: animatedWidth }}>
        <div
          role="separator"
          aria-label={t("team.inspector.resize")}
          aria-orientation="vertical"
          aria-valuemin={minimum}
          aria-valuemax={maximum}
          aria-valuenow={width}
          tabIndex={0}
          className="team-inspector-resizer"
          onPointerDown={startResize}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowLeft" ? width + 10
                : event.key === "ArrowRight" ? width - 10
                : event.key === "Home" ? minimum
                : event.key === "End" ? maximum
                : undefined;
            if (next === undefined) return;
            event.preventDefault();
            commitWidth(clampWidth(next, shellWidth, reservedLeftWidth));
          }}
          onDoubleClick={() => {
            cancelResize();
            commitWidth(DEFAULT_INSPECTOR_WIDTH);
          }}
        >
          <span />
        </div>
        <div className="q-sidebar-clip">
          <div className="q-sidebar-frame" style={{ width, minWidth: width }}>
            {children}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
