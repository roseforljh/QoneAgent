import { createHash } from "node:crypto";
import type { ExecutionIncidentRepo, RunRepo } from "@qone/database";
import type { BackgroundShellJobInfo } from "@qone/protocol";

const COMMAND_TOOLS = new Set(["powershell", "bash", "server_exec", "server_terminal", "codemode"]);
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls", "server_read_file", "server_write_file", "server_edit", "server_upload", "server_download"]);
const toolLabel = (name: string) => COMMAND_TOOLS.has(name) || FILE_TOOLS.has(name) ? name : "other-tool";
type Reason = "cancelled" | "permission" | "timeout" | "shell-syntax" | "script-syntax" | "regex" | "missing-path" | "missing-command" | "invalid-tool-call" | "invalid-arguments" | "transport" | "nonzero-exit" | "unclassified";

/** Controlled classification of a failed tool or run; the raw text never leaves this module. */
export function reasonFor(text: string, exitCode: number | null, timedOut = false): Reason {
  const value = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  if (timedOut || /\b(?:command timed out|deadline exceeded|TimeoutError)\b/i.test(value)) return "timeout";
  if (exitCode === null && /(?:^|\n)(?:Command aborted|Operation aborted|Script aborted:[^\n]*|AbortError:[^\n]*|The operation was aborted\.?)\s*$/i.test(value)) return "cancelled";
  if (/permission denied|denied by permission policy|rejected by user|not approved/i.test(value)) return "permission";
  if (/regex parse error|invalid regular expression|unclosed (?:group|character class)/i.test(value)) return "regex";
  if (/ParserError:|syntax error near unexpected|unexpected EOF while looking for/i.test(value)) return "shell-syntax";
  if (/\b(?:SyntaxError|ReferenceError):/i.test(value)) return "script-syntax";
  if (/\bENOENT\b|no such file|cannot find path|找不到路径|os error [23]\)/i.test(value)) return "missing-path";
  if (/command not found|CommandNotFoundException|not recognized as the name|不会被识别/i.test(value)) return "missing-command";
  if (/tool .{1,120} not found|tools\..{1,120} does not exist|invalid (?:tool (?:name|arguments)|arguments)|validation failed/i.test(value)) return "invalid-tool-call";
  if (/\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)\b|failed to connect|unable to exec|SSH channel/i.test(value)) return "transport";
  return exitCode ? "nonzero-exit" : "unclassified";
}

/** Agent-initiated stops are interruptions, not mistakes; they are never recorded as failures. */
const INTERRUPTION = /run aborted|run force-stopped|session .* already has an active run|run aborted|AbortError/i;

/**
 * Records execution failures with allowlisted labels only: no command text and no
 * tool output. The provider/model always comes from the run row, so a subagent's
 * failure is attributed to the model that actually ran it, not to its parent.
 */
export class ExecutionRecorder {
  constructor(
    private incidents: ExecutionIncidentRepo,
    private runs: RunRepo,
    private recordEnabled: () => boolean,
  ) {}

  toolFailed(runId: string, toolCallId: string, toolName: string, result: unknown, at: number): void {
    const outcome = this.classifyTool(result);
    if (!outcome) return;
    this.insert(`tool:${hash(`${runId}:${toolCallId}`)}`, runId, toolLabel(toolName), outcome.outcome, outcome.reason, at);
  }

  background(job: BackgroundShellJobInfo, toolName: string, runId?: string) {
    const id = `background:${hash(`${job.sessionId}:${job.startedAt}:${job.id}`)}`;
    if (job.status === "running") {
      if (runId) this.insert(id, runId, toolLabel(toolName), "interrupted", "outcome-unknown", job.startedAt);
      return;
    }
    if (!this.incidents.backgroundOwner(id)) return;
    const reason = reasonFor(job.output.slice(-4_096), job.exitCode ?? null);
    const failed = this.recordEnabled() && job.status !== "stopped" && job.exitCode !== 0 && reason !== "cancelled";
    this.incidents.finishBackground(id, job.endedAt ?? Date.now(), failed ? reason : undefined);
  }

  runFailed(runId: string, at: number, error?: string): void {
    if (INTERRUPTION.test(error ?? "")) return;
    const reason = reasonFor(error?.slice(0, 4_096) ?? "", null);
    if (reason === "cancelled") return;
    this.insert(`run:${hash(runId)}`, runId, null, "failed", reason, at);
  }

  private insert(id: string, runId: string, tool: string | null, outcome: "failed" | "interrupted", reason: string, at: number) {
    if (!this.recordEnabled()) return;
    // The run row owns both the session and the model: one lookup, no guessed attribution.
    const run = this.runs.get(runId) as { sessionId?: string; model?: string | null } | undefined;
    const slash = (run?.model ?? "").indexOf("/");
    if (!run?.sessionId || slash <= 0 || !run.model) return;
    const provider = run.model.slice(0, slash), model = run.model.slice(slash + 1);
    // A subagent run is a separate run row, so a parent tool failure and its child's
    // failure have distinct ids; only the child's own tool calls are recorded here.
    this.incidents.add({ id, sessionId: run.sessionId, runId, tool, provider, model, outcome, reason, at });
  }

  private classifyTool(result: unknown): { outcome: "failed" | "interrupted"; reason: Reason } | undefined {
    const value = result as { content?: { type: string; text?: string }[]; structuredContent?: { exit_code?: number; timed_out?: boolean }; details?: { cancelled?: boolean } } | undefined;
    if (value?.details?.cancelled) return undefined; // Cancelled by the user: not a failure.
    const text = (value?.content ?? []).slice(0, 3).map(part => part.type === "text" ? part.text?.slice(-4_096) ?? "" : "").join("\n");
    let exitCode = value?.structuredContent?.exit_code;
    let timedOut = value?.structuredContent?.timed_out === true;
    // Older tool results and abnormal SSH exits carry a text block instead of structured content.
    const remote = value?.content?.[0]?.text;
    if (remote?.startsWith("{")) try {
      const parsed = JSON.parse(remote) as { exit_code?: number; timed_out?: boolean } | null;
      exitCode ??= parsed?.exit_code;
      timedOut ||= parsed?.timed_out === true;
    } catch { /* Not a structured payload. */ }
    const code = Number.isSafeInteger(exitCode) ? exitCode! : null;
    const reason = reasonFor(text, code, timedOut);
    if (reason === "cancelled") return undefined;
    return { outcome: "failed", reason };
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
