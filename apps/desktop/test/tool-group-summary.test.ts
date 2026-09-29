import { expect, test } from "bun:test";
import { toolGroupSummary } from "../src/components/assistant-ui/tool-group-summary";

test("completed groups describe every operation in first-occurrence order", () => {
  expect(toolGroupSummary([{ verb: "读取" }, { verb: "搜索" }, { verb: "读取" }], "zh-CN"))
    .toBe("读取 2 项 · 搜索 1 项");
  expect(toolGroupSummary([{ verb: "Read" }, { verb: "Read" }], "en")).toBe("Read ×2");
  expect(toolGroupSummary([{ verb: "custom_tool" }], "en")).toBe("custom_tool ×1");
});
