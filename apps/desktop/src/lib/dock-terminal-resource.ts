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
  // A local shell runs in a Windows pseudo console; xterm adapts its
  // wrapping and reflow to ConPTY's output only when told.
  const term = new Terminal({ cursorBlink: true, cursorStyle: "bar", cursorInactiveStyle: "bar", convertEol: false, scrollOnUserInput: true,
    ...("cwd" in target ? { windowsPty: { backend: "conpty" as const }, reflowCursorLine: true } : {}) });
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
  const fitNow = () => { if (element.isConnected && element.clientWidth > 0 && element.clientHeight > 0) fit.fit(); };
  // ConPTY output carries absolute positions for the size it was rendered at.
  // xterm parses written data on a timer, so resizing first would apply
  // already-received old-size output to the new grid (and answer the shell's
  // next cursor query from that wrong position). Resize after it is parsed.
  const fitTerminal = () => term.write("", fitNow);
  let stopAppearance: (() => void) | undefined;
  return {
    session,
    attach(host: HTMLElement) {
      host.append(element);
      stopAppearance?.();
      term.options = readDockTerminalAppearance(element);
      const first = !opened;
      if (first) {
        term.open(element);
        opened = true;
      }
      const stop = bindDockTerminalAppearance(element, term, fitTerminal);
      stopAppearance = stop;
      // Spawn the console at its visible size, not xterm's default 80×24;
      // nothing has been written before the first start.
      if (first) fitNow(); else fitTerminal();
      void session.start();
      return () => { if (element.parentElement === host) { stop(); stopAppearance = undefined; element.remove(); } };
    },
    fit: fitTerminal,
    clear: () => { if ("cwd" in target) session.clear(); term.clear(); },
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
