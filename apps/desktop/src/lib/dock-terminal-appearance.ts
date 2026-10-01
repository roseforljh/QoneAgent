import type { ITerminalOptions, Terminal } from "@xterm/xterm";

// Read resolved CSS values: xterm cannot consume CSS custom properties itself.
export function readDockTerminalAppearance(host: HTMLElement): ITerminalOptions {
  const style = getComputedStyle(host);
  const root = getComputedStyle(document.documentElement);
  const selection = root.getPropertyValue("--q-selection").trim();
  return {
    fontFamily: style.fontFamily,
    fontSize: parseFloat(style.fontSize),
    theme: {
      background: style.backgroundColor,
      foreground: style.color,
      cursor: style.color,
      cursorAccent: style.backgroundColor,
      ...(selection ? { selectionBackground: selection, selectionInactiveBackground: selection } : {}),
    },
  };
}

export function bindDockTerminalAppearance(host: HTMLElement, term: Pick<Terminal, "options" | "rows" | "refresh">, fit: () => void) {
  let frame: number | undefined;
  let previous = "";
  const update = () => {
    if (!host.isConnected) return;
    const next = readDockTerminalAppearance(host);
    const signature = JSON.stringify(next);
    if (signature === previous) return;
    previous = signature;
    const fontChanged = term.options.fontFamily !== next.fontFamily || term.options.fontSize !== next.fontSize;
    term.options = next;
    if (fontChanged) fit();
    if (term.rows > 0) term.refresh(0, term.rows - 1);
  };
  const observer = new MutationObserver(() => {
    if (frame !== undefined) return;
    frame = requestAnimationFrame(() => { frame = undefined; update(); });
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "data-theme", "data-accent"] });
  update();
  return () => {
    observer.disconnect();
    if (frame !== undefined) cancelAnimationFrame(frame);
  };
}
