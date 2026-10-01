import { useAuiState } from "@assistant-ui/react";
import { CodexIcon } from "../ui/CodexIcon";
import arrowDown from "../../assets/codex-icons/arrow-down-lg-light-16.svg";
import { useLocale } from "../../localization";
import { useThreadBottomControl } from "./thread-scroll-follower";
import "./thread-scroll-to-bottom.css";

// ScrollToBottom's physical-bottom predicate includes top-anchor slack.
// Keep the official viewport/anchor primitives and share our real-tail predicate instead.
export function ThreadScrollToBottomButton({ show, running, onClick, label }: {
  show: boolean; running: boolean; onClick: () => void; label: string;
}) {
  return <div className="q-thread-bottom-anchor">
    <button
      type="button"
      className="q-thread-scroll-to-bottom"
      data-visible={show}
      data-working={show && running}
      aria-label={label}
      aria-hidden={!show}
      tabIndex={show ? undefined : -1}
      onClick={show ? onClick : undefined}
    >
      {show && running && <span aria-hidden="true" className="q-thread-bottom-dots"><span /><span /><span /></span>}
      <CodexIcon src={arrowDown} className="q-thread-bottom-arrow" />
    </button>
  </div>;
}

export function ThreadScrollToBottom() {
  const { show, scrollToBottom } = useThreadBottomControl();
  const running = useAuiState((state) => state.thread.isRunning);
  const { t } = useLocale();
  return <ThreadScrollToBottomButton show={show} running={running} onClick={scrollToBottom} label={t("chat.scrollToBottom")} />;
}
