'use strict';
// A freer .xlsx writer than xlsx.js's tables: cells anywhere with values or formulas, a small set of
// styles, column widths, frozen panes, conditional formats and native charts (bars + lines).
//
//   const sh = sheet('Name'); sh.set(row, col, value, style); sh.f(row, col, '=A1*2', style, cached)
//   buildBook([sh, ...]) -> Buffer
// Rows and columns count from 1. Styles: the keys of STYLES below.
const { zip, xmlEsc, colName } = require('./xlsx');

const ref = (r, c, abs = '') => `${abs}${colName(c - 1)}${abs}${r}`;
const qs = (name) => `'${String(name).replace(/'/g, "''")}'`;

// fonts: 0 normal, 1 bold, 2 title, 3 note, 4 input (blue), 5 white bold
// fills: 0 none, 1 gray125, 2 header grey, 3 input yellow, 4 section blue, 5 override grey
// borders: 0 none, 1 bottom, 2 top
const STYLES = {
  text: [0, 0, 0, 0], bold: [0, 1, 0, 0], header: [0, 1, 2, 1], int: [3, 0, 0, 0], intBold: [3, 1, 0, 2], pct: [9, 0, 0, 0], pctBold: [9, 1, 0, 2],
  title: [0, 2, 0, 0], note: [0, 3, 0, 0], input: [3, 4, 3, 0], inputPct: [9, 4, 3, 0], section: [0, 5, 4, 0], fixed: [3, 0, 5, 0], dec: [164, 0, 0, 0], inputDec: [164, 4, 3, 0],
  headerNum: [0, 1, 2, 1, 'right'], wrap: [0, 0, 0, 0, 'wrap'], pctSigned: [165, 0, 0, 0], date: [14, 0, 0, 0],
  money: [4, 0, 0, 0], moneyBold: [4, 1, 0, 2], inputMoney: [4, 4, 3, 0], inputText: [0, 4, 3, 0], inputDate: [14, 4, 3, 0], inputWrap: [0, 4, 3, 0, 'wrap'],
};
const STYLE_IDS = Object.fromEntries(Object.keys(STYLES).map((k, i) => [k, i]));
const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
  + '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.0"/><numFmt numFmtId="165" formatCode="+0%;-0%;0%"/></numFmts>'
  + '<fonts count="6"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font>'
  + '<font><b/><sz val="14"/><color rgb="FF1F3B63"/><name val="Calibri"/></font><font><i/><sz val="9"/><color rgb="FF6B7280"/><name val="Calibri"/></font>'
  + '<font><sz val="10"/><color rgb="FF1D4ED8"/><name val="Calibri"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>'
  + '<fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EBF0"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF7D6"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3B63"/><bgColor indexed="64"/></patternFill></fill>'
  + '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F1F1"/><bgColor indexed="64"/></patternFill></fill></fills>'
  + '<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border>'
  + '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9CA3AF"/></bottom><diagonal/></border>'
  + '<border><left/><right/><top style="thin"><color rgb="FF9CA3AF"/></top><bottom/><diagonal/></border></borders>'
  + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
  + `<cellXfs count="${Object.keys(STYLES).length}">${Object.values(STYLES).map(([n, f, fi, b, al]) => `<xf numFmtId="${n}" fontId="${f}" fillId="${fi}" borderId="${b}" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"${al ? ` applyAlignment="1"><alignment ${al === 'wrap' ? 'wrapText="1" vertical="top"' : 'horizontal="right"'}/></xf>` : '/>'}`).join('')}</cellXfs>`
  + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
  // conditional formats: 0 good, 1 warning, 2 bad
  + '<dxfs count="6"><dxf><font><color rgb="FF166534"/></font><fill><patternFill><bgColor rgb="FFDCFCE7"/></patternFill></fill></dxf>'
  + '<dxf><font><b/><color rgb="FF92400E"/></font><fill><patternFill><bgColor rgb="FFFEF3C7"/></patternFill></fill></dxf>'
  + '<dxf><font><b/><color rgb="FF991B1B"/></font><fill><patternFill><bgColor rgb="FFFEE2E2"/></patternFill></fill></dxf>'
  // the technologies' text colours, as the CPM workbook has them: DOD teal, Emboss black, Laser purple
  + '<dxf><font><color rgb="FF008080"/></font></dxf><dxf><font><color rgb="FF000000"/></font></dxf><dxf><font><color rgb="FF7030A0"/></font></dxf></dxfs>'
  + '</styleSheet>';

