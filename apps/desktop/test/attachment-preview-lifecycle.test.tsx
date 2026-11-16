import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ChatMessage } from "../src/store";

const dom = new JSDOM("<!doctype html><body></body>", { url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const pending: Array<() => void> = [];
let authorizations = 0;
Object.assign(dom.window, { electronBridge: {
  invoke: async (name: string) => {
    if (name !== "authorize_attachment_preview") return;
    authorizations++;
    await new Promise<void>(resolve => pending.push(resolve));
  },
  convertFileSrc: (path: string) => `asset://${path}`,
  listen: async () => () => {},
} });
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});
const { createRoot } = await import("react-dom/client");
const { useAttachmentPreviewSrc } = await import("../src/hooks/use-attachment-src");
const { useConversationMessages } = await import("../src/lib/use-conversation-messages");
const emptySteers: ChatMessage[] = [];
const tools: [] = [];
const images = new Map();
const imagePath = "C:/Media/lifecycle.png";
const message: ChatMessage = { id: "image-message", role: "user", content: "look", attachments: [
  { id: "image", type: "image", name: "lifecycle.png", mimeType: "image/png", localPath: imagePath },
] };
function Conversation({ messages }: { messages: ChatMessage[] }) {
  const converted = useConversationMessages({ messages, streaming: "", streamingParts: [], running: false,
    currentSessionId: "preview-session", toolCalls: tools, childImagesByRun: images }, emptySteers);
  return <pre>{JSON.stringify(converted)}</pre>;
}
function Thumbnail() {
  return <span data-preview>{useAttachmentPreviewSrc({ localPath: imagePath }) ?? "pending"}</span>;
}

test("pending image previews survive conversation refreshes and are released by both hook owners", async () => {
  const host = dom.window.document.createElement("div"); dom.window.document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<><Conversation messages={[message]} /><Thumbnail key="thumbnail" /></>));
    expect(authorizations).toBe(1);
    // Replacing the messages array cancels the old effect while authorization
    // remains pending; the replacement effect must subscribe to the same work.
    await act(async () => root.render(<><Conversation messages={[{ ...message }]} /><Thumbnail key="thumbnail" /></>));
    expect(authorizations).toBe(1);
    await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
    expect(host.querySelector("pre")!.textContent).toContain('"type":"image"');
    expect(host.querySelector("[data-preview]")!.textContent).toBe(`asset://${imagePath}`);
    await act(async () => root.render(<><Thumbnail key="thumbnail" /></>));
    expect(authorizations).toBe(1);
    await act(async () => root.render(null));
    await act(async () => root.render(<><Thumbnail key="thumbnail" /></>));
    expect(authorizations).toBe(2);
    await act(async () => { pending.splice(0).forEach(resolve => resolve()); });
    expect(host.textContent).toBe(`asset://${imagePath}`);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
