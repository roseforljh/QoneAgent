import { expect, test } from "bun:test";
import { dirname, join } from "node:path";
import {
  CompositeAttachmentAdapter, SimpleImageAttachmentAdapter, SimpleTextAttachmentAdapter,
  type AppendMessage, type AttachmentAdapter, type ExternalStoreAdapter, type PendingAttachment,
} from "@assistant-ui/react";
import { bindComposerDrafts, ComposerDraftStore } from "../src/lib/composer-drafts";
import { AnyFileAttachmentAdapter } from "../src/lib/file-attachment-adapter";
import { createNativeAttachmentFile } from "../src/lib/native-attachment-file";
import { serializeMessageAttachments } from "../src/lib/message-attachments";

// Exercise the installed external-store runtime: a switch really replaces the
// main composer, including its nested subscriptions and memoized public state.
const reactDist = dirname(Bun.resolveSync("@assistant-ui/react", import.meta.dir));
const { ExternalStoreRuntimeCore } = await import(join(reactDist, "legacy-runtime/runtime-cores/external-store/ExternalStoreRuntimeCore.js"));
const { AssistantRuntimeImpl } = await import(join(reactDist, "legacy-runtime/runtime/AssistantRuntime.js"));

const localAttachments = () => new CompositeAttachmentAdapter([
  new SimpleTextAttachmentAdapter(), new SimpleImageAttachmentAdapter(), new AnyFileAttachmentAdapter(),
]);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(drafts = new ComposerDraftStore(), subscribeFirst = false, attachments: AttachmentAdapter = localAttachments()) {
  const submitted: AppendMessage[] = [];
  const adapter = (id: string, ids = ["a", "b", "c"]): ExternalStoreAdapter => ({
    messages: [],
    onNew: async (message) => { submitted.push(message); },
    adapters: { attachments, threadList: { threadId: id, threads: ids.map((id) => ({ id, status: "regular" as const })) } },
  });
  const core = new ExternalStoreRuntimeCore(adapter("a"));
  const runtime = new AssistantRuntimeImpl(core);
  // UI consumers can connect the main-composer binding before our parent hook.
  const unsubscribeUI = subscribeFirst ? runtime.thread.composer.subscribe(() => {
    runtime.thread.composer.getState();
  }) : () => {};
  let selected: string | undefined = "a";
  const bind = () => {
    const owner = selected;
    return bindComposerDrafts(runtime, owner, () => selected === owner, drafts);
  };
  let dispose = bind();
  return {
    runtime, drafts, submitted,
    attachments: () => runtime.thread.composer.getState().attachments,
    add: (file: File) => runtime.thread.composer.addAttachment(file),
    remove: (id: string) => runtime.thread.composer.getAttachmentByIndex(
      runtime.thread.composer.getState().attachments.findIndex((attachment: { id: string }) => attachment.id === id),
    ).remove(),
    text: () => runtime.thread.composer.getState().text,
    type: (text: string) => runtime.thread.composer.setText(text),
    switch: (id: string, ids?: string[]) => {
      // Match React: selection changes first, adapter effect replaces the core,
      // then the draft binding's old cleanup and new setup run.
      selected = id;
      core.setAdapter(adapter(id, ids));
      dispose();
      dispose = bind();
      if (ids) drafts.prune(ids);
    },
    dispose: () => { dispose(); unsubscribeUI(); },
    rebind: () => { dispose(); dispose = bind(); },
    subscribe: (callback: () => void) => runtime.thread.composer.subscribe(callback),
  };
}

test("unsent long multiline text is restored verbatim after switching sessions", () => {
  const f = fixture();
  const text = `  中文草稿\n${"long text 🐧 ".repeat(2000)}\n\n尾部  `;
  f.type(text);
  f.switch("b");
  expect(f.text()).toBe("");
  f.switch("a");
  expect(f.text()).toBe(text);
  f.dispose();
});

