import { expect, test } from "bun:test";
import { Terminal } from "@xterm/xterm";

const write = (term: Terminal, data: string) => new Promise<void>((resolve) => term.write(data, resolve));

for (const text of ["a".repeat(82), "中".repeat(41)]) {
  test(`reflow keeps the cursor attached to its text (${text.startsWith("中") ? "wide" : "ASCII"})`, async () => {
    const term = new Terminal({ cols: 88, rows: 12, reflowCursorLine: true });
    try {
      await write(term, `header\r\n${text}\x1b[2m${"prediction".repeat(8)}\x1b[0m\x1b[2;83H`);
      term.resize(72, 12);
      expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([10, 2]);
      term.resize(100, 12);
      expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([82, 1]);
    } finally { term.dispose(); }
  });
}

test("reflow excludes the unused cell before a wrapped wide character", async () => {
  const term = new Terminal({ cols: 88, rows: 8, reflowCursorLine: true });
  try {
    await write(term, `header\r\n${"中".repeat(41)}prediction\x1b[2;83H`);
    term.resize(71, 8);
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([12, 2]);
    term.resize(88, 8);
    expect([term.buffer.active.cursorX, term.buffer.active.cursorY]).toEqual([82, 1]);
  } finally { term.dispose(); }
});

test("reflow retains the cursor when its logical line exceeds scrollback", async () => {
  const term = new Terminal({ cols: 88, rows: 6, scrollback: 8, reflowCursorLine: true });
  try {
    await write(term, "x".repeat(88 * 13 + 20));
    term.resize(30, 6);
    expect(term.buffer.active.cursorX).toBe(24);
    expect(term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)!.translateToString(true)).toBe("x".repeat(24));
  } finally { term.dispose(); }
});

test("reflow retains the input position when earlier scrollback lines wrap", async () => {
  const term = new Terminal({ cols: 88, rows: 6, scrollback: 20, reflowCursorLine: true });
  try {
    await write(term, `${("history".repeat(15) + "\r\n").repeat(18)}${"x".repeat(82)}`);
    term.resize(30, 6);
    expect(term.buffer.active.cursorX).toBe(22);
    const cursor = term.buffer.active.getLine(term.buffer.active.baseY + term.buffer.active.cursorY)!;
    expect(cursor.translateToString(true)).toBe("x".repeat(22));
    term.resize(100, 6);
    expect(term.buffer.active.cursorX).toBe(82);
  } finally { term.dispose(); }
});
