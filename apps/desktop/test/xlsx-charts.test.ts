import { expect, test } from "bun:test";
import { read } from "xlsx";
import { chartSvg } from "../src/lib/chart-svg";
import { sheetCharts, usedRange } from "../src/lib/xlsx-charts";
import { chartWorkbook } from "./helpers/xlsx-chart-fixture";

const book = read(chartWorkbook(), { type: "array", dense: true, bookFiles: true });
const charts = sheetCharts(book, "数据 表");

test("charts are found through sheet → drawing → chart relationships and keep their anchor geometry", () => {
  expect(charts.map((chart) => chart.chart.title)).toEqual(["销量", "占比", "趋势", "堆积面积", "条形", "散点", "雷达"]);
  // 默认列宽 64px、行高 20px：E2 起，宽 7 列、高 15 行。
  expect(charts[0]).toMatchObject({ row: 1, left: 256, top: 20, width: 448, height: 300 });
});

test("empty caches fall back to the referenced cells; literal and cached data are used as is", () => {
  const [north, south] = charts[0]!.chart.plots[0]!.series;
  expect(north).toMatchObject({ name: "北区", color: "#FF0000", categories: ["Q1", "Q2", "Q3", "Q4"], values: [10, 14, 8, 16] });
  expect(south!.values).toEqual([4, 9, 12, 6]);
  // Sheet9 不存在：饼图只能用缓存，分类来自 strLit。
  expect(charts[1]!.chart.plots[0]!.series[0]).toMatchObject({ categories: ["甲", "乙", "丙"], values: [1, 2, 1] });
  expect(charts[5]!.chart.plots[0]!.series[0]).toMatchObject({ x: [10, 14, 8, 16], values: [4, 9, 12, 6], line: false, markers: true });
  expect(charts[2]!.chart.plots[0]!.series.map((series) => series.markers)).toEqual([true, false]);
  expect(charts[6]!.chart.unsupported).toBe(true);
});

test("every chart renders to SVG with the right marks", () => {
  const svg = charts.map(({ chart, width, height }) => chartSvg(chart, width, height, "不支持"));
  const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
  expect(count(svg[0]!, /<rect [^>]*><title>/g)).toBe(8);
  expect(count(svg[1]!, /<path [^>]*fill="#[0-9A-F]{6}" stroke="#fff"/g)).toBe(3);
  expect(svg[2]).toContain('stroke="#4472C4"');
  expect(count(svg[2]!, /<circle /g)).toBe(4);
  expect(svg[4]).toContain(">100%</text>");
  expect(count(svg[5]!, /<circle /g)).toBe(4);
  expect(svg[6]).toContain(">不支持</text>");
  for (const item of svg) expect(item).not.toContain("NaN");
});

test("used range ignores declared but empty trailing cells", () => {
  expect(usedRange({ "!ref": "A1:Z1000", "!data": [[{ t: "s", v: "x" }], [], [undefined, { t: "n", v: 1 }]] } as never)).toBe("A1:B3");
  expect(usedRange({ "!ref": "A1:C3", "!data": [] } as never)).toBeUndefined();
});
