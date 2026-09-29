import { expect, test } from "bun:test";
import type { SubagentRunInfo } from "@qone/protocol";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import { appendSubagentImages, selectSubagentImages, subagentImagesByRun } from "../src/lib/subagent-images";
import { subagentImageGenerations } from "../src/lib/subagent-image-generations";

function child(id: string, parentRunId: string, startedAt: number, images: string[]): SubagentRunInfo {
  return {
    id, parentRunId, parentSessionId: "session", depth: 1, toolCallId: id,
    title: id, task: "generate", status: "completed", startedAt,
    content: "", parts: images.map((image, messageSequence) => ({ type: "image", image, filename: `${id}-${messageSequence}.png`, messageSequence })),
    turnCount: 1, retryCount: 0,
  };
}

test("child images appear in the parent answer during streaming and after reload", () => {
  const children = [
    child("later", "run-1", 20, ["data:image/png;base64,B", "data:image/png;base64,A"]),
    child("earlier", "run-1", 10, ["data:image/png;base64,A"]),
    child("unrelated", "run-2", 5, ["data:image/png;base64,C"]),
  ];
  const images = subagentImagesByRun(children).get("run-1");
  expect(images?.every((part) => part.status.type === "complete")).toBe(true);
  const live = appendSubagentImages(assistantMessageContent({ content: "生成中" }, [], true), images);
  const reopened = appendSubagentImages(assistantMessageContent({ content: "已完成" }, [], false), images);
  for (const content of [live, reopened]) {
    expect(content.filter((part) => part.type === "image").map((part) => part.image)).toEqual([
      "data:image/png;base64,A", "data:image/png;base64,B",
    ]);
  }
  expect(subagentImagesByRun(children).get("run-2")?.map((part) => part.image)).toEqual(["data:image/png;base64,C"]);
});

test("an image already emitted by the parent is not shown twice", () => {
  const image = "data:image/png;base64,A";
  const parent = assistantMessageContent({ content: "", parts: [{ type: "image", image, messageSequence: 1 }] }, [], false);
  expect(appendSubagentImages(parent, subagentImagesByRun([child("image", "run", 1, [image])]).get("run"))).toEqual(parent);
});

test("images belong to only the assistant segment in which their child started", () => {
  const images = subagentImagesByRun([
    child("before-steer", "run", 10, ["data:image/png;base64,A"]),
    child("after-steer", "run", 30, ["data:image/png;base64,B"]),
  ]).get("run");
  const first = appendSubagentImages([], images, undefined, 20);
  const second = appendSubagentImages([], images, 20, 40);
  expect(first.filter((part) => part.type === "image").map((part) => part.image)).toEqual(["data:image/png;base64,A"]);
  expect(second.filter((part) => part.type === "image").map((part) => part.image)).toEqual(["data:image/png;base64,B"]);
});

test("streaming child text does not re-render the parent until images change", () => {
  const first = child("image", "run", 1, ["data:image/png;base64,A"]);
  const before = selectSubagentImages({ subagents: [first] });
  const textUpdate = selectSubagentImages({ subagents: [{ ...first, streaming: "still working" }] });
  expect(textUpdate).toBe(before);
  const imageUpdate = selectSubagentImages({ subagents: [child("image", "run", 1, ["data:image/png;base64,A", "data:image/png;base64,B"])] });
  expect(imageUpdate).not.toBe(before);
});

test("image subagents show a parent placeholder through generation and remove it after success", () => {
  const image = { ...child("image", "run", 1, []), profileId: "builtin:imageGeneration", status: "created" as const };
  const text = { ...child("researcher", "run", 2, []), profileId: "researcher", status: "running" as const };
  const unrelated = { ...image, id: "other", parentRunId: "another-run" };
  const models = [{ id: "custom-image", provider: "custom", model: "my-model", config: { output: ["image"] }, enabled: true, updatedAt: 0 }];
  const custom = { ...child("custom", "run", 3, []), profileId: "user-profile", model: "custom-image", status: "running" as const };
  expect(subagentImageGenerations([image, text, unrelated, custom], "run", models).map((item) => item.id)).toEqual(["image", "custom"]);
  expect(subagentImageGenerations([{ ...image, status: "running" }], "run", models)[0]?.generating).toBe(true);
  expect(subagentImageGenerations([{ ...image, parts: child("image", "run", 1, ["data:image/png;base64,A"]).parts, status: "completed" }], "run", models)).toEqual([]);
  expect(subagentImageGenerations([image], undefined, models)).toEqual([]);
});

test("failed image subagents show an error while cancelled runs stop showing a placeholder", () => {
  const image = { ...child("image", "run", 1, []), profileId: "builtin:imageGeneration" };
  expect(subagentImageGenerations([{ ...image, status: "failed", error: "Content filtered" }], "run", [])[0]).toMatchObject({
    id: "image", generating: false, error: "Content filtered",
  });
  expect(subagentImageGenerations([{ ...image, status: "completed" }], "run", [])[0]?.missingImage).toBe(true);
  expect(subagentImageGenerations([{ ...image, status: "cancelled" }], "run", [])).toEqual([]);
});
