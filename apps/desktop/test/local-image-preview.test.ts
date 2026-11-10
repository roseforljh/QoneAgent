import { expect, test } from "bun:test";
import { localImagePreview } from "../src/lib/local-image-preview";

test("local image previews authorize the original file and reuse its asset URL", async () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: Array<{ command: string; path: unknown }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    electronBridge: {
      invoke: async (command: string, args?: { path?: unknown }) => {
        calls.push({ command, path: args?.path });
      },
      listen: async () => () => {},
      convertFileSrc: (filePath: string) => `asset://localhost/${filePath.replaceAll("\\", "/")}`,
    },
  } });
  try {
    const path = "C:\\Media\\plot.png";
    const first = await localImagePreview(path);
    const second = await localImagePreview(path);
    expect(first).toBe(second);
    expect(first).toContain("plot.png");
    expect(calls).toEqual([{ command: "authorize_attachment_preview", path }]);
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});