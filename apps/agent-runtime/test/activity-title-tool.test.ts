import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ACTIVITY_TITLE_MAX_LENGTH, ACTIVITY_TITLE_TOOL, activityTitleFromArgs, applyAssistantToolEvent, assistantPartsFromPiMessage } from "@qone/protocol";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo } from "@qone/database";
import { createActivityTitleTool } from "../src/activity-title-tool";
import { ApprovalQueue, withPermission } from "../src/permissions";

const execute = (tool: ReturnType<typeof createActivityTitleTool>, args: unknown) => tool.execute("stage-1", args as never, undefined, undefined, undefined);

test("the stage tool records an authored purpose without requesting work permissions", async () => {
  const tool = withPermission(createActivityTitleTool(), {
    queue: new ApprovalQueue(), workspacePath: process.cwd(), internal: true,
    mode: () => "ask", rules: { get: () => "deny" },
    emitApproval: () => { throw new Error("stage metadata requested approval"); },
  });
  const result = await execute(tool, { title: "  Investigate\n state transitions  " });
  expect(tool.name).toBe(ACTIVITY_TITLE_TOOL);
  expect(result.content).toEqual([{ type: "text", text: '{"title":"Investigate state transitions"}' }]);
  expect(result.details).toEqual({});
});

test("empty, non-string, inherited and oversized headings are rejected rather than fabricated", async () => {
  const tool = createActivityTitleTool();
  for (const args of [{ title: " " }, { title: 1 }, {}, [], Object.create({ title: "Inherited" }), { title: "x".repeat(ACTIVITY_TITLE_MAX_LENGTH + 1) }]) {
    expect(activityTitleFromArgs(args)).toBeUndefined();
    await expect(execute(tool, args)).rejects.toThrow();
  }
});

test("stage purposes survive the ordinary Pi event and database reopen path", async () => {
  const args = { title: "Investigate lifecycle transitions" };
  const result = await execute(createActivityTitleTool(), args);
  const parts = applyAssistantToolEvent(assistantPartsFromPiMessage({ message: {
    role: "assistant", stopReason: "toolUse", content: [
      { type: "toolCall", id: "stage-1", name: ACTIVITY_TITLE_TOOL, arguments: args },
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "lifecycle.ts" } },
    ],
  } }, 3), "tool.completed", { toolCallId: "stage-1", result });
  const db = openDb(":memory:");
  const session = new SessionRepo(db).create();
  const run = new RunRepo(db).create(session.id);
  const saved = new MessageRepo(db).addAssistant(session.id, "", run.id, undefined, parts);
  const snapshot = db.$client.serialize();
  closeDb(db);
  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
  try {
    const history = new MessageRepo(reopened).listBySession(session.id);
    const restored = JSON.parse(history.find((message) => message.id === saved.id)!.parts!);
    expect(restored).toEqual(parts);
    expect(activityTitleFromArgs(restored[0].args)).toBe(args.title);
    expect(restored.map((part: { toolCallId: string }) => part.toolCallId)).toEqual(["stage-1", "read-1"]);
  } finally { closeDb(reopened); }
});
