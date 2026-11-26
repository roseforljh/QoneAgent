import { read, utils, type WorkBook, type WorkSheet } from "xlsx";
import { chartSvg } from "./chart-svg";
import { columnPixels, rowPixels, sheetCharts, usedRange, type SheetChart } from "./xlsx-charts";

// 大工作簿解析要几秒，放在 Worker 里不卡界面；工作簿留在这里，按需生成单个工作表的 HTML。
let book: WorkBook | undefined;
const MARGIN = 12;

const table = (sheet: WorkSheet, ref: string) => utils.sheet_to_html({ ...sheet, "!ref": ref }, { header: "", footer: "" });

/**
 * 有图表的工作表按 Excel 的网格几何排版：列宽、行高取自工作表，图表按锚点绝对定位在网格上，
 * 与 Excel 里看到的位置一致（单元格里的说明文字和图表交错时也不会错位）。
 * ponytail: 行高小于一行文字（约 19px）时浏览器会撑高该行，下方图表随之略有偏移。
 */
function gridHtml(sheet: WorkSheet, used: string | undefined, charts: SheetChart[], unsupportedLabel: string): string {
  let grid = "";
  let right = 0;
  let bottom = 0;
  if (used) {
    const range = utils.decode_range(used);
    let left = 0;
    let top = 0;
    for (let col = 0; col < range.s.c; col++) left += columnPixels(sheet, col);
    for (let row = 0; row < range.s.r; row++) top += rowPixels(sheet, row);
    const widths: number[] = [];
    const heights: number[] = [];
    for (let col = range.s.c; col <= range.e.c; col++) widths.push(columnPixels(sheet, col));
    for (let row = range.s.r; row <= range.e.r; row++) heights.push(rowPixels(sheet, row));
    const width = widths.reduce((sum, value) => sum + value, 0);
    right = left + width;
    bottom = top + heights.reduce((sum, value) => sum + value, 0);
    let row = 0;
    grid = table(sheet, used)
      .replace(/^<table[^>]*>/, (open) => `${open.replace("<table", `<table class="grid" style="left:${left + MARGIN}px;top:${top + MARGIN}px;width:${width}px"`)}<colgroup>${widths.map((value) => `<col style="width:${value}px">`).join("")}</colgroup>`)
      .replace(/<tr>/g, () => { const height = heights[row++] ?? 0; return height ? `<tr style="height:${height}px">` : `<tr style="display:none">`; });
  }
  const chartBoxes = charts.map((chart) => {
    right = Math.max(right, chart.left + chart.width);
    bottom = Math.max(bottom, chart.top + chart.height);
    return `<div class="chart" style="left:${chart.left + MARGIN}px;top:${chart.top + MARGIN}px;width:${chart.width}px;height:${chart.height}px">${chartSvg(chart.chart, chart.width, chart.height, unsupportedLabel)}</div>`;
  }).join("");
  return `<div class="sheet" style="width:${right + MARGIN * 2}px;height:${bottom + MARGIN * 2}px">${grid}${chartBoxes}</div>`;
}

function sheetHtml(sheet: WorkSheet, name: string, unsupportedLabel: string): string {
  // 只输出有内容的区域，整列格式等声明出来的空行空列不渲染。
  const used = usedRange(sheet);
  const charts = book ? sheetCharts(book, name) : [];
  if (charts.length) return gridHtml(sheet, used, charts, unsupportedLabel);
  return used ? table(sheet, used) : "";
}

self.onmessage = ({ data }: MessageEvent<{ id: number; bytes?: ArrayBuffer | Uint8Array; sheet?: string; unsupportedLabel?: string }>) => {
  try {
    if (data.bytes) {
      // bookFiles 保留包内原始部件，图表 XML 要从这里读。
      book = read(data.bytes, { type: "array", dense: true, bookFiles: true });
      self.postMessage({ id: data.id, sheets: book.SheetNames });
      return;
    }
    const sheet = book?.Sheets[data.sheet ?? ""];
    self.postMessage({ id: data.id, html: sheet ? sheetHtml(sheet, data.sheet!, data.unsupportedLabel ?? "") : "" });
  } catch (error) {
    self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) });
  }
};
