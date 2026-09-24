import { motion } from "motion/react";
import type { ReactNode } from "react";
import type { PendingApproval, ToolCall } from "../../store";

const statusStyle: Record<ToolCall["status"], string> = {
  running: "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:border-amber-400/50 dark:bg-amber-400/10 dark:text-amber-300",
  success: "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/50 dark:bg-emerald-400/10 dark:text-emerald-300",
  failed: "border-red-500/50 bg-red-500/10 text-red-700 dark:border-red-400/50 dark:bg-red-400/10 dark:text-red-300",
  waiting: "border-violet-500/50 bg-violet-500/10 text-violet-700 dark:border-violet-400/50 dark:bg-violet-400/10 dark:text-violet-300",
};

function stringify(value: unknown) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function ToolShell({ call, title, children }: { call: ToolCall; title: string; children: ReactNode }) {
  return <motion.article
    initial={{ opacity: 0, y: 4 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.16 }}
    className="mb-2 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground text-xs shadow-sm"
  >
    <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <strong className="text-foreground">{title}</strong>
      <code className="text-muted-foreground">{call.toolName}</code>
      <span className={`ml-auto rounded-full border px-2 py-0.5 font-medium ${statusStyle[call.status]}`}>{call.status}</span>
    </header>
    <div className="p-3">{children}</div>
  </motion.article>;
}

function Result({ value }: { value?: string }) {
  if (!value) return null;
  return <details className="mt-2" open={value.length < 500}>
    <summary className="text-muted-foreground cursor-pointer font-medium">Result</summary>
    <pre className="bg-muted text-foreground mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded p-3">{value}</pre>
  </details>;
}

function FileCard({ call }: { call: ToolCall }) {
  const args = call.args as { path?: string; content?: string } | undefined;
  return <ToolShell call={call} title={call.toolName === "read" ? "File read" : "File created"}>
    <div className="text-foreground/80 font-mono">{args?.path ?? "Unknown path"}</div>
    {args?.content && <pre className="bg-muted text-foreground mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded p-2">{args.content}</pre>}
    <Result value={call.summary} />
  </ToolShell>;
}

function EditCard({ call }: { call: ToolCall }) {
  const args = call.args as { path?: string; edits?: Array<{ oldText?: string; newText?: string }> } | undefined;
  return <ToolShell call={call} title="Code diff">
    <div className="text-foreground/80 mb-2 font-mono">{args?.path ?? "Unknown path"}</div>
    {(args?.edits ?? []).map((edit, index) => <div key={index} className="mb-2 overflow-hidden rounded border border-border font-mono">
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-red-500/10 px-2 py-1 text-red-700 dark:bg-red-400/10 dark:text-red-300">{`- ${edit.oldText ?? ""}`}</pre>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">{`+ ${edit.newText ?? ""}`}</pre>
    </div>)}
    <Result value={call.summary} />
  </ToolShell>;
}

function SearchCard({ call }: { call: ToolCall }) {
  const args = call.args as { pattern?: string; path?: string } | undefined;
  return <ToolShell call={call} title={call.toolName === "ls" ? "Directory tree" : call.toolName === "find" ? "File results" : "Search results"}>
    <div className="text-muted-foreground flex gap-3">
      {args?.pattern && <code>{args.pattern}</code>}
      {args?.path && <code>{args.path}</code>}
    </div>
    <Result value={call.summary} />
  </ToolShell>;
}

function CommandCard({ call }: { call: ToolCall }) {
  const args = call.args as { command?: string; timeout?: number } | undefined;
  return <ToolShell call={call} title="PowerShell command">
    <pre className="bg-muted text-foreground max-h-56 overflow-auto whitespace-pre-wrap rounded p-3 font-mono">{args?.command ?? ""}</pre>
    <Result value={call.summary} />
  </ToolShell>;
}

function ExternalCard({ call }: { call: ToolCall }) {
  const title = call.toolName.startsWith("mcp:") ? "MCP tool" : call.toolName.startsWith("plugin:") ? "Plugin tool" : "Tool";
  return <ToolShell call={call} title={title}>
    {call.args !== undefined && <pre className="bg-muted text-foreground max-h-36 overflow-auto whitespace-pre-wrap rounded p-2">{stringify(call.args)}</pre>}
    <Result value={call.summary} />
  </ToolShell>;
}

export function ToolCard({ call }: { call: ToolCall }) {
  if (call.toolName === "read" || call.toolName === "write") return <FileCard call={call} />;
  if (call.toolName === "edit") return <EditCard call={call} />;
  if (["grep", "find", "ls"].includes(call.toolName)) return <SearchCard call={call} />;
  if (call.toolName === "powershell") return <CommandCard call={call} />;
  return <ExternalCard call={call} />;
}

export function ApprovalCard({ approval, onApprove, onReject }: {
  approval: PendingApproval;
  onApprove: () => void;
  onReject: () => void;
}) {
  return <section className="mx-4 mb-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-foreground shadow-sm dark:border-amber-400/40 dark:bg-amber-400/10" role="alertdialog" aria-labelledby={`approval-${approval.id}`}>
    <div className="flex items-center gap-2">
      <strong id={`approval-${approval.id}`} className="text-amber-800 dark:text-amber-200">Approval required</strong>
      <code className="text-amber-700 dark:text-amber-300">{approval.toolName}</code>
    </div>
    <pre className="bg-background text-foreground mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-3 text-xs">{stringify(approval.args)}</pre>
    <div className="mt-3 flex gap-2">
      <button type="button" onClick={onApprove} className="rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white hover:bg-amber-800">Approve</button>
      <button type="button" onClick={onReject} className="rounded-md border border-amber-500/50 bg-background px-3 py-1.5 font-medium text-amber-800 hover:bg-amber-500/10 dark:border-amber-400/50 dark:text-amber-200">Reject</button>
    </div>
  </section>;
}
