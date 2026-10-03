const STORAGE_KEY = "qone-composer-history-by-session";
const MAX_HISTORY_ITEMS = 100;

type ComposerHistoryBySession = Map<string, string[]>;

function normalizeItems(items: unknown): string[] {
  if (!Array.isArray(items)) return [];
  return items.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(-MAX_HISTORY_ITEMS);
}

function loadStoredHistory(): ComposerHistoryBySession {
  const history = new Map<string, string[]>();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return history;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return history;
    for (const [sessionId, items] of Object.entries(parsed)) {
      const normalized = normalizeItems(items);
      if (normalized.length > 0) history.set(sessionId, normalized);
    }
  } catch {
    // Ignore storage failure or malformed persisted history.
  }
  return history;
}

function saveStoredHistory(history: ComposerHistoryBySession) {
  try {
    const serialized = Object.fromEntries(
      [...history].map(([sessionId, items]) => [sessionId, items.slice(-MAX_HISTORY_ITEMS)]),
    );
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(serialized));
  } catch {
    // Ignore storage failure.
  }
}

const memoryHistory = loadStoredHistory();

function validSessionId(sessionId: string | undefined): string | undefined {
  const normalized = sessionId?.trim();
  return normalized || undefined;
}

/**
 * 将用户发送的消息记录到指定会话的历史列表中。
 * 没有 sessionId 时，消息仍会由当前会话消息列表提供给导航，不写入共享历史桶。
 */
export function addComposerHistory(sessionId: string | undefined, text: string) {
  const key = validSessionId(sessionId);
  const trimmed = text.trim();
  if (!key || !trimmed) return;

  const current = memoryHistory.get(key) ?? [];
  if (current[current.length - 1] === trimmed) return;

  // 过滤掉旧位置的相同记录，使最新发送的项排在会话历史末尾。
  const next = current.filter((item) => item !== trimmed);
  next.push(trimmed);
  memoryHistory.set(key, next.slice(-MAX_HISTORY_ITEMS));
  saveStoredHistory(memoryHistory);
}

/**
 * 获取指定会话的历史记录（按从旧到新排列，最新消息在末尾）。
 * 已持久化的会话历史只与该会话当前已加载的用户消息合并，绝不读取其他会话。
 */
export function getCombinedComposerHistory(
  sessionId: string | undefined,
  sessionUserMessages?: readonly string[],
): string[] {
  const history = [...(memoryHistory.get(validSessionId(sessionId) ?? "") ?? [])];
  const validSession = (sessionUserMessages ?? [])
    .map((message) => message.trim())
    .filter((message) => message.length > 0);

  // 去重时保留最后一次出现的位置，与发送历史的“最新在末尾”规则一致。
  for (const message of validSession) {
    const existingIndex = history.indexOf(message);
    if (existingIndex >= 0) history.splice(existingIndex, 1);
    history.push(message);
  }
  return history;
}
