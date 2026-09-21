import { describe, expect, test } from "bun:test";
import { runCpuTask } from "@qone/shared";

describe("CPU worker abstraction", () => {
  test("runs a structured-cloneable task without changing the caller API", async () => {
    const result = await runCpuTask({ values: [3, 1, 2] }, (input) => input.values.toSorted((a, b) => a - b));
    expect(result).toEqual([1, 2, 3]);
  });
});
