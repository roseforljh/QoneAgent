import { useEffect, useMemo, useState } from "react";
import { Globe, KeyRound, MessageCircleQuestion } from "lucide-react";
import type { McpElicitationContent, McpElicitationField, McpElicitationInfo } from "@qone/protocol";
import { QoneSelect } from "../ui/Select";
import { cn } from "../../lib/utils";
import { openBrowserInDock } from "../../lib/browser-dock";
import { useLocale, type MessageKey } from "../../localization";
import { useStore } from "../../store";
import { useConversationStore } from "../../lib/conversation-context";
import { respondToElicitation, useElicitationStore } from "../../lib/elicitation-state";
import "../settings/servers/servers.css";
import "./elicitation-panel.css";

type Value = string | boolean | string[];
type Choice = { value: string; label: string };
type Problem = { key: MessageKey; values?: Record<string, string | number> };
type Checked = { value: McpElicitationContent[string] } | { problem: Problem };

function choices(field: McpElicitationField): Choice[] | undefined {
  if (field.oneOf) return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  if (field.enum) return field.enum.map((value, index) => ({ value, label: field.enumNames?.[index] ?? value }));
  if (field.items?.anyOf) return field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
  if (field.items?.enum) return field.items.enum.map((value) => ({ value, label: value }));
  return undefined;
}

function initialValue(field: McpElicitationField): Value {
  if (field.type === "boolean") return field.default === true;
  if (field.type === "array") return Array.isArray(field.default) ? field.default.map(String) : [];
  return field.default === undefined ? "" : String(field.default);
}

const inputType = (field: McpElicitationField) => field.type === "number" || field.type === "integer" ? "number"
  : field.format === "password" ? "password"
  : field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : field.format === "date-time" ? "datetime-local" : "text";

// Same rules the MCP SDK checks before the answer leaves (ajv-formats, full mode).
const EMAIL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function check(field: McpElicitationField, value: Value): Checked {
  if (field.type === "number" || field.type === "integer") {
    const number = Number(value);
    if (!Number.isFinite(number)) return { problem: { key: "elicitation.invalid.number" } };
    if (field.type === "integer" && !Number.isInteger(number)) return { problem: { key: "elicitation.invalid.integer" } };
    if (field.minimum !== undefined && number < field.minimum) return { problem: { key: "elicitation.invalid.min", values: { min: field.minimum } } };
    if (field.maximum !== undefined && number > field.maximum) return { problem: { key: "elicitation.invalid.max", values: { max: field.maximum } } };
    return { value: number };
  }
  if (typeof value !== "string") return { value };
  if (field.minLength !== undefined && value.length < field.minLength) return { problem: { key: "elicitation.invalid.minLength", values: { count: field.minLength } } };
  if (field.maxLength !== undefined && value.length > field.maxLength) return { problem: { key: "elicitation.invalid.maxLength", values: { count: field.maxLength } } };
  if (field.format === "email" && !EMAIL.test(value)) return { problem: { key: "elicitation.invalid.email" } };
  if (field.format === "uri" && !URL.parse(value)?.protocol) return { problem: { key: "elicitation.invalid.uri" } };
  if (field.format === "date-time") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? { problem: { key: "elicitation.invalid.date" } } : { value: date.toISOString() };
  }
  return { value };
}

/** The answer in the server's types, or what is wrong with each field. */
function validate(request: McpElicitationInfo, values: Record<string, Value>) {
  const content: McpElicitationContent = {};
  const problems: Record<string, Problem> = {};
  for (const [name, field] of Object.entries(request.fields ?? {})) {
    const value = values[name] ?? initialValue(field);
    if (value === "" || (Array.isArray(value) && !value.length)) {
      if (request.required?.includes(name)) problems[name] = { key: "elicitation.invalid.required" };
      continue;
    }
    const result = check(field, value);
    if ("problem" in result) problems[name] = result.problem;
    else content[name] = result.value;
  }
  return { content, problems, valid: !Object.keys(problems).length };
}

/**
 * A question an MCP server asks while one of its tools runs. It sits above the
 * composer of the conversation that made the call, so the reply that led to it
 * stays readable.
 */
