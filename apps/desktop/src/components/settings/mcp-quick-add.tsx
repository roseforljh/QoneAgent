import { useState, type KeyboardEvent } from "react";
import { Popover } from "radix-ui";
import { LoaderCircle, Plus } from "lucide-react";
import { useLocale } from "../../localization";
import { configFields, fieldComplete, parseMcpInput, type ParsedMcp } from "../../lib/mcp-command";
import { CodexIcon } from "../ui/CodexIcon";
import terminalIcon from "../../assets/codex-icons/terminal-light-16.svg";

function describe(input: string): { items: ParsedMcp[]; error?: boolean } {
  try { return { items: parseMcpInput(input) }; }
  catch { return { items: [], error: true }; }
}

/** One line in, configured MCP out: paste an install command, `mcp add` line, URL or JSON snippet. */
export function McpQuickAdd({ onAdd, onManual }: { onAdd: (items: ParsedMcp[]) => Promise<string | undefined>; onManual: () => void }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const { items, error } = describe(input);
  // Keys and headers are reviewed here; README placeholders such as YOUR_API_KEY must be replaced.
  const fields = configFields(items);
  const valueOf = (field: (typeof fields)[number]) => values[field.id] ?? field.prefill;
  const missing = fields.filter(field => !fieldComplete(field, valueOf(field)));
  const ready = items.length > 0 && !missing.length && !busy;
  const submit = async () => {
    if (!ready) return;
    const filled = structuredClone(items);
    for (const field of fields) field.apply(filled[field.index]!, valueOf(field).trim());
    setBusy(true); setFailure("");
    try {
      // The popover stays open until the service really connects, so a wrong key is fixed in place.
      const failed = await onAdd(filled);
      if (failed) setFailure(failed);
      else { setOpen(false); setInput(""); setValues({}); }
    } finally { setBusy(false); }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); }
  };
  const preview = busy ? t("mcp.quickAdd.connecting") : failure || (error ? t("mcp.quickAdd.invalid")
    : items.length === 1 ? t("mcp.quickAdd.found", { name: items[0]!.name, target: items[0]!.url ?? [items[0]!.command, ...items[0]!.args ?? []].join(" ") })
      : items.length > 1 ? t("mcp.quickAdd.foundMany", { count: items.length, names: items.map(item => item.name).join("、") })
        : t("mcp.quickAdd.hint"));
  return <Popover.Root open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
    <Popover.Trigger asChild>
      <button type="button" className="settings-primary-action" aria-expanded={open}><Plus size={15} />{t("mcp.addService")}</button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="settings-mcp-quick-add" side="bottom" align="end" sideOffset={8} collisionPadding={16} onEscapeKeyDown={event => event.stopPropagation()}>
        <label className={error ? "is-invalid" : undefined}>
          <CodexIcon src={terminalIcon} className="size-4" />
          <input autoFocus spellCheck={false} autoComplete="off" aria-label={t("mcp.addService")} placeholder={t("mcp.quickAdd.placeholder")} value={input} disabled={busy} onChange={event => { setInput(event.target.value); setValues({}); setFailure(""); }} onKeyDown={onKeyDown} />
        </label>
        <p className={error || failure ? "is-invalid" : items.length ? "is-ready" : undefined} role={failure ? "alert" : "status"} title={preview}>{preview}</p>
        {fields.length > 0 && <div className="settings-mcp-quick-fields">
          <span>{missing.length ? t("mcp.quickAdd.fill", { count: missing.length }) : t("mcp.quickAdd.review")}</span>
          {fields.map(field => <label key={field.id} className={fieldComplete(field, valueOf(field)) ? "is-complete" : undefined}>
            <em title={items.length > 1 ? `${field.server} · ${field.label}` : field.label}>{items.length > 1 ? `${field.server} · ` : ""}{field.label}</em>
            <input type={field.secret ? "password" : "text"} spellCheck={false} autoComplete="off" disabled={busy} aria-label={field.label} placeholder={t(field.required ? field.secret ? "mcp.pasteKey" : "mcp.quickAdd.value" : "mcp.optional")} value={valueOf(field)} onChange={event => setValues(current => ({ ...current, [field.id]: event.target.value }))} onKeyDown={onKeyDown} />
          </label>)}
        </div>}
        <footer>
          <button type="button" className="settings-mcp-quick-manual" onClick={() => { setOpen(false); onManual(); }}>{t("mcp.quickAdd.manual")}</button>
          <button type="button" className="settings-primary-action" disabled={!ready} onClick={() => void submit()}>{busy && <LoaderCircle size={14} className="settings-spin" aria-hidden="true" />}{t("mcp.add")}</button>
        </footer>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
