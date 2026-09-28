import { expect, test } from "bun:test";
import { externalBrowserUrl, htmlFromDataUrl, isHtmlDataUrl } from "../src/lib/browser-dock";

test("external browser accepts only navigable web pages", () => {
  expect(externalBrowserUrl("https://cn.bing.com/search?q=test")).toBe("https://cn.bing.com/search?q=test");
  expect(externalBrowserUrl("http://localhost:1420/")).toBe("http://localhost:1420/");
  for (const url of ["about:blank", "data:text/html,hello", "file:///C:/test.html", "javascript:alert(1)", "not a URL"]) {
    expect(externalBrowserUrl(url)).toBeUndefined();
  }
});

test("HTML data previews can be opened externally", () => {
  expect(isHtmlDataUrl("data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=")).toBe(true);
  expect(isHtmlDataUrl("data:text/html,%3Ch1%3EHello%3C%2Fh1%3E")).toBe(true);
  expect(isHtmlDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
  expect(htmlFromDataUrl("data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=")).toBe("<h1>Hello</h1>");
  expect(htmlFromDataUrl("data:text/html,%3Ch1%3EHello%3C%2Fh1%3E")).toBe("<h1>Hello</h1>");
  expect(htmlFromDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeUndefined();
});
