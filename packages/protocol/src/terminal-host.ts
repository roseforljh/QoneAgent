// Internal transport: never accepted by the renderer-facing RuntimeCommand parser.
export const elevatedTerminalEnv = "QONE_ELEVATED_TERMINAL";

interface ExecRequest {
  type: "terminal-host.exec";
  id: string;
  command: string;
  cwd: string;
  timeout?: number;
  env?: Record<string, string | undefined>;
}

export type ShellHostRequest = ExecRequest | { type: "terminal-host.cancel"; id: string };
export type TerminalHostRequest = ShellHostRequest |
  { type: "pty.spawn"; id: string; shell: string; args: string[]; options: {
    cwd: string; cols: number; rows: number; env: Record<string, string | undefined>;
  } } |
  { type: "pty.write"; id: string; data: string } |
  { type: "pty.resize"; id: string; cols: number; rows: number } |
  { type: "pty.clear" | "pty.kill"; id: string };

export type ShellHostResponse =
  { type: "terminal-host.output"; id: string; data: string } |
  { type: "terminal-host.exit"; id: string; exitCode: number | null } |
  { type: "terminal-host.error"; id: string; message: string };
export type TerminalHostResponse = ShellHostResponse |
  { type: "pty.data"; id: string; data: string } |
  { type: "pty.exit"; id: string; exitCode: number; signal?: number; error?: string };
