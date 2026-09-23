import { expect, test } from "bun:test";
import { Check } from "typebox/value";
import { presentTool } from "../src/present-tool";
import { decide } from "../src/permissions";

test("present exposes the official recursive UI schema without an approval prompt", async () => {
  const card = {
    $type: "Card",
    title: "Summary",
    children: [{ $type: "Text", children: "Ready" }],
  };
  expect(Check(presentTool.parameters, card)).toBe(true);
  expect(Check(presentTool.parameters, { $type: "Unknown" })).toBe(false);
  expect(Check(presentTool.parameters, { $type: "Button", label: "Dead control" })).toBe(false);
  expect(decide({ toolName: "present", args: card })).toBe("allow");
  const result = await presentTool.execute("call-1", card, undefined, undefined, {} as never);
  expect(result.isError).not.toBe(true);
});
