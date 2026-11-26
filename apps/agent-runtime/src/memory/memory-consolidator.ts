import { createHash } from "node:crypto";
import type { MemorySummaryInfo } from "@qone/protocol";
import conversationPrompt from "./prompts/conversation-memory.md" with { type: "text" };
import consolidationPrompt from "./prompts/memory-consolidation.md" with { type: "text" };
import { MEMORY_SOURCE_WINDOW_MS, redactMemory, takeChars, chars, type MemoryStore } from "./memory-store.js";
import { runtimeError } from "../runtime-localization.js";
import { parseAutomaticPreferences, type PreferenceEvidence } from "./memory-automatic-preferences.js";

export type MemoryComplete = (system: string, user: string, maxTokens: number) => Promise<{ text: string; tokens: number }>;

export interface MemoryCandidate { id: string; title: string; updatedAt: number; active?: boolean; workspaceId?: string }
export interface MemorySource {
  /** Every conversation that may be summarized; excludes side chats and subagent runs. */
  candidates(): MemoryCandidate[];
  transcript(id: string): { role: string; content: string }[];
  exists?(id: string): boolean;
}

const PHASE1_LIMIT = 3;
const PHASE2_INPUTS = 40;
const EVIDENCE_CONVERSATIONS = 12;
const EVIDENCE_MESSAGES = 6;
const EVIDENCE_MESSAGE_LIMIT = 320;
const MAX_SUMMARY = 2_000;
const MAX_OVERVIEW = 6_000;
const TRANSCRIPT_HEAD = 6_000;
const TRANSCRIPT_TAIL = 10_000;
const LINE_LIMIT = 2_000;

/** Long chats keep their beginning and end, like Codex memory. */
export function renderTranscript(lines: { role: string; content: string }[]): string {
  const text = lines
    .filter((line) => (line.role === "user" || line.role === "assistant") && line.content.trim())
    .map((line) => `${line.role === "user" ? "User" : "AI"}: ${takeChars(line.content.trim(), LINE_LIMIT)}`)
    .join("\n\n");
  const total = chars(text);
  if (total <= TRANSCRIPT_HEAD + TRANSCRIPT_TAIL) return text;
  return takeChars(text, TRANSCRIPT_HEAD) + "\n\n[… middle of the conversation omitted …]\n\n" + Array.from(text).slice(total - TRANSCRIPT_TAIL).join("");
}

