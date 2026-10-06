import { describe, expect, test } from "bun:test";
import { compactionReserveTokens, DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, PI_REQUEST_LIMITS } from "../src/pi-adapter";

describe("Qone compaction settings", () => {
  test("normalizes persisted preferences and keeps the default", () => {
    expect(normalizePiCompactionPreferences(undefined)).toEqual(DEFAULT_PI_COMPACTION_PREFERENCES);
    expect(normalizePiCompactionPreferences({ autoCompactionEnabled: false, compactionThreshold: 99 })).toEqual({
      autoCompactionEnabled: false,
      compactionThreshold: 95,
    });
  });

  test("maps the UI percentage to Pi reserve tokens per model context window", () => {
    expect(compactionReserveTokens(128_000, 80)).toBe(25_600);
    expect(compactionReserveTokens(32_000, 50)).toBe(16_000);
    expect(compactionReserveTokens(1, 95)).toBe(1);
  });

  test("bounds provider stalls and agent retries for interactive runs", () => {
    expect(PI_REQUEST_LIMITS).toMatchObject({
      httpIdleTimeoutMs: 90_000,
      retry: { maxRetries: 1, provider: { timeoutMs: 90_000, maxRetries: 0 } },
    });
  });
});
