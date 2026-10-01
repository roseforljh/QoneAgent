import type { RunPermissionMode, RunThinkingLevel } from "@qone/protocol";

export type SessionRunOptions = {
  modelId?: string;
  permissionMode?: RunPermissionMode;
  thinkingByModel?: Record<string, RunThinkingLevel>;
};

const STORAGE_KEY = "qone-session-run-options";
const DEFAULT_PERMISSION_STORAGE_KEY = "qone-default-permission-mode";
const modes = new Set<RunPermissionMode>(["ask", "auto", "full"]);
const levels = new Set<RunThinkingLevel>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function loadRunOptions(): Record<string, SessionRunOptions> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, Record<string, unknown>] => !!entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])).map(([id, value]) => [id, {
      modelId: typeof value.modelId === "string" && value.modelId ? value.modelId : undefined,
      permissionMode: modes.has(value.permissionMode as RunPermissionMode) ? value.permissionMode as RunPermissionMode : undefined,
      thinkingByModel: value.thinkingByModel && typeof value.thinkingByModel === "object" && !Array.isArray(value.thinkingByModel)
        ? Object.fromEntries(Object.entries(value.thinkingByModel).filter(([, level]) => levels.has(level as RunThinkingLevel)))
        : undefined,
    }]));
  } catch { return {}; }
}

export function saveRunOptions(options: Record<string, SessionRunOptions>): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options)); } catch { /* unavailable storage */ }
}

export function loadDefaultPermissionMode(): RunPermissionMode {
  try {
    const value = window.localStorage.getItem(DEFAULT_PERMISSION_STORAGE_KEY);
    return modes.has(value as RunPermissionMode) ? value as RunPermissionMode : "ask";
  } catch { return "ask"; }
}

export function saveDefaultPermissionMode(mode: RunPermissionMode): void {
  try { window.localStorage.setItem(DEFAULT_PERMISSION_STORAGE_KEY, mode); } catch { /* unavailable storage */ }
}
