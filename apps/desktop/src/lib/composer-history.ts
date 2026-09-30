const STORAGE_KEY = "qone-composer-history";
const MAX_HISTORY_ITEMS = 100;

function loadStoredHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    }
  } catch {
    // Ignore storage failure
  }
  return [];
}

function saveStoredHistory(history: string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(-MAX_HISTORY_ITEMS)));
  } catch {
    // Ignore storage failure
  }
}

let memoryHistory: string[] = loadStoredHistory();

/**
 * 将用户发送的消息记录到历史列表中
 */
export function addComposerHistory(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;

  // 避免连续重复
  if (memoryHistory.length > 0 && memoryHistory[memoryHistory.length - 1] === trimmed) {
    return;
  }

  // 过滤掉同名旧记录，使最新发送的项排在历史末尾
  const filtered = memoryHistory.filter((item) => item !== trimmed);
  filtered.push(trimmed);
  memoryHistory = filtered.slice(-MAX_HISTORY_ITEMS);
  saveStoredHistory(memoryHistory);
}

/**
 * 获取组合后的历史记录列表（按从旧到新排列，最新消息在末尾）
 * 包含当前会话的历史用户消息以及持久化的全局历史
 */
export function getCombinedComposerHistory(sessionUserMessages?: readonly string[]): string[] {
  if (sessionUserMessages && sessionUserMessages.length > 0) {
    const validSession = sessionUserMessages.map((m) => m.trim()).filter((m) => m.length > 0);
    const sessionSet = new Set(validSession);
    const olderGlobals = memoryHistory.filter((item) => !sessionSet.has(item));
    return [...olderGlobals, ...validSession];
  }
  return [...memoryHistory];
}
