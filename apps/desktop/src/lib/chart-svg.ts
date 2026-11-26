import { PALETTE, type ChartAxis, type ChartModel, type ChartPlot, type ChartSeries } from "./xlsx-charts";

// 把解析出的 Excel 图表画成静态 SVG：折线、柱/条形（簇状/堆积/百分比堆积）、面积、饼图/圆环、散点。

const FONT = 11;
const PAD = 10;
const GRID = "#e5e7eb";
const AXIS = "#9ca3af";
const INK = "#374151";

const escape = (value: string) => value.replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);
const textWidth = (value: string) => [...value].reduce((width, character) => width + (character.charCodeAt(0) > 0x2e80 ? FONT : FONT * 0.6), 0);
const round = (value: number) => Math.round(value * 100) / 100;
const label = (x: number, y: number, value: string, anchor = "middle", extra = "") =>
  `<text x="${round(x)}" y="${round(y)}" text-anchor="${anchor}" ${extra}>${escape(value)}</text>`;

function niceTicks(low: number, high: number, target: number): number[] {
  if (!(high > low)) high = low + 1;
  const rough = (high - low) / Math.max(1, target);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / magnitude;
  // 取不小于粗略步长的 1/2/5×10ⁿ，刻度数不超过目标。
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let value = Math.floor(low / step + 1e-9) * step; value <= high + step * 1e-6; value += step) ticks.push(Number(value.toPrecision(12)));
  if (ticks.at(-1)! < high - step * 1e-6) ticks.push(Number((ticks.at(-1)! + step).toPrecision(12)));
  return ticks;
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });
const formatValue = (value: number, percent: boolean) => percent ? `${Number((value * 100).toPrecision(10))}%` : numberFormat.format(value);

type Point = { x: number; y: number };
const pathOf = (points: (Point | undefined)[]) => {
  let path = "";
  let open = false;
  for (const point of points) {
    if (!point) { open = false; continue; }
    path += `${open ? "L" : "M"}${round(point.x)} ${round(point.y)}`;
    open = true;
  }
  return path;
};

function legendLayout(items: { name: string; color: string }[], width: number) {
  const rows: { name: string; color: string; x: number }[][] = [[]];
  let x = 0;
  for (const item of items) {
    const itemWidth = 16 + textWidth(item.name) + 12;
    if (x > 0 && x + itemWidth > width) { rows.push([]); x = 0; }
    rows.at(-1)!.push({ ...item, x });
    x += itemWidth;
  }
  return { rows, height: items.length ? rows.length * 16 + 4 : 0 };
}

function legendSvg(layout: ReturnType<typeof legendLayout>, width: number, top: number): string {
  return layout.rows.map((row, index) => {
    const rowWidth = row.length ? row.at(-1)!.x + 16 + textWidth(row.at(-1)!.name) : 0;
    const left = (width - rowWidth) / 2;
    const y = top + index * 16 + 12;
    return row.map((item) => `<rect x="${round(left + item.x)}" y="${y - 9}" width="10" height="10" fill="${item.color}"/>${label(left + item.x + 14, y, item.name, "start")}`).join("");
  }).join("");
}

