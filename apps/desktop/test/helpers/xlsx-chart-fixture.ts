import { CFB, utils, write } from "xlsx";

// 生成带图表的真实 xlsx 包：SheetJS 写出数据表，再按 OOXML 结构补上 drawing / chart 部件。
const NS = `xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

export interface FixtureChart { xml: string; col: number; row: number; toCol: number; toRow: number }

const ref = (column: string) => `<c:numRef><c:f>'数据 表'!$${column}$2:$${column}$5</c:f><c:numCache><c:ptCount val="0"/></c:numCache></c:numRef>`;
const categories = `<c:cat><c:strRef><c:f>'数据 表'!$A$2:$A$5</c:f></c:strRef></c:cat>`;
const series = (index: number, column: string, extra = "") =>
  `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:strRef><c:f>'数据 表'!$${column}$1</c:f></c:strRef></c:tx>${extra}${categories}<c:val>${ref(column)}</c:val></c:ser>`;
const axes = `<c:catAx><c:axId val="1"/><c:axPos val="b"/><c:title><c:tx><c:rich><a:p><a:r><a:t>季度</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/></c:valAx>`;
export const chartXml = (title: string, plot: string, plotAxes = axes) =>
  `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace ${NS}><c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title><c:plotArea>${plot}${plotAxes}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;

export const FIXTURE_CHARTS: FixtureChart[] = [
  { xml: chartXml("销量", `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>${series(0, "B", `<c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr>`)}${series(1, "C")}</c:barChart>`), col: 4, row: 1, toCol: 11, toRow: 16 },
  { xml: chartXml("占比", `<c:pieChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>占比</c:v></c:tx><c:cat><c:strLit><c:ptCount val="3"/><c:pt idx="0"><c:v>甲</c:v></c:pt><c:pt idx="1"><c:v>乙</c:v></c:pt><c:pt idx="2"><c:v>丙</c:v></c:pt></c:strLit></c:cat><c:val><c:numRef><c:f>Sheet9!$A$1:$A$3</c:f><c:numCache><c:ptCount val="3"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt><c:pt idx="2"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:pieChart>`, ""), col: 12, row: 1, toCol: 18, toRow: 16 },
  { xml: chartXml("趋势", `<c:lineChart><c:grouping val="standard"/>${series(0, "B", `<c:marker><c:symbol val="circle"/></c:marker>`)}${series(1, "C", `<c:marker><c:symbol val="none"/></c:marker>`)}</c:lineChart>`), col: 4, row: 17, toCol: 11, toRow: 32 },
  { xml: chartXml("堆积面积", `<c:areaChart><c:grouping val="stacked"/>${series(0, "B")}${series(1, "C")}</c:areaChart>`), col: 12, row: 17, toCol: 18, toRow: 32 },
  { xml: chartXml("条形", `<c:barChart><c:barDir val="bar"/><c:grouping val="percentStacked"/>${series(0, "B")}${series(1, "C")}</c:barChart>`, `<c:catAx><c:axId val="1"/><c:axPos val="l"/><c:title><c:tx><c:rich><a:p><a:r><a:t>季度</a:t></a:r></a:p></c:rich></c:tx></c:title></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="b"/></c:valAx>`), col: 4, row: 33, toCol: 11, toRow: 48 },
  { xml: chartXml("散点", `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>B 对 C</c:v></c:tx><c:spPr><a:ln><a:noFill/></a:ln></c:spPr><c:xVal>${ref("B")}</c:xVal><c:yVal>${ref("C")}</c:yVal></c:ser></c:scatterChart>`, `<c:valAx><c:axId val="1"/><c:axPos val="b"/></c:valAx><c:valAx><c:axId val="2"/><c:axPos val="l"/></c:valAx>`), col: 12, row: 33, toCol: 18, toRow: 48 },
  { xml: chartXml("雷达", `<c:radarChart>${series(0, "B")}</c:radarChart>`), col: 4, row: 49, toCol: 11, toRow: 60 },
];

export function chartWorkbook(charts: FixtureChart[] = FIXTURE_CHARTS): Uint8Array {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([["季度", "北区", "南区"], ["Q1", 10, 4], ["Q2", 14, 9], ["Q3", 8, 12], ["Q4", 16, 6]]), "数据 表");
  const container = CFB.read(write(book, { type: "buffer", bookType: "xlsx" }), { type: "buffer" });
  const add = (path: string, xml: string) => CFB.utils.cfb_add(container, path, Buffer.from(xml, "utf8"));
  add("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
  const marker = (tag: string, col: number, row: number) => `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`;
  add("xl/drawings/drawing1.xml", `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${charts.map((chart, index) =>
    `<xdr:twoCellAnchor>${marker("from", chart.col, chart.row)}${marker("to", chart.toCol, chart.toRow)}<xdr:graphicFrame><a:graphic><a:graphicData><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL}" r:id="rId${index + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join("")}</xdr:wsDr>`);
  add("xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${charts.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="${REL}/chart" Target="/xl/charts/chart${index + 1}.xml"/>`).join("")}</Relationships>`);
  charts.forEach((chart, index) => add(`xl/charts/chart${index + 1}.xml`, chart.xml));
  return new Uint8Array(CFB.write(container, { type: "buffer", fileType: "zip" }) as Buffer);
}
