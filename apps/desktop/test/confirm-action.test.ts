import { expect, test } from "bun:test";
import {
  confirmDestructiveAction,
  getConfirmationRequest,
  resolveConfirmation,
  subscribeConfirmation,
} from "../src/lib/confirm-action";

test("destructive confirmations are queued and resolve only after an explicit choice", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  const changes: Array<string | null> = [];
  const unsubscribe = subscribeConfirmation(() => changes.push(getConfirmationRequest()?.message ?? null));
  try {
    const first = confirmDestructiveAction("Delete chat?");
    const second = confirmDestructiveAction("Delete project?");
    expect(getConfirmationRequest()?.message).toBe("Delete chat?");
    resolveConfirmation(false);
    expect(await first).toBe(false);
    expect(getConfirmationRequest()?.message).toBe("Delete project?");
    resolveConfirmation(true);
    expect(await second).toBe(true);
    expect(getConfirmationRequest()).toBeNull();
    expect(changes).toEqual(["Delete chat?", "Delete chat?", "Delete project?", null]);
  } finally {
    unsubscribe();
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