test("independent drafts survive rapid round trips without blank snapshots overwriting them", () => {
  const f = fixture();
  f.type("draft A");
  f.switch("b"); f.type("draft B");
  f.switch("c"); f.type("draft C");
  for (let i = 0; i < 5; i++) {
    f.switch("a"); expect(f.text()).toBe("draft A");
    f.switch("b"); expect(f.text()).toBe("draft B");
    f.switch("c"); expect(f.text()).toBe("draft C");
  }
  f.dispose();
});

test("manually clearing a draft removes it and whitespace-only text remains exact", () => {
  const f = fixture();
  f.type("old draft"); f.type("");
  f.switch("b"); f.switch("a");
  expect(f.text()).toBe("");
  f.type(" \n  "); f.switch("b"); f.switch("a");
  expect(f.text()).toBe(" \n  ");
  f.dispose();
});

test("sending clears only the sender's draft", async () => {
  const f = fixture();
  f.type("keep A"); f.switch("b"); f.type("send B");
  f.runtime.thread.composer.send();
  await Promise.resolve(); await Promise.resolve();
  expect(f.text()).toBe("");
  f.switch("a"); expect(f.text()).toBe("keep A");
  f.switch("b"); expect(f.text()).toBe("");
  f.dispose();
});

test("same-thread adapter refresh and StrictMode-style effect rebinding keep the current draft", () => {
  const f = fixture();
  f.type("latest text");
  f.switch("a"); f.rebind();
  expect(f.text()).toBe("latest text");
  f.type("edited after rebind");
  f.switch("b"); f.switch("a");
  expect(f.text()).toBe("edited after rebind");
  f.dispose();
});

test("drafts survive chat-page runtime remounts and listeners detach on cleanup", () => {
  const drafts = new ComposerDraftStore();
  const first = fixture(drafts);
  first.type("keep across navigation"); first.dispose();
  first.type("detached runtime must not overwrite");
  const second = fixture(drafts);
  expect(second.text()).toBe("keep across navigation");
  second.dispose();
});

test("deleting an inactive session drops its draft", () => {
  const f = fixture();
  f.type("deleted A"); f.switch("b");
  f.switch("b", ["b", "c"]);
  expect(f.drafts.get("a")).toBeUndefined();
  f.switch("a"); expect(f.text()).toBe("");
  f.dispose();
});

test("earlier UI subscribers cannot save the replacement's blank state under the outgoing owner", () => {
  const f = fixture(new ComposerDraftStore(), true);
  f.type("A survives subscriber ordering");
  f.switch("b"); f.type("B survives too");
  f.switch("a"); expect(f.text()).toBe("A survives subscriber ordering");
  f.switch("b"); expect(f.text()).toBe("B survives too");
  f.dispose();
});

test("mixed image, video, audio and document drafts retain exact files, IDs and order without rereads", async () => {
  const f = fixture(new ComposerDraftStore(), true);
  const files = [
    new File(["image"], "plot.png", { type: "image/png" }),
    new File(["video"], "clip.mp4", { type: "video/mp4" }),
    new File(["audio"], "voice.wav", { type: "audio/wav" }),
    new File(["notes"], "notes.txt", { type: "text/plain" }),
    new File(["pdf"], "report.pdf", { type: "application/pdf" }),
  ];
  for (const file of files) {
    // Restoration must retain a reference, never read or regenerate media.
    Object.defineProperty(file, "arrayBuffer", { value: () => { throw new Error("unexpected reread"); } });
    await f.add(file);
  }
  const original = f.attachments();
  f.type("mixed draft");
  for (let i = 0; i < 5; i++) {
    f.switch("b"); expect(f.attachments()).toHaveLength(0);
    f.switch("a");
    expect(f.text()).toBe("mixed draft");
    expect(f.attachments()).toBe(original);
    expect(f.attachments().map((attachment) => attachment.file)).toEqual(files);
  }
  f.dispose();
});

