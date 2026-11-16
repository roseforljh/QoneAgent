import { useMemo, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import { Search } from "lucide-react";
import type { MemoryNoteInfo, MemoryStateInfo, MemorySummaryInfo } from "@qone/protocol";
import { cn } from "../../../lib/utils";
import { confirmDestructiveAction } from "../../../lib/confirm-action";
import { useLocale, type MessageKey } from "../../../localization";
import { CodexIcon } from "../../ui/CodexIcon";
import trashIcon from "../../../assets/codex-icons/trash-light-16.svg";
import documentIcon from "../../../assets/codex-icons/document-text-light-16.svg";
import { NestedDialog } from "../nested-dialog";

type Relative = (at: number) => string;

const OVERVIEW_SECTIONS: Record<string, MessageKey> = {
  "user profile": "memory.sectionProfile",
  "user preferences": "memory.sectionPreferences",
  "general tips": "memory.sectionTips",
  "what's in memory": "memory.sectionContents",
};

/** Plain text preview of a markdown summary for cards. */
const preview = (markdown: string) => markdown.replace(/[#>*_`[\]]+/g, "").replace(/\s+/g, " ").trim();

export function MemoryOverview({ state, relative, onOpenSummary }: { state: MemoryStateInfo; relative: Relative; onOpenSummary: (id: string) => void }) {
  const { t } = useLocale();
  const markdown = useMemo(() => (state.overview?.content ?? "")
    .replace(/^##\s+(.+)$/gm, (line, heading: string) => {
      const key = OVERVIEW_SECTIONS[heading.trim().toLowerCase()];
      return key ? `## ${t(key)}` : line;
    })
    // Pointers to chat memories become links; ones whose summary was deleted are dropped.
    .replace(/\[conv:([^\]\s]+)\]/g, (_match, id: string) => {
      const summary = state.summaries.find((item) => item.id === id);
      return summary ? `[${summary.title || t("memory.untitled")}](#conv:${encodeURIComponent(id)})` : "";
    }), [state.overview?.content, state.summaries, t]);
  if (!state.overview) return <Empty title={t("memory.notReady")} body={t("memory.overviewEmpty")} />;
  return (
    <article className="memory-overview">
      <p className="memory-overview-meta">{t("memory.updatedAt", { time: relative(state.overview.generatedAt) })}</p>
      <div className="memory-markdown">
        <ReactMarkdown components={{
          a: ({ href, children }) => href?.startsWith("#conv:")
            ? <button type="button" className="memory-conv-link" onClick={() => onOpenSummary(decodeURIComponent(href.slice(6)))}><CodexIcon src={documentIcon} className="size-3.5" />{children}</button>
            : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}>{markdown}</ReactMarkdown>
      </div>
    </article>
  );
}

export function MemorySummaries({ summaries, relative, onOpen, onDelete }: { summaries: MemorySummaryInfo[]; relative: Relative; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle ? summaries.filter((item) => `${item.title}\n${item.content}`.toLowerCase().includes(needle)) : summaries;
  if (!summaries.length) return <Empty title={t("memory.summariesEmptyTitle")} body={t("memory.overviewEmpty")} />;
  return <>
    <label className="memory-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memory.searchSummaries")} /></label>
    <div className="memory-summary-list">
      <AnimatePresence initial={false}>
        {visible.map((item) => (
          <motion.div key={item.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginBottom: -8 }} transition={{ duration: 0.16 }}>
            <article className="memory-summary-card" tabIndex={0} onClick={() => onOpen(item.id)} onKeyDown={(event) => { if (event.key === "Enter") onOpen(item.id); }}>
              <header>
                <CodexIcon src={documentIcon} className="size-4" />
                <strong>{item.title || t("memory.untitled")}</strong>
                <time>{relative(item.sourceUpdatedAt)}</time>
                <button type="button" className="memory-icon-button" aria-label={t("memory.forgetConversation")} title={t("memory.forgetConversation")}
                  onClick={async (event) => { event.stopPropagation(); if (await confirmDestructiveAction(t("memory.forgetConversationConfirm"))) onDelete(item.id); }}>
                  <CodexIcon src={trashIcon} className="size-4" />
                </button>
              </header>
              <p>{preview(item.content)}</p>
            </article>
          </motion.div>
        ))}
      </AnimatePresence>
      {!visible.length && <p className="memory-hint">{t("memory.noMatch")}</p>}
    </div>
  </>;
}

