// remark-math requires multiline $$ blocks to have their markers on separate lines.
// Models often put the expression on the opening line instead.
export function normalizeMultilineDisplayMath(text: string): string {
  let output = "";
  let copiedThrough = 0;
  let cursor = 0;
  let opening = -1;
  let inlineCodeLength = 0;
  let fence: { marker: string; length: number } | null = null;

  while (cursor < text.length) {
    if (cursor === 0 || text[cursor - 1] === "\n") {
      const lineEnd = text.indexOf("\n", cursor);
      const line = text.slice(cursor, lineEnd < 0 ? text.length : lineEnd);
      const marker = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker?.[0] === fence.marker && marker.length >= fence.length &&
            line.slice(line.indexOf(marker) + marker.length).trim() === "") fence = null;
        cursor = lineEnd < 0 ? text.length : lineEnd + 1;
        continue;
      }
      if (!inlineCodeLength && marker && (marker[0] === "~" || !line.slice(line.indexOf(marker) + marker.length).includes("`"))) {
        fence = { marker: marker[0], length: marker.length };
        cursor = lineEnd < 0 ? text.length : lineEnd + 1;
        continue;
      }
    }

    if (text[cursor] === "\\") { cursor += 2; continue; }
    if (text[cursor] === "`") {
      let end = cursor + 1;
      while (text[end] === "`") end++;
      const length = end - cursor;
      if (!inlineCodeLength) inlineCodeLength = length;
      else if (length === inlineCodeLength) inlineCodeLength = 0;
      cursor = end;
      continue;
    }
    if (!inlineCodeLength && text.startsWith("$$", cursor)) {
      if (opening < 0) opening = cursor;
      else {
        const body = text.slice(opening + 2, cursor);
        if (body.includes("\n")) {
          const before = opening > 0 && text[opening - 1] !== "\n" ? "\n" : "";
          const after = cursor + 2 < text.length && text[cursor + 2] !== "\n" ? "\n" : "";
          output += text.slice(copiedThrough, opening) + `${before}$$\n${body.trim()}\n$$${after}`;
          copiedThrough = cursor + 2;
        }
        opening = -1;
      }
      cursor += 2;
      continue;
    }
    cursor++;
  }
  return output + text.slice(copiedThrough);
}
