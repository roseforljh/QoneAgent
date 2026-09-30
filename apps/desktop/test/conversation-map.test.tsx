import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationMap } from "../src/components/assistant-ui/elements/conversation-map";

const entries = Array.from({ length: 4 }, (_, index) => ({ id: `turn-${index}`, title: `Message ${index}`, preview: "Answer" }));

test("fewer than four user turns do not mount a rail or preview root", () => {
  for (let count = 0; count < 4; count++) {
    expect(renderToStaticMarkup(<ConversationMap entries={entries.slice(0, count)} />)).toBe("");
  }
});

test("four turns mount navigation with its preview initially closed", () => {
  const html = renderToStaticMarkup(<ConversationMap entries={entries} sessionId="session" activeId="turn-2" />);
  expect(html.match(/data-slot="conversation-map-tick"/g)).toHaveLength(4);
  expect(html).toContain('aria-current="true"');
  expect(html).not.toContain('class="q-conversation-preview"');
  expect(html).not.toContain("Answer");
});