function sheet(name) {
  const cells = new Map(); // 'r,c' → { v, f, s }
  const sh = {
    name: String(name).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), cells, widths: {}, freeze: null, cf: [], charts: [], merges: [],
    set(r, c, v, s = typeof v === 'number' ? 'int' : 'text') { if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) { if (s !== 'text') cells.set(`${r},${c}`, { s }); return sh; } cells.set(`${r},${c}`, { v, s }); return sh; },
    f(r, c, formula, s = 'int', cached = null) { cells.set(`${r},${c}`, { f: String(formula).replace(/^=/, ''), v: cached, s }); return sh; },
    width(c, w) { sh.widths[c] = w; return sh; },
    ref, abs: (r, c) => ref(r, c, '$'), range: (r1, c1, r2, c2, abs = true) => `${ref(r1, c1, abs ? '$' : '')}:${ref(r2, c2, abs ? '$' : '')}`,
    full: (r1, c1, r2 = r1, c2 = c1) => `${qs(sh.name)}!${ref(r1, c1, '$')}${r2 === r1 && c2 === c1 ? '' : `:${ref(r2, c2, '$')}`}`,
  };
  return sh;
}

function cellXml(r, c, x) {
  const s = STYLE_IDS[x.s] ?? 0; const at = ref(r, c);
  if (x.f) {
    const v = x.v === null || x.v === undefined ? '' : typeof x.v === 'number' && Number.isFinite(x.v) ? `<v>${x.v}</v>` : '';
    return `<c r="${at}" s="${s}"><f>${xmlEsc(x.f)}</f>${v}</c>`;
  }
  if (x.v === undefined || x.v === null) return `<c r="${at}" s="${s}"/>`;
  if (typeof x.v === 'number') return `<c r="${at}" s="${s}"><v>${x.v}</v></c>`;
  if (typeof x.v === 'boolean') return `<c r="${at}" s="${s}" t="b"><v>${x.v ? 1 : 0}</v></c>`;
  return `<c r="${at}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(x.v)}</t></is></c>`;
}

