import { describe, expect, test } from "bun:test";
import { compactionReserveTokens, DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, PI_REQUEST_OVERRIDES } from "../src/pi-adapter";

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

  test("does not impose a client idle timeout on model requests", () => {
    expect(PI_REQUEST_OVERRIDES).toEqual({ httpIdleTimeoutMs: 0 });
  });
});