export function ElicitationPanel() {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  // Side chats render their own thread; a question shows only in the conversation that asked it.
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const mainSessionId = useStore((state) => state.currentSessionId);
  const request = useElicitationStore((state) => state.requests.find((item) => item.sessionId ? item.sessionId === sessionId : sessionId === mainSessionId));
  const [values, setValues] = useState<Record<string, Value>>({});
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    setValues(Object.fromEntries(Object.entries(request?.fields ?? {}).map(([name, field]) => [name, initialValue(field)])));
    setAttempted(false);
  }, [request?.id]);
  const result = useMemo(() => request?.mode === "form" ? validate(request, values) : undefined, [request, values]);
  if (!request) return null;

  const respond = (action: "accept" | "decline" | "cancel", body?: McpElicitationContent) => void respondToElicitation(send, request.id, action, body);
  const submit = () => {
    setAttempted(true);
    if (result?.valid) respond("accept", result.content);
  };
  const url = request.mode === "url" ? URL.parse(request.url ?? "") : null;
  const safeUrl = url && ["https:", "http:"].includes(url.protocol) ? url : null;
  const set = (name: string, value: Value) => setValues((current) => ({ ...current, [name]: value }));
  const problem = (name: string) => attempted ? result?.problems[name] : undefined;
  const secret = request.secretTarget;

  return <section className="elicitation-panel" role="dialog" aria-labelledby={`elicitation-${request.id}`}>
    <header>
      {secret ? <KeyRound size={15} aria-hidden="true" /> : request.mode === "url" ? <Globe size={15} aria-hidden="true" /> : <MessageCircleQuestion size={15} aria-hidden="true" />}
      <strong id={`elicitation-${request.id}`}>{secret ? t("elicitation.secretTitle") : t(request.mode === "url" ? "elicitation.urlTitle" : "elicitation.title", { server: request.serverName })}</strong>
      {secret && <span className="elicitation-secret-hint">{t("elicitation.secretHint")}</span>}
    </header>
    <div className="elicitation-body">
      {request.message && <p className="elicitation-message">{request.message}</p>}
      {secret && <ul className="elicitation-secret-targets">
        {secret.env && <li>{secret.server ? t("elicitation.secretServerEnv", { name: secret.env, server: secret.server }) : t("elicitation.secretEnv", { name: secret.env })}</li>}
        {secret.file && <li title={secret.file}>{t("elicitation.secretFile", { file: secret.server ? `${secret.server}:${secret.file}` : secret.file })}</li>}
      </ul>}
      {request.mode === "url" && safeUrl && <p className="servers-hint">{t("elicitation.urlHint", { host: safeUrl.host })}</p>}
      {request.mode === "form" && <form className="servers-form" noValidate onSubmit={(event) => { event.preventDefault(); submit(); }}>
        {Object.entries(request.fields ?? {}).map(([name, field]) => {
          const label = <span>{field.title ?? name}{request.required?.includes(name) && <em className="elicitation-required"> *</em>}</span>;
          const options = choices(field);
          const value = values[name] ?? initialValue(field);
          const issue = problem(name);
          return <div key={name} className="servers-field">
            {field.type === "boolean"
              ? <div className="elicitation-check">{label}
                  <button type="button" role="switch" aria-checked={value === true} aria-label={field.title ?? name} className={cn("settings-switch", value === true && "is-on")} onClick={() => set(name, value !== true)}><span /></button>
                </div>
              : <>{label}
                {field.type === "array" && options
                  ? <div className="elicitation-options">{options.map((option) => {
                      const selected = (value as string[]).includes(option.value);
                      return <button key={option.value} type="button" aria-pressed={selected} className={cn(selected && "is-active")}
                        onClick={() => set(name, selected ? (value as string[]).filter((item) => item !== option.value) : [...value as string[], option.value])}>{option.label}</button>;
                    })}</div>
                  : options
                  ? <QoneSelect value={String(value)} onChange={(next) => set(name, next)} options={options} ariaLabel={field.title ?? name} className="servers-select" triggerClassName="servers-select-trigger" />
                  : <input type={inputType(field)} value={String(value)} onChange={(event) => set(name, event.target.value)} min={field.minimum} max={field.maximum}
                      step={field.type === "integer" ? 1 : "any"} aria-invalid={Boolean(issue) || undefined}
                      {...field.format === "password" ? { autoComplete: "off", spellCheck: false, autoFocus: true } : {}} />}
              </>}
            {issue ? <small className="elicitation-problem" role="alert">{t(issue.key, issue.values)}</small> : field.description && <small>{field.description}</small>}
          </div>;
        })}
        <button type="submit" hidden />
      </form>}
    </div>
    <footer>
      <button type="button" className="servers-button" onClick={() => respond("decline")}>{t("elicitation.decline")}</button>
      {request.mode === "url"
        ? <button type="button" className="servers-button is-primary" disabled={!safeUrl} onClick={() => { openBrowserInDock(safeUrl!.toString(), sessionId); respond("accept"); }}>{t("elicitation.open")}</button>
        : <button type="button" className="servers-button is-primary" onClick={submit}>{t("elicitation.submit")}</button>}
    </footer>
  </section>;
}
