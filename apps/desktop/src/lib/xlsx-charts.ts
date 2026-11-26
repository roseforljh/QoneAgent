import { DOMParser, type Element } from "@xmldom/xmldom";
import { utils, type CellObject, type WorkBook, type WorkSheet } from "xlsx";

// 从 xlsx 包里读出工作表上的图表（drawing → chart XML），数据优先取图表缓存，缓存为空时按公式引用回读单元格。

export type ChartType = "line" | "bar" | "area" | "pie" | "doughnut" | "scatter";
export interface ChartSeries { name: string; color?: string; pointColors: (string | undefined)[]; categories: string[]; values: (number | null)[]; x?: (number | null)[]; line: boolean; markers: boolean }
export interface ChartPlot { type: ChartType; horizontal: boolean; stacking?: "stacked" | "percent"; holeSize: number; series: ChartSeries[] }
export interface ChartAxis { title?: string; min?: number; max?: number; percent: boolean }
export interface ChartModel { title?: string; legend: boolean; plots: ChartPlot[]; xAxis: ChartAxis; yAxis: ChartAxis; unsupported: boolean }
export interface SheetChart { row: number; left: number; top: number; width: number; height: number; chart: ChartModel }

const EMU_PER_PX = 9525;
const DEFAULT_COL_PX = 64;
const DEFAULT_ROW_PX = 20;
const DRAWING_REL = /\/relationships\/drawing$/;
const CHART_TYPES: Record<string, ChartType> = {
  lineChart: "line", line3DChart: "line", stockChart: "line",
  barChart: "bar", bar3DChart: "bar",
  areaChart: "area", area3DChart: "area",
  pieChart: "pie", pie3DChart: "pie", ofPieChart: "pie",
  doughnutChart: "doughnut",
  scatterChart: "scatter", bubbleChart: "scatter",
};
const UNSUPPORTED = new Set(["radarChart", "surfaceChart", "surface3DChart"]);

const children = (element: Element | undefined, name: string): Element[] => {
  const result: Element[] = [];
  for (let node = element?.firstChild; node; node = node.nextSibling) if (node.nodeType === 1 && (node as Element).localName === name) result.push(node as Element);
  return result;
};
const child = (element: Element | undefined, ...path: string[]): Element | undefined => {
  let current = element;
  for (const name of path) current = children(current, name)[0];
  return current;
};
const val = (element: Element | undefined, ...path: string[]): string | undefined => child(element, ...path)?.getAttribute("val") ?? undefined;
const descendants = (element: Element | undefined, name: string): Element[] => element ? Array.from(element.getElementsByTagNameNS("*", name)) : [];
const text = (element: Element | undefined) => descendants(element, "t").map((node) => node.textContent ?? "").join("");

/** read(..., { bookFiles: true }) 额外保留的包内部件，SheetJS 类型里没有声明。 */
type PackagedBook = WorkBook & { files?: Record<string, { content?: Uint8Array | string }>; Directory?: { workbooks?: string[] } };

