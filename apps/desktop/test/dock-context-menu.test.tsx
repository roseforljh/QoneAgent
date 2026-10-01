import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeContextMenu, DockTabContextMenu, ImageContextMenu, WorkspacePathContextMenu } from "../src/components/assistant-ui/dock-context-menu";
import { Image } from "../src/components/assistant-ui/elements/image";
import { WorkspaceFileContent } from "../src/components/assistant-ui/workspace-file-content";

test("tab and file menus attach to their existing focusable surface", () => {
  const tab = renderToStaticMarkup(<DockTabContextMenu filePath="C:/Repo/A.ts" onClose={() => {}} onCloseOther={() => {}} onCloseRight={() => {}}><div data-dock-tab="tab"><button role="tab">Terminal</button></div></DockTabContextMenu>);
  expect(tab).toContain('data-dock-tab="tab"');
  expect(tab).toContain("data-dock-tab-context-menu-trigger");
  expect(tab.match(/<button/g)).toHaveLength(1);
  const file = renderToStaticMarkup(<WorkspacePathContextMenu path="C:/Repo/A.ts"><button>A.ts</button></WorkspacePathContextMenu>);
  expect(file).toContain("data-workspace-path-context-menu-trigger");
  expect(file.match(/<button/g)).toHaveLength(1);
});

test("code menu preserves source markup and line positioning", () => {
  const diff = renderToStaticMarkup(<CodeContextMenu path="C:/Repo/A.ts" relativePath="A.ts"><pre>  unchanged code</pre></CodeContextMenu>);
  expect(diff).toContain("data-code-context-menu-trigger");
  expect(diff).toContain(">  unchanged code</pre>");
  const source = renderToStaticMarkup(<WorkspaceFileContent code={"\n  const value = 1;\n"} language="typescript" path="C:/Repo/A.ts" active={false} />);
  expect(source).toContain("data-code-context-menu-trigger");
  expect(source).toContain('tabindex="0"');
  expect(source).toContain('data-file-line="2">  const value = 1;');
});

test("images expose only the capabilities Qone already implements", () => {
  const remote = renderToStaticMarkup(<ImageContextMenu src="https://example.com/image.png" onSave={() => {}}><img alt="image" /></ImageContextMenu>);
  expect(remote).toContain("data-image-context-menu-trigger");
  const data = renderToStaticMarkup(<ImageContextMenu src="data:image/png;base64,AA==" onSave={() => {}}><img alt="image" /></ImageContextMenu>);
  expect(data).toContain("data-image-context-menu-trigger");
  const image = renderToStaticMarkup(<Image image="data:image/png;base64,AA==" filename="sample.png" />);
  expect(image).toContain("data-image-context-menu-trigger");
});