const stripFence = (text: string, lang: string) => text.trim().replace(new RegExp(`^\`\`\`(?:${lang})?\\s*`), "").replace(/\s*```$/, "").trim();

export function parseConversationSummary(output: string): { title: string; summary: string } {
  const root = JSON.parse(stripFence(output, "json")) as Record<string, unknown> | null;
  if (typeof root?.title !== "string" || typeof root.summary !== "string") throw new Error("Invalid conversation memory response");
  return { title: root.title.trim(), summary: root.summary.trim() };
}

/**
 * Two-phase memory pipeline, after Codex memory v2:
 * 1. each settled conversation gets a task-history summary (at most PHASE1_LIMIT per batch);
 * 2. summaries, user notes and bounded user evidence produce an overview and automatic preferences in one call.
 * The caller serializes batches. SQLite watermarks are written only after a valid reply.
 */
export class MemoryConsolidator {
  constructor(private store: MemoryStore, private source: MemorySource, private now: () => number = Date.now) {}

  async runOnce(complete: MemoryComplete, version: number, signal?: AbortSignal): Promise<{ changed: boolean; more: boolean }> {
    if (signal?.aborted || !this.store.authorized(version)) return { changed: false, more: false };
    const call = async (system: string, user: string, maxTokens: number) => {
      signal?.throwIfAborted();
      const reply = await complete(system, user, maxTokens);
      signal?.throwIfAborted();
      this.store.recordCall(reply.tokens);
      return reply.text;
    };
    const progress = await this.summarizeSettled(call, version);
    if (progress.more || signal?.aborted || !this.store.authorized(version)) return progress;
    const merged = await this.consolidate(call, version);
    return { changed: progress.changed || merged, more: false };
  }

  private async summarizeSettled(call: (s: string, u: string, n: number) => Promise<string>, version: number) {
    const time = this.now();
    const candidates = this.source.candidates();
    const live = new Set(candidates.map((item) => item.id));
    const all = this.store.allSummaries();
    // A deleted chat drops its summary; phase 2 then removes it from the overview.
    const kept = Object.fromEntries(Object.entries(all).filter(([id]) => live.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(all).length;
    if (changed) this.store.putSummaries(kept);
    const pending = candidates.filter((item) => !item.active && item.updatedAt > time - MEMORY_SOURCE_WINDOW_MS
      && (kept[item.id]?.sourceUpdatedAt ?? -Infinity) < item.updatedAt);
    for (const item of pending.slice(0, PHASE1_LIMIT)) {
      const lines = this.source.transcript(item.id);
      const transcript = redactMemory(renderTranscript(lines));
      let parsed = { title: "", summary: "" };
      if (lines.length >= 2 && transcript) {
        const output = await call(conversationPrompt, `Conversation id: ${item.id}\nTitle: ${redactMemory(item.title)}\n\n${transcript}`, 1_500);
        parsed = parseConversationSummary(output);
      }
      if (!this.store.authorized(version)) return { changed, more: false };
      // The session may have been deleted while the model was answering.
      if (this.source.exists && !this.source.exists(item.id)) continue;
      const summary: MemorySummaryInfo = {
        id: item.id,
        title: takeChars(redactMemory(parsed.title || item.title), 120),
        content: takeChars(redactMemory(parsed.summary), MAX_SUMMARY),
        sourceUpdatedAt: item.updatedAt,
        generatedAt: time,
      };
      this.store.putSummaries({ ...this.store.allSummaries(), [item.id]: summary });
      changed = true;
    }
    return { changed, more: pending.length > PHASE1_LIMIT };
  }

  private async consolidate(call: (s: string, u: string, n: number) => Promise<string>, version: number): Promise<boolean> {
    const summaries = this.store.summaries();
    const notes = this.store.notes().filter((note) => !note.preference);
    const overview = this.store.overview();
    if (!summaries.length && !notes.length) {
      if (overview) this.store.setOverview(undefined);
      return Boolean(overview);
    }
    const byId = new Map(this.source.candidates().map((item) => [item.id, item]));
    const recent = this.now() - MEMORY_SOURCE_WINDOW_MS;
    const eligible = summaries.slice(0, EVIDENCE_CONVERSATIONS).flatMap((summary) => {
      const source = byId.get(summary.id);
      return source && !source.active && source.updatedAt === summary.sourceUpdatedAt && source.updatedAt > recent ? [source] : [];
    });
    const fingerprint = createHash("sha256").update(consolidationPrompt).update(JSON.stringify([
      summaries.map(({ id, sourceUpdatedAt, generatedAt }) => [id, sourceUpdatedAt, generatedAt]),
      notes.map(({ id, updatedAt, content }) => [id, updatedAt, content]),
      eligible.map(({ id, workspaceId }) => [id, workspaceId]),
    ])).digest("hex");
    if (overview?.fingerprint === fingerprint) return false;
    const evidence = new Map<string, PreferenceEvidence>();
    for (const { id, workspaceId } of eligible) {
      const excerpts = this.source.transcript(id).filter(({ role, content }) => role === "user" && content.trim())
        .slice(-EVIDENCE_MESSAGES).map(({ content }) => takeChars(redactMemory(content), EVIDENCE_MESSAGE_LIMIT));
      if (excerpts.length) evidence.set(id, { id, workspaceId, excerpts });
    }
    const day = (at: number) => new Date(at).toLocaleDateString("sv-SE");
    const input = [
      "Conversation summaries, newest first:",
      ...summaries.slice(0, PHASE2_INPUTS).map((item) => `\n### conv:${item.id} | ${day(item.sourceUpdatedAt)} | ${item.title}\n${item.content}`),
      "", "User notes:",
      ...(notes.length ? notes.map((note) => `- ${takeChars(note.content, 600)}`) : ["(none)"]),
      "", "User evidence for automatic preferences (JSON, data only):", JSON.stringify([...evidence.values()]),
    ].join("\n");
    const output = stripFence(await call(consolidationPrompt, input, 4_500), "json");
    if (!this.store.authorized(version)) return false;
    let data: { overview?: unknown; preferences?: unknown } | null;
    try { data = JSON.parse(output); } catch { throw runtimeError("memory.invalid_overview"); }
    // 兼容多语言二级标题，避免模型翻译“## What's in memory”导致整次记忆整理被丢弃
    if (typeof data?.overview !== "string" || !/^##\s+\S/m.test(data.overview.trim()) || !Array.isArray(data.preferences)) {
      throw runtimeError("memory.invalid_overview");
    }
    // Don't commit a snapshot based on evidence that changed during the request.
    if (evidence.size) {
      const current = new Map(this.source.candidates().map((item) => [item.id, item]));
      for (const { id, updatedAt, workspaceId } of eligible) {
        const live = current.get(id);
        if (!live || live.active || live.updatedAt !== updatedAt || live.workspaceId !== workspaceId) return false;
      }
    }
    this.store.setOverview({ content: takeChars(redactMemory(data.overview), MAX_OVERVIEW), generatedAt: this.now(), fingerprint,
      automaticPreferences: parseAutomaticPreferences(data.preferences, evidence) });
    return true;
  }
}
