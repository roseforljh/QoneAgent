import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, useAui, useExternalStoreRuntime } = await import("@assistant-ui/react");
const { createQoneMessageQueue } = await import("../src/lib/qone-message-queue");
const { useMessageQueueAdapter } = await import("../src/lib/use-message-queue-adapter");
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

const queue = createQoneMessageQueue({ sessionId: "transit", isRunning: () => true, send: () => {}, steer: async () => true, sync: () => {} });
queue.controller.notifyBusy();
// Like dropped screenshots, the image is only prepared when the message is sent.
const imageAdapter = {
  accept: "image/*",
  add: async ({ file }: { file: File }) => ({ id: "shot", type: "image" as const, name: file.name, contentType: file.type, file, status: { type: "requires-action" as const, reason: "composer-send" as const } }),
  send: async (attachment: { id: string; name: string; contentType: string }) => ({ ...attachment, type: "image" as const, status: { type: "complete" as const }, content: [{ type: "image" as const, image: "data:image/png;base64,AA==" }] }),
  remove: async () => {},
};
let aui: ReturnType<typeof useAui>;
function Capture() { aui = useAui(); return null; }
function User() { return <div data-user><MessagePrimitive.Parts /></div>; }
function View() {
  const adapter = useMessageQueueAdapter(queue);
  const runtime = useExternalStoreRuntime({
    messages: [{ id: "a", role: "assistant", content: [{ type: "text", text: "working" }] }],
    convertMessage: (message) => message, isRunning: true, onNew: async () => {}, queue: adapter, adapters: { attachments: imageAdapter },
  });
  return <AssistantRuntimeProvider runtime={runtime}><Capture /><ThreadPrimitive.Messages components={{ UserMessage: User, AssistantMessage: () => null }} /></AssistantRuntimeProvider>;
}

test("a message with a screenshot sent to the queue during a run is not also shown in the conversation", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<View />));
  await act(async () => { await aui.composer().addAttachment(new dom.window.File(["png"], "shot.png", { type: "image/png" }) as unknown as File); });
  await act(async () => { aui.composer().setText("queued while running"); aui.composer().send(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["queued while running"]);
  expect(host.querySelectorAll("[data-user]")).toHaveLength(0);
  await act(async () => root.unmount());
});
