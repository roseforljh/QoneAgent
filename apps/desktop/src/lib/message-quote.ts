import type { AppendMessage, QuoteInfo } from "@assistant-ui/react";

export function messageQuote(message: Pick<AppendMessage, "metadata">): QuoteInfo | undefined {
  const quote = message.metadata?.custom?.quote;
  if (!quote || typeof quote !== "object" || !("text" in quote) || !("messageId" in quote)) return;
  if (typeof quote.text !== "string" || !quote.text.trim() || typeof quote.messageId !== "string") return;
  return quote as QuoteInfo;
}

/** Expand commands before adding the reference: quoted directives are never commands. */
export function withMessageQuote(text: string, quote?: QuoteInfo): string {
  if (!quote?.text.trim()) return text;
  const reference = quote.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return text ? `${text}\n\n${reference}` : reference;
}
