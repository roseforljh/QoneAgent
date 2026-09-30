import type { MessageAttachmentInfo } from "./index.js";

type UserInput = { content: string; attachments?: readonly MessageAttachmentInfo[] };
type HistoryMessage = UserInput & { id: string; role: string };

/** Compare the submitted payload, including attachment order and file identity. */
export function sameUserInput(left: UserInput, right: UserInput): boolean {
  if (left.content !== right.content) return false;
  const a = left.attachments ?? [];
  const b = right.attachments ?? [];
  return a.length === b.length && a.every((file, index) => {
    const other = b[index]!;
    return file.type === other.type && file.name === other.name &&
      file.mimeType === other.mimeType && file.data === other.data &&
      file.localPath === other.localPath;
  });
}

/** Only merge adjacent user bubbles; an intervening answer starts a new turn. */
export function repeatedUserMessageId(history: readonly HistoryMessage[], input: UserInput): string | undefined {
  let id: string | undefined;
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]!;
    if (message.role !== "user" || !sameUserInput(message, input)) break;
    id = message.id;
  }
  return id;
}
