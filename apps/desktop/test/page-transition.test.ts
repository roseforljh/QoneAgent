import { expect, test } from "bun:test";
import {
  PAGE_TRANSITION_VARIANTS,
  REDUCED_PAGE_TRANSITION_VARIANTS,
  pageTransitionDirection,
  pageTransitionKey,
} from "../src/lib/page-transition";

test("pageTransitionKey maps main sidebar routes and keeps chat subroutes on the chat layer", () => {
  expect(pageTransitionKey("/")).toBe("chat");
  expect(pageTransitionKey("/settings")).toBe("chat");
  expect(pageTransitionKey("/chat/session-1")).toBe("chat");
  expect(pageTransitionKey("/workspaces/ws-1")).toBe("chat");
  expect(pageTransitionKey("/teams")).toBe("teams");
  expect(pageTransitionKey("/schedules")).toBe("schedules");
  expect(pageTransitionKey("/browser")).toBe("browser");
  expect(pageTransitionKey("/skills")).toBe("skills");
  expect(pageTransitionKey("/permissions")).toBe("permissions");
});

test("pageTransitionDirection stays directional across forward, back, and direct switches", () => {
  expect(pageTransitionDirection("chat", "chat")).toBe(0);
  expect(pageTransitionDirection("chat", "teams")).toBe(1);
  expect(pageTransitionDirection("chat", "schedules")).toBe(1);
  expect(pageTransitionDirection("teams", "schedules")).toBe(1);
  expect(pageTransitionDirection("schedules", "teams")).toBe(-1);
  expect(pageTransitionDirection("teams", "chat")).toBe(-1);
  expect(pageTransitionDirection("schedules", "chat")).toBe(-1);
});

test("page transition variants invert horizontal offset by direction and respect reduced motion", () => {
  const enter = PAGE_TRANSITION_VARIANTS.enter as (dir: 1 | -1) => { opacity: number; x: number; scale: number };
  const exit = PAGE_TRANSITION_VARIANTS.exit as (dir: 1 | -1) => { opacity: number; x: number; scale: number };
  expect(enter(1).x).toBeGreaterThan(0);
  expect(enter(-1).x).toBeLessThan(0);
  expect(exit(1).x).toBeLessThan(0);
  expect(exit(-1).x).toBeGreaterThan(0);
  expect(REDUCED_PAGE_TRANSITION_VARIANTS.center).toMatchObject({ opacity: 1, x: 0, scale: 1 });
});
