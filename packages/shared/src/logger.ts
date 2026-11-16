export type LogLevel = "debug" | "info" | "warn" | "error";

import { mkdirSync } from "node:fs";
import { appendFile, rename, stat } from "node:fs/promises";
import path from "node:path";
import { qoneLogsDir } from "./qone-paths.js";

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

/** Shared by every module writing this file; no concurrent append/rotate race. */
type PendingLog = { lines: string[]; bytes: number; limit: number };
const pendingLogs = new Map<string, PendingLog>();
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
function maxBytes(): number {
  const configured = Number(process.env.QONE_LOG_MAX_BYTES);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_BYTES;
}

async function drain(file: string, pending: PendingLog) {
  try {
    let written = await stat(file).then(info => info.size, () => 0);
    while (pending.lines.length) {
      const text = pending.lines.join("");
      const bytes = pending.bytes;
      pending.lines = [];
      pending.bytes = 0;
      if (written + bytes > pending.limit) {
        await rename(file, `${file}.1`);
        written = 0;
      }
      await appendFile(file, text, "utf8");
      written += bytes;
    }
  } catch {
    // Stderr already received every entry; a locked disk must not grow the queue.
  } finally {
    pendingLogs.delete(file);
  }
}

function appendLog(file: string, line: string) {
  let pending = pendingLogs.get(file);
  const bytes = Buffer.byteLength(line);
  const limit = pending?.limit ?? maxBytes();
  // Bound the diagnostic file copy and its queue; stderr still receives the full
  // entry, including oversized entries or bursts faster than the disk can write.
  if (bytes > limit || (pending?.bytes ?? 0) + bytes > limit) return;
  if (pending) {
    pending.lines.push(line);
    pending.bytes += bytes;
  } else {
    pending = { lines: [line], bytes, limit };
    pendingLogs.set(file, pending);
    void drain(file, pending);
  }
}

// One JSON line per entry to stderr, so stdout stays clean for protocol NDJSON.
export function createLogger(module: string): Logger {
  const logDir = process.env.QONE_LOG_DIR ?? qoneLogsDir();
  let logFile: string | undefined;
  try {
    mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, "runtime.log");
  } catch { /* stderr remains available */ }
  const write = (level: LogLevel, msg: string, fields?: LogFields) => {
    const line = JSON.stringify({ timestamp: Date.now(), level, module, msg, ...fields }) + "\n";
    process.stderr.write(line);
    if (logFile) appendLog(logFile, line);
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}
