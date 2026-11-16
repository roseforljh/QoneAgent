import type { SettingsRepo } from "@qone/database";
import type { MemoryNoteInfo, MemoryStateInfo, MemorySummaryInfo } from "@qone/protocol";
import { runtimeError } from "../runtime-localization.js";

/** Unicode code points, so emoji are not counted twice. */
export const chars = (text: string) => Array.from(text).length;
export const takeChars = (text: string, max: number) => Array.from(text).slice(0, Math.max(0, max)).join("");

// Known credential shapes and explicit secret fields only; this cannot recognize every secret.
const SENSITIVE = /(\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+\S+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|(?:api[_ -]?key|secret|password|passwd|access[_ -]?token|cookie|密码|密钥|验证码|银行卡(?:号)?)\s*[:：=]\s*\S+)/gi;
const FORGED_BOUNDARY = /<\/?\s*qone-memory\b/gi;

const normalize = (content: string) => content.replace(/\r\n?/g, "\n").trim();

/** Model output is not rejected wholesale; credentials and forged boundaries are replaced. */
export function redactMemory(content: string): string {
  return normalize(content).replace(SENSITIVE, "[REDACTED]").replace(FORGED_BOUNDARY, "[tag]");
}

/** Every write path shares this check; prompts and model promises cannot replace it. */
export function validateMemory(content: string): string {
  const value = normalize(content);
  if (!value) throw runtimeError("memory.empty");
  if (new RegExp(SENSITIVE.source, "i").test(value)) throw runtimeError("memory.sensitive");
  if (new RegExp(FORGED_BOUNDARY.source, "i").test(value)) throw runtimeError("memory.forged_boundary");
  return value;
}

interface Settings { enabled: boolean; version: number }
interface Overview { content: string; generatedAt: number; fingerprint: string }
interface Stats { calls: number; tokens: number }

const KEY = {
  settings: "memory.settings",
  notes: "memory.notes",
  summaries: "memory.summaries",
  overview: "memory.overview",
  stats: "memory.stats",
} as const;

/**
 * All memory data lives in the runtime database because it is derived from
 * local sessions. `version` advances whenever the user changes permission or
 * content, so a slow background task holding an older version cannot write back.
 */
export class MemoryStore {
  constructor(private repo: SettingsRepo) {}

  settings(): Settings {
    const value = this.repo.get<Partial<Settings>>(KEY.settings);
    return { enabled: value?.enabled === true, version: Number(value?.version) || 0 };
  }

  authorized(version: number): boolean {
    const settings = this.settings();
    return settings.enabled && settings.version === version;
  }

  private advance(enabled = this.settings().enabled) {
    this.repo.set(KEY.settings, { enabled, version: this.settings().version + 1 });
  }

  setEnabled(enabled: boolean): boolean {
    if (this.settings().enabled === enabled) return false;
    this.advance(enabled);
    return true;
  }

  notes(): MemoryNoteInfo[] {
    return this.repo.get<MemoryNoteInfo[]>(KEY.notes) ?? [];
  }

  /** Model writes pass the version they were authorized with; manual edits do not need it. */
  saveNote(content: string, options: { id?: string; origin?: MemoryNoteInfo["origin"]; version?: number } = {}): MemoryNoteInfo {
    if (options.version !== undefined && !this.authorized(options.version)) throw runtimeError("memory.stale");
    const value = validateMemory(content);
    const notes = this.notes();
    const old = options.id ? notes.find((note) => note.id === options.id) : undefined;
    if (options.id && !old) throw runtimeError("memory.deleted");
    const duplicate = notes.find((note) => note.id !== options.id && note.content === value);
    if (duplicate) {
      if (old) throw runtimeError("memory.duplicate");
      return duplicate;
    }
    const now = Math.max(Date.now(), (old?.updatedAt ?? 0) + 1);
    const saved: MemoryNoteInfo = { id: old?.id ?? crypto.randomUUID(), content: value, origin: old?.origin ?? options.origin ?? "manual", createdAt: old?.createdAt ?? now, updatedAt: now };
    this.repo.set(KEY.notes, old ? notes.map((note) => note.id === saved.id ? saved : note) : [saved, ...notes]);
    if (options.version === undefined) this.advance();
    return saved;
  }

  deleteNote(id: string, version?: number) {
    if (version !== undefined && !this.authorized(version)) throw runtimeError("memory.stale");
    const notes = this.notes();
    if (!notes.some((note) => note.id === id)) throw runtimeError("memory.deleted");
    this.repo.set(KEY.notes, notes.filter((note) => note.id !== id));
    this.advance();
  }

  /** Includes blank summaries: they remember the source time so unchanged chats are not re-summarized. */
  allSummaries(): Record<string, MemorySummaryInfo> {
    return this.repo.get<Record<string, MemorySummaryInfo>>(KEY.summaries) ?? {};
  }

  summaries(): MemorySummaryInfo[] {
    return Object.values(this.allSummaries()).filter((item) => item.content).sort((a, b) => b.sourceUpdatedAt - a.sourceUpdatedAt || a.id.localeCompare(b.id));
  }

  summary(id: string): MemorySummaryInfo | undefined {
    const item = this.allSummaries()[id];
    return item?.content ? item : undefined;
  }

  putSummaries(items: Record<string, MemorySummaryInfo>) {
    this.repo.set(KEY.summaries, items);
  }

  /**
   * Deleting a chat memory keeps its source time with empty content, so the
   * same chat is not summarized again until it gets new messages.
   */
  forgetSummary(id: string) {
    const all = this.allSummaries();
    const old = all[id];
    if (!old) throw runtimeError("memory.deleted");
    this.putSummaries({ ...all, [id]: { ...old, content: "", generatedAt: Math.max(Date.now(), old.generatedAt + 1) } });
    this.advance();
  }

  overview(): Overview | undefined {
    const value = this.repo.get<Overview>(KEY.overview);
    return value?.content ? value : undefined;
  }

  setOverview(value: Overview | undefined) {
    this.repo.set(KEY.overview, value ?? null);
  }

  recordCall(tokens: number) {
    const stats = this.repo.get<Stats>(KEY.stats) ?? { calls: 0, tokens: 0 };
    this.repo.set(KEY.stats, { calls: stats.calls + 1, tokens: stats.tokens + Math.max(0, tokens) });
  }

  state(): MemoryStateInfo {
    const stats = this.repo.get<Stats>(KEY.stats) ?? { calls: 0, tokens: 0 };
    const overview = this.overview();
    const summaries = this.summaries();
    return {
      enabled: this.settings().enabled,
      overview: overview && { content: overview.content, generatedAt: overview.generatedAt },
      summaries,
      notes: this.notes(),
      stats: { ...stats, lastUpdatedAt: Math.max(0, overview?.generatedAt ?? 0, ...summaries.map((item) => item.generatedAt)) },
    };
  }
}