function parsePart(book: WorkBook, partPath: string): Element | undefined {
  const file = (book as PackagedBook).files?.[partPath.replace(/^\//, "")];
  if (!file?.content) return undefined;
  const xml = typeof file.content === "string" ? file.content : new TextDecoder().decode(file.content);
  return new DOMParser().parseFromString(xml, "text/xml").documentElement ?? undefined;
}

/** OPC：Target 以 / 开头是包内绝对路径，否则相对于源部件所在目录。 */
function relationships(book: WorkBook, partPath: string): Map<string, { type: string; target: string }> {
  const slash = partPath.lastIndexOf("/");
  const directory = partPath.slice(0, slash);
  const map = new Map<string, { type: string; target: string }>();
  for (const rel of children(parsePart(book, `${directory}/_rels/${partPath.slice(slash + 1)}.rels`), "Relationship")) {
    if (rel.getAttribute("TargetMode") === "External") continue;
    const target = rel.getAttribute("Target") ?? "";
    const segments = (target.startsWith("/") ? target : `${directory}/${target}`).split("/");
    const resolved: string[] = [];
    for (const segment of segments) if (segment === "..") resolved.pop(); else if (segment && segment !== ".") resolved.push(segment);
    map.set(rel.getAttribute("Id") ?? "", { type: rel.getAttribute("Type") ?? "", target: resolved.join("/") });
  }
  return map;
}

function sheetPart(book: WorkBook, sheetName: string): string | undefined {
  const workbookPath = (book as PackagedBook).Directory?.workbooks?.[0]?.replace(/^\//, "") ?? "xl/workbook.xml";
  const sheet = descendants(parsePart(book, workbookPath), "sheet").find((node) => node.getAttribute("name") === sheetName);
  const id = sheet && Array.from(sheet.attributes).find((attribute) => attribute.localName === "id")?.value;
  return id ? relationships(book, workbookPath).get(id)?.target : undefined;
}

type CellValues = { labels: string[]; numbers: (number | null)[] };

function cellAt(sheet: WorkSheet, row: number, col: number): CellObject | undefined {
  const dense = sheet["!data"] as CellObject[][] | undefined;
  return dense ? dense[row]?.[col] : sheet[utils.encode_cell({ r: row, c: col })] as CellObject | undefined;
}

/** 公式形如 'Sheet 1'!$A$2:$A$9 或 (Sheet1!$A$1:$A$3,Sheet1!$C$1:$C$3)；定义名称等无法解析的引用返回空。 */
function referenceValues(book: WorkBook, formula: string): CellValues {
  const result: CellValues = { labels: [], numbers: [] };
  const pattern = /(?:'((?:[^']|'')+)'|([^'!,()]+))!\$?([A-Z]+)\$?(\d*)(?::\$?([A-Z]+)\$?(\d*))?/g;
  for (const match of formula.matchAll(pattern)) {
    const sheet = book.Sheets[match[1]?.replace(/''/g, "'") ?? match[2]!.trim()];
    const used = sheet && usedRange(sheet);
    if (!used) continue;
    // 整列引用（$B:$B）没有行号；行范围都截到实际有内容的区域。
    const limit = utils.decode_range(used);
    const startCol = utils.decode_col(match[3]!);
    const endCol = match[5] ? utils.decode_col(match[5]) : startCol;
    const startRow = match[4] ? Number(match[4]) - 1 : 0;
    const endRow = Math.min(match[6] ? Number(match[6]) - 1 : match[5] ? limit.e.r : startRow, limit.e.r);
    for (let row = startRow; row <= endRow; row++) for (let col = startCol; col <= endCol; col++) {
      const cell = cellAt(sheet, row, col);
      result.labels.push(cell?.w ?? (cell?.v === undefined ? "" : String(cell.v)));
      result.numbers.push(typeof cell?.v === "number" ? cell.v : null);
    }
  }
  return result;
}

function cachedValues(cache: Element | undefined): CellValues | undefined {
  const points = children(cache, "pt");
  if (!points.length) return undefined;
  const count = Math.max(Number(val(cache, "ptCount") ?? 0), ...points.map((point) => Number(point.getAttribute("idx") ?? 0) + 1));
  const result: CellValues = { labels: Array<string>(count).fill(""), numbers: Array<number | null>(count).fill(null) };
  for (const point of points) {
    const index = Number(point.getAttribute("idx") ?? 0);
    const value = child(point, "v")?.textContent ?? "";
    result.labels[index] = value;
    result.numbers[index] = value.trim() === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  }
  return result;
}

/** c:cat / c:val / c:tx 等数据源：字面量、缓存、单元格引用依次尝试。 */
function dataSource(book: WorkBook, source: Element | undefined): CellValues {
  const empty = { labels: [], numbers: [] };
  if (!source) return empty;
  const literal = child(source, "numLit") ?? child(source, "strLit");
  if (literal) return cachedValues(literal) ?? empty;
  const reference = child(source, "numRef") ?? child(source, "strRef") ?? child(source, "multiLvlStrRef");
  if (!reference) return { labels: [child(source, "v")?.textContent ?? ""], numbers: [] };
  const cache = child(reference, "numCache") ?? child(reference, "strCache") ?? child(reference, "multiLvlStrCache", "lvl");
  const formula = child(reference, "f")?.textContent;
  return cachedValues(cache) ?? (formula ? referenceValues(book, formula) : empty);
}

export const PALETTE = ["#4472C4", "#ED7D31", "#A5A5A5", "#FFC000", "#5B9BD5", "#70AD47", "#264478", "#9E480E", "#636363", "#997300"];

function color(fill: Element | undefined): string | undefined {
  const rgb = val(fill, "srgbClr");
  if (rgb) return `#${rgb}`;
  const accent = /^accent(\d)$/.exec(val(fill, "schemeClr") ?? "")?.[1];
  return accent ? PALETTE[Number(accent) - 1] : undefined;
}

