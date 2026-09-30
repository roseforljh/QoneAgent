import { expect, test } from "bun:test";
import { PiAdapter } from "../src/pi-adapter";

test("a child execution does not mark the parent session as running", () => {
  const adapter = new PiAdapter(() => {});
  const runs = (adapter as unknown as { activeRunIds: Map<string, string> }).activeRunIds;
  runs.set("parent::subagent::child", "child-run");
  expect(adapter.isRunning("parent::subagent::child")).toBe(true);
  expect(adapter.isRunning("parent")).toBe(false);
});
