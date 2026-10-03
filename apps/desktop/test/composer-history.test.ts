import { expect, test } from "bun:test";
import { addComposerHistory, getCombinedComposerHistory } from "../src/lib/composer-history";

function sessionId(name: string) {
  return `composer-history-test-${name}-${crypto.randomUUID()}`;
}

test("composer history is isolated by session", () => {
  const sessionA = sessionId("a");
  const sessionB = sessionId("b");

  addComposerHistory(sessionA, "message from A");
  addComposerHistory(sessionB, "message from B");

  expect(getCombinedComposerHistory(sessionA)).toEqual(["message from A"]);
  expect(getCombinedComposerHistory(sessionB)).toEqual(["message from B"]);
});

test("current session messages merge only into their own history", () => {
  const sessionA = sessionId("loaded-a");
  const sessionB = sessionId("loaded-b");

  addComposerHistory(sessionA, "persisted A");

  expect(getCombinedComposerHistory(sessionA, ["loaded A"])).toEqual(["persisted A", "loaded A"]);
  expect(getCombinedComposerHistory(sessionB, ["loaded B"])).toEqual(["loaded B"]);
});

test("history navigation does not write drafts without a session id", () => {
  const sessionA = sessionId("draft");

  addComposerHistory(undefined, "unowned draft");

  expect(getCombinedComposerHistory(sessionA)).toEqual([]);
  expect(getCombinedComposerHistory(undefined, ["current draft"])).toEqual(["current draft"]);
});