function seriesColor(spPr: Element | undefined, preferLine: boolean): string | undefined {
  const fill = color(child(spPr, "solidFill"));
  const line = color(child(spPr, "ln", "solidFill"));
  return preferLine ? line ?? fill : fill ?? line;
}

function readSeries(book: WorkBook, ser: Element, type: ChartType, group: Element): ChartSeries {
  const values = dataSource(book, child(ser, "val") ?? child(ser, "yVal"));
  const categories = dataSource(book, child(ser, "cat") ?? child(ser, "xVal"));
  const spPr = child(ser, "spPr");
  const lineHidden = Boolean(child(spPr, "ln", "noFill"));
  const symbol = val(ser, "marker", "symbol");
  const pointColors: (string | undefined)[] = [];
  for (const point of children(ser, "dPt")) pointColors[Number(val(point, "idx") ?? 0)] = seriesColor(child(point, "spPr"), false);
  return {
    name: dataSource(book, child(ser, "tx")).labels.join(" "),
    color: seriesColor(spPr, type === "line" || type === "scatter"),
    pointColors,
    categories: categories.labels,
    values: values.numbers,
    ...(type === "scatter" ? { x: categories.numbers.some((value) => value !== null) ? categories.numbers : undefined } : {}),
    line: !lineHidden,
    // 折线图：系列指定了标记，或图表组 <c:marker val="1"/> 且系列未关闭；散点图默认显示标记。
    markers: symbol !== "none" && (type === "scatter" || type === "line" && (symbol !== undefined || val(group, "marker") === "1")),
  };
}

function readAxis(axis: Element | undefined): ChartAxis {
  const min = val(axis, "scaling", "min");
  const max = val(axis, "scaling", "max");
  return {
    ...(child(axis, "title") ? { title: text(child(axis, "title")) } : {}),
    ...(min !== undefined ? { min: Number(min) } : {}),
    ...(max !== undefined ? { max: Number(max) } : {}),
    percent: (child(axis, "numFmt")?.getAttribute("formatCode") ?? "").includes("%"),
  };
}

export function readChart(book: WorkBook, root: Element): ChartModel {
  const chart = child(root, "chart");
  const plotArea = child(chart, "plotArea");
  const plots: ChartPlot[] = [];
  let unsupported = false;
  for (let node = plotArea?.firstChild; node; node = node.nextSibling) {
    if (node.nodeType !== 1) continue;
    const group = node as Element;
    const type = CHART_TYPES[group.localName ?? ""];
    if (!type) { unsupported ||= UNSUPPORTED.has(group.localName ?? ""); continue; }
    const grouping = val(group, "grouping");
    plots.push({
      type,
      horizontal: val(group, "barDir") === "bar",
      ...(grouping === "stacked" || grouping === "percentStacked" ? { stacking: grouping === "stacked" ? "stacked" as const : "percent" as const } : {}),
      holeSize: Number(val(group, "holeSize") ?? 50),
      series: children(group, "ser").map((ser) => readSeries(book, ser, type, group)),
    });
  }
  const axes = [...children(plotArea, "catAx"), ...children(plotArea, "valAx"), ...children(plotArea, "dateAx")];
  const position = (axis: Element) => val(axis, "axPos") ?? "";
  const xAxis = axes.find((axis) => /^[bt]$/.test(position(axis)));
  const yAxis = axes.find((axis) => /^[lr]$/.test(position(axis)));
  const titleElement = child(chart, "title");
  const autoTitle = val(chart, "autoTitleDeleted") !== "1" && plots.length === 1 && plots[0]!.series.length === 1 ? plots[0]!.series[0]!.name : undefined;
  const title = titleElement ? text(titleElement) || autoTitle : undefined;
  return {
    ...(title ? { title } : {}),
    legend: Boolean(child(chart, "legend")),
    plots,
    xAxis: readAxis(xAxis),
    yAxis: readAxis(yAxis),
    unsupported: unsupported && plots.length === 0,
  };
}

export function columnPixels(sheet: WorkSheet, column: number): number {
  const info = sheet["!cols"]?.[column];
  return info?.hidden ? 0 : info?.wpx ?? (info?.wch !== undefined ? Math.round(info.wch * 7 + 5) : DEFAULT_COL_PX);
}

