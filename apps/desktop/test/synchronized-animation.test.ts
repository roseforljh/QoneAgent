import { expect, test } from "bun:test";
import { synchronizeDocumentAnimations } from "../src/lib/synchronized-animation";

function fixture(startTimes: number[], timeline: object) {
  const animations = startTimes.map((startTime) => ({ startTime, timeline }));
  const requests: GetAnimationsOptions[] = [];
  const element = {
    ownerDocument: { timeline },
    getAnimations: (options: GetAnimationsOptions) => {
      requests.push(options);
      return animations;
    },
  } as unknown as Element;
  return { element, animations, requests };
}

test("staggered mounts share the document origin for both rotation and arc animations", () => {
  const timeline = { currentTime: 5000 };
  const first = fixture([100, 100], timeline);
  const later = fixture([4200, 4200], timeline);
  synchronizeDocumentAnimations(first.element);
  synchronizeDocumentAnimations(later.element);
  expect(first.animations.map((animation) => animation.startTime)).toEqual([0, 0]);
  expect(later.animations.map((animation) => animation.startTime)).toEqual([0, 0]);
  expect(first.requests).toEqual([{ subtree: true }]);
  expect(later.requests).toEqual([{ subtree: true }]);
});

test("remounted and recreated animations rejoin the same clock without resetting other instances", () => {
  const timeline = { currentTime: 9000 };
  const existing = fixture([0, 0], timeline);
  const recreated = fixture([8500, 8500], timeline);
  synchronizeDocumentAnimations(recreated.element);
  expect(recreated.animations.map((animation) => animation.startTime)).toEqual([0, 0]);
  expect(existing.animations.map((animation) => animation.startTime)).toEqual([0, 0]);
  expect(existing.requests).toEqual([]);
});

test("reduced-motion elements with no animations remain static", () => {
  const reduced = fixture([], { currentTime: 5000 });
  expect(() => synchronizeDocumentAnimations(reduced.element)).not.toThrow();
  expect(reduced.animations).toEqual([]);
});

test("animations on another timeline keep their own origin", () => {
  const ownTimeline = {};
  const otherTimeline = {};
  const { element, animations } = fixture([100, 200], ownTimeline);
  animations[1]!.timeline = otherTimeline;
  synchronizeDocumentAnimations(element);
  expect(animations.map((animation) => animation.startTime)).toEqual([0, 200]);
});
