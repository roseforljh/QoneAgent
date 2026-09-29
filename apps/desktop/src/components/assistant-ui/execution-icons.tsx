import type { ComponentType, HTMLAttributes } from "react";
import { CodexIcon } from "../ui/CodexIcon";
import brain from "../../assets/codex-icons/brain-light-16.svg";
import chevronRight from "../../assets/codex-icons/chevron-right-md-light-16.svg";
import fileSearch from "../../assets/codex-icons/document-badge-magnifyingglass-light-16.svg";
import penLine from "../../assets/codex-icons/pencil-light-16.svg";
import search from "../../assets/codex-icons/magnifying-glass-lg-light-16.svg";
import terminal from "../../assets/codex-icons/terminal-light-16.svg";
import wrench from "../../assets/codex-icons/toolbox-light-16.svg";
import clock3 from "../../assets/codex-icons/clock-light-16.svg";
import x from "../../assets/codex-icons/xmark-md-light-16.svg";
import alertCircle from "../../assets/codex-icons/circle-exclamation-mark-light-16.svg";
import loader2 from "../../assets/codex-icons/spinner-quarter-graded-regular-16.svg";
import rotateCw from "../../assets/codex-icons/arrow-rotate-clockwise-regular-20.svg";
import arrowLeft from "../../assets/codex-icons/arrow-left-md-light-16.svg";
import check from "../../assets/codex-icons/checkmark-md-light-16.svg";

export type ExecutionIcon = ComponentType<HTMLAttributes<HTMLSpanElement> & { size?: number }>;

function icon(src: string): ExecutionIcon {
  return function ExecutionGlyph({ size, style, ...props }) {
    return <CodexIcon src={src} {...props} style={{ ...(size ? { width: size, height: size } : {}), ...style }} />;
  };
}

export const CodexBrainIcon = icon(brain);
export const CodexChevronRightIcon = icon(chevronRight);
export const CodexFileSearchIcon = icon(fileSearch);
export const CodexPenLineIcon = icon(penLine);
export const CodexSearchIcon = icon(search);
export const CodexTerminalIcon = icon(terminal);
export const CodexWrenchIcon = icon(wrench);
export const CodexClock3Icon = icon(clock3);
export const CodexXIcon = icon(x);
export const CodexAlertCircleIcon = icon(alertCircle);
export const CodexLoader2Icon = icon(loader2);
export const CodexRotateCwIcon = icon(rotateCw);
export const CodexArrowLeftIcon = icon(arrowLeft);
export const CodexCheckIcon = icon(check);
