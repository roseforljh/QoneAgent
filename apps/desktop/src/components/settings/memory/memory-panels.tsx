import { useMemo, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import ReactMarkdown from "react-markdown";
import { Search } from "lucide-react";
import { MEMORY_PREFERENCE_MAX_LENGTH, type MemoryAutomaticPreference, type MemoryNoteInfo, type MemoryPreferenceScope, type MemoryStateInfo, type MemorySummaryInfo, type WorkspaceInfo } from "@qone/protocol";
import { cn } from "../../../lib/utils";
import { confirmDestructiveAction } from "../../../lib/confirm-action";
import { useLocale, type MessageKey } from "../../../localization";
import { CodexIcon } from "../../ui/CodexIcon";
import trashIcon from "../../../assets/codex-icons/trash-light-16.svg";
import documentIcon from "../../../assets/codex-icons/document-text-light-16.svg";
import { NestedDialog } from "../nested-dialog";
import { QoneSelect } from "../../ui/Select";

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
  if (!summaries.length) return <Empty title={t("memory.summariesEmptyTitle")} body={t("memory.summariesEmptyBody")} />;
  return <>
    <label className="memory-search"><Search size={14} /><input aria-label={t("memory.searchSummaries")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("memory.searchSummaries")} /></label>
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

export function SummaryDialog({ summary, relative, workspace, canResume, onResume, onOpenChange, onDelete }: {
  summary?: MemorySummaryInfo; relative: Relative; workspace?: WorkspaceInfo; canResume: boolean;
  onResume: (summary: MemorySummaryInfo, workspace: WorkspaceInfo) => void;
  onOpenChange: (open: boolean) => void; onDelete: (id: string) => void;
}) {
  const { t } = useLocale();
  if (!summary) return null;
  return (
    <NestedDialog open onOpenChange={onOpenChange} wide title={summary.title || t("memory.untitled")} description={t("memory.conversationMeta", { time: relative(summary.sourceUpdatedAt) })}
      footer={<>
        <button type="button" className="memory-button is-danger" onClick={async () => { if (await confirmDestructiveAction(t("memory.forgetConversationConfirm"))) onDelete(summary.id); }}>{t("memory.forgetConversation")}</button>
        {workspace && <button type="button" className="memory-button is-primary" disabled={!canResume}
          onClick={() => onResume(summary, workspace)}>{t("memory.resume")}</button>}
      </>}>
      {workspace && <p className="memory-hint">{t("memory.resumeDescription", { workspace: workspace.name })}</p>}
      <div className="memory-markdown"><ReactMarkdown>{summary.content}</ReactMarkdown></div>
    </NestedDialog>
  );
}

const NOTE_SCOPE = "note";
const GLOBAL_SCOPE = "global";
const workspaceScope = (id: string) => `workspace:${id}`;
const noteScope = ({ preference }: Pick<MemoryNoteInfo, "preference">) => preference?.workspaceId ? workspaceScope(preference.workspaceId) : preference ? GLOBAL_SCOPE : NOTE_SCOPE;
const scopeValue = (scope: string): MemoryPreferenceScope | null => scope === NOTE_SCOPE ? null : scope === GLOBAL_SCOPE ? {} : { workspaceId: scope.slice("workspace:".length) };
type ScopeOption = { value: string; label: string };

function ScopeSelect({ scope, options, onChange, disabled }: { scope: string; options: ScopeOption[]; onChange: (scope: string) => void; disabled: boolean }) {
  const { t } = useLocale();
  return <QoneSelect value={scope} options={options} onChange={onChange} ariaLabel={t("memory.scope")} disabled={disabled}
    className="settings-select-wrap" triggerClassName="qone-select-trigger-compact settings-value-button" menuClassName="settings-dropdown" align="end" />;
}

const validDraft = (text: string, scope: string) => Boolean(text.trim()) && (scope === NOTE_SCOPE || Array.from(text.trim()).length <= MEMORY_PREFERENCE_MAX_LENGTH);

export function MemoryAutomaticPreferences({ preferences, summaries, workspaces, busy, onEdit, onOpenSummary }: {
  preferences: MemoryAutomaticPreference[]; summaries: MemorySummaryInfo[]; workspaces: WorkspaceInfo[];
  busy: boolean; onOpenSummary: (id: string) => void;
  onEdit: (id: string, value: { content: string; preference: MemoryPreferenceScope } | null) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState<string>();
  const options = [{ value: GLOBAL_SCOPE, label: t("memory.scopeGlobal") }, ...workspaces.map(({ id, name }) => ({ value: workspaceScope(id), label: name }))];
  return <section className="memory-automatic-list" aria-label={t("memory.automaticPreferences")}>
    <h3>{t("memory.automaticPreferences")}</h3>
    {!preferences.length && <p className="memory-hint">{t("memory.automaticPreferencesEmpty")}</p>}
    {preferences.map((item) => <article className="memory-automatic-preference" key={item.id}>
      {editing === item.id ? <NoteEditor note={item} options={options} busy={busy}
        saveLabel={t("memory.saveManualPreference")} onCancel={() => setEditing(undefined)}
        onSave={async (content, scope) => {
          const preference = scopeValue(scope);
          if (preference && await onEdit(item.id, { content, preference })) setEditing(undefined);
        }} /> : <>
        <p>{item.content}</p>
        <footer>
          <span className="memory-chip">{options.find((option) => option.value === noteScope(item))?.label ?? t("memory.scopeMissing")}</span>
          <button
            type="button"
            className="memory-button"
            disabled={busy}
            onClick={async () => {
              if (await confirmDestructiveAction(t("memory.removeAutomaticPreferenceConfirm"))) {
                await onEdit(item.id, null);
              }
            }}
          >
            {t("memory.removeAutomaticPreference")}
          </button>
          <button type="button" className="memory-button" disabled={busy} onClick={() => setEditing(item.id)}>{t("memory.edit")}</button>
        </footer>
      </>}
      <details className="memory-preference-sources">
        <summary>{t("memory.sources", { count: item.sources.length })}</summary>
        {item.sources.map(({ id, quote }) => <div key={id}>
          <button type="button" className="memory-conv-link" onClick={() => onOpenSummary(id)}>{summaries.find((summary) => summary.id === id)?.title || t("memory.untitled")}</button>
          <blockquote>{quote}</blockquote>
        </div>)}
      </details>
    </article>)}
  </section>;
}

export function MemoryNotes({ notes, relative, busy, preferences = false, workspaceId, workspaces, onSave, onDelete }: {
  notes: MemoryNoteInfo[]; relative: Relative; busy: boolean; preferences?: boolean; workspaceId?: string; workspaces: WorkspaceInfo[];
  onSave: (content: string, id: string | undefined, preference: MemoryPreferenceScope | null) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [selectedScope, setScope] = useState<string>();
  const options = [{ value: NOTE_SCOPE, label: t("memory.scopeNote") }, { value: GLOBAL_SCOPE, label: t("memory.scopeGlobal") },
    ...workspaces.map(({ id, name }) => ({ value: workspaceScope(id), label: name }))];
  const scope = !preferences ? NOTE_SCOPE : selectedScope ?? (workspaceId ? workspaceScope(workspaceId) : GLOBAL_SCOPE);
  const allowed = !busy && options.some((option) => option.value === scope) && validDraft(draft, scope);
  const add = async () => {
    if (allowed && await onSave(draft, undefined, scopeValue(scope))) {
      setDraft("");
      setAdding(false);
    }
  };
  const placeholder = t(preferences ? "memory.preferencePlaceholder" : "memory.noteEmpty");
  return <>
    {preferences && <div className="memory-preferences-heading">
      <h3>{t("memory.manualPreferences")}</h3>
      <button type="button" className="memory-button" aria-expanded={adding} disabled={busy}
        onClick={() => setAdding(!adding)}>{t(adding ? "memory.cancel" : "memory.addPreference")}</button>
    </div>}
    {(!preferences || adding) && <div className="memory-composer">
      <textarea autoFocus={preferences} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label={placeholder} placeholder={placeholder} rows={2}
        maxLength={preferences ? MEMORY_PREFERENCE_MAX_LENGTH : undefined}
        onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void add(); } }} />
      <footer>
        <span>{t("memory.saveShortcut")}</span>
        {preferences && <ScopeSelect scope={scope} options={options.slice(1)} onChange={setScope} disabled={busy} />}
        <button type="button" className="memory-button is-primary" disabled={!allowed} onClick={() => void add()}>{t("memory.save")}</button>
      </footer>
    </div>}
    {preferences && !notes.length && !adding && <p className="memory-hint">{t("memory.manualPreferencesEmpty")}</p>}
    <div className="memory-note-grid">
      <AnimatePresence initial={false}>
        {notes.map((note) => (
          <motion.div key={note.id} layout initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.16 }}>
            {editing === note.id
              ? <NoteEditor note={note} options={options} busy={busy} onCancel={() => setEditing(undefined)}
                onSave={async (content, scope) => { if (await onSave(content, note.id, scopeValue(scope))) setEditing(undefined); }} />
              : <article className="memory-note-card" tabIndex={preferences ? undefined : 0}
                onClick={preferences ? undefined : () => setEditing(note.id)}
                onKeyDown={preferences ? undefined : (event) => { if (event.key === "Enter" && event.target === event.currentTarget) setEditing(note.id); }}>
                <p>{note.content}</p>
                <footer>
                  <span className={cn("memory-chip", !note.preference && note.origin === "chat" && "is-chat")}>
                    {note.preference ? options.find((option) => option.value === noteScope(note))?.label ?? t("memory.scopeMissing") : t(note.origin === "chat" ? "memory.fromChat" : "memory.manual")}
                  </span>
                  <time>{relative(note.updatedAt)}</time>
                  {preferences && <button type="button" className="memory-button" disabled={busy} onClick={() => setEditing(note.id)}>{t("memory.edit")}</button>}
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

function NoteEditor({ note, options, busy, saveLabel, onSave, onCancel }: { note: Pick<MemoryNoteInfo, "content" | "preference">; options: ScopeOption[]; busy: boolean; saveLabel?: string; onSave: (content: string, scope: string) => void; onCancel: () => void }) {
  const { t } = useLocale();
  const [text, setText] = useState(note.content);
  const [scope, setScope] = useState(() => noteScope(note));
  const allowed = !busy && (saveLabel || text.trim() !== note.content || scope !== noteScope(note)) && validDraft(text, scope) && options.some((option) => option.value === scope);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (allowed) onSave(text, scope); }
  };
  return (
    <div className="memory-note-card is-editing">
      <textarea value={text} aria-label={t("memory.edit")} autoFocus onChange={(event) => setText(event.target.value)} onKeyDown={keys}
        onFocus={(event) => event.currentTarget.setSelectionRange(text.length, text.length)} />
      <footer>
        <span className="memory-hint">{t("memory.saveShortcut")}</span>
        <ScopeSelect scope={scope} options={options} onChange={setScope} disabled={busy} />
        <button type="button" className="memory-button" onClick={onCancel}>{t("memory.cancel")}</button>
        <button type="button" className="memory-button is-primary" disabled={!allowed} onClick={() => onSave(text, scope)}>{saveLabel ?? t("memory.save")}</button>
      </footer>
    </div>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="memory-empty"><strong>{title}</strong><p>{body}</p></div>;
}
