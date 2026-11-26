import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@qone/protocol";
import { nextRunAt } from "../src/schedules/schedule-rule";
import { recoveredParts } from "../src/run-checkpoints";
import { McpElicitations } from "../src/mcp-elicitation";

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

test("schedule rules give the next local fire time and never fire twice for one slot", () => {
  // 2026-11-26 is a Thursday.
  const now = local(2026, 11, 26, 9, 30);
  expect(nextRunAt({ kind: "daily", time: "10:00" }, now)).toBe(local(2026, 11, 26, 10, 0));
  expect(nextRunAt({ kind: "daily", time: "09:30" }, now)).toBe(local(2026, 11, 27, 9, 30));
  expect(nextRunAt({ kind: "weekly", days: [1], time: "08:00" }, now)).toBe(local(2026, 11, 30, 8, 0));
  expect(nextRunAt({ kind: "weekly", days: [4], time: "09:00" }, now)).toBe(local(2026, 12, 3, 9, 0));
  expect(nextRunAt({ kind: "once", at: now + 1 }, now)).toBe(now + 1);
  expect(nextRunAt({ kind: "once", at: now }, now)).toBeUndefined();
  expect(nextRunAt({ kind: "interval", minutes: 30 }, now)).toBe(now + 30 * 60_000);
  // After a long sleep the next slot follows the anchor's cadence, without a backlog.
  expect(nextRunAt({ kind: "interval", minutes: 30 }, now + 95 * 60_000, now)).toBe(now + 120 * 60_000);
});

test("a recovered transcript keeps finished tool results and closes the one cut off by the restart", () => {
  const raw = [
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Reading" }, { type: "toolCall", id: "a", name: "read", arguments: { path: "x" } }] },
    { role: "toolResult", toolCallId: "a", content: [{ type: "text", text: "file body" }], isError: false },
    { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "make" } }] },
  ];
  const parts = recoveredParts(raw, 100, "interrupted");
  expect(parts.map((part) => part.type)).toEqual(["text", "tool-call", "tool-call"]);
  expect(parts[1]).toMatchObject({ toolCallId: "a", isError: false, result: { content: [{ type: "text", text: "file body" }] } });
  expect(parts[2]).toMatchObject({ toolCallId: "b", isError: true, result: { content: [{ type: "text", text: "interrupted" }] } });
});

test("MCP questions are listed until answered or cancelled by the server", async () => {
  const published: RuntimeEvent[] = [];
  const broker = new McpElicitations((event) => published.push(event));
  const config = { id: "srv", name: "Server" };
  const form = broker.ask(config, { message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } } as never, new AbortController().signal);
  const pending = published.at(-1) as Extract<RuntimeEvent, { type: "mcp.elicitations" }>;
  expect(pending.requests).toHaveLength(1);
  expect(pending.requests[0]).toMatchObject({ serverName: "Server", mode: "form", required: ["name"] });
  expect(broker.respond({ type: "mcp.elicitation.respond", requestId: "r", elicitationId: pending.requests[0]!.id, action: "accept", content: { name: "Ada" } })).toBe(true);
  expect(await form).toEqual({ action: "accept", content: { name: "Ada" } });
  expect((published.at(-1) as typeof pending).requests).toEqual([]);

  const controller = new AbortController();
  const url = broker.ask(config, { mode: "url", message: "Sign in", url: "https://example.com", elicitationId: "e" } as never, controller.signal);
  controller.abort();
  expect(await url).toEqual({ action: "cancel" });
  expect((published.at(-1) as typeof pending).requests).toEqual([]);
});