export function rowPixels(sheet: WorkSheet, row: number): number {
  const info = sheet["!rows"]?.[row];
  return info?.hidden ? 0 : info?.hpx ?? (info?.hpt !== undefined ? Math.round(info.hpt * 4 / 3) : DEFAULT_ROW_PX);
}

function markerPosition(sheet: WorkSheet, marker: Element | undefined): { x: number; y: number } {
  const column = Number(child(marker, "col")?.textContent ?? 0);
  const row = Number(child(marker, "row")?.textContent ?? 0);
  let x = Number(child(marker, "colOff")?.textContent ?? 0) / EMU_PER_PX;
  let y = Number(child(marker, "rowOff")?.textContent ?? 0) / EMU_PER_PX;
  for (let index = 0; index < column; index++) x += columnPixels(sheet, index);
  for (let index = 0; index < row; index++) y += rowPixels(sheet, index);
  return { x, y };
}

export function sheetCharts(book: WorkBook, sheetName: string): SheetChart[] {
  const sheet = book.Sheets[sheetName];
  const part = sheet && (book as PackagedBook).files ? sheetPart(book, sheetName) : undefined;
  if (!sheet || !part) return [];
  const charts: SheetChart[] = [];
  for (const drawingRel of relationships(book, part).values()) {
    if (!DRAWING_REL.test(drawingRel.type)) continue;
    const drawing = parsePart(book, drawingRel.target);
    const drawingRels = relationships(book, drawingRel.target);
    for (let node = drawing?.firstChild; node; node = node.nextSibling) {
      if (node.nodeType !== 1) continue;
      const anchor = node as Element;
      const reference = descendants(anchor, "chart")[0];
      const id = reference && Array.from(reference.attributes).find((attribute) => attribute.localName === "id")?.value;
      const target = id ? drawingRels.get(id)?.target : undefined;
      const root = target ? parsePart(book, target) : undefined;
      if (!root) continue;
      const extent = child(anchor, "ext");
      const from = anchor.localName === "absoluteAnchor"
        ? { x: Number(child(anchor, "pos")?.getAttribute("x") ?? 0) / EMU_PER_PX, y: Number(child(anchor, "pos")?.getAttribute("y") ?? 0) / EMU_PER_PX }
        : markerPosition(sheet, child(anchor, "from"));
      const to = anchor.localName === "twoCellAnchor" ? markerPosition(sheet, child(anchor, "to"))
        : { x: from.x + Number(extent?.getAttribute("cx") ?? 0) / EMU_PER_PX, y: from.y + Number(extent?.getAttribute("cy") ?? 0) / EMU_PER_PX };
      charts.push({ row: Number(child(anchor, "from", "row")?.textContent ?? 0), left: Math.round(from.x), top: Math.round(from.y), width: Math.max(160, Math.round(to.x - from.x)), height: Math.max(120, Math.round(to.y - from.y)), chart: readChart(book, root) });
    }
  }
  return charts;
}

/** 有内容的单元格范围（去掉只有格式的尾部空行空列）；没有任何内容时返回 undefined。一个工作表会被几百个图表引用，结果缓存。 */
const usedRanges = new WeakMap<WorkSheet, string | undefined>();
export function usedRange(sheet: WorkSheet): string | undefined {
  if (usedRanges.has(sheet)) return usedRanges.get(sheet);
  const ref = sheet["!ref"];
  if (!ref) return undefined;
  const range = utils.decode_range(ref);
  let lastRow = -1;
  let lastCol = -1;
  const visit = (row: number, col: number, value: unknown) => {
    if (value !== undefined && value !== "") { lastRow = Math.max(lastRow, row); lastCol = Math.max(lastCol, col); }
  };
  // 只遍历实际存在的单元格；!ref 可能因为整列格式声明到百万行。
  const dense = sheet["!data"] as CellObject[][] | undefined;
  if (dense) dense.forEach((cells, row) => cells?.forEach((cell, col) => visit(row, col, cell?.v)));
  else for (const key of Object.keys(sheet)) if (!key.startsWith("!")) { const cell = utils.decode_cell(key); visit(cell.r, cell.c, (sheet[key] as CellObject).v); }
  const used = lastRow < 0 ? undefined : utils.encode_range({ s: range.s, e: { r: lastRow, c: lastCol } });
  usedRanges.set(sheet, used);
  return used;
}
