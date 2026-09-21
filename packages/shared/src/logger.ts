export type LogLevel = "debug" | "info" | "warn" | "error";

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface LogFields {
  sessionId?: string;
  runId?: string;
  toolCallId?: string;
  module?: string;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

// Simple stdout logger for the runtime sidecar. Writes one JSON line per entry
// to stderr so stdout stays clean for protocol NDJSON.
export function createLogger(module: string): Logger {
  const logDir = process.env.QONE_LOG_DIR ?? path.join(
    process.env.APPDATA ?? process.env.HOME ?? process.cwd(),
    "QoneAgent",
    "logs",
  );
  let logFile: string | undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, "runtime.log");
  } catch {
    // Stderr remains the safe fallback if the log directory is unavailable.
  }
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    const line = JSON.stringify({
      timestamp: Date.now(),
      level,
      module,
      msg,
      ...fields,
    });
    process.stderr.write(line + "\n");
    if (logFile) {
      try { appendFileSync(logFile, line + "\n", "utf8"); } catch { /* stderr already received the entry */ }
    }
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
