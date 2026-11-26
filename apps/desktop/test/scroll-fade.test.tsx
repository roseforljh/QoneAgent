import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FadeScroll } from "../src/components/assistant-ui/elements/fade-scroll";

const desktopSrc = resolve(import.meta.dir, "../src");

test("index.css loads unified scroll-fade.css with vertical, horizontal, bidirectional rules and opt-out", () => {
  const indexCss = readFileSync(resolve(desktopSrc, "index.css"), "utf8");
  const fadeCss = readFileSync(resolve(desktopSrc, "scroll-fade.css"), "utf8");

  expect(indexCss).toContain('@import "./scroll-fade.css";');
  for (const prop of [
    "@property --q-scroll-fade-top",
    "@property --q-scroll-fade-bottom",
    "@property --q-scroll-fade-left",
    "@property --q-scroll-fade-right",
    "@property --q-scroll-fade-size",
  ]) {
    expect(fadeCss).toContain(prop);
  }
  expect(fadeCss).toContain("@supports (animation-timeline: scroll(self y)) {");
  expect(fadeCss).not.toContain("animation-range");
  expect(fadeCss).toContain("animation-timeline: scroll(self y);");
  expect(fadeCss).toContain("animation-timeline: scroll(self x);");
  expect(fadeCss).toContain("mask-composite: intersect;");
  expect(fadeCss).toContain(".overflow-y-auto");
  expect(fadeCss).toContain(".overflow-x-auto");
  expect(fadeCss).toContain(".overflow-auto");
  expect(fadeCss).toContain(".q-subagent-panel-scroll");
  expect(fadeCss).toContain(".qone-select-list");
  expect(fadeCss).toContain('[data-scroll-fade="none"]');
  expect(fadeCss).toContain(".aui-viewport");
  // @property 的 initial-value 必须计算独立（禁止 rem/em/%/vh/vw），否则 Chromium 会忽略整条规则。
  const propertyBlocks = fadeCss.match(/@property\s+[^{]+\{[^}]+\}/g) ?? [];
  expect(propertyBlocks.length).toBeGreaterThanOrEqual(5);
  for (const block of propertyBlocks) {
    expect(block).not.toMatch(/initial-value\s*:\s*[^;]*(?:rem|em|vh|vw|%)/);
  }
});

test("FadeScroll relies on global CSS scroll-fade instead of inline mask-image", () => {
  const markup = renderToStaticMarkup(<FadeScroll className="min-h-0 flex-1"><span>item</span></FadeScroll>);
  expect(markup).toContain("overflow-y-auto");
  expect(markup).toContain('data-scroll-region=""');
  expect(markup).not.toContain("mask-image");
});
