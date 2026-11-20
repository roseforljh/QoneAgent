import type { ExecutionStats } from "../execution-stats.js";
import type { MemoryComplete } from "./memory-consolidator.js";

const INTERVAL_MS = 4 * 60 * 60_000;

// The summary model chooses from known, scoped suggestions; its free-form text never enters a tool result.
const corrections = {
  "rg-path": { tool: "powershell", reason: "missing-path", text: "For rg on PowerShell, pass a real directory as the search path; pass filename patterns with -g.",
    matches: ({ command }) => typeof command === "string" && /^\s*rg(?:\.exe)?\s+[^\r\n|;]+/i.test(command) && /[\\/][^\s|;]*[*?]/.test(command) },
  "literal-local": { tool: "grep", reason: "regex", text: "If you intend a literal search, pass literal: true; otherwise check regex escaping.",
    matches: ({ pattern, literal }) => literal !== true && typeof pattern === "string" && /[\\()[\]{}*+?|]/.test(pattern) },
  "ssh-cwd": { tool: "server_exec", reason: "missing-path", text: "Check cwd on the selected SSH host. A local path or a path inside a container is not the SSH host's working directory.",
    matches: ({ cwd }) => typeof cwd === "string" && cwd.length > 0 },
  "codemode-path": { tool: "codemode", reason: "script-syntax", text: "For Windows paths in JavaScript strings, use forward slashes or escape each backslash.",
    matches: ({ code }) => typeof code === "string" && /\b[A-Z]:\\/i.test(code) },
} satisfies Record<string, { tool: string; reason: string; text: string; matches(args: Record<string, unknown>): boolean }>;

const isCorrection = (value: unknown): value is keyof typeof corrections => typeof value === "string" && Object.hasOwn(corrections, value);

export class MemoryIncidents {
  private timer?: ReturnType<typeof setInterval>;
  private active?: AbortController;

  constructor(private input: {
    stats: Pick<ExecutionStats, "consentVersion" | "pendingAnalysis" | "saveAnalysis" | "lessons">;
    permission(): string | undefined;
    complete(signal: AbortSignal): MemoryComplete;
    onError(error: unknown): void;
  }) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), INTERVAL_MS);
    this.timer.unref?.();
    void this.check();
  }

  invalidate() { this.active?.abort(); }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.invalidate();
  }

  async check() {
    const { stats, permission, complete, onError } = this.input;
    const key = permission();
    if (key === undefined || this.active) return;
    const version = stats.consentVersion;
    const active = this.active = new AbortController();
    const allowed = () => !active.signal.aborted && key === permission() && version === stats.consentVersion;
    try {
      for (const batch of stats.pendingAnalysis()) {
        if (!allowed()) break;
        const candidates = Object.entries(corrections).flatMap(([id, rule]) => {
          const record = batch.rows.find(({ tool, reason }) => tool === rule.tool && reason === rule.reason);
          return record && record.count >= 2 ? [{ id, ...record }] : [];
        });
        if (!candidates.length) continue;
        const reply = await complete(active.signal)(
          "Review repeated execution symptoms. Counts do not prove model fault. Return a JSON array of the suggested IDs worth reminding the model about. Return [] if unsure. Do not add other text or keys.",
          JSON.stringify({ model: batch.model, provider: batch.provider, candidates }),
          128,
        );
        if (!allowed()) break;
        const selected: unknown = JSON.parse(reply.text.trim());
        const offered = new Set(candidates.map(({ id }) => id));
        if (!Array.isArray(selected) || !selected.every((id) => isCorrection(id) && offered.has(id))) throw new Error("Invalid execution analysis response");
        stats.saveAnalysis(batch, [...new Set(selected as (keyof typeof corrections)[])].map((advice) => ({
          advice, tool: corrections[advice].tool, reason: corrections[advice].reason,
        })));
      }
    } catch (error) {
      if (allowed()) onError(error);
    } finally { this.active = undefined; }
  }

  advice(provider: string, model: string, tool: string, args: unknown): string | undefined {
    if (this.input.permission() === undefined || !args || typeof args !== "object") return;
    for (const { tool: target, advice } of this.input.stats.lessons(provider, model)) {
      if (target !== tool || !isCorrection(advice)) continue;
      const rule = corrections[advice];
      if (rule.tool === tool && rule.matches(args as Record<string, unknown>)) return rule.text;
    }
  }
}
