/** Pasted text at or above this size is easier to work with as a document. */
export const LONG_PASTE_CHAR_LIMIT = 2_000;

export function shouldConvertLongPaste(text: string): boolean {
  return text.length >= LONG_PASTE_CHAR_LIMIT && text.trim().length > 0;
}

/**
 * Use the first line as the visible document title. This keeps terminal logs
 * and pasted source files recognizable while the complete text stays in File.
 */
export function getPastedTextFileName(text: string): string {
  const firstLine = text
    .split(/\r?\n/, 1)[0]
    ?.replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!firstLine) return "粘贴的文本.txt";
  return firstLine.length > 96 ? `${firstLine.slice(0, 95)}…` : firstLine;
}