export function SummaryDialog({ summary, relative, onOpenChange, onDelete }: { summary?: MemorySummaryInfo; relative: Relative; onOpenChange: (open: boolean) => void; onDelete: (id: string) => void }) {
  const { t } = useLocale();
  if (!summary) return null;
  return (
    <NestedDialog open onOpenChange={onOpenChange} wide title={summary.title || t("memory.untitled")} description={t("memory.conversationMeta", { time: relative(summary.sourceUpdatedAt) })}
      footer={<button type="button" className="memory-button is-danger" onClick={async () => { if (await confirmDestructiveAction(t("memory.forgetConversationConfirm"))) onDelete(summary.id); }}>{t("memory.forgetConversation")}</button>}>
      <div className="memory-markdown"><ReactMarkdown>{summary.content}</ReactMarkdown></div>
    </NestedDialog>
  );
}

export function MemoryNotes({ notes, relative, busy, onSave, onDelete }: {
  notes: MemoryNoteInfo[]; relative: Relative; busy: boolean;
  onSave: (content: string, id?: string) => Promise<boolean>; onDelete: (id: string) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string>();
  const add = async () => { if (draft.trim() && await onSave(draft)) setDraft(""); };
  return <>
    <div className="memory-composer">
      <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={t("memory.noteEmpty")} rows={2}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void add(); } }} />
      <footer><span>{t("memory.saveShortcut")}</span><button type="button" className="memory-button is-primary" disabled={busy || !draft.trim()} onClick={() => void add()}>{t("memory.save")}</button></footer>
    </div>
    <div className="memory-note-grid">
      <AnimatePresence initial={false}>
        {notes.map((note) => (
          <motion.div key={note.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.16 }}>
            {editing === note.id
              ? <NoteEditor note={note} busy={busy} onCancel={() => setEditing(undefined)} onSave={async (content) => { if (await onSave(content, note.id)) setEditing(undefined); }} />
              : <article className="memory-note-card" tabIndex={0} onClick={() => setEditing(note.id)} onKeyDown={(event) => { if (event.key === "Enter") setEditing(note.id); }}>
                <p>{note.content}</p>
                <footer>
                  <span className={cn("memory-chip", note.origin === "chat" && "is-chat")}>{t(note.origin === "chat" ? "memory.fromChat" : "memory.manual")}</span>
                  <time>{relative(note.updatedAt)}</time>
                  <button type="button" className="memory-icon-button" aria-label={t("memory.noteDelete")} title={t("memory.noteDelete")}
                    onClick={async (event) => { event.stopPropagation(); if (await confirmDestructiveAction(t("memory.noteDeleteConfirm"))) await onDelete(note.id); }}>
                    <CodexIcon src={trashIcon} className="size-4" />
                  </button>
                </footer>
              </article>}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  </>;
}

function NoteEditor({ note, busy, onSave, onCancel }: { note: MemoryNoteInfo; busy: boolean; onSave: (content: string) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [text, setText] = useState(note.content);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (text.trim() && text !== note.content) onSave(text); }
  };
  return (
    <div className="memory-note-card is-editing">
      <textarea value={text} autoFocus onChange={(event) => setText(event.target.value)} onKeyDown={keys}
        onFocus={(event) => event.currentTarget.setSelectionRange(text.length, text.length)} />
      <footer>
        <span className="memory-hint">{t("memory.saveShortcut")}</span>
        <button type="button" className="memory-button" onClick={onCancel}>{t("memory.cancel")}</button>
        <button type="button" className="memory-button is-primary" disabled={busy || !text.trim() || text === note.content} onClick={() => onSave(text)}>{t("memory.save")}</button>
      </footer>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="memory-empty"><strong>{title}</strong><p>{body}</p></div>;
}
