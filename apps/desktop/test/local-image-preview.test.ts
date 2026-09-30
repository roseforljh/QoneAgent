import { expect, test } from "bun:test";
import { clearMocks, mockConvertFileSrc, mockIPC } from "@tauri-apps/api/mocks";
import { localImagePreview } from "../src/lib/local-image-preview";

test("local image previews authorize the original file and reuse its asset URL", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
  const calls: Array<{ command: string; path: unknown }> = [];
  try {
    mockIPC((command, payload) => {
      calls.push({ command, path: (payload as { path?: unknown } | undefined)?.path });
    });
    mockConvertFileSrc("windows");
    const path = "C:\\Media\\plot.png";
    const first = await localImagePreview(path);
    const second = await localImagePreview(path);
    expect(first).toBe(second);
    expect(first).toContain("plot.png");
    expect(calls).toEqual([{ command: "authorize_attachment_preview", path }]);
  } finally {
    clearMocks();
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
