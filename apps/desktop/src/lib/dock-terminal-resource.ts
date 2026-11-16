import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "./desktop-bridge";
import { listen } from "./desktop-bridge";
import { createDockTerminalSession } from "./dock-terminal-session";
import { bindDockTerminalAppearance, readDockTerminalAppearance } from "./dock-terminal-appearance";
import { serverTerminalTransport } from "./server-terminal";
import { useStore } from "../store";

/** A local PowerShell in a workspace, or an SSH shell on one of the user's servers. */
export type DockTerminalTarget = { cwd: string } | { serverId: string };

function localTransport(terminalId: string) {
  return {
    invoke,
    listen: async (events: { data: (data: string) => void; exit: () => void }) => {
      const registrations = await Promise.allSettled([
        listen<{ terminalId: string; data: string }>("terminal:data", (event) => { if (event.payload.terminalId === terminalId) events.data(event.payload.data); }),
        listen<{ terminalId: string }>("terminal:exit", (event) => { if (event.payload.terminalId === terminalId) events.exit(); }),
      ]);
      const release = () => { for (const registration of registrations) if (registration.status === "fulfilled") registration.value(); };
      const failure = registrations.find((registration) => registration.status === "rejected");
      if (failure?.status === "rejected") { release(); throw failure.reason; }
      return release;
    },
  };
}

function createResource(tabId: string, target: DockTerminalTarget) {
  const element = document.createElement("div");
  element.className = "q-dock-terminal-renderer h-full min-h-0 w-full min-w-0 overflow-hidden";
  const term = new Terminal({ cursorBlink: true, cursorStyle: "bar", cursorInactiveStyle: "bar", convertEol: false, scrollOnUserInput: true });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;
  const terminalId = `dock-${tabId}`;
  const transport = "serverId" in target ? serverTerminalTransport(target.serverId, terminalId, (command) => useStore.getState().send(command)) : localTransport(terminalId);
  const session = createDockTerminalSession({
    terminalId, cwd: "cwd" in target ? target.cwd : "",
    dimensions: () => ({ cols: term.cols, rows: term.rows }),
    output: (data) => term.write(data),
    ...transport,
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
export function getDockTerminalResource(tabId: string, target: DockTerminalTarget): DockTerminalResource {
  let resource = resources.get(tabId);
  if (!resource) { resource = createResource(tabId, target); resources.set(tabId, resource); }
  return resource;
}
export function closeDockTerminalResource(tabId: string): void {
  const resource = resources.get(tabId);
  resources.delete(tabId);
  resource?.dispose();
}
