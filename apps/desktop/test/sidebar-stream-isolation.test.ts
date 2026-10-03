import { expect, test } from "bun:test";
import type { SessionInfo, SubagentRunInfo } from "@qone/protocol";
import { createSidebarSessionsSelector } from "../src/lib/sidebar-sessions";
import { createSubagentImagesSelector } from "../src/lib/subagent-images";
import { createSubagentMediaSelector, subagentImageGenerations } from "../src/lib/subagent-image-generations";

test("assistant activity leaves sidebar summaries stable, while user activity and title/project changes update only their row", () => {
  const sessions: SessionInfo[] = ["a", "b"].map((id) => ({ id, title: id, workspaceId: "project", createdAt: 1, updatedAt: 2, lastUserMessageAt: 2 }));
  const select = createSidebarSessionsSelector();
  const original = select(sessions);
  for (let index = 0; index < 200; index++) expect(select([{ ...sessions[0]!, updatedAt: 3 + index }, sessions[1]!])).toBe(original);
  const changed = select([{ ...sessions[0]!, title: "renamed", workspaceId: "other", lastUserMessageAt: 300 }, sessions[1]!]);
  expect(changed[0]!.title).toBe("renamed"); expect(changed[0]!.workspaceId).toBe("other"); expect(changed[0]!.updatedAt).toBe(300);
  expect(changed[1]).toBe(original[1]);
  expect(select([sessions[1]!, sessions[0]!]).map((item) => item.id)).toEqual(["b", "a"]);
  expect(select([sessions[0]!])).toHaveLength(1);
});

test("image selectors from separate conversations keep their own references across interleaved child output", () => {
  const child = { id: "a", parentRunId: "parent", startedAt: 1, parts: [{ type: "image", image: "data:image/png;base64,AA", messageSequence: 1 }] } as SubagentRunInfo;
  const a = createSubagentImagesSelector(), b = createSubagentImagesSelector();
  const firstA = a({ subagents: [child] }), firstB = b({ subagents: [{ ...child, id: "b", parentRunId: "other" }] });
  for (let index = 0; index < 200; index++) {
    expect(a({ subagents: [{ ...child, streaming: `${index}` }] })).toBe(firstA);
    expect(b({ subagents: [{ ...child, id: "b", parentRunId: "other", streaming: `${index}` }] })).toBe(firstB);
  }
  expect(a({ subagents: [{ ...child, parts: [{ type: "image", image: "data:image/png;base64,BB", messageSequence: 1 }] }] })).not.toBe(firstA);
  expect(a({ subagents: [] }).size).toBe(0);
});

test("child media projections ignore text/reasoning and retain terminal errors and generated images", () => {
  const select = createSubagentMediaSelector();
  const child = { id: "a", parentRunId: "parent", title: "image", task: "draw", profileId: "builtin:imageGeneration", status: "running", parts: [] } as unknown as SubagentRunInfo;
  const first = select(subagentImageGenerations([child], "parent", []), ["a"]);
  expect(first.generations).toEqual([{ id: "a", prompt: "draw", generating: true, error: undefined, missingImage: false }]);
  for (let index = 0; index < 200; index++) expect(select(subagentImageGenerations([{ ...child, streaming: `${index}`, parts: [{ type: "reasoning", text: `${index}`, messageSequence: 1 }] }], "parent", []), ["a"])).toBe(first);
  const failed = select(subagentImageGenerations([{ ...child, status: "failed", error: "failed" }], "parent", []), ["a"]);
  expect(failed.generations[0]).toEqual({ id: "a", prompt: "draw", generating: false, error: "failed", missingImage: false });
  const completed = select(subagentImageGenerations([{ ...child, status: "completed", parts: [{ type: "image", image: "image", messageSequence: 1 }] }], "parent", []), ["a"]);
  expect(completed.generations).toEqual([]); expect(completed.childRunIds).toEqual(["a"]);
});
