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
  expect(QONE_SYSTEM_PROMPT).toContain("多个阶段之间有实质进展或关键发现时");
  expect(QONE_SYSTEM_PROMPT).toContain("不要只连续输出标题");
});

test("child acknowledgements belong at receipt or result reading, before subsequent work", () => {
  expect(QONE_SYSTEM_PROMPT).toContain("下一条助手回复开头");
  expect(QONE_SYSTEM_PROMPT).toContain("不要等到最终结论末尾补写");
  expect(QONE_SYSTEM_PROMPT).toContain("在继续其他工具之前");
  expect(QONE_SYSTEM_PROMPT).toContain("控制请求被接受不等于任务完成");
});
