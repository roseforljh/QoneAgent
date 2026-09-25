import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

interface Props {
  terminalId: string;
  cwd?: string;
}

// One TerminalView = one ConPTY on the Rust side. Input goes via terminal_write,
// output arrives via "terminal:data" events.
export default function TerminalView({ terminalId, cwd }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    termRef.current = term;

    const unData = listen<{ terminalId: string; data: string }>("terminal:data", (e) => {
      if (e.payload.terminalId === terminalId) term.write(e.payload.data);
    });
    const unExit = listen<{ terminalId: string }>("terminal:exit", (e) => {
      if (e.payload.terminalId === terminalId) term.write("\r\n[process exited]\r\n");
    });

    const sub = term.onData((d) => {
      invoke("terminal_write", { terminalId, data: d }).catch(() => {});
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      invoke("terminal_resize", {
        terminalId,
        cols: term.cols,
        rows: term.rows,
      }).catch(() => {});
    });
    ro.observe(ref.current);

    invoke("terminal_spawn", {
      terminalId,
      shell: "powershell.exe",
      cwd,
      cols: term.cols,
      rows: term.rows,
    }).catch((e) => term.write(`\r\nspawn failed: ${e}\r\n`));

    return () => {
      sub.dispose();
      ro.disconnect();
      unData.then((f) => f());
      unExit.then((f) => f());
      invoke("terminal_kill", { terminalId }).catch(() => {});
      term.dispose();
    };
  }, [terminalId, cwd]);

  return <div ref={ref} style={{ flex: 1, minHeight: 0 }} />;
}