function sheetXml(sh, drawingRel) {
  const rows = new Map();
  for (const [k, x] of sh.cells) { const [r, c] = k.split(',').map(Number); (rows.get(r) || rows.set(r, []).get(r)).push([c, x]); }
  const data = [...rows.keys()].sort((a, b) => a - b).map((r) => `<row r="${r}">${rows.get(r).sort((a, b) => a[0] - b[0]).map(([c, x]) => cellXml(r, c, x)).join('')}</row>`).join('');
  const widths = Object.entries(sh.widths).sort((a, b) => a[0] - b[0]);
  const fr = sh.freeze; const pane = fr ? `<pane ${fr.col > 1 ? `xSplit="${fr.col - 1}" ` : ''}${fr.row > 1 ? `ySplit="${fr.row - 1}" ` : ''}topLeftCell="${ref(fr.row, fr.col)}" activePane="${fr.row > 1 && fr.col > 1 ? 'bottomRight' : fr.row > 1 ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
  let prio = 1;
  const DXF = { good: 0, warn: 1, bad: 2, DOD: 3, Emboss: 4, Laser: 5 };
  const cf = sh.cf.map((x) => `<conditionalFormatting sqref="${x.ref}">${x.rules.map((rule) => (rule.expr
    ? `<cfRule type="expression" dxfId="${DXF[rule.dxf]}" priority="${prio++}"><formula>${xmlEsc(rule.expr)}</formula></cfRule>`
    : `<cfRule type="cellIs" dxfId="${DXF[rule.dxf]}" priority="${prio++}" operator="${rule.op}"><formula>${rule.v}</formula>${rule.v2 !== undefined ? `<formula>${rule.v2}</formula>` : ''}</cfRule>`)).join('')}</conditionalFormatting>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheetViews><sheetView workbookViewId="0" zoomScale="90">${pane}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="13.5"/>`
    + (widths.length ? `<cols>${widths.map(([c, w]) => `<col min="${c}" max="${c}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '')
    + `<sheetData>${data}</sheetData>`
    + (sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '')
    + cf
    + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/><pageSetup orientation="landscape" paperSize="9" fitToHeight="0"/>'
    + (drawingRel ? `<drawing r:id="${drawingRel}"/>` : '')
    + '</worksheet>';
}

// a chart: { title, cats: "'Sheet'!$B$2:$M$2", series: [{ name, ref, kind: 'bar'|'line', color: 'RRGGBB', dash }], from: [col, row], to: [col, row], y }
function chartXml(ch) {
  const ser = (x, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${xmlEsc(x.name)}</c:v></c:tx>`
    + `<c:spPr>${x.kind === 'line' ? `<a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${x.color}"/></a:solidFill>${x.dash ? '<a:prstDash val="dash"/>' : ''}<a:round/></a:ln>` : `<a:solidFill><a:srgbClr val="${x.color}"/></a:solidFill>`}</c:spPr>`
    + (x.kind === 'line' ? `<c:marker><c:symbol val="${x.markers ? 'circle' : 'none'}"/>${x.markers ? `<c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${x.color}"/></a:solidFill></c:spPr>` : ''}</c:marker>` : '<c:invertIfNegative val="0"/>')
    + (x.labels ? `<c:dLbls><c:numFmt formatCode="${x.pct ? '0%' : '#,##0,&quot;k&quot;'}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="800"/></a:pPr><a:endParaRPr lang="en-GB"/></a:p></c:txPr><c:dLblPos val="${x.kind === 'line' ? 't' : 'outEnd'}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` : '')
    + `<c:cat><c:strRef><c:f>${xmlEsc(ch.cats)}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${xmlEsc(x.ref)}</c:f></c:numRef></c:val>${x.kind === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
  const bars = ch.series.map((x, i) => [x, i]).filter(([x]) => x.kind !== 'line'); const lines = ch.series.map((x, i) => [x, i]).filter(([x]) => x.kind === 'line');
  const axes = '<c:axId val="5001"/><c:axId val="5002"/>';
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<c:roundedCorners val="0"/><c:chart>'
    + `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1200" b="1"/></a:pPr><a:r><a:rPr lang="en-GB" sz="1200" b="1"/><a:t>${xmlEsc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`
    + '<c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>'
    + (bars.length ? `<c:barChart><c:barDir val="col"/><c:grouping val="${ch.stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${bars.map(([x, i]) => ser(x, i)).join('')}<c:gapWidth val="60"/><c:overlap val="${ch.stacked ? 100 : -10}"/>${axes}</c:barChart>` : '')
    + (lines.length ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${lines.map(([x, i]) => ser(x, i)).join('')}<c:marker val="1"/>${axes}</c:lineChart>` : '')
    + '<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>'
    + `<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="6350"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${ch.pct ? '0%' : '#,##0.00,,&quot;M&quot;'}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/>${ch.major ? `<c:majorUnit val="${ch.major}"/>` : ''}</c:valAx>`
    + '</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>'
    + '<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="en-GB"/></a:p></c:txPr></c:chartSpace>';
}
function drawingXml(charts, firstId) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">'
    + charts.map((ch, i) => `<xdr:twoCellAnchor><xdr:from><xdr:col>${ch.from[0] - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${ch.from[1] - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${ch.to[0] - 1}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${ch.to[1] - 1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>`
      + `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${firstId + i + 1}" name="Chart ${firstId + i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('')
    + '</xdr:wsDr>';
}

function buildBook(sheets, { active = 0 } = {}) {
  const files = {}; const ct = []; let chartNo = 0; let drawNo = 0;
  sheets.forEach((sh, i) => {
    let rel = null;
    if (sh.charts.length) {
      drawNo++; rel = 'rId1';
      files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawNo}.xml"/></Relationships>`;
      const first = chartNo;
      files[`xl/drawings/drawing${drawNo}.xml`] = drawingXml(sh.charts, first);
      files[`xl/drawings/_rels/drawing${drawNo}.xml.rels`] = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sh.charts.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${first + k + 1}.xml"/>`).join('') + '</Relationships>';
      ct.push(`<Override PartName="/xl/drawings/drawing${drawNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      sh.charts.forEach((ch) => { chartNo++; files[`xl/charts/chart${chartNo}.xml`] = chartXml(ch); ct.push(`<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`); });
    }
    files[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(sh, rel);
  });
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + ct.join('') + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<bookViews><workbookView activeTab="${active}"/></bookViews><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES_XML,
    ...files,
  });
}

module.exports = { sheet, buildBook, ref, qs };
