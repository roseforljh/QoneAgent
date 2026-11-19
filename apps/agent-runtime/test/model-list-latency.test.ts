import { expect, test } from "bun:test";
import type { ModelConfigInfo } from "@qone/protocol";
import { handleRuntimeCommand } from "../src/runtime-commands";

test("model.list replies with stored configs without waiting for network model metadata", async () => {
  const configs: ModelConfigInfo[] = [{ id: "p/m", provider: "p", model: "m", config: { apiType: "claude", thinking: "high" }, enabled: true, updatedAt: 1 }];
  const sent: unknown[] = [];
  let refreshes = 0;
  const services = {
    modelConfigRepo: { list: () => configs },
    // Metadata resolution (provider /models, models.dev) that never finishes.
    ensureModelsReady: () => { refreshes++; return new Promise<void>(() => {}); },
    send: (event: unknown) => { sent.push(event); },
    log: { warn() {} },
  } as unknown as Parameters<typeof handleRuntimeCommand>[1];
  expect(await handleRuntimeCommand({ type: "model.list", requestId: "list" }, services)).toBe(true);
  expect(sent).toEqual([{ type: "model.list", configs }]);
  expect(refreshes).toBe(1);
});
