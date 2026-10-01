import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createDockTerminalSession } from "./dock-terminal-session";
import { bindDockTerminalAppearance, readDockTerminalAppearance } from "./dock-terminal-appearance";

function createResource(tabId: string, cwd: string) {
  const element = document.createElement("div");
  element.className = "q-dock-terminal-renderer h-full min-h-0 w-full min-w-0 overflow-hidden";
  const term = new Terminal({ cursorBlink: true, cursorStyle: "bar", cursorInactiveStyle: "bar", convertEol: false, scrollOnUserInput: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;
  const session = createDockTerminalSession({
    terminalId: `dock-${tabId}`, cwd,
    dimensions: () => ({ cols: term.cols, rows: term.rows }),
    invoke,
    output: (data) => term.write(data),
    listen: async (events) => {
      const registrations = await Promise.allSettled([
        listen<{ terminalId: string; data: string }>("terminal:data", (event) => { if (event.payload.terminalId === `dock-${tabId}`) events.data(event.payload.data); }),
        listen<{ terminalId: string }>("terminal:exit", (event) => { if (event.payload.terminalId === `dock-${tabId}`) events.exit(); }),
      ]);
      const release = () => { for (const registration of registrations) if (registration.status === "fulfilled") registration.value(); };
      const failure = registrations.find((registration) => registration.status === "rejected");
      if (failure?.status === "rejected") { release(); throw failure.reason; }
      return release;
    },
  });
  const input = term.onData(session.write);
  const resize = term.onResize(() => session.resize());
  const fitTerminal = () => { if (element.isConnected && element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); };
  let stopAppearance: (() => void) | undefined;
  return {
    session,
    attach(host: HTMLElement) {
      host.append(element);
      stopAppearance?.();
      term.options = readDockTerminalAppearance(element);
      if (!opened) {
        term.open(element);
        opened = true;
      }
      const stop = bindDockTerminalAppearance(element, term, fitTerminal);
      stopAppearance = stop;
      void session.start();
      return () => { if (element.parentElement === host) { stop(); stopAppearance = undefined; element.remove(); } };
    },
    fit: fitTerminal,
    clear: () => term.clear(),
    focus: () => { if (element.isConnected) term.focus(); },
    dispose() {
      stopAppearance?.();
      input.dispose();
      resize.dispose();
      element.remove();
      void session.dispose().catch((error) => console.error("terminal close failed", error));
      term.dispose();
    },
  };
}
export type DockTerminalResource = ReturnType<typeof createResource>;
const resources = new Map<string, DockTerminalResource>();
export function getDockTerminalResource(tabId: string, cwd: string): DockTerminalResource {
  let resource = resources.get(tabId);
  if (!resource) { resource = createResource(tabId, cwd); resources.set(tabId, resource); }
  return resource;
}
export function closeDockTerminalResource(tabId: string): void {
  const resource = resources.get(tabId);
  resources.delete(tabId);
  resource?.dispose();
}