function pieSvg(chart: ChartModel, plot: ChartPlot, width: number, height: number, top: number, colors: string[]): string {
  const series = plot.series[0];
  const values = series?.values.map((value) => (value !== null && value > 0 ? value : 0)) ?? [];
  const total = values.reduce((sum, value) => sum + value, 0);
  const names = values.map((_, index) => series?.categories[index] || String(index + 1));
  const legend = legendLayout(chart.legend ? names.map((name, index) => ({ name, color: colors[index]! })) : [], width - PAD * 2);
  const radius = Math.max(10, Math.min(width - PAD * 2, height - top - legend.height - PAD * 2) / 2);
  const cx = width / 2;
  const cy = top + PAD + radius;
  const inner = plot.type === "doughnut" ? radius * Math.min(0.9, Math.max(0.1, plot.holeSize / 100)) : 0;
  let angle = -Math.PI / 2;
  let slices = "";
  for (let index = 0; index < values.length && total > 0; index++) {
    const sweep = (values[index]! / total) * Math.PI * 2;
    if (sweep <= 0) continue;
    const end = angle + Math.min(sweep, Math.PI * 2 - 1e-4);
    const large = sweep > Math.PI ? 1 : 0;
    const at = (r: number, a: number) => `${round(cx + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`;
    const path = inner
      ? `M${at(radius, angle)}A${round(radius)} ${round(radius)} 0 ${large} 1 ${at(radius, end)}L${at(inner, end)}A${round(inner)} ${round(inner)} 0 ${large} 0 ${at(inner, angle)}Z`
      : `M${cx} ${cy}L${at(radius, angle)}A${round(radius)} ${round(radius)} 0 ${large} 1 ${at(radius, end)}Z`;
    slices += `<path d="${path}" fill="${colors[index]}" stroke="#fff" stroke-width="1"><title>${escape(`${names[index]}: ${numberFormat.format(values[index]!)}`)}</title></path>`;
    angle += sweep;
  }
  return slices + legendSvg(legend, width, cy + radius + PAD);
}

function domain(plots: ChartPlot[], axis: ChartAxis, count: number): { low: number; high: number; percent: boolean } {
  let low = Infinity;
  let high = -Infinity;
  let zero = false;
  let percent = axis.percent;
  for (const plot of plots) {
    zero ||= plot.type === "bar" || plot.type === "area";
    if (plot.stacking) {
      percent ||= plot.stacking === "percent";
      for (let index = 0; index < count; index++) {
        let positive = 0;
        let negative = 0;
        for (const series of plot.series) { const value = series.values[index] ?? 0; if (value >= 0) positive += value; else negative += value; }
        const total = plot.stacking === "percent" ? Math.max(positive - negative, 1e-12) : 1;
        high = Math.max(high, positive / total);
        low = Math.min(low, negative / total);
      }
    } else for (const series of plot.series) for (const value of series.values) if (value !== null) { low = Math.min(low, value); high = Math.max(high, value); }
  }
  if (!Number.isFinite(low)) { low = 0; high = 1; }
  // Excel 自动刻度：数据都为正且跨度足够大时从 0 开始。
  if (zero || (low > 0 && low < high * 5 / 6)) low = Math.min(low, 0);
  if (high < 0 && (zero || high > low * 5 / 6)) high = 0;
  return { low: axis.min ?? low, high: axis.max ?? high, percent };
}

export function chartSvg(chart: ChartModel, width: number, height: number, unsupportedLabel: string): string {
  const titleHeight = chart.title ? 22 : 0;
  const plots = chart.plots.filter((plot) => plot.series.length);
  const colors: string[] = [];
  let content = "";
  if (chart.title) content += label(width / 2, PAD + 12, chart.title, "middle", `font-size="13" font-weight="600"`);
  const radial = plots.find((plot) => plot.type === "pie" || plot.type === "doughnut");
  if (chart.unsupported || !plots.length) {
    content += label(width / 2, height / 2, chart.unsupported ? unsupportedLabel : "", "middle", `fill="${AXIS}"`);
  } else if (radial) {
    const series = radial.series[0]!;
    const count = Math.max(series.values.length, series.categories.length);
    for (let index = 0; index < count; index++) colors.push(series.pointColors[index] ?? PALETTE[index % PALETTE.length]!);
    content += pieSvg(chart, radial, width, height, PAD + titleHeight, colors);
  } else content += cartesianSvg(chart, plots, width, height, PAD + titleHeight);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(chart.title ?? "")}" font-family="system-ui,-apple-system,'Segoe UI',sans-serif" font-size="${FONT}" fill="${INK}">${content}</svg>`;
}

