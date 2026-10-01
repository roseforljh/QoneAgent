import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadScrollToBottomButton } from "../src/components/assistant-ui/thread-scroll-to-bottom";

test("running state renders animated dots and keeps the arrow for hover/focus", () => {
  const html = renderToStaticMarkup(<ThreadScrollToBottomButton show running onClick={() => {}} label="返回最底部" />);
  expect(html).toContain('data-visible="true"');
  expect(html).toContain('data-working="true"');
  expect(html).toContain('class="q-thread-bottom-dots"><span></span><span></span><span></span>');
  expect(html).toContain('data-slot="codex-icon"');
  expect(html).not.toContain('tabindex="-1"');
});

test("completed state shows the arrow and hidden state is removed from interaction", () => {
  const completed = renderToStaticMarkup(<ThreadScrollToBottomButton show running={false} onClick={() => {}} label="Scroll to bottom" />);
  expect(completed).toContain('data-working="false"');
  expect(completed).not.toContain('q-thread-bottom-dots');
  const hidden = renderToStaticMarkup(<ThreadScrollToBottomButton show={false} running onClick={() => {}} label="Scroll to bottom" />);
  expect(hidden).toContain('aria-hidden="true"');
  expect(hidden).toContain('tabindex="-1"');
  expect(hidden).toContain('data-visible="false"');
});
