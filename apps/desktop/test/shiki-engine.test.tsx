import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SyntaxHighlighter } from "../src/components/assistant-ui/elements/shiki-highlighter";

test("the JavaScript engine tokenizes code and preserves file line markers", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>");
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = new Map(Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  try {
    await act(async () => root.render(<SyntaxHighlighter code={"const answer: number = 42;\nconsole.log(answer);"}
      language="typescript" delay={0} preserveWhitespace lineMarkers />));
    const deadline = Date.now() + 5000;
    while (!host.querySelector(".shiki") && Date.now() < deadline) {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
    expect(host.querySelector(".shiki")).not.toBeNull();
    expect(host.querySelectorAll(".line[data-file-line]")).toHaveLength(2);
    expect(host.querySelectorAll(".line span[style]").length).toBeGreaterThan(2);
    expect(host.textContent).toContain("const answer: number = 42;");
  } finally {
    await act(async () => root.unmount());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    dom.window.close();
  }
});
