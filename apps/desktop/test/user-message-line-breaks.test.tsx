import { expect, test } from "bun:test";
import { ReadonlyThreadProvider, ThreadPrimitive } from "@assistant-ui/react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessage } from "../src/components/assistant-ui/user-message";
import { serializeInlineQuote } from "../src/lib/inline-quote";

function renderUserMessage(text: string): string {
  return renderToStaticMarkup(
    <ReadonlyThreadProvider messages={[{ id: "user", role: "user", content: [{ type: "text", text }], createdAt: new Date(), attachments: [], metadata: { custom: {} } }]}>
      <ThreadPrimitive.Viewport>
        <ThreadPrimitive.Messages components={{ UserMessage }} />
      </ThreadPrimitive.Viewport>
    </ReadonlyThreadProvider>,
  );
}

test("用户消息保留输入框中的单换行与空行分段", () => {
  const singleBreaks = renderUserMessage("1、第一条内容\n2、第二条内容\n第三行补充");
  expect(singleBreaks).toContain("1、第一条内容<br/>\n2、第二条内容<br/>\n第三行补充");

  const paragraphs = renderUserMessage("第一段\n\n第二段");
  expect(paragraphs).toMatch(/<p[^>]*>第一段<\/p>.*<p[^>]*>第二段<\/p>/);
});

test("用户消息内嵌引用与代码块同时存在时不破坏换行或代码格式", () => {
  const withQuote = renderUserMessage(`第一行 ${serializeInlineQuote("选中片段")}\n第二行`);
  expect(withQuote).toContain("q-inline-quote");
  expect(withQuote).toContain("<br/>\n第二行");

  const withCode = renderUserMessage("说明行1\n说明行2\n\n```ts\nconst a = 1;\nconst b = 2;\n```");
  expect(withCode).toContain("说明行1<br/>\n说明行2");
  expect(withCode).not.toContain("const a = 1;<br/>");
});
