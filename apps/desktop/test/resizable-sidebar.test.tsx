import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ResizableSidebar } from "../src/components/assistant-ui/resizable-sidebar";

test("closing clips the same content frame rather than laying out an icon-only strip", () => {
  const children = <aside><span>会话标题</span><button>项目</button></aside>;
  const open = renderToStaticMarkup(<ResizableSidebar collapsed={false} onCollapsedChange={() => {}}>{children}</ResizableSidebar>);
  const closed = renderToStaticMarkup(<ResizableSidebar collapsed onCollapsedChange={() => {}}>{children}</ResizableSidebar>);
  expect(open).toContain('style="width:340px"');
  expect(closed).toContain('style="width:0px"');
  for (const html of [open, closed]) {
    expect(html).toContain('class="q-sidebar-frame" style="width:340px;min-width:340px"');
    expect(html).toContain('会话标题');
  }
  expect(closed).toContain('inert=""');
  expect(closed).toContain('aria-hidden="true"');
  expect(closed).not.toContain('role="separator"');
  expect(open).toContain('role="separator"');
});

test("collapsed controls stay outside the inert content and inside the measured sidebar pane", () => {
  const html = renderToStaticMarkup(<ResizableSidebar collapsed onCollapsedChange={() => {}}
    collapsedContent={<nav data-collapsed-controls><button>New chat</button></nav>}>
    <aside>Expanded sidebar</aside>
  </ResizableSidebar>);
  expect(html).toContain('class="q-sidebar-pane relative flex h-full shrink-0"');
  expect(html).toContain('inert="" aria-hidden="true"');
  expect(html).toContain('</aside></div></div></div><nav data-collapsed-controls="true">');
  expect(html).toEndWith('</nav></div>');
});
