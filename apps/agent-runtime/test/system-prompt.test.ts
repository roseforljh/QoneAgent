import { expect, test } from "bun:test";
import { ACTIVITY_TITLE_TOOL } from "@qone/protocol";
import { QONE_SYSTEM_PROMPT } from "../src/system-prompt";

test("system prompt keeps execution guidance general instead of forcing source-tree output", () => {
  expect(QONE_SYSTEM_PROMPT).toContain(ACTIVITY_TITLE_TOOL);
  expect(QONE_SYSTEM_PROMPT).not.toContain("源码结构");
  expect(QONE_SYSTEM_PROMPT).not.toContain("完整项目树");
  expect(QONE_SYSTEM_PROMPT).toContain("结论、实际变化、验证结果");
  expect(QONE_SYSTEM_PROMPT).toContain("先说结论");
  expect(QONE_SYSTEM_PROMPT).toContain("避免空话、模板话、翻译腔");
});
