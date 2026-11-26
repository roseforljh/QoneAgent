import type { ExecutionStats } from "../execution-stats.js";
import type { MemoryComplete } from "./memory-consolidator.js";
import { chars, validateMemory } from "./memory-store.js";

const INTERVAL_MS = 4 * 60 * 60_000;
const MAX_CUSTOM_ADVICE_LENGTH = 240;

// 内置精确匹配规则用于针对特定参数形态按需触发；其余重复错误也允许模型生成精简通用教训。
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

function stripFence(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

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
        const repeated = batch.rows.filter((record) => record.count >= 2);
        if (!repeated.length) continue;
        const knownRules = Object.entries(corrections).flatMap(([id, rule]) => {
          const record = repeated.find(({ tool, reason }) => tool === rule.tool && reason === rule.reason);
          return record ? [{ id, ...record }] : [];
        });
        const offeredKnown = new Set(knownRules.map(({ id }) => id));
        const repeatedKeys = new Set(repeated.map(({ tool, reason }) => `${tool}\0${reason}`));
        const reply = await complete(active.signal)(
          "Review repeated execution symptoms. Counts do not prove model fault. Return a JSON array where each element is either a suggested known rule ID string from `candidates`, or an object {\"tool\":\"<exact tool>\",\"reason\":\"<exact reason>\",\"advice\":\"<one short actionable tip under 240 chars>\"} for any repeated symptom in `symptoms`. Return [] if unsure. Do not add other text.",
          JSON.stringify({ model: batch.model, provider: batch.provider, candidates: knownRules, symptoms: repeated }),
          512,
        );
        if (!allowed()) break;
        const selected: unknown = JSON.parse(stripFence(reply.text));
        if (!Array.isArray(selected)) throw new Error("Invalid execution analysis response");
        const parsed: { advice: string; tool: string; reason: string }[] = [];
        const dedup = new Set<string>();
        for (const item of selected) {
          if (typeof item === "string") {
            if (!isCorrection(item) || !offeredKnown.has(item)) throw new Error("Invalid execution analysis response");
            const rule = corrections[item];
            const k = `${rule.tool}\0${rule.reason}\0${item}`;
            if (!dedup.has(k)) { dedup.add(k); parsed.push({ advice: item, tool: rule.tool, reason: rule.reason }); }
            continue;
          }
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid execution analysis response");
          const entry = item as Record<string, unknown>;
          if (typeof entry.tool !== "string" || typeof entry.reason !== "string" || typeof entry.advice !== "string"
            || !repeatedKeys.has(`${entry.tool}\0${entry.reason}`)) {
            throw new Error("Invalid execution analysis response");
          }
          const cleanAdvice = validateMemory(entry.advice.replace(/\s+/gu, " "));
          if (chars(cleanAdvice) > MAX_CUSTOM_ADVICE_LENGTH) throw new Error("Invalid execution analysis response");
          const k = `${entry.tool}\0${entry.reason}\0${cleanAdvice}`;
          if (!dedup.has(k)) { dedup.add(k); parsed.push({ advice: cleanAdvice, tool: entry.tool, reason: entry.reason }); }
        }
        stats.saveAnalysis(batch, parsed);
      }
    } catch (error) {
      if (allowed()) onError(error);
    } finally { this.active = undefined; }
  }

  advice(provider: string, model: string, tool: string, args: unknown): string | undefined {
    if (this.input.permission() === undefined || !args || typeof args !== "object") return;
    for (const { tool: target, advice } of this.input.stats.lessons(provider, model)) {
      if (target !== tool) continue;
      if (isCorrection(advice)) {
        const rule = corrections[advice];
        if (rule.tool === tool && rule.matches(args as Record<string, unknown>)) return rule.text;
      } else if (advice.trim()) {
        return advice.trim();
      }
    }
  }
}
