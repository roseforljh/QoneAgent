export interface PiCompactionPreferences {
  autoCompactionEnabled: boolean;
  compactionThreshold: number;
}

const MIN_COMPACTION_THRESHOLD = 50;
const MAX_COMPACTION_THRESHOLD = 95;

export const DEFAULT_PI_COMPACTION_PREFERENCES: PiCompactionPreferences = {
  autoCompactionEnabled: true,
  compactionThreshold: 80,
};

export function normalizePiCompactionPreferences(value: unknown): PiCompactionPreferences {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const threshold = typeof record.compactionThreshold === "number" && Number.isInteger(record.compactionThreshold)
    ? Math.min(MAX_COMPACTION_THRESHOLD, Math.max(MIN_COMPACTION_THRESHOLD, record.compactionThreshold))
    : DEFAULT_PI_COMPACTION_PREFERENCES.compactionThreshold;
  return {
    autoCompactionEnabled: typeof record.autoCompactionEnabled === "boolean"
      ? record.autoCompactionEnabled
      : DEFAULT_PI_COMPACTION_PREFERENCES.autoCompactionEnabled,
    compactionThreshold: threshold,
  };
}

export function compactionReserveTokens(contextWindow: number, threshold: number): number {
  return Math.max(1, Math.ceil(contextWindow * (1 - threshold / 100)));
}