function cartesianSvg(chart: ChartModel, plots: ChartPlot[], width: number, height: number, top: number): string {
  const allSeries = plots.flatMap((plot) => plot.series);
  const seriesColor = new Map<ChartSeries, string>(allSeries.map((series, index) => [series, series.color ?? PALETTE[index % PALETTE.length]!]));
  const horizontal = plots.some((plot) => plot.type === "bar" && plot.horizontal);
  const scatter = plots.every((plot) => plot.type === "scatter");
  const count = Math.max(1, ...allSeries.map((series) => Math.max(series.values.length, series.categories.length)));
  const categories = Array.from({ length: count }, (_, index) => allSeries.find((series) => series.categories[index])?.categories[index] ?? String(index + 1));
  // 条形图的数值轴是横轴，轴标题与刻度格式跟着互换。
  const valueAxis = horizontal ? chart.xAxis : chart.yAxis;
  const categoryAxis = horizontal ? chart.yAxis : chart.xAxis;
  const values = domain(plots, valueAxis, count);
  const legend = legendLayout(chart.legend ? allSeries.map((series, index) => ({ name: series.name || `Series ${index + 1}`, color: seriesColor.get(series)! })) : [], width - PAD * 2);
  const valueTicks = niceTicks(values.low, values.high, horizontal ? Math.max(2, Math.floor(width / 90)) : Math.max(2, Math.floor((height - top) / 45)));
  const [low, high] = [Math.min(valueTicks[0]!, values.low), Math.max(valueTicks.at(-1)!, values.high)];
  const xs = scatter ? allSeries.flatMap((series) => series.x ?? series.values.map((_, index) => index + 1)).filter((value): value is number => value !== null) : [];
  const xTicks = scatter ? niceTicks(chart.xAxis.min ?? Math.min(...xs, 0), chart.xAxis.max ?? Math.max(...xs, 1), Math.max(2, Math.floor(width / 90))) : [];
  const valueLabels = valueTicks.map((value) => formatValue(value, values.percent));
  const leftLabels = horizontal ? categories : valueLabels;
  const leftWidth = Math.min(width * 0.4, Math.max(...leftLabels.map(textWidth), 10)) + 6;
  const yTitle = (horizontal ? categoryAxis : valueAxis).title;
  const xTitle = (horizontal ? valueAxis : categoryAxis).title;
  const plot = { x: PAD + (yTitle ? 16 : 0) + leftWidth, y: top + 6, w: 0, h: 0 };
  plot.w = Math.max(20, width - plot.x - PAD - 6);
  plot.h = Math.max(20, height - plot.y - PAD - 16 - (xTitle ? 16 : 0) - legend.height);
  const valuePos = (value: number) => horizontal ? plot.x + ((value - low) / (high - low)) * plot.w : plot.y + plot.h - ((value - low) / (high - low)) * plot.h;
  const band = (horizontal ? plot.h : plot.w) / count;
  // 条形图第一个分类在最下方，与 Excel 一致。
  const categoryPos = (index: number) => horizontal ? plot.y + plot.h - band * (index + 0.5) : plot.x + band * (index + 0.5);
  const xLow = xTicks[0] ?? 0;
  const xHigh = xTicks.at(-1) ?? 1;
  const scatterX = (value: number) => plot.x + ((value - xLow) / (xHigh - xLow || 1)) * plot.w;
  const point = (category: number, value: number): Point => horizontal ? { x: valuePos(value), y: categoryPos(category) } : { x: categoryPos(category), y: valuePos(value) };
  let svg = "";
  for (let index = 0; index < valueTicks.length; index++) {
    const position = valuePos(valueTicks[index]!);
    svg += horizontal
      ? `<line x1="${round(position)}" y1="${plot.y}" x2="${round(position)}" y2="${plot.y + plot.h}" stroke="${GRID}"/>${label(position, plot.y + plot.h + 14, valueLabels[index]!)}`
      : `<line x1="${plot.x}" y1="${round(position)}" x2="${plot.x + plot.w}" y2="${round(position)}" stroke="${GRID}"/>${label(plot.x - 6, position + 4, valueLabels[index]!, "end")}`;
  }
  if (scatter) {
    for (const tick of xTicks) svg += label(scatterX(tick), plot.y + plot.h + 14, numberFormat.format(tick));
  } else {
    const widest = Math.max(...categories.map(textWidth), 1);
    const step = Math.max(1, Math.ceil(count / Math.max(1, Math.floor((horizontal ? plot.h : plot.w) / (horizontal ? 14 : widest + 10)))));
    for (let index = 0; index < count; index += step) {
      svg += horizontal ? label(plot.x - 6, categoryPos(index) + 4, categories[index]!, "end") : label(categoryPos(index), plot.y + plot.h + 14, categories[index]!);
    }
  }
  const baseline = valuePos(Math.min(Math.max(0, low), high));
  svg += horizontal
    ? `<line x1="${round(baseline)}" y1="${plot.y}" x2="${round(baseline)}" y2="${plot.y + plot.h}" stroke="${AXIS}"/>`
    : `<line x1="${plot.x}" y1="${round(baseline)}" x2="${plot.x + plot.w}" y2="${round(baseline)}" stroke="${AXIS}"/>`;

  for (const chartPlot of plots) {
    const stacks = Array.from({ length: count }, () => ({ positive: 0, negative: 0 }));
    const totals = stacks.map((_, index) => chartPlot.series.reduce((sum, series) => sum + Math.abs(series.values[index] ?? 0), 0) || 1);
    const scale = (index: number, value: number) => chartPlot.stacking === "percent" ? value / totals[index]! : value;
    const clustered = chartPlot.type === "bar" && !chartPlot.stacking ? chartPlot.series.length : 1;
    const groupWidth = band / 2.5;
    chartPlot.series.forEach((series, seriesIndex) => {
      const color = seriesColor.get(series)!;
      const tops: (Point | undefined)[] = [];
      const bottoms: Point[] = [];
      for (let index = 0; index < count; index++) {
        const raw = series.values[index];
        if (raw === null || raw === undefined) { tops.push(undefined); continue; }
        const value = scale(index, raw);
        const stack = stacks[index]!;
        const start = chartPlot.stacking ? (value >= 0 ? stack.positive : stack.negative) : 0;
        const end = start + value;
        if (chartPlot.stacking) { if (value >= 0) stack.positive = end; else stack.negative = end; }
        if (chartPlot.type === "bar") {
          const size = groupWidth / clustered;
          const offset = categoryPos(index) - groupWidth / 2 + size * (clustered > 1 ? seriesIndex : 0);
          const [a, b] = [valuePos(start), valuePos(end)];
          const rect = horizontal
            ? `x="${round(Math.min(a, b))}" y="${round(offset)}" width="${round(Math.abs(b - a))}" height="${round(size)}"`
            : `x="${round(offset)}" y="${round(Math.min(a, b))}" width="${round(size)}" height="${round(Math.abs(b - a))}"`;
          svg += `<rect ${rect} fill="${series.pointColors[index] ?? color}"><title>${escape(`${series.name ? `${series.name} · ` : ""}${categories[index]}: ${numberFormat.format(raw)}`)}</title></rect>`;
        } else if (chartPlot.type === "scatter") {
          const x = series.x?.[index];
          tops.push(x === null ? undefined : { x: scatterX(x ?? index + 1), y: valuePos(raw) });
        } else {
          tops.push(point(index, end));
          bottoms.push(point(index, start));
        }
      }
      if (chartPlot.type === "area") {
        const valid = tops.filter((entry): entry is Point => Boolean(entry));
        if (valid.length) svg += `<path d="${pathOf(valid)}${bottoms.reverse().map((entry) => `L${round(entry.x)} ${round(entry.y)}`).join("")}Z" fill="${color}" fill-opacity="0.75"/>`;
      } else if (chartPlot.type !== "bar") {
        if (series.line) svg += `<path d="${pathOf(tops)}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>`;
        if (series.markers) svg += tops.map((entry) => entry ? `<circle cx="${round(entry.x)}" cy="${round(entry.y)}" r="2.5" fill="${color}"/>` : "").join("");
      }
    });
  }
  if (yTitle) svg += label(PAD + 6, plot.y + plot.h / 2, yTitle, "middle", `transform="rotate(-90 ${PAD + 6} ${round(plot.y + plot.h / 2)})"`);
  if (xTitle) svg += label(plot.x + plot.w / 2, plot.y + plot.h + 30, xTitle);
  return svg + legendSvg(legend, width, plot.y + plot.h + 18 + (xTitle ? 16 : 0));
}