test("attachment-only drafts and independent per-session files are restored synchronously", async () => {
  const f = fixture();
  await f.add(new File(["A"], "a.png", { type: "image/png" }));
  const a = f.attachments();
  f.switch("b");
  await f.add(new File(["B"], "b.mp3", { type: "audio/mpeg" }));
  const b = f.attachments();
  f.switch("a"); expect(f.text()).toBe(""); expect(f.attachments()).toBe(a);
  f.switch("b"); expect(f.attachments()).toBe(b);
  f.switch("c"); expect(f.attachments()).toHaveLength(0);
  f.dispose();
});

test("effect rebinding does not duplicate or rebuild attachments", async () => {
  const f = fixture();
  await f.add(new File(["image"], "image.png", { type: "image/png" }));
  const original = f.attachments();
  f.rebind(); f.rebind(); f.switch("a");
  expect(f.attachments()).toBe(original);
  expect(f.attachments()).toHaveLength(1);
  f.dispose();
});

test("remounting a chat runtime preserves native media file metadata", async () => {
  const drafts = new ComposerDraftStore();
  const first = fixture(drafts);
  const video = createNativeAttachmentFile("video.mp4", "video/mp4", "C:\\Media\\video.mp4", 3_000_000_000);
  const audio = createNativeAttachmentFile("audio.wav", "audio/wav", "C:\\Media\\audio.wav", 400_000_000);
  await first.add(video); await first.add(audio);
  const original = first.attachments();
  first.dispose();
  const second = fixture(drafts);
  expect(second.attachments()).toBe(original);
  expect(second.attachments()[0]?.file).toBe(video);
  expect(second.attachments()[1]?.file).toBe(audio);
  second.runtime.thread.composer.send();
  await tick();
  expect(second.submitted).toHaveLength(1);
  expect(await serializeMessageAttachments(second.submitted[0]!)).toEqual([
    { type: "file", name: "video.mp4", mimeType: "video/mp4", data: "", localPath: "C:\\Media\\video.mp4" },
    { type: "file", name: "audio.wav", mimeType: "audio/wav", data: "", localPath: "C:\\Media\\audio.wav" },
  ]);
  second.dispose();
});

test("completed external attachments keep original content and can still be sent", async () => {
  const f = fixture();
  await f.runtime.thread.composer.addAttachment({
    id: "external-image", type: "image", name: "external.png", contentType: "image/png",
    content: [{ type: "image", image: "data:image/png;base64,aGVsbG8=" }],
  });
  const original = f.attachments()[0]!;
  f.switch("b"); f.switch("a");
  expect(f.attachments()[0]).toBe(original);
  f.runtime.thread.composer.send(); await tick();
  expect(await serializeMessageAttachments(f.submitted[0]!)).toEqual([
    { type: "image", name: "external.png", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
  ]);
  f.dispose();
});

test("removing an attachment or resetting a draft never resurrects it after switching", async () => {
  const f = fixture();
  await f.add(new File(["image"], "image.png", { type: "image/png" }));
  await f.add(new File(["audio"], "audio.wav", { type: "audio/wav" }));
  f.type("keep text");
  await f.remove(f.attachments()[0]!.id);
  f.switch("b"); f.switch("a");
  expect(f.attachments().map((attachment) => attachment.name)).toEqual(["audio.wav"]);
  expect(f.text()).toBe("keep text");
  await f.runtime.thread.composer.reset();
  f.switch("b"); f.switch("a");
  expect(f.attachments()).toHaveLength(0);
  expect(f.text()).toBe("");
  expect(f.drafts.get("a")).toBeUndefined();
  f.dispose();
});

test("sending restored files clears only the sender's attachments and sends their original bytes", async () => {
  const f = fixture();
  await f.add(new File(["image"], "image.png", { type: "image/png" }));
  f.type("send A"); f.switch("b");
  await f.add(new File(["B"], "b.mp3", { type: "audio/mpeg" }));
  const b = f.attachments();
  f.switch("a"); f.runtime.thread.composer.send(); await tick();
  expect(f.submitted).toHaveLength(1);
  expect(await serializeMessageAttachments(f.submitted[0]!)).toEqual([
    { type: "image", name: "image.png", mimeType: "image/png", data: "data:image/png;base64,aW1hZ2U=" },
  ]);
  f.switch("b"); expect(f.attachments()).toBe(b);
  f.switch("a"); expect(f.attachments()).toHaveLength(0); expect(f.text()).toBe("");
  f.dispose();
});

test("deleting a session releases its attachment draft", async () => {
  const f = fixture();
  await f.add(new File(["image"], "image.png", { type: "image/png" }));
  f.switch("b", ["b", "c"]);
  expect(f.drafts.get("a")).toBeUndefined();
  f.switch("a"); expect(f.attachments()).toHaveLength(0);
  f.dispose();
});

function uploadingAdapter() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const local = new AnyFileAttachmentAdapter();
  const adapter: AttachmentAdapter = {
    accept: "*",
    async *add({ file }) {
      const attachment: PendingAttachment = {
        id: "upload-1", type: "file", name: file.name, contentType: file.type, file,
        status: { type: "running", reason: "uploading", progress: 10 },
      };
      yield attachment;
      await gate;
      yield { ...attachment, status: { type: "requires-action", reason: "composer-send" } };
    },
    remove: (attachment) => local.remove(attachment),
    send: (attachment) => local.send(attachment),
  };
  return { adapter, finish: () => finish() };
}

