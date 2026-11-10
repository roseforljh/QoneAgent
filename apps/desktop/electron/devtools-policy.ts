/**
 * Electron equivalent of the old Rust `webview-policy.js`: block the DevTools
 * toggle shortcuts before the page or an editor sees them. Chromium registers
 * these as accelerators, so `preventDefault()` on the input event is what
 * actually stops the inspector from opening.
 */
export interface DevtoolsShortcutInput {
  key?: string;
  code?: string;
  control?: boolean;
  meta?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export function blocksDevtoolsShortcut(input: DevtoolsShortcutInput): boolean {
  if (input.key === "F12" || input.code === "F12") return true;
  if (input.code !== "KeyI") return false;
  const ctrl = Boolean(input.control);
  const meta = Boolean(input.meta);
  const alt = Boolean(input.alt);
  const shift = Boolean(input.shift);
  return (ctrl && shift && !meta && !alt) || (meta && alt && !ctrl && !shift);
}

/** The slice of `webContents` this policy needs; keeps it unit-testable. */
export interface InputEventSource {
  on(
    event: "before-input-event",
    listener: (event: { preventDefault(): void }, input: DevtoolsShortcutInput) => void,
  ): unknown;
}

/**
 * Wire the shortcut filter onto a window. Kept here rather than inline in
 * `main.ts` so tests drive the exact same listener the app registers.
 */
export function installDevtoolsShortcutGuard(webContents: InputEventSource): void {
  webContents.on("before-input-event", (event, input) => {
    if (blocksDevtoolsShortcut(input)) event.preventDefault();
  });
}