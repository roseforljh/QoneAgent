import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { fileTypeIcon, fileTypeIconInfo } from "../src/lib/markdown-file-icon";
import { OPEN_WORKSPACE_FILE_EVENT, type WorkspaceFileTarget } from "../src/lib/workspace-file-navigation";
import { useStore } from "../src/store";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();
let createRoot: typeof import("react-dom/client").createRoot;
let aui: typeof import("@assistant-ui/react");
let SessionTimeline: typeof import("../src/components/assistant-ui/session-timeline").SessionTimeline;
let root: ReturnType<typeof createRoot> | undefined;

beforeAll(async () => {
  view.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as any;
  const globals = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, CustomEvent: view.CustomEvent,
    MutationObserver: view.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: view.getComputedStyle.bind(view), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
  aui = await import("@assistant-ui/react");
  ({ SessionTimeline } = await import("../src/components/assistant-ui/session-timeline"));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  document.body.innerHTML = "";
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});

test("fileTypeIcon distinguishes documents, spreadsheets, media, languages and config formats", () => {
  const cases: readonly [string, string, string?][] = [
    ["report.docx", "ms-word-light-16.svg"],
    ["budget.xlsx", "ms-excel-light-16.svg"],
    ["metrics.csv", "spreadsheet-light-16.svg"],
    ["slides.pptx", "ms-powerpoint-light-16.svg"],
    ["spec.pdf", "document-pdf-light-16.svg"],
    ["README.md", "book-open-light-16.svg"],
    ["notes.txt", "document-text-light-16.svg"],
    ["fixture1.png", "photo-light-16.svg"],
    ["logo.svg", "paint-palette-light-16.svg"],
    ["mockup.sketch", "sketch-light-16.svg"],
    ["clip.mp4", "video-light-16.svg"],
    ["voice.wav", "wavelength-light-16.svg"],
    ["song.mp3", "music-note-light-16.svg"],
    ["bundle.zip", "document-zip-light-16.svg"],
    ["index.ts", "file-typescript-26-928.svg"],
    ["App.tsx", "file-react-26-928.svg"],
    ["script.py", "file-python-26-928.svg"],
    ["main.rs", "file-rust-26-928.svg"],
    ["run.ps1", "file-shell-26-928.svg"],
    ["package.json", "file-json-26-928.svg"],
    ["config.yaml", "braces-light-16.svg"],
    ["schema.sql", "table-light-16.svg"],
    [".env.local", "sliders-light-16.svg"],
    ["bun.lock", "lock-light-16.svg"],
    ["cert.pem", "key-badge-lock-light-16.svg"],
    ["SKILL.md", "file-skill-26-928.svg"],
    ["Dockerfile.prod", "file-terminal-26-928.svg"],
    ["Makefile", "file-build-26-928.svg"],
    ["no-ext", "photo-light-20.svg", "image/png"],
  ];
  for (const [filePath, expectedIcon, mimeType] of cases) {
    expect(fileTypeIcon(filePath, mimeType)).toContain(expectedIcon);
  }
  expect(fileTypeIconInfo("index.ts").colorClass).toContain("text-sky-");
  expect(fileTypeIconInfo("budget.xlsx").colorClass).toContain("text-emerald-");
  expect(fileTypeIconInfo("spec.pdf").colorClass).toContain("text-rose-");
  expect(fileTypeIconInfo("fixture1.png").colorClass).toContain("text-purple-");
});

test("read file rows render a non-collapsible file button with a typed icon and open the right preview pane on click", async () => {
  const previous = useStore.getState();
  const opened: WorkspaceFileTarget[] = [];
  const onOpen = (event: Event) => opened.push((event as CustomEvent<WorkspaceFileTarget>).detail);
  window.addEventListener(OPEN_WORKSPACE_FILE_EVENT, onOpen);

  function Fixture({ content }: { content: ThreadMessageLike["content"] }) {
    const messages: ThreadMessageLike[] = [{
      id: "file-read-row", role: "assistant", status: { type: "complete", reason: "stop" }, content,
    }];
    const runtime = aui.useExternalStoreRuntime({ messages, convertMessage: (m) => m, onNew: async () => {} });
    return (
      <aui.AssistantRuntimeProvider runtime={runtime}>
        <aui.ThreadPrimitive.Messages components={{
          AssistantMessage: () => <aui.MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={1} /></aui.MessagePrimitive.Root>,
        }} />
      </aui.AssistantRuntimeProvider>
    );
  }

  try {
    useStore.setState({
      currentSessionId: "session-read",
      sessions: [{ id: "session-read", workspaceId: "ws-1", title: "Test", createdAt: 1, updatedAt: 1 }],
      workspaces: [{ id: "ws-1", name: "Repo", path: "C:/Repo", createdAt: 1 }],
      toolCalls: [],
    });

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    // 1. 工作区外绝对路径的图片读取（即使模型附带默认 offset=1, limit=2000 也不显示行号）：不展开收起，带彩色图片图标，单击打开右侧预览
    await act(async () => {
      root!.render(
        <Fixture content={[{
          type: "tool-call",
          toolName: "read",
          toolCallId: "read-img",
          args: { path: "C:/Users/33039/AppData/Local/Temp/qone-chart-probe/fixture1.png", offset: 1, limit: 2000 },
          result: { content: [{ type: "text", text: "Read image file [image/png]" }] },
        }]} />,
      );
    });

    expect(container.querySelector('[data-slot="file-read-activity"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="collapsible-trigger"]')).toBeNull();
    expect(container.querySelector('[data-slot="tool-result-panel"]')).toBeNull();
    expect(container.textContent).not.toContain("Read image file [image/png]");

    const button = container.querySelector<HTMLButtonElement>('[data-file-read-button="true"]')!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("fixture1.png");
    const imgIcon = button.querySelector('[data-file-type-icon="true"]');
    expect(imgIcon?.getAttribute("style")).toContain("photo-light-16.svg");
    expect(imgIcon?.className).toContain("text-purple-");

    await act(async () => { button.click(); });
    expect(opened).toEqual([{
      sessionId: "session-read",
      workspaceId: "ws-1",
      path: "C:/Users/33039/AppData/Local/Temp/qone-chart-probe/fixture1.png",
      line: undefined,
      endLine: undefined,
    }]);

    // 1b. 文本文件默认整文件分页（offset=1, limit=2000）不附带 :1–2000，避免整文件被高亮
    await act(async () => {
      root!.render(
        <Fixture content={[{
          type: "tool-call",
          toolName: "read",
          toolCallId: "read-whole-sh",
          args: { path: "scripts/build-ffmpeg.sh", offset: 1, limit: 2000 },
          result: "#!/usr/bin/env bash",
        }]} />,
      );
    });
    const wholeShButton = container.querySelector<HTMLButtonElement>('[data-file-read-button="true"]')!;
    expect(wholeShButton.textContent).toBe("build-ffmpeg.sh");
    expect(wholeShButton.querySelector('[data-file-type-icon="true"]')?.className).toContain("text-emerald-");
    await act(async () => { wholeShButton.click(); });
    expect(opened[1]).toEqual({
      sessionId: "session-read",
      workspaceId: "ws-1",
      path: "C:/Repo/scripts/build-ffmpeg.sh",
      line: undefined,
      endLine: undefined,
    });

    // 2. 工作区内相对路径带行号范围的代码读取：携带 line / endLine 且图标细化为 React TSX
    await act(async () => {
      root!.render(
        <Fixture content={[{
          type: "tool-call",
          toolName: "read",
          toolCallId: "read-tsx",
          args: { path: "src/App.tsx", offset: 12, limit: 20 },
          result: "export function App() {}",
        }]} />,
      );
    });

    const tsxButton = container.querySelector<HTMLButtonElement>('[data-file-read-button="true"]')!;
    expect(tsxButton.textContent).toBe("App.tsx:12–31");
    expect(tsxButton.querySelector('[data-file-type-icon="true"]')?.getAttribute("style")).toContain("react-26-928.svg");

    await act(async () => { tsxButton.click(); });
    expect(opened[2]).toEqual({
      sessionId: "session-read",
      workspaceId: "ws-1",
      path: "C:/Repo/src/App.tsx",
      line: 12,
      endLine: 31,
    });
  } finally {
    window.removeEventListener(OPEN_WORKSPACE_FILE_EVENT, onOpen);
    await act(async () => { useStore.setState(previous); });
  }
});

test("failed file read allows expanding error details while keeping the typed file button", () => {
  function FailedFixture() {
    const messages: ThreadMessageLike[] = [{
      id: "failed-read",
      role: "assistant",
      status: { type: "complete", reason: "stop" },
      content: [{
        type: "tool-call",
        toolName: "read",
        toolCallId: "read-missing",
        args: { path: "C:/Repo/missing.pdf" },
        result: "ENOENT: no such file or directory",
        isError: true,
      }],
    }];
    const runtime = aui.useExternalStoreRuntime({ messages, convertMessage: (m) => m, onNew: async () => {} });
    return (
      <aui.AssistantRuntimeProvider runtime={runtime}>
        <aui.ThreadPrimitive.Messages components={{
          AssistantMessage: () => <aui.MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={1} /></aui.MessagePrimitive.Root>,
        }} />
      </aui.AssistantRuntimeProvider>
    );
  }
  const html = renderToStaticMarkup(<FailedFixture />);
  expect(html).toContain('data-slot="file-read-activity"');
  expect(html).toContain('data-status="failed"');
  expect(html).toContain('data-slot="collapsible-trigger"');
  expect(html).toContain("document-pdf-light-16.svg");
  expect(html).toContain("missing.pdf");
});