test("an in-progress attachment completes in its restored session, never the selected other session", async () => {
  const upload = uploadingAdapter();
  const f = fixture(new ComposerDraftStore(), true, upload.adapter);
  const file = new File(["video"], "video.mp4", { type: "video/mp4" });
  const task = f.add(file);
  await tick();
  expect(f.attachments()[0]?.status.type).toBe("running");
  f.switch("b"); f.type("B must remain untouched");
  upload.finish(); await task;
  expect(f.attachments()).toHaveLength(0);
  expect(f.text()).toBe("B must remain untouched");
  f.switch("a");
  expect(f.attachments()[0]?.file).toBe(file);
  expect(f.attachments()[0]?.status.type).toBe("requires-action");
  f.dispose();
});

test("returning before upload completion mirrors the result without losing newer text or files", async () => {
  const upload = uploadingAdapter();
  const f = fixture(new ComposerDraftStore(), true, upload.adapter);
  const task = f.add(new File(["video"], "video.mp4", { type: "video/mp4" }));
  await tick();
  f.switch("b"); f.switch("a");
  f.type("edited while uploading");
  await f.runtime.thread.composer.addAttachment({
    id: "new-file", name: "new.txt", contentType: "text/plain", content: [{ type: "text", text: "new" }],
  });
  upload.finish(); await task;
  expect(f.text()).toBe("edited while uploading");
  expect(f.attachments().map((attachment) => attachment.id)).toEqual(["upload-1", "new-file"]);
  expect(f.attachments()[0]?.status.type).toBe("requires-action");
  f.switch("b"); f.switch("a");
  expect(f.attachments()).toHaveLength(2);
  f.dispose();
});

test("removing a restored upload cannot be undone by a detached upload's completion", async () => {
  const upload = uploadingAdapter();
  const f = fixture(new ComposerDraftStore(), false, upload.adapter);
  const task = f.add(new File(["audio"], "audio.wav", { type: "audio/wav" }));
  await tick(); f.switch("b"); f.switch("a");
  f.type("keep newer text"); await f.remove("upload-1");
  upload.finish(); await task;
  expect(f.attachments()).toHaveLength(0);
  expect(f.text()).toBe("keep newer text");
  f.switch("b"); f.switch("a"); expect(f.attachments()).toHaveLength(0);
  f.dispose();
});

test("deleting a session prevents an unfinished upload from recreating its draft", async () => {
  const upload = uploadingAdapter();
  const f = fixture(new ComposerDraftStore(), false, upload.adapter);
  const task = f.add(new File(["audio"], "audio.wav", { type: "audio/wav" }));
  await tick(); f.switch("b", ["b", "c"]);
  upload.finish(); await task;
  expect(f.drafts.get("a")).toBeUndefined();
  f.switch("a"); expect(f.attachments()).toHaveLength(0);
  f.dispose();
});
