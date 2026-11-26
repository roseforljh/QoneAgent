import { describe, expect, test } from "bun:test";
import {
  canNavigateBack,
  createInitialNavigationState,
  pushNavigationState,
  stepNavigationState,
} from "../src/components/app-chrome/use-app-navigation";

describe("app titlebar navigation", () => {
  test("booting or refreshing on a sub-page keeps Back enabled to return to the project home page", () => {
    const initial = createInitialNavigationState("/teams", "s1");
    expect(canNavigateBack(initial, "/teams")).toBe(true);
    expect(initial.entries).toEqual([{ path: "/", sessionId: "s1" }, { path: "/teams" }]);

    const back = stepNavigationState(initial, -1, "s1");
    expect(back.target).toEqual({ path: "/", sessionId: "s1" });
    expect(back.next.index).toBe(0);
    expect(canNavigateBack(back.next, "/")).toBe(false);

    const forward = stepNavigationState(back.next, 1, "s1");
    expect(forward.target).toEqual({ path: "/teams" });
    expect(forward.next.index).toBe(1);
  });

  test("preserves multi-page history and falls back to home if at index 0 on a non-home route", () => {
    let state = createInitialNavigationState("/", undefined);
    expect(canNavigateBack(state, "/")).toBe(false);

    state = pushNavigationState(state, { path: "/", sessionId: "s1" });
    expect(canNavigateBack(state, "/")).toBe(false);

    state = pushNavigationState(state, { path: "/teams", sessionId: "s1" });
    state = pushNavigationState(state, { path: "/schedules", sessionId: "s1" });
    expect(state.entries).toEqual([{ path: "/", sessionId: "s1" }, { path: "/teams" }, { path: "/schedules" }]);

    const step1 = stepNavigationState(state, -1, "s1");
    expect(step1.target).toEqual({ path: "/teams" });
    const step2 = stepNavigationState(step1.next, -1, "s1");
    expect(step2.target).toEqual({ path: "/", sessionId: "s1" });

    // 兜底：即便历史被截断到仅剩子页，仍允许退回 "/" 且保留当前页可前进。
    const orphan = { entries: [{ path: "/teams" }], index: 0 };
    expect(canNavigateBack(orphan, "/teams")).toBe(true);
    const backHome = stepNavigationState(orphan, -1, "s2");
    expect(backHome.target).toEqual({ path: "/", sessionId: "s2" });
    expect(backHome.next.entries).toEqual([{ path: "/", sessionId: "s2" }, { path: "/teams" }]);
  });
});
