import { afterEach, beforeEach, expect, test } from "bun:test";
import type { FilePreviewInfo, RuntimeCommand } from "@qone/protocol";
import { disconnectFilePreviews, dispatchFilePreview, dispatchFilePreviewError, removeFilePreview, requestFilePreview, useFilePreviewStore } from "../src/lib/file-preview-state";

let commands: Extract<RuntimeCommand, { type: "file.preview" }>[] = [];
const send = async (command: RuntimeCommand) => {
  if (command.type === "file.preview") commands.push(command);
  return true;
};
const file = (absolutePath: string, content: string): FilePreviewInfo => ({ absolutePath, content, kind: "markdown", mimeType: "text/markdown", size: content.length, truncated: false });
const receive = (command: (typeof commands)[number], content: string) => dispatchFilePreview({ ...command, file: file(command.path, content) });

beforeEach(() => { commands = []; disconnectFilePreviews(); useFilePreviewStore.setState({ views: {} }); });
afterEach(() => { disconnectFilePreviews(); useFilePreviewStore.setState({ views: {} }); });

test("independent readers accept out-of-order responses in their owning tabs", async () => {
  await requestFilePreview("first", { path: "C:/Repo/first.md" }, send);
  await requestFilePreview("second", { path: "D:/Docs/second.md" }, send);
  receive(commands[1]!, "# Second");
  receive(commands[0]!, "# First");
  const views = useFilePreviewStore.getState().views;
  expect(views.first?.file?.content).toBe("# First");
  expect(views.second?.file?.content).toBe("# Second");
  expect(views.first?.loading || views.second?.loading).toBe(false);
});

test("stale success and error responses cannot replace a refreshed reader", async () => {
  await requestFilePreview("reader", { path: "C:/Repo/guide.md" }, send);
  await requestFilePreview("reader", { path: "C:/Repo/guide.md" }, send);
  await requestFilePreview("reader", { path: "C:/Repo/guide.md", full: true }, send);
  receive(commands[2]!, "# Latest");
  receive(commands[0]!, "# Stale");
  expect(dispatchFilePreviewError(commands[1]!.requestId, "stale failure")).toBe(true);
  expect(useFilePreviewStore.getState().views.reader).toMatchObject({ loading: false, file: { content: "# Latest" } });
  expect(useFilePreviewStore.getState().views.reader?.error).toBeUndefined();
});

test("closing a tab consumes its late error without recreating it or reporting a chat error", async () => {
  await requestFilePreview("reader", { path: "C:/Repo/missing.md" }, send);
  removeFilePreview("reader");
  expect(dispatchFilePreviewError(commands[0]!.requestId, "file missing")).toBe(true);
  expect(useFilePreviewStore.getState().views.reader).toBeUndefined();
  expect(dispatchFilePreviewError("chat-request", "chat error")).toBe(false);
});

test("disconnect and failed sends settle loading state, then a new request recovers", async () => {
  await requestFilePreview("reader", { path: "C:/Repo/guide.md" }, async () => false);
  expect(useFilePreviewStore.getState().views.reader).toMatchObject({ loading: false, error: "disconnected" });
  await requestFilePreview("reader", { path: "C:/Repo/guide.md" }, send);
  disconnectFilePreviews();
  expect(useFilePreviewStore.getState().views.reader).toMatchObject({ loading: false, error: "disconnected" });
  receive(commands[0]!, "# Before restart");
  expect(useFilePreviewStore.getState().views.reader?.file).toBeUndefined();
  await requestFilePreview("reader", { path: "C:/Repo/guide.md" }, send);
  receive(commands[1]!, "# Reconnected");
  expect(useFilePreviewStore.getState().views.reader).toMatchObject({ loading: false, file: { content: "# Reconnected" } });
  expect(useFilePreviewStore.getState().views.reader?.error).toBeUndefined();
});
