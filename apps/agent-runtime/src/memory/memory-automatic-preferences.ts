import { createHash } from "node:crypto";
import { MEMORY_PREFERENCE_MAX_LENGTH, type MemoryAutomaticPreference } from "@qone/protocol";
import { chars, preferenceContentKey, validateMemory } from "./memory-store.js";

// Bound automatic context and identify entries the user has edited or removed.
const MAX_AUTOMATIC_PREFERENCES = 6;
const MAX_QUOTES = 3;
const clean = (text: string) => text.replace(/\s+/gu, " ").trim();
const digest = (text: string) => createHash("sha256").update(clean(text).toLowerCase()).digest("hex");

export type PreferenceEvidence = { id: string; workspaceId?: string; excerpts: string[] };
export type StoredAutomaticPreference = MemoryAutomaticPreference & { keys: string[] };

/** Only user excerpts included in this request can support an automatic preference. Scope is checked locally. */
export function parseAutomaticPreferences(input: unknown[], sources: ReadonlyMap<string, PreferenceEvidence>): StoredAutomaticPreference[] {
  const seen = new Set<string>();
  const preferences: StoredAutomaticPreference[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const { content, scope, basis, evidence } = item as Record<string, unknown>;
    if (typeof content !== "string" || (scope !== "global" && scope !== "workspace")
      || (basis !== "explicit" && basis !== "repeated") || !Array.isArray(evidence)
      || !evidence.length || evidence.length > MAX_QUOTES) continue;
    let text: string;
    try { text = validateMemory(clean(content)); } catch { continue; }
    if (chars(text) > MEMORY_PREFERENCE_MAX_LENGTH) continue;
    const verified = new Map<string, { source: PreferenceEvidence; quote: string }>();
    for (const reference of evidence) {
      if (!reference || typeof reference.id !== "string" || typeof reference.quote !== "string") break;
      const source = sources.get(reference.id);
      const quote = clean(reference.quote);
      if (!source || verified.has(source.id) || !quote || quote.includes("[REDACTED]") || chars(quote) > MEMORY_PREFERENCE_MAX_LENGTH
        || !source.excerpts.some((excerpt) => clean(excerpt).includes(quote))) break;
      verified.set(source.id, { source, quote });
    }
    if (verified.size !== evidence.length || (basis === "repeated" && verified.size < 2)) continue;
    const matches = [...verified.values()];
    const workspaces = new Set(matches.map(({ source }) => source.workspaceId));
    const workspaceId = matches[0]?.source.workspaceId;
    if (scope === "workspace" && (!workspaceId || workspaces.size !== 1)) continue;
    if (scope === "global" && basis === "repeated" && (workspaces.has(undefined) || workspaces.size < 2)) continue;
    const preference = scope === "workspace" ? { workspaceId } : {};
    const id = preferenceContentKey(text, preference.workspaceId);
    const keys = [id, ...matches.map(({ source, quote }) => digest(JSON.stringify([source.id, quote])))];
    if (keys.some((key) => seen.has(key))) continue;
    keys.forEach((key) => seen.add(key));
    preferences.push({ id, content: text, preference,
      sources: matches.map(({ source, quote }) => ({ id: source.id, quote })), keys });
    if (preferences.length >= MAX_AUTOMATIC_PREFERENCES) break;
  }
  return preferences;
}
