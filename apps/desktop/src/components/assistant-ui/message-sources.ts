import type { Source } from "./elements/sources";

type SourcePart = { type: "source"; sourceType: "url"; url: string; title?: string };
type TextPart = { type: "text"; text: string };

/** Only URLs actually present in this reply may become source cards. */
export function messageSources(parts: readonly (SourcePart | TextPart | { type: string })[]): Source[] {
  const sources = new Map<string, Source>();
  const add = (rawUrl: string, title?: string) => {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") return;
      const value = url.href;
      if (!sources.has(value)) sources.set(value, { domain: url.hostname, title: title && !/^\[?\d+\]?$/.test(title) ? title : url.hostname, url: value });
    } catch { /* Ignore malformed links from model output. */ }
  };
  for (const part of parts) {
    if (part.type === "source" && "sourceType" in part && part.sourceType === "url" && "url" in part) {
      add(part.url, "title" in part ? part.title : undefined);
    } else if (part.type === "text" && "text" in part) {
      const prose = part.text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]+`/g, "");
      for (const match of prose.matchAll(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^\s)]+)(?:\s+"[^"]*")?\)/g)) add(match[2]!, match[1]);
    }
  }
  return [...sources.values()];
}
