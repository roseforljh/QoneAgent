import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarContextMenu } from "../src/components/assistant-ui/sidebar-menu";

test("sidebar rows expose the shared context-menu trigger without changing their row content", () => {
  const markup = renderToStaticMarkup(<SidebarContextMenu
    pinned={false}
    onTogglePinned={() => {}}
    onRename={() => {}}
    onDelete={() => {}}
    onNewChat={() => {}}
    newChatLabel="New chat in project"
  ><div data-sidebar-row>Project</div></SidebarContextMenu>);

  expect(markup).toContain("data-sidebar-context-menu-trigger");
  expect(markup).toContain("data-sidebar-row");
  expect(markup).toContain("Project");
});
