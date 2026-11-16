import { afterEach, expect, test } from "bun:test";

const calls: string[] = [];
const pending = new Map<string, Array<() => void>>();
const release = (path: string) => { for (const resolve of pending.get(path) ?? []) resolve(); pending.delete(path); };
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    electronBridge: {
      invoke: async (name: string, args?: { path?: string }) => {
        if (name !== "authorize_attachment_preview" || !args?.path) return;
        calls.push(args.path);
        // Hold the authorization open so an owner can release while it is pending.
        await new Promise<void>((resolve) => {
          const list = pending.get(args.path!) ?? [];
          list.push(resolve);
          pending.set(args.path!, list);
        });
      },
      listen: async () => () => {},
      convertFileSrc: (path: string) => `asset://${path}`,
    },
  },
});

const { localImagePreview, releaseLocalImagePreview, retainLocalImagePreview } = await import("../src/lib/local-image-preview");
afterEach(() => { calls.length = 0; pending.clear(); });
process.on("exit", () => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("a path released while its authorization is pending is re-requested by the next owner", async () => {
  const path = "C:\\Media\\pending.png";
  retainLocalImagePreview(path);
  const first = localImagePreview(path);
  // Owner A unmounts before authorization settles; owner B mounts for the same
  // path. The dropped entry must not be mistaken for an in-flight request.
  releaseLocalImagePreview(path);
  retainLocalImagePreview(path);
  const second = localImagePreview(path);
  expect(calls).toEqual([path, path]);
  release?.(path);
  expect(await first).toBe("asset://C:\\Media\\pending.png");
  expect(await second).toBe("asset://C:\\Media\\pending.png");
  releaseLocalImagePreview(path);
});

test("two owners share one authorization and only the last release drops it", async () => {
  const path = "C:\\Media\\shared.png";
  retainLocalImagePreview(path);
  retainLocalImagePreview(path);
  const first = localImagePreview(path);
  releaseLocalImagePreview(path);
  const second = localImagePreview(path);
  expect(second).toBe(first);
  expect(calls).toEqual([path]);
  release?.(path);
  await first;
  releaseLocalImagePreview(path);
  const third = localImagePreview(path);
  expect(calls).toEqual([path, path]);
  release?.(path);
  await third;
});
