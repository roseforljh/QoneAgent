import type { RunPermissionMode, RunThinkingLevel } from "@qone/protocol";

export type SessionRunOptions = {
  modelId?: string;
  permissionMode?: RunPermissionMode;
  thinkingByModel?: Record<string, RunThinkingLevel>;
};

export const DEFAULT_RUN_PERMISSION_MODE: RunPermissionMode = "ask";

const STORAGE_KEY = "qone-session-run-options";
const NEW_SESSION_STORAGE_KEY = "qone-new-session-run-options";
const LEGACY_NEW_SESSION_MODEL_STORAGE_KEY = "qone-new-session-model";
const LEGACY_DEFAULT_PERMISSION_STORAGE_KEY = "qone-default-permission-mode";
const modes = new Set<RunPermissionMode>(["ask", "auto", "full"]);
const levels = new Set<RunThinkingLevel>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseRunOptions(value: unknown): SessionRunOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const modelId = typeof record.modelId === "string" && record.modelId ? record.modelId : undefined;
  const permissionMode = modes.has(record.permissionMode as RunPermissionMode) ? record.permissionMode as RunPermissionMode : undefined;
  const thinkingByModel = record.thinkingByModel && typeof record.thinkingByModel === "object" && !Array.isArray(record.thinkingByModel)
    ? Object.fromEntries(Object.entries(record.thinkingByModel).filter(([, level]) => levels.has(level as RunThinkingLevel))) as Record<string, RunThinkingLevel>
    : undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(thinkingByModel && Object.keys(thinkingByModel).length ? { thinkingByModel } : {}),
  };
}

export function withRunOptionDefaults(options: SessionRunOptions | undefined, defaults: SessionRunOptions | undefined): SessionRunOptions {
  const modelId = options?.modelId ?? defaults?.modelId;
  const permissionMode = options?.permissionMode ?? defaults?.permissionMode;
  const thinkingByModel = options?.thinkingByModel || defaults?.thinkingByModel
    ? { ...defaults?.thinkingByModel, ...options?.thinkingByModel }
    : undefined;
  return {
    ...(modelId ? { modelId } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(thinkingByModel && Object.keys(thinkingByModel).length ? { thinkingByModel } : {}),
  };
}

export function loadRunOptions(): Record<string, SessionRunOptions> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, parseRunOptions(value)]));
  } catch { return {}; }
}

export function saveRunOptions(options: Record<string, SessionRunOptions>): void {
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(options)); } catch { /* unavailable storage */ }
}

/** The shared defaults every brand-new conversation starts from. */
export function loadNewSessionRunOptions(): SessionRunOptions {
  try {
    const raw = window.localStorage.getItem(NEW_SESSION_STORAGE_KEY);
    if (raw !== null) {
      const parsed = parseRunOptions(JSON.parse(raw));
      return { ...parsed, permissionMode: parsed.permissionMode ?? DEFAULT_RUN_PERMISSION_MODE };
    }
    const legacyModelId = window.localStorage.getItem(LEGACY_NEW_SESSION_MODEL_STORAGE_KEY) || undefined;
    const legacyPermission = window.localStorage.getItem(LEGACY_DEFAULT_PERMISSION_STORAGE_KEY);
    return {
      ...(legacyModelId ? { modelId: legacyModelId } : {}),
      permissionMode: modes.has(legacyPermission as RunPermissionMode) ? legacyPermission as RunPermissionMode : DEFAULT_RUN_PERMISSION_MODE,
    };
  } catch {
    return { permissionMode: DEFAULT_RUN_PERMISSION_MODE };
  }
}

export function saveNewSessionRunOptions(options: SessionRunOptions): void {
  try { window.localStorage.setItem(NEW_SESSION_STORAGE_KEY, JSON.stringify(options)); } catch { /* unavailable storage */ }
}
