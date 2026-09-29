import { useEffect, useMemo, useRef, useState } from "react";
import { CodexIcon } from "../ui/CodexIcon";
import searchIcon from "../../assets/codex-icons/magnifying-glass-lg-light-16.svg";
import clockIcon from "../../assets/codex-icons/clock-light-16.svg";
import arrowIcon from "../../assets/codex-icons/arrow-right-lg-light-16.svg";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";

export function ChatSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useStore((state) => state.searchResults);
  const sessions = useStore((state) => state.sessions);
  const recentChats = useMemo(() => sessions.slice(0, 8), [sessions]);
  const loading = useStore((state) => state.searchLoading);
  const searchSessions = useStore((state) => state.searchSessions);
  const selectSession = useStore((state) => state.selectSession);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    useStore.setState({ searchResults: [], searchLoading: false });
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchSessions(query), query.trim() ? 160 : 0);
    return () => window.clearTimeout(timer);
  }, [query, searchSessions]);

  const handleSelect = (id: string) => {
    selectSession(id);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent className="q-chat-search-dialog" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>{t("sidebar.searchChats")}</DialogTitle>
          <DialogDescription>{t("sidebar.searchChatsDescription")}</DialogDescription>
        </DialogHeader>
        <div className="q-chat-search-input-wrap">
          <CodexIcon src={searchIcon} className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
            placeholder={t("sidebar.searchChatsPlaceholder")}
            aria-label={t("sidebar.searchChats")}
            autoComplete="off"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="q-chat-search-results" aria-live="polite">
          {!query.trim() && recentChats.length > 0 && <>
            <p className="q-chat-search-section-label">{t("sidebar.recentChats")}</p>
            {recentChats.map((session) => <button key={session.id} type="button" className="q-chat-search-result" onClick={() => handleSelect(session.id)}>
              <span className="q-chat-search-result-icon"><CodexIcon src={clockIcon} className="size-4" /></span>
              <span className="q-chat-search-result-copy"><strong>{session.title}</strong></span>
              <CodexIcon src={arrowIcon} className="q-chat-search-result-arrow size-4" />
            </button>)}
          </>}
          {!query.trim() && recentChats.length === 0 && <p className="q-chat-search-hint"><CodexIcon src={clockIcon} className="size-4" />{t("sidebar.searchChatsHint")}</p>}
          {query.trim() && loading && <p className="q-chat-search-hint">{t("sidebar.searchingChats")}</p>}
          {query.trim() && !loading && results.length === 0 && <p className="q-chat-search-hint">{t("sidebar.noMatchingChats")}</p>}
          {results.map((result) => (
            <button key={result.session.id} type="button" className="q-chat-search-result" onClick={() => handleSelect(result.session.id)}>
              <span className="q-chat-search-result-icon"><CodexIcon src={clockIcon} className="size-4" /></span>
              <span className="q-chat-search-result-copy">
                <strong>{result.session.title}</strong>
                {result.snippet && <span>{result.snippet}</span>}
              </span>
              <CodexIcon src={arrowIcon} className="q-chat-search-result-arrow size-4" />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
