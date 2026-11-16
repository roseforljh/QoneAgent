import { createHash } from "node:crypto";
import type { MemorySummaryInfo } from "@qone/protocol";
import conversationPrompt from "./prompts/conversation-memory.md" with { type: "text" };
import consolidationPrompt from "./prompts/memory-consolidation.md" with { type: "text" };
import { redactMemory, takeChars, chars, type MemoryStore } from "./memory-store.js";
import { runtimeError } from "../runtime-localization.js";

export type MemoryComplete = (system: string, user: string, maxTokens: number) => Promise<{ text: string; tokens: number }>;

export interface MemoryCandidate { id: string; title: string; updatedAt: number }
export interface MemorySource {
  /** Every conversation that may be summarized; excludes side chats and subagent runs. */
  candidates(): MemoryCandidate[];
  transcript(id: string): { role: string; content: string }[];
}

const PHASE1_LIMIT = 3;
const PHASE2_INPUTS = 40;
const MAX_SUMMARY = 2_000;
const MAX_OVERVIEW = 6_000;
const IDLE_MS = 10 * 60_000;
const WINDOW_MS = 30 * 24 * 60 * 60_000;
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
  const root = JSON.parse(stripFence(output, "json")) as Record<string, unknown>;
  const field = (key: string) => typeof root[key] === "string" ? (root[key] as string).trim() : "";
  return { title: field("title"), summary: field("summary") };
}

/**
 * Two-phase memory pipeline, after Codex memory v2:
 * 1. each idle conversation gets a task-history summary (at most PHASE1_LIMIT per run);
 * 2. summaries plus user notes are merged into one overview.
 * Runs in the background when the user sends a message, one at a time; failures never affect chat.
 */
export class MemoryConsolidator {
  private running = false;

  constructor(private store: MemoryStore, private source: MemorySource, private now: () => number = Date.now) {}

  async runOnce(complete: MemoryComplete, currentId: string, version: number): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      if (!this.store.authorized(version)) return false;
      const call = async (system: string, user: string, maxTokens: number) => {
        const reply = await complete(system, user, maxTokens);
        this.store.recordCall(reply.tokens);
        return reply.text;
      };
      await this.summarizeIdle(call, currentId, version);
      await this.consolidate(call, version);
      return true;
    } finally {
      this.running = false;
    }
  }

  private async summarizeIdle(call: (s: string, u: string, n: number) => Promise<string>, currentId: string, version: number) {
    const time = this.now();
    const candidates = this.source.candidates();
    const live = new Set(candidates.map((item) => item.id));
    const all = this.store.allSummaries();
    // A deleted chat drops its summary; phase 2 then removes it from the overview.
    const kept = Object.fromEntries(Object.entries(all).filter(([id]) => live.has(id)));
    if (Object.keys(kept).length !== Object.keys(all).length) this.store.putSummaries(kept);
    const pending = candidates
      .filter((item) => item.id !== currentId && item.updatedAt < time - IDLE_MS && item.updatedAt > time - WINDOW_MS
        && (kept[item.id]?.sourceUpdatedAt ?? -Infinity) < item.updatedAt)
      .slice(0, PHASE1_LIMIT);
    for (const item of pending) {
      const lines = this.source.transcript(item.id);
      const transcript = renderTranscript(lines);
      let parsed = { title: "", summary: "" };
      if (lines.length >= 2 && transcript) {
        const output = await call(conversationPrompt, `Conversation id: ${item.id}\nTitle: ${item.title}\n\n${transcript}`, 1_500);
        // An unparsable reply still records the source time, so the same content is not paid for again.
        try { parsed = parseConversationSummary(output); } catch { /* keep empty */ }
      }
      if (!this.store.authorized(version)) return;
      const summary: MemorySummaryInfo = {
        id: item.id,
        title: takeChars(redactMemory(parsed.title || item.title), 120),
        content: takeChars(redactMemory(parsed.summary), MAX_SUMMARY),
        sourceUpdatedAt: item.updatedAt,
        generatedAt: time,
      };
      this.store.putSummaries({ ...this.store.allSummaries(), [item.id]: summary });
    }
  }

  private async consolidate(call: (s: string, u: string, n: number) => Promise<string>, version: number) {
    const summaries = this.store.summaries().slice(0, PHASE2_INPUTS);
    const notes = this.store.notes();
    const fingerprint = createHash("sha256")
      .update(summaries.map((item) => `${item.id}:${item.generatedAt}`).join("\n") + "\n--\n" + notes.map((note) => `${note.id}:${note.updatedAt}:${note.content}`).join("\n"))
      .digest("hex");
    const overview = this.store.overview();
    if (overview?.fingerprint === fingerprint) return;
    if (!summaries.length && !notes.length) {
      if (overview) this.store.setOverview(undefined);
      return;
    }
    const day = (at: number) => new Date(at).toLocaleDateString("sv-SE");
    const input = [
      "Existing overview (may be empty or outdated):", overview?.content || "(none)", "",
      "Conversation summaries, newest first:",
      ...summaries.map((item) => `\n### conv:${item.id} | ${day(item.sourceUpdatedAt)} | ${item.title}\n${item.content}`),
      "", "User notes:",
      ...(notes.length ? notes.map((note) => `- ${takeChars(note.content, 600)}`) : ["(none)"]),
    ].join("\n");
    const output = stripFence(await call(consolidationPrompt, input, 3_000), "markdown");
    if (!output.includes("## What's in memory")) throw runtimeError("memory.invalid_overview");
    if (!this.store.authorized(version)) return;
    this.store.setOverview({ content: takeChars(redactMemory(output), MAX_OVERVIEW), generatedAt: this.now(), fingerprint });
  }
}
