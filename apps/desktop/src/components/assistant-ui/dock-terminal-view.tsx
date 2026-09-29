import { useEffect, useRef, type MutableRefObject } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import { useStore } from "../../store";
// Real ConPTY terminal hosted by the Tauri backend: keystrokes go through
// terminal_write, output arrives via "terminal:data" events.
export interface TerminalApi {
  clear: () => void;
  focus: () => void;
  restart: () => void;
}

export default function TerminalView({ tabId, workspaceId, active, apiRef, onStatus }: { tabId: string; workspaceId: string; active: boolean; apiRef: MutableRefObject<TerminalApi | undefined>; onStatus: (tabId: string, status: "starting" | "ready" | "exited" | "error", detail?: string) => void }) {
  const cwd = useStore((s) => s.workspaces.find((w) => w.id === workspaceId)?.path);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const terminalIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !cwd) return undefined;
    // A mount gets its own native session id. This prevents a delayed
    // cleanup from one React mount from colliding with the next mount.
    const terminalId = `dock-${workspaceId}-${crypto.randomUUID()}`;
    terminalIdRef.current = terminalId;
    // getComputedStyle resolves the inherited color to rgb(); xterm's canvas
    // parser cannot handle raw CSS var values like oklch().
    const term = new XTerm({
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      cursorBlink: true,
      convertEol: false,
      scrollOnUserInput: true,
      theme: {
        background: "rgba(0,0,0,0)",
        foreground: getComputedStyle(host).color || undefined,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;
    let disposed = false;
    let restarting = false;
    let nativeReady = false;
    const pendingInput: string[] = [];
    let lastInputError = "";

    const writeInput = (data: string) => {
      if (!nativeReady) {
        pendingInput.push(data);
        return;
      }
      void invoke("terminal_write", { terminalId, data }).catch((error) => {
        if (disposed || String(error) === lastInputError) return;
        lastInputError = String(error);
        nativeReady = false;
        onStatus(tabId, "error", lastInputError);
        term.write(`\r\n[input failed: ${lastInputError}]\r\n`);
      });
    };

    const flushInput = () => {
      const buffered = pendingInput.splice(0);
      for (const data of buffered) writeInput(data);
    };

    let startPromise: Promise<void> | undefined;
    let eventsReady: Promise<unknown[]> | undefined;

    const start = () => {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        restarting = true;
        nativeReady = false;
        lastInputError = "";
        onStatus(tabId, "starting");
        try {
          // xterm must be listening before CreateProcessW starts emitting the
          // initial PowerShell prompt. A bounded fallback prevents one stuck
          // event registration from blocking the whole terminal forever.
          await Promise.race([
            eventsReady,
            new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
          ]);
          // Kill stale sessions first. This closes the race where React has
          // already unmounted the view but ConPTY has not finished cleaning up.
          await invoke("terminal_kill", { terminalId }).catch(() => {});
          if (disposed) return;
          await invoke("terminal_spawn", {
            terminalId,
            shell: "pwsh.exe -NoProfile",
            cwd,
            cols: term.cols,
            rows: term.rows,
          });
          if (!disposed) {
            nativeReady = true;
            await invoke("terminal_resize", { terminalId, cols: term.cols, rows: term.rows }).catch(() => {});
            flushInput();
            onStatus(tabId, "ready");
          }
        } catch (error) {
          nativeReady = false;
          pendingInput.splice(0);
          if (!disposed) {
            onStatus(tabId, "error", String(error));
            term.write(`\r\nspawn failed: ${String(error)}\r\n`);
          }
        } finally {
          restarting = false;
        }
      })().finally(() => { startPromise = undefined; });
      return startPromise;
    };

    apiRef.current = { clear: () => term.clear(), focus: () => term.focus(), restart: () => { void start(); } };
    onStatus(tabId, "starting");

    const unData = listen<{ terminalId: string; data: string }>("terminal:data", (e) => {
      if (e.payload.terminalId === terminalId) term.write(e.payload.data);
    });
    const unExit = listen<{ terminalId: string }>("terminal:exit", (e) => {
      if (e.payload.terminalId === terminalId && !disposed) {
        nativeReady = false;
        if (!restarting) {
          term.write("\r\n[process exited]\r\n");
          onStatus(tabId, "exited");
        }
      }
    });
    eventsReady = Promise.all([unData, unExit]);
    const inputSub = term.onData((data) => {
      writeInput(data);
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (nativeReady) invoke("terminal_resize", { terminalId, cols, rows }).catch(() => {});
    });
    let fitFrame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      fitFrame = requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!disposed && host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      });
    });
    observer.observe(host);

    void start();

    return () => {
      disposed = true;
      nativeReady = false;
      pendingInput.splice(0);
      inputSub.dispose();
      resizeSub.dispose();
      observer.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      if (apiRef.current) apiRef.current = undefined;
      unData.then((off) => off());
      unExit.then((off) => off());
      invoke("terminal_kill", { terminalId }).catch(() => {});
      term.dispose();
      termRef.current = undefined;
      fitRef.current = undefined;
      if (terminalIdRef.current === terminalId) terminalIdRef.current = undefined;
    };
  }, [tabId, workspaceId, cwd, apiRef, onStatus]);

  useEffect(() => {
    const terminalId = terminalIdRef.current;
    if (!active || !fitRef.current || !terminalId) return;
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (termRef.current) {
        termRef.current.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [active, workspaceId]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden p-2">
      <div
        ref={hostRef}
        className="min-h-0 min-w-0 flex-1 overflow-hidden"
        tabIndex={0}
        role="application"
        aria-label="Terminal"
        onPointerDown={() => termRef.current?.focus()}
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
}

