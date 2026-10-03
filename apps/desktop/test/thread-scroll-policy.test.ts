import { expect, test } from "bun:test";
import { nextThreadFollowMode, threadPhase } from "../src/lib/thread-scroll-policy";

test("follow mode watches live replies and follows overflow through final answer and idle", () => {
  expect(nextThreadFollowMode("static", { type: "phase", previous: "idle", phase: "prework" })).toBe("prework_watch");
  expect(nextThreadFollowMode("prework_watch", { type: "content", phase: "prework", overflow: 1 })).toBe("prework_follow");
  expect(nextThreadFollowMode("prework_follow", { type: "phase", previous: "prework", phase: "final_answer" })).toBe("user_follow");
  expect(nextThreadFollowMode("static", { type: "phase", previous: "idle", phase: "final_answer" })).toBe("prework_watch");
  expect(nextThreadFollowMode("prework_watch", { type: "phase", previous: "prework", phase: "final_answer" })).toBe("prework_watch");
  expect(nextThreadFollowMode("prework_watch", { type: "content", phase: "final_answer", overflow: -100 })).toBe("prework_watch");
  expect(nextThreadFollowMode("prework_watch", { type: "content", phase: "final_answer", overflow: 1 })).toBe("user_follow");
  expect(nextThreadFollowMode("user_follow", { type: "phase", previous: "final_answer", phase: "idle" })).toBe("user_follow");
  expect(nextThreadFollowMode("user_follow", { type: "distance", phase: "final_answer", distance: 25 })).toBe("static");
  expect(nextThreadFollowMode("static", { type: "bottom", phase: "prework" })).toBe("prework_follow");
  expect(nextThreadFollowMode("static", { type: "bottom", phase: "final_answer" })).toBe("user_follow");
});

test("phase classification only reads the active assistant turn", () => {
  const user = { id: "u", role: "user", content: [{ type: "text", text: "Question" }] } as any;
  const assistant = (content: unknown[]) => ({ id: "a", role: "assistant", content }) as any;
  expect(threadPhase(true, [assistant([{ type: "text", text: "Old answer" }]), user])).toBe("idle");
  expect(threadPhase(true, [user, assistant([{ type: "reasoning", text: "Think" }])])).toBe("prework");
  expect(threadPhase(true, [user, assistant([{ type: "text", text: "Answer", parentId: "pi:phase:final_answer:1" }])])).toBe("final_answer");
  expect(threadPhase(false, [user, assistant([{ type: "text", text: "Answer" }])])).toBe("idle");
});

test("completion without final text retains following but does not resume paused reading", () => {
  expect(nextThreadFollowMode("prework_follow", { type: "phase", previous: "prework", phase: "idle" })).toBe("user_follow");
  expect(nextThreadFollowMode("prework_watch", { type: "phase", previous: "prework", phase: "idle" })).toBe("static");
  expect(nextThreadFollowMode("static", { type: "phase", previous: "prework", phase: "idle" })).toBe("static");
});
