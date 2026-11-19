/**
 * Selected text lives inline in the message at the point the user placed it.
 * The tag is what the model reads and what the composer/bubble parse back into
 * chips. It stays on one line because the composer parses its text per line.
 */
export const INLINE_QUOTE_TYPE = "qone-quote";
export const INLINE_QUOTE_HREF = "qone-quote:";

const OPEN = "<selected-text>";
const CLOSE = "</selected-text>";
const PATTERN = /<selected-text>((?:[^\\<\r\n]|\\.)*)<\/selected-text>/gu;

export type InlineQuoteSegment = { kind: "text"; text: string } | { kind: "quote"; text: string };

export function serializeInlineQuote(text: string): string {
  const body = text.replace(/\r\n?/gu, "\n").replace(/[\\<]/gu, "\\$&").replaceAll("\n", "\\n");
  return `${OPEN}${body}${CLOSE}`;
}

const unescapeQuote = (body: string) => body.replace(/\\(.)/gu, (_, char: string) => char === "n" ? "\n" : char);

export function hasInlineQuote(text: string): boolean {
  return text.includes(OPEN);
}

export function splitInlineQuotes(text: string): InlineQuoteSegment[] {
  if (!hasInlineQuote(text)) return text ? [{ kind: "text", text }] : [];
  const segments: InlineQuoteSegment[] = [];
  let offset = 0;
  for (const match of text.matchAll(PATTERN)) {
    if (match.index > offset) segments.push({ kind: "text", text: text.slice(offset, match.index) });
    segments.push({ kind: "quote", text: unescapeQuote(match[1]!) });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) segments.push({ kind: "text", text: text.slice(offset) });
  return segments;
}

/** Chip label: the quote's first words; CSS truncates the rest. */
export function inlineQuoteLabel(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 80);
}

/** Single-line previews (queue rows) show quotes as their quoted words. */
export function plainInlineQuotes(text: string): string {
  return splitInlineQuotes(text).map((segment) => segment.kind === "quote" ? `“${inlineQuoteLabel(segment.text)}”` : segment.text).join("");
}

/** Drafts created outside an editor (side chat, legacy queue items) get the chip at the end. */
export function appendInlineQuote(text: string, quote: string): string {
  const chip = serializeInlineQuote(quote);
  return text && !/\s$/u.test(text) ? `${text} ${chip} ` : `${text}${chip} `;
}

/** Markdown for a user bubble: each quote becomes a link the bubble renders as a chip. */
export function inlineQuotesToMarkdown(text: string): { markdown: string; quotes: string[] } {
  const quotes: string[] = [];
  const markdown = splitInlineQuotes(text).map((segment) => {
    if (segment.kind === "text") return segment.text;
    quotes.push(segment.text);
    return `[quote](${INLINE_QUOTE_HREF}${quotes.length - 1})`;
  }).join("");
  return { markdown, quotes };
}
