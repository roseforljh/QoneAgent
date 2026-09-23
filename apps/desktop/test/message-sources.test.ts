import { expect, test } from "bun:test";
import { messageSources } from "../src/components/assistant-ui/message-sources";

test("source cards use actual answer URLs and ignore examples in code fences", () => {
  const sources = messageSources([
    { type: "text", text: "See [docs](https://example.com/a) and [1](https://example.com/a).\n```md\n[example](https://ignored.test)\n```" },
    { type: "source", sourceType: "url", url: "https://source.test/path", title: "Source title" },
  ]);
  expect(sources).toEqual([
    { domain: "example.com", title: "docs", url: "https://example.com/a" },
    { domain: "source.test", title: "Source title", url: "https://source.test/path" },
  ]);
});
