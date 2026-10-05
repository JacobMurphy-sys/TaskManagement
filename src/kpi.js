'use strict';
// Weekly KPI reporting from the CI workbook: a snapshot of a week holds what the
// A3 Weekly Report and Database sheets showed (cached values, formats, conditional
// format colours, charts) and a disconnected copy of the A3 — values only, colours
// fixed, charts as pictures, no formulas, links, queries or macros.

const { readBook, decode, attr, colLetters, colNum, parseRef, items, section, resolvePart, relsPathOf, shiftFormula } = require('./xlsxread');
const { conditionalStyles, isErr } = require('./xlformula');
const { formatValue } = require('./numfmt');
const { zip, readZip, xmlEsc } = require('./xlsx');

const EMU_PX = 9525;
const ptToPx = (pt) => (pt * 96) / 72;
// Column width (characters) → pixels, as Excel does at 100% zoom (max digit width 7px).
const colPx = (w) => Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7);

// ---- sheet → view model -------------------------------------------------------------------

const BORDER_CSS = {
  thin: '1px solid', hair: '1px dotted', dotted: '1px dotted', dashed: '1px dashed', dashDot: '1px dashed', dashDotDot: '1px dashed',
  medium: '2px solid', mediumDashed: '2px dashed', mediumDashDot: '2px dashed', mediumDashDotDot: '2px dashed', slantDashDot: '2px dashed',
  thick: '3px solid', double: '3px double',
};
// Wingdings letters Excel files often use for faces, ticks and arrows (for screens without the font).
const WINGDINGS = { J: '☺', K: '😐', L: '☹', ü: '✔', û: '✘', ý: '☒', þ: '☑', o: '☐', l: '●', n: '■', è: '➔', ç: '⬅', é: '⬆', ê: '⬇', ñ: '▲', ò: '▼', '«': '★' };

function sheetView(book, sheet, cf, { maxRows = 600, maxCols = 80 } = {}) {
  const st = book.styles;
  // How far the sheet visibly goes: values, or styled cells with a fill or border.
  let lastRow = 0; let lastCol = 0;
  for (const c of sheet.cells.values()) {
    const xf = st.xfs[c.s] || {};
    const b = st.borders[xf.borderId] || {};
    const shown = (c.v !== null && c.v !== '') || st.fills[xf.fillId] || b.left || b.right || b.top || b.bottom;
    if (!shown) continue;
    if (c.row > lastRow) lastRow = c.row;
    if (c.col > lastCol) lastCol = c.col;
  }
  for (const m of sheet.merges) { if (m.bottom > lastRow && m.top <= lastRow) lastRow = m.bottom; if (m.right > lastCol && m.left <= lastCol) lastCol = m.right; }
  const drawing = book.drawing(sheet);
  const anchorEnd = (a) => (a.to ? { row: a.to.row + 1, col: a.to.col + 1 } : { row: (a.from?.row || 0) + 1, col: (a.from?.col || 0) + 1 });
  for (const a of drawing.anchors) { if (a.kind === 'shape' || a.hidden) continue; const e = anchorEnd(a); lastRow = Math.max(lastRow, e.row); lastCol = Math.max(lastCol, e.col); }
  lastRow = Math.min(lastRow, maxRows);
  lastCol = Math.min(lastCol, maxCols);

  const defW = colPx(sheet.defaultColWidth || 9.14);
  const cols = [];
  for (let c = 1; c <= lastCol; c++) {
    const def = sheet.cols.find((x) => c >= x.min && c <= x.max);
    cols.push(def?.hidden ? 0 : def?.width ? colPx(def.width) : defW);
  }
  const rows = [];
  for (let r = 1; r <= lastRow; r++) {
    const def = sheet.rows.get(r);
    rows.push(def?.hidden ? 0 : Math.round(ptToPx(def?.ht ?? sheet.defaultRowHeight)));
  }
  const x = [0]; cols.forEach((w) => x.push(x[x.length - 1] + w));
  const y = [0]; rows.forEach((h) => y.push(y[y.length - 1] + h));

  const styleIds = new Map(); const styles = [];
  const css = (s) => { if (!styleIds.has(s)) { styleIds.set(s, styles.length); styles.push(s); } return styleIds.get(s); };
  const mergeAt = new Map();
  const covered = new Set();
  for (const m of sheet.merges) {
    if (m.top > lastRow || m.left > lastCol) continue;
    mergeAt.set(`${m.top},${m.left}`, m);
    for (let r = m.top; r <= m.bottom; r++) for (let c = m.left; c <= m.right; c++) if (r !== m.top || c !== m.left) covered.add(`${r},${c}`);
  }
  const border = (row, col, side) => {
    const c = sheet.cells.get(`${colLetters(col)}${row}`);
    const s = c ? c.s : (sheet.rows.get(row)?.s ?? sheet.cols.find((d) => col >= d.min && col <= d.max)?.s ?? 0);
    const cfB = c && cf.get(c.r)?.border?.[side];
    const b = cfB || st.borders[st.xfs[s]?.borderId]?.[side];
    return b ? `${BORDER_CSS[b.style] || '1px solid'} #${b.color || '000000'}` : null;
  };

  const cells = [];
  for (const c of sheet.cells.values()) {
    if (c.row > lastRow || c.col > lastCol || covered.has(`${c.row},${c.col}`)) continue;
    const xf = st.xfs[c.s] || {};
    const font = st.fonts[xf.fontId] || {};
    const fill = st.fills[xf.fillId];
    const over = cf.get(c.r) || {};
    const m = mergeAt.get(`${c.row},${c.col}`);
    const bottom = m ? m.bottom : c.row; const right = m ? m.right : c.col;
    const sides = { top: border(c.row, c.col, 'top'), left: border(c.row, c.col, 'left'), bottom: border(bottom, c.col, 'bottom'), right: border(c.row, right, 'right') };
    const hasValue = c.v !== null && c.v !== '';
    const fillColor = over.fill?.color || fill?.color;
    if (!hasValue && !fillColor && !sides.top && !sides.left && !sides.bottom && !sides.right) continue;
    const code = over.numFmt || st.numFmts[xf.numFmtId] || 'General';
    const value = c.t === 'e' ? c.v : c.v;
    let f = hasValue ? (c.t === 'e' ? { text: String(c.v), color: null } : formatValue(value, code, { date1904: book.date1904 })) : { text: '', color: null };
    if (hasValue && c.t === 'n' && /^general$/i.test(code) && !Number.isInteger(value)) f = { ...f, text: fitGeneral(value, (x[Math.min(right, lastCol)] - x[c.col - 1]) || 64, font.sz || 11) };
    const wingdings = /^wingdings/i.test(font.name || '');
    const text = wingdings ? [...f.text].map((ch) => WINGDINGS[ch] || ch).join('') : f.text;
    const color = over.font?.color || f.color || font.color;
    const a = xf.align || {};
    const h = a.h && a.h !== 'general' ? a.h : (c.t === 'n' ? 'right' : c.t === 'b' || c.t === 'e' ? 'center' : 'left');
    const decoration = [(over.font?.u || font.u) && 'underline', (over.font?.strike || font.strike) && 'line-through'].filter(Boolean).join(' ');
    const rule = [
      `font-family:${wingdings ? 'Wingdings, "Segoe UI Emoji", sans-serif' : `"${(font.name || 'Calibri').replace(/"/g, '')}", Calibri, Arial, sans-serif`}`,
      `font-size:${font.sz || 11}pt`, (over.font?.b ?? font.b) ? 'font-weight:700' : '', (over.font?.i ?? font.i) ? 'font-style:italic' : '',
      decoration ? `text-decoration:${decoration}` : '', color ? `color:#${color}` : '', fillColor ? `background:#${fillColor}` : '',
      `justify-content:${{ left: 'flex-start', right: 'flex-end', center: 'center', centerContinuous: 'center', fill: 'flex-start', justify: 'flex-start', distributed: 'center' }[h] || 'flex-start'}`,
      `text-align:${h === 'right' ? 'right' : h === 'center' || h === 'centerContinuous' ? 'center' : 'left'}`,
      `align-items:${{ top: 'flex-start', center: 'center', bottom: 'flex-end', justify: 'flex-start', distributed: 'center' }[a.v || 'bottom'] || 'flex-end'}`,
      a.wrap ? 'white-space:pre-wrap' : 'white-space:pre',
      a.indent ? `padding-left:${a.indent * 9 + 2}px` : '',
      ...Object.entries(sides).filter(([, v]) => v).map(([k, v]) => `border-${k}:${v}`),
    ].filter(Boolean).join(';');
    cells.push([c.row, c.col, text, css(rule), bottom - c.row + 1, right - c.col + 1, a.rotate || 0]);
  }

  // Pictures (as data URLs) and charts, placed where they're anchored.
  const box = (a) => {
    const at = (p) => ({ x: (x[Math.min(p.col, lastCol)] ?? x[x.length - 1]) + p.colOff / EMU_PX, y: (y[Math.min(p.row, lastRow)] ?? y[y.length - 1]) + p.rowOff / EMU_PX });
    const from = at(a.from || { col: 0, row: 0, colOff: 0, rowOff: 0 });
    if (a.to && a.type === 'twoCellAnchor') { const to = at(a.to); return { x: Math.round(from.x), y: Math.round(from.y), w: Math.round(to.x - from.x), h: Math.round(to.y - from.y) }; }
    return { x: Math.round(from.x), y: Math.round(from.y), w: Math.round((a.ext?.cx || 0) / EMU_PX), h: Math.round((a.ext?.cy || 0) / EMU_PX) };
  };
  const images = []; const charts = [];
  drawing.anchors.forEach((a, index) => {
    if (a.hidden) return;
    if (a.kind === 'picture' && a.image) {
      const data = book.zip.read(a.image);
      if (!data) return;
      const ext = a.image.split('.').pop().toLowerCase();
      const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', emf: null, wmf: null }[ext];
      if (mime) images.push({ ...box(a), src: `data:${mime};base64,${data.toString('base64')}` });
    } else if (a.kind === 'chart' && a.chart) {
      const b = box(a);
      charts.push({ ...b, index, name: a.name, spec: prepareChart(book.chart(a.chart), b, book) });
    }
  });
  return { name: sheet.name, cols, rows, x, y, cells, styles, images, charts, showGrid: sheet.showGrid };
}

// Excel shows a General number with as many decimals as fit the cell.
function fitGeneral(v, widthPx, sizePt) {
  const chars = Math.max(1, Math.floor((widthPx - 4) / (ptToPx(sizePt) * 0.55)));
  const whole = String(Math.trunc(Math.abs(v))).length + (v < 0 ? 1 : 0);
  if (whole > chars) return formatValue(v, 'General').text;
  const dec = Math.max(0, Math.min(9, chars - whole - 1));
  return String(Number(v.toFixed(dec)));
}

// ---- charts: scales and formatted labels, so the page only has to draw ------------------------

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}
function prepareChart(spec, box, book) {
  const fmt = (v, code) => (v === null || v === undefined ? '' : formatValue(v, code || 'General', { date1904: book.date1904 }).text);
  for (const g of spec.groups) {
    for (const s of g.series) {
      s.color = g.kind === 'line' || g.kind === 'scatter' || g.kind === 'radar' ? (s.line?.color || s.fill || s.fallback) : (s.fill === null ? null : s.fill || s.fallback);
      s.labelText = s.vals.map((v, i) => {
        if (!s.labels?.showVal || v === null || s.labels.deleted?.includes(i)) return null;
        const parts = [];
        if (s.labels.showSerName) parts.push(s.name);
        if (s.labels.showCatName) parts.push(s.cats[i] ?? '');
        parts.push(fmt(v, s.labels.numFmt || s.ptFormats[i] || s.formatCode));
        return parts.join(', ');
      });
    }
    const valAxis = g.axIds.map((id) => spec.axes[id]).find((a) => a && a.kind === 'valAx');
    g.valAx = g.axIds.find((id) => spec.axes[id]?.kind === 'valAx') || null;
    g.catAx = g.axIds.find((id) => spec.axes[id]?.kind !== 'valAx') || null;
    if (valAxis) {
      valAxis.groups = (valAxis.groups || 0) + 1;
      // data range on this axis (stacked groups add up per category)
      const n = Math.max(0, ...g.series.map((s) => s.vals.length));
      let lo = Infinity; let hi = -Infinity;
      if (/stacked/i.test(g.grouping) && g.kind !== 'line') {
        for (let i = 0; i < n; i++) {
          let pos = 0; let neg = 0;
          for (const s of g.series) { const v = s.vals[i]; if (v === null || v === undefined) continue; if (v >= 0) pos += v; else neg += v; }
          if (g.grouping === 'percentStacked') { lo = Math.min(lo, neg < 0 ? -1 : 0); hi = Math.max(hi, pos > 0 ? 1 : 0); } else { lo = Math.min(lo, neg); hi = Math.max(hi, pos); }
        }
      } else {
        for (const s of g.series) for (const v of s.vals) if (v !== null && v !== undefined) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
      }
      valAxis.dataMin = Math.min(valAxis.dataMin ?? Infinity, lo);
      valAxis.dataMax = Math.max(valAxis.dataMax ?? -Infinity, hi);
      valAxis.formatSource = valAxis.formatSource || g.series[0]?.formatCode;
      if (g.grouping === 'percentStacked') valAxis.formatSource = '0%';
    }
  }
  const plotH = Math.max(60, box.h * (spec.plotLayout?.h || 0.7));
  for (const ax of Object.values(spec.axes)) {
    if (ax.kind !== 'valAx') continue;
    let lo = Number.isFinite(ax.dataMin) ? ax.dataMin : 0; let hi = Number.isFinite(ax.dataMax) ? ax.dataMax : 1;
    if (lo === hi) { hi = lo === 0 ? 1 : lo + Math.abs(lo) * 0.1; if (lo > 0) lo = 0; }
    let min = ax.min; let max = ax.max;
    if (min === null) min = lo >= 0 ? (lo > hi * 5 / 6 ? lo : 0) : lo;
    const ticks = Math.max(4, Math.min(10, Math.floor(plotH / 22)));
    let step = ax.majorUnit || niceStep((max ?? hi) - min, ticks);
    if (!ax.majorUnit && max !== null) { // a fixed range: a step that lands on both ends, as Excel picks
      const span = max - min;
      const fits = [1, 2, 2.5, 5, 10].flatMap((f) => [-1, 0, 1].map((e) => f * 10 ** (Math.floor(Math.log10(span / ticks)) + e)))
        .filter((st) => Math.abs(span / st - Math.round(span / st)) < 1e-9 && span / st <= 10 && span / st >= 3).sort((a, b) => b - a);
      if (fits.length) step = fits.find((st) => span / st >= 5) || fits[fits.length - 1];
    }
    if (ax.min === null && min !== 0) min = Math.floor(min / step) * step;
    if (max === null) { max = Math.ceil(hi / step) * step; if (max === hi && hi !== 0 && ax.max === null && hi > 0 && (hi - min) / (max - min || 1) > 0.95) max += hi % step === 0 ? 0 : step; }
    if (max <= min) max = min + step;
    ax.scale = { min, max, step };
    const code = ax.sourceLinked || !ax.numFmt || ax.numFmt === 'General' ? (ax.formatSource || 'General') : ax.numFmt;
    ax.ticks = [];
    for (let v = min, k = 0; v <= max + step * 1e-9 && k < 60; v = min + step * ++k) ax.ticks.push({ v: Number(v.toPrecision(12)), text: fmt(Number(v.toPrecision(12)), code) });
  }
  return spec;
}

// ---- the disconnected A3 -----------------------------------------------------------------------

const xmlAttr = (s) => xmlEsc(String(s)).replace(/"/g, '&quot;');

// Adds the formats conditional formatting gave a cell to a copy of its style.
function makeStyleBaker(stylesXml, book) {
  let xml = stylesXml;
  const cache = new Map();
  const list = (tag) => { const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? items(m[1], tag.slice(0, -1) === 'cellXf' ? 'xf' : tag.replace(/s$/, '')) : []; };
  const append = (tag, itemXml) => {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>|<${tag}\\b[^>]*/>`));
    const existing = m ? (m[0].endsWith('/>') ? 0 : items(m[0].replace(new RegExp(`^<${tag}\\b[^>]*>|</${tag}>$`, 'g'), ''), tag === 'cellXfs' ? 'xf' : tag === 'numFmts' ? 'numFmt' : tag.replace(/s$/, '')).length) : 0;
    if (!m) { xml = xml.replace(/<fonts\b/, `<${tag} count="1">${itemXml}</${tag}><fonts`); return 0; }
    const inner = m[0].endsWith('/>') ? '' : m[0].replace(new RegExp(`^<${tag}\\b[^>]*>|</${tag}>$`, 'g'), '');
    xml = xml.replace(m[0], `<${tag} count="${existing + 1}">${inner}${itemXml}</${tag}>`);
    return existing;
  };
  const colorTag = (hex) => `<color rgb="FF${hex}"/>`;
  return {
    bake(s, over) {
      const key = `${s}|${JSON.stringify(over)}`;
      if (cache.has(key)) return cache.get(key);
      const xfs = list('cellXfs');
      let xf = xfs[s] || xfs[0];
      if (over.font) {
        const fonts = list('fonts');
        let f = fonts[Number(attr(xf.match(/^<xf\b[^>]*>/)[0], 'fontId') || 0)] || '<font/>';
        if (f.endsWith('/>')) f = f.replace(/\/>$/, '></font>');
        if (over.font.color) f = /<color\b[^>]*\/>/.test(f) ? f.replace(/<color\b[^>]*\/>/, colorTag(over.font.color)) : f.replace(/(<name\b|<family\b|<charset\b|<scheme\b|<\/font>)/, `${colorTag(over.font.color)}$1`);
        if (over.font.b && !/<b\s*\/>|<b val="1"\/>/.test(f)) f = f.replace(/^<font\b[^>]*>/, (m) => `${m}<b/>`);
        if (over.font.i && !/<i\s*\/>/.test(f)) f = f.replace(/(<\/?(?:strike|condense|extend|outline|shadow|u|vertAlign|sz|color|name|family|charset|scheme)\b)/, '<i/>$1');
        if (over.font.strike && !/<strike\b/.test(f)) f = f.replace(/(<(?:condense|extend|outline|shadow|u|vertAlign|sz|color|name|family|charset|scheme)\b)/, '<strike/>$1');
        if (over.font.u && !/<u\b/.test(f)) f = f.replace(/(<(?:vertAlign|sz|color|name|family|charset|scheme)\b)/, `<u${over.font.u === 'single' ? '' : ` val="${over.font.u}"`}/>$1`);
        const id = append('fonts', f);
        xf = xf.replace(/\sfontId="\d+"/, ` fontId="${id}"`).replace(/\sapplyFont="[^"]*"/, '').replace(/^<xf\b/, '<xf applyFont="1"');
      }
      if (over.fill?.color) {
        const id = append('fills', `<fill><patternFill patternType="solid"><fgColor rgb="FF${over.fill.color}"/><bgColor indexed="64"/></patternFill></fill>`);
        xf = xf.replace(/\sfillId="\d+"/, ` fillId="${id}"`).replace(/\sapplyFill="[^"]*"/, '').replace(/^<xf\b/, '<xf applyFill="1"');
      }
      if (over.numFmt) {
        const ids = [...xml.matchAll(/numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
        const id = Math.max(163, ...ids) + 1;
        append('numFmts', `<numFmt numFmtId="${id}" formatCode="${xmlAttr(over.numFmt)}"/>`);
        xf = xf.replace(/\snumFmtId="\d+"/, ` numFmtId="${id}"`).replace(/\sapplyNumberFormat="[^"]*"/, '').replace(/^<xf\b/, '<xf applyNumberFormat="1"');
      }
      const index = append('cellXfs', xf);
      cache.set(key, index);
      return index;
    },
    get xml() { return xml; },
  };
}

// The trend symbols carry their own colour: ▲ green, ▼ red, ▬ yellow. The workbook's rules
// only colour ▲ and ▼ in some cells (and ▬ nowhere), so a symbol could show in whatever
// colour its cell happened to have.
const SYMBOL_COLOURS = { '▲': '00B050', '▼': 'FF0000', '▬': 'FFC000' };
function symbolColours(sheet, cf) {
  for (const c of sheet.cells.values()) {
    const colour = typeof c.v === 'string' ? SYMBOL_COLOURS[c.v.trim()] : null;
    if (!colour) continue;
    const cur = cf.get(c.r) || {};
    cf.set(c.r, { ...cur, font: { ...(cur.font || {}), color: colour } });
  }
  return cf;
}

// What can be changed by hand on the A3, per cell shown: 't' typed text (no formula), and
// for a cell with conditional formats 'f' its text colour or 'b' its fill — e.g. { Z13: 't', E7: 'f' }.
function editKinds(book, sheet, view) {
  const mode = new Map();
  const R = view.rows.length; const C = view.cols.length;
  for (const rule of sheet.cf || []) {
    const dxf = rule.dxfId !== null && rule.dxfId !== undefined ? book.styles.dxfs[rule.dxfId] : null;
    const fill = dxf ? !!dxf.fill?.color : /<fill\b[\s\S]*?Color\b/.test(rule.dxfXml || '');
    const font = dxf ? !!dxf.font?.color : /<font\b[\s\S]*?<color\b/.test(rule.dxfXml || '');
    if (!fill && !font) continue;
    for (const r of rule.ranges) {
      for (let row = r.top; row <= Math.min(r.bottom, R); row++) for (let col = r.left; col <= Math.min(r.right, C); col++) {
        const ref = `${colLetters(col)}${row}`;
        if (font || mode.get(ref) === 'f') mode.set(ref, 'f'); else mode.set(ref, 'b');
      }
    }
  }
  const out = {};
  for (const [row, col] of view.cells) {
    const ref = `${colLetters(col)}${row}`;
    const c = sheet.cells.get(ref);
    const symbol = typeof c?.v === 'string' && SYMBOL_COLOURS[c.v.trim()];
    const k = symbol ? 'fs' : `${c?.f ? '' : 't'}${mode.get(ref) || ''}`;
    if (k) out[ref] = k;
  }
  return out;
}

// Hand-made changes written into the A3 file: { ref: { text, color } } — text replaces the
// cell's value (a number stays a number), color its conditional-format colour (text or fill,
// as kinds says).
function applyEdits(pkg, edits, kinds = {}) {
  const list = Object.entries(edits || {});
  if (!list.length) return pkg;
  const files = readZip(pkg);
  const sPath = 'xl/worksheets/sheet1.xml';
  const baker = makeStyleBaker(files['xl/styles.xml'].toString('utf8'));
  let xml = files[sPath].toString('utf8');
  for (const [ref, e] of list) {
    const re = new RegExp(`<c\\b(?=[^>]*\\sr="${ref}")([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
    xml = xml.replace(re, (whole, attrs, body) => {
      let s = Number(attr(`<c${attrs}>`, 's') || 0);
      if (e.color) s = baker.bake(s, (kinds[ref] || '').includes('b') ? { fill: { color: e.color } } : { font: { color: e.color } });
      const sAttr = s ? ` s="${s}"` : '';
      if (e.text === null || e.text === undefined) return whole.replace(/\ss="\d+"/, '').replace(/^(<c\b[^>]*?\sr="[^"]*")/, `$1${sAttr}`);
      const wasNumber = body !== undefined && !/\bt="/.test(attrs) && /<v>/.test(body);
      const n = Number(String(e.text).trim());
      if (e.text === '') return `<c r="${ref}"${sAttr}/>`;
      if (wasNumber && String(e.text).trim() !== '' && Number.isFinite(n)) return `<c r="${ref}"${sAttr}><v>${n}</v></c>`;
      return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(e.text))}</t></is></c>`;
    });
  }
  files[sPath] = Buffer.from(xml, 'utf8');
  files['xl/styles.xml'] = Buffer.from(baker.xml, 'utf8');
  return zip(files);
}

// A workbook with only the A3: values instead of formulas, conditional format colours
// written in as plain formats, pictures kept and each chart a placeholder that
// exportA3() swaps for a picture of it.
function buildA3Package(book, sheet, cf, { title = 'A3', sheetName = 'Snapshot' } = {}) {
  const z = book.zip;
  const baker = makeStyleBaker(z.text('xl/styles.xml'), book);
  let xml = sheet.xml;
  const root = xml.match(/<worksheet\b[^>]*>/)[0];
  const sheetData = xml.match(/<sheetData\s*\/>|<sheetData>[\s\S]*?<\/sheetData>/)[0];
  const newData = sheetData.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (whole, attrs) => {
    const a = `<c${attrs}>`;
    const r = attr(a, 'r');
    const c = sheet.cells.get(r);
    let s = Number(attr(a, 's') || 0);
    const over = cf.get(r);
    if (over && (over.font || over.fill || over.numFmt)) s = baker.bake(s, over);
    const sAttr = s ? ` s="${s}"` : '';
    if (!c || c.v === null || c.v === undefined || c.v === '') return `<c r="${r}"${sAttr}/>`;
    if (c.t === 'e') return `<c r="${r}"${sAttr} t="e"><v>${xmlEsc(String(c.v))}</v></c>`;
    if (c.t === 'b') return `<c r="${r}"${sAttr} t="b"><v>${c.v ? 1 : 0}</v></c>`;
    if (c.t === 'n') return `<c r="${r}"${sAttr}><v>${c.v}</v></c>`;
    return `<c r="${r}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(c.v))}</t></is></c>`;
  });
  const keep = (tag) => (xml.match(new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`)) || [''])[0];
  const sheetPr = keep('sheetPr').replace(/\scodeName="[^"]*"/, '');
  const pageSetup = keep('pageSetup').replace(/\sr:id="[^"]*"/, '');
  const drawing = book.drawing(sheet);
  const hasDrawing = drawing.anchors.some((a) => (a.kind === 'picture' && a.image) || a.kind === 'chart');
  const out = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${root}${sheetPr}${keep('dimension')}${keep('sheetViews')}${keep('sheetFormatPr')}${keep('cols')}`
    + `${newData}${keep('mergeCells')}${keep('printOptions')}${keep('pageMargins')}${pageSetup}${keep('headerFooter')}${keep('rowBreaks')}${keep('colBreaks')}`
    + `${hasDrawing ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;

  const files = {};
  const media = [];
  if (hasDrawing) {
    let dxml = drawing.xml.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, ''); // form controls (e.g. the export button)
    const rels = [];
    let n = 0;
    dxml = dxml.replace(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g, (a) => {
      const anchor = drawing.anchors.find((x) => x.xml === a);
      if (!anchor) return '';
      if (anchor.kind === 'shape') return /macro="[^"]+"/.test(a) || anchor.hidden ? '' : a.replace(/\sr:(?:embed|link|id)="[^"]*"/g, '');
      if (anchor.kind === 'picture') {
        const data = z.read(anchor.image);
        if (!data) return '';
        const name = `image${++n}.${anchor.image.split('.').pop().toLowerCase()}`;
        media.push(name);
        files[`xl/media/${name}`] = data;
        const rid = `rIdImg${n}`;
        rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`);
        return a.replace(/r:embed="[^"]*"/, `r:embed="${rid}"`).replace(/\sr:link="[^"]*"/, '');
      }
      // chart → placeholder
      const index = drawing.anchors.indexOf(anchor);
      return a.replace(/<xdr:graphicFrame\b[\s\S]*?<\/xdr:graphicFrame>/, `<!--CIM-CHART:${index}-->`);
    });
    files['xl/drawings/drawing1.xml'] = Buffer.from(dxml, 'utf8');
    files['xl/drawings/_rels/drawing1.xml.rels'] = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`, 'utf8');
    files['xl/worksheets/_rels/sheet1.xml.rels'] = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>', 'utf8');
  }
  const exts = [...new Set(media.map((m) => m.split('.').pop()))];
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', emf: 'image/x-emf', wmf: 'image/x-wmf', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
  files['[Content_Types].xml'] = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + `${[...new Set([...exts, 'png'])].map((e) => `<Default Extension="${e}" ContentType="${MIME[e] || 'application/octet-stream'}"/>`).join('')}`
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + `${hasDrawing ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : ''}`
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>', 'utf8');
  files['_rels/.rels'] = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>', 'utf8');
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  files['docProps/core.xml'] = Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEsc(title)}</dc:title><dc:creator>CI Manager</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`, 'utf8');
  files['docProps/app.xml'] = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>CI Manager</Application></Properties>', 'utf8');
  files['xl/workbook.xml'] = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<workbookPr${book.date1904 ? ' date1904="1"' : ''}/><bookViews><workbookView/></bookViews><sheets><sheet name="${xmlAttr(sheetName)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`, 'utf8');
  files['xl/_rels/workbook.xml.rels'] = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>', 'utf8');
  files['xl/theme/theme1.xml'] = z.read('xl/theme/theme1.xml') || Buffer.from('');
  files['xl/styles.xml'] = Buffer.from(baker.xml, 'utf8');
  files['xl/worksheets/sheet1.xml'] = Buffer.from(out, 'utf8');
  return zip(files);
}

// The final file: each chart placeholder becomes its picture (PNG), or is dropped.
function exportA3(pkg, images = {}) {
  const files = readZip(pkg);
  const dPath = 'xl/drawings/drawing1.xml';
  if (!files[dPath]) return zip(files);
  let dxml = files[dPath].toString('utf8');
  let rels = files['xl/drawings/_rels/drawing1.xml.rels'].toString('utf8');
  let id = 1000;
  dxml = dxml.replace(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>(?:(?!<\/xdr:\1>)[\s\S])*?<!--CIM-CHART:(\d+)-->[\s\S]*?<\/xdr:\1>/g, (a, type, index) => {
    const png = images[index];
    if (!png) return '';
    const name = `chart${index}.png`;
    files[`xl/media/${name}`] = png;
    const rid = `rIdChart${index}`;
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/></Relationships>`);
    const ext = a.match(/<xdr:ext\b[^>]*>/)?.[0];
    const cx = attr(ext, 'cx') || 0; const cy = attr(ext, 'cy') || 0;
    const pic = `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${++id}" name="Chart ${Number(index)}"/><xdr:cNvPicPr><a:picLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
      + `<xdr:blipFill><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>`;
    return a.replace(`<!--CIM-CHART:${index}-->`, pic).replace(/<xdr:clientData\b[^>]*\/>/, (m) => m);
  });
  files[dPath] = Buffer.from(dxml, 'utf8');
  files['xl/drawings/_rels/drawing1.xml.rels'] = Buffer.from(rels, 'utf8');
  return zip(files);
}

// ---- a week from the workbook ------------------------------------------------------------

// Week codes like W2639 or W2640_1 (a week split at a month end).
function weekParts(code) {
  const m = String(code || '').match(/W?(\d{2})(\d{2})(?:_(\d))?/i);
  if (!m) return null;
  return { yy: m[1], year: 2000 + Number(m[1]), wk: m[2], part: m[3] || '' };
}

function loadWeek(buf, { a3Sheet = 'A3 Weekly Report', dbSheet = 'Database', weekCell = 'B2' } = {}) {
  const book = readBook(buf);
  const findSheet = (want) => book.sheets.find((s) => s.name === want) || book.sheets.find((s) => s.name.toLowerCase() === String(want).toLowerCase());
  const a3Info = findSheet(a3Sheet);
  if (!a3Info) throw new Error(`The workbook has no sheet called "${a3Sheet}"`);
  const dbInfo = findSheet(dbSheet);
  const a3 = book.sheet(a3Info.name);
  const dbs = dbInfo ? book.sheet(dbInfo.name) : null;
  const cell = (sh, ref) => sh?.cells.get(ref)?.v ?? null;
  const week = String(cell(dbs, weekCell) ?? cell(a3, 'C4') ?? '').trim();
  if (!week) throw new Error(`No reporting week found (${dbSheet}!${weekCell} is empty)`);
  const a3cf = symbolColours(a3, conditionalStyles(book, a3));
  const views = { a3: sheetView(book, a3, a3cf) };
  views.a3.edit = editKinds(book, a3, views.a3);
  if (dbs) views.database = sheetView(book, dbs, conditionalStyles(book, dbs));
  // Raw values of the Database sheet, to check the CI Manager's own figures against.
  const values = dbs ? Object.fromEntries([...dbs.cells.values()].filter((c) => c.v !== null && c.v !== '' && c.t !== 'e').map((c) => [c.r, c.v])) : {};
  const parts = weekParts(week);
  const pkg = buildA3Package(book, a3, a3cf, { title: `A3 Weekly Report ${week}` });
  const errors = [...a3.cells.values()].filter((c) => c.t === 'e').map((c) => `${c.r} ${c.v}`);
  return {
    week, year: parts?.year ?? (typeof cell(dbs, 'B4') === 'number' ? cell(dbs, 'B4') : null),
    month: typeof cell(dbs, 'A2') === 'string' ? cell(dbs, 'A2') : null, views, values, pkg,
    sheets: { a3: a3Info.name, database: dbInfo?.name || null }, errors,
  };
}

// ---- forecast files ---------------------------------------------------------------------------

// A forecast sheet as the workbook's query would leave it after a refresh from `buf`: the
// file's sheet (from its first filled cell), first row as headers — a blank one is
// "ColumnN", a date reads dd/mm/yyyy, as Power Query writes them — put where the workbook's
// table starts. The table's own formula columns (e.g. the customer and month the report
// groups by) are carried down every row; the rest of the workbook's sheet (the formulas
// beside or under the table) is kept.
function forecastSheet(tpl, table, buf, spec) {
  const fb = readBook(buf);
  const info = fb.sheets.find((x) => x.name.toLowerCase() === spec.sheet.toLowerCase());
  if (!info) throw new Error(`${spec.file} has no sheet called "${spec.sheet}" (it has ${fb.sheets.map((x) => x.name).join(', ')})`);
  const src = fb.sheet(info.name);
  const filled = (v) => v !== null && v !== undefined && v !== '';
  let top = Infinity; let left = Infinity; let right = 0; let bottom = 0;
  for (const c of src.cells.values()) if (filled(c.v)) { top = Math.min(top, c.row); left = Math.min(left, c.col); right = Math.max(right, c.col); bottom = Math.max(bottom, c.row); }
  if (top === Infinity) throw new Error(`The "${info.name}" sheet of ${spec.file} is empty`);
  const T = table.range;
  const width = right - left + 1; const height = bottom - top + 1;
  const cells = new Map();
  const put = (row, col, v, extra = {}) => { const r = `${colLetters(col)}${row}`; cells.set(r, { r, row, col, s: 0, t: typeof v === 'string' ? 's' : typeof v === 'boolean' ? 'b' : 'n', v, f: null, ...extra }); };
  const ddmmyyyy = (n) => { const d = new Date(Math.round((n - 25569) * 86400000)); const p2 = (x) => String(x).padStart(2, '0'); return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
  const headers = [];
  for (let k = 0; k < width; k++) {
    const v = src.cells.get(`${colLetters(left + k)}${top}`)?.v;
    const h = !filled(v) ? `Column${k + 1}` : typeof v === 'number' && v > 20000 && v < 80000 ? ddmmyyyy(v) : String(v);
    headers.push(h); put(T.top, T.left + k, h);
  }
  for (const c of src.cells.values()) {
    if (c.row <= top || c.col < left || !filled(c.v)) continue;
    put(T.top + c.row - top, T.left + c.col - left, c.v, c.t === 'e' ? { t: 'e' } : {});
  }
  const dataBottom = T.top + height - 1;
  // the table's formula columns, past the file's own columns
  const colOf = new Map(headers.map((h, k) => [h.toLowerCase(), T.left + k]));
  let next = T.left + width;
  for (let col = T.left; col <= T.right; col++) {
    const first = tpl.cells.get(`${colLetters(col)}${T.top + 1}`);
    if (!first?.f || col < T.left + width) continue;
    const head = tpl.cells.get(`${colLetters(col)}${T.top}`)?.v ?? `Column${col - T.left + 1}`;
    const at = next++;
    put(T.top, at, head);
    colOf.set(String(head).toLowerCase(), at);
    // a plain reference to another table column in the same row follows that column (by its header)
    const tplHead = (k) => tpl.cells.get(`${colLetters(k)}${T.top}`)?.v;
    const moved = first.f.replace(/("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g, (m, str, sheet, d1, letters, d2, rowNo, offset, whole) => {
      if (str || sheet || Number(rowNo) !== T.top + 1 || /[\w.]/.test(whole[offset - 1] || '')) return m;
      const k = colNum(letters); if (k < T.left || k > T.right) return m;
      const c = colOf.get(String(tplHead(k) ?? '').toLowerCase());
      return c ? `${d1}${colLetters(c)}${d2}${rowNo}` : m;
    });
    // Table[[#This Row],[Name]] / [@Name] → the cell in that row (written for the first data row)
    const f0 = moved.replace(/(?:[A-Za-z_][\w.]*)?\[\[#This Row\],\[([^\]]+)\]\]|(?:[A-Za-z_][\w.]*)?\[@\[?([^\]]+?)\]?\]/g, (m, a, b) => {
      const c = colOf.get(String(a || b).trim().toLowerCase());
      if (!c) throw new Error(`The ${spec.workbook} formula column "${head}" uses "${a || b}", which isn't a column of ${spec.file}`);
      return `${colLetters(c)}${T.top + 1}`;
    });
    for (let row = T.top + 1; row <= dataBottom; row++) put(row, at, null, { f: shiftFormula(f0, row - T.top - 1, 0), v: null });
  }
  const tableRight = next - 1;
  // the rest of the workbook's sheet (formulas beside or under the table)
  let overlap = 0;
  for (const c of tpl.cells.values()) {
    if (c.row >= T.top && c.row <= T.bottom && c.col >= T.left && c.col <= T.right) continue;
    if (c.row >= T.top && c.row <= dataBottom && c.col >= T.left && c.col <= tableRight) { overlap++; continue; }
    cells.set(c.r, c);
  }
  let maxRow = 0; let maxCol = 0;
  for (const c of cells.values()) { if (c.row > maxRow) maxRow = c.row; if (c.col > maxCol) maxCol = c.col; }
  return { name: tpl.name, cells, maxRow, maxCol, rows: new Map(), cols: [], merges: [], recalc: true, read: { rows: height - 1, columns: width, overlap } };
}

// ---- the A3 for any week, worked out by the CI Manager -----------------------------------

// The workbook (the last one loaded) is the template: its Database and A3 formulas are
// re-run for `week`, with the Database weekly block (rows from 63, week code in column B)
// and the top-5 scrap and top-10 shipped figures taken from the CI Manager's own data.
// data: { weeks: [{ week, perso_ps, … }], topScrap(week), shippedFor(customer, year, month?), columns: { key: 'D', … } }
// Parts that still come only from Excel (this month's customer forecast, typed text) are
// listed in `flags`.
function buildWeek(buf, week, data, { a3Sheet = 'A3 Weekly Report', dbSheet = 'Database', weekCell = 'B2' } = {}) {
  const { createCalc } = require('./xlcalc');
  const book = readBook(buf);
  const findSheet = (want) => book.sheets.find((x) => x.name.toLowerCase() === String(want).toLowerCase());
  const a3Info = findSheet(a3Sheet); const dbInfo = findSheet(dbSheet);
  if (!a3Info || !dbInfo) throw new Error(`The workbook needs the "${a3Sheet}" and "${dbSheet}" sheets`);
  const a3 = book.sheet(a3Info.name); const dbs = book.sheet(dbInfo.name);
  const sheets = { [a3Info.name]: Object.assign(a3, { name: a3Info.name }), [dbInfo.name]: Object.assign(dbs, { name: dbInfo.name }) };
  for (const n of ['DatabaseReferences', 'BeNeLux Forecast', 'Amex Forecast']) {
    const i = findSheet(n);
    // a forecast read from its file replaces the workbook's copy: read that copy only when needed
    if (i) Object.defineProperty(sheets, i.name, { enumerable: true, configurable: true, get: () => { const sh = Object.assign(book.sheet(i.name), { name: i.name }); Object.defineProperty(sheets, i.name, { value: sh, enumerable: true, writable: true, configurable: true }); return sh; } });
  }
  const templateWeek = String(dbs.cells.get(weekCell)?.v ?? '');
  const templateMonth = String(dbs.cells.get('A2')?.v ?? '');
  const parts = weekParts(week);
  const weekRow = data.weeks.find((w) => w.week === week);
  if (!weekRow) throw new Error(`${week} isn't a reporting week of ${parts?.year || 'that year'}`);
  const monthNo = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].findIndex((m) => weekRow.month.startsWith(m)) + 1;
  const sameMonth = templateMonth.slice(0, 3).toLowerCase() === weekRow.month.slice(0, 3).toLowerCase() && templateWeek.slice(0, 3) === week.slice(0, 3);
  const flags = [];
  // customer forecasts: from their files when set (data.forecasts: [{ spec, buf, file, modified }]),
  // else the workbook's own copy, as Excel last refreshed it
  const fcSheets = [];
  for (const f of data.forecasts || []) {
    const info = findSheet(f.spec.workbook);
    if (!info) continue;
    fcSheets.push(info.name);
    if (!f.buf) { if (f.error) flags.push({ part: 'forecast', text: `${f.spec.label}: ${f.error} — the workbook's copy is used.` }); continue; }
    try {
      const table = book.tables().find((t) => t.name.toLowerCase() === f.spec.table.toLowerCase() && t.sheet.toLowerCase() === info.name.toLowerCase());
      if (!table) throw new Error(`the workbook has no "${f.spec.table}" table on its ${info.name} sheet to put it in`);
      const R = table.range; // the table's own rows aren't needed from the workbook, only its first (the formulas)
      const tpl = Object.assign(book.sheet(info.name, { skipRows: (n) => n > R.top + 1 && n <= R.bottom }), { name: info.name });
      Object.defineProperty(sheets, info.name, { value: forecastSheet(tpl, table, f.buf, f.spec), enumerable: true, writable: true, configurable: true });
      flags.push({ part: 'forecast-file', text: `${f.spec.label} read from ${f.file}${f.modified ? ` (saved ${String(f.modified).slice(0, 16).replace('T', ' ')})` : ''}.` });
    } catch (err) { flags.push({ part: 'forecast', text: `${f.spec.label} couldn't be read from ${f.file}: ${err.message} — the workbook's copy is used.` }); }
  }
  const fcFromWorkbook = fcSheets.filter((n) => !sheets[n].recalc);
  if (fcFromWorkbook.length) flags.push({ part: 'forecast-workbook', text: `Customer forecasts (${fcFromWorkbook.join(', ')}) are the workbook's copy, as Excel last refreshed them — set the forecast files on From sources to read them directly.` });
  const over = new Map();
  const put = (ref, v) => over.set(`${dbInfo.name}!${ref}`, v);
  put(weekCell, week);
  // weekly block
  const byCode = new Map(data.weeks.map((w) => [w.week, w]));
  const blank = { hours: null, contract: null, temps: null, otd_sc: '', otd_global: '', cpms: '', scrap_rate: '', productivity: '' };
  for (let r = 40; r <= dbs.maxRow; r++) {
    const code = dbs.cells.get(`B${r}`)?.v;
    if (typeof code !== 'string' || !/^W\d{4}(_[12])?$/.test(code) || r < 60) continue;
    const w = byCode.get(code);
    for (const [key, col] of Object.entries(data.columns)) {
      const v = w ? w[key] : null;
      put(`${col}${r}`, v === null || v === undefined ? (key in blank ? blank[key] : 0) : v);
    }
  }
  // top 5 scrap (spilling Z6:AA10 and AC6:AD10)
  const ts = data.topScrap(week);
  for (let i = 0; i < 5; i++) {
    put(`Z${6 + i}`, ts.customers[i]?.[0] ?? ''); put(`AA${6 + i}`, ts.customers[i]?.[1] ?? '');
    put(`AC${6 + i}`, ts.orders[i]?.[0] ?? ''); put(`AD${6 + i}`, ts.orders[i]?.[1] ?? '');
  }
  let noForecast = false;
  // top 10: cards shipped this month (O) and this year (V) per customer; this month's forecast (N)
  for (let r = 1; r <= 40; r++) {
    const o = dbs.cells.get(`O${r}`); const v = dbs.cells.get(`V${r}`); const nC = dbs.cells.get(`N${r}`);
    const oName = o?.f?.match(/ShippedImport!\$A\$\d+:\$A\$\d+="([^"]+)"/)?.[1];
    const until = data.weekEnd ? data.weekEnd(week) : null; // month / year to date, as of the reporting week
    if (oName) put(`O${r}`, data.shippedFor(oName, parts.year, monthNo, until));
    const vName = v?.f?.match(/\[Customer\],"([^"]+)"/)?.[1];
    if (vName) put(`V${r}`, data.shippedFor(vName, parts.year, null, until));
    if (nC?.f && /Forecast/i.test(nC.f) && !sameMonth && !Object.keys(sheets).some((n) => /forecast/i.test(n))) { noForecast = true; put(`N${r}`, ''); put(`P${r}`, ''); put(`Q${r}`, ''); } // no forecast for that month yet
  }
  if (noForecast) flags.push({ part: 'forecast', text: `The top-10 “% of FC” and “Missing” MTD figures need ${weekRow.month}'s forecast per customer, which only comes from Excel for now (the workbook was on ${templateMonth}) — they're left blank.` });
  if (week !== templateWeek) flags.push({ part: 'text', text: `The executive summary, comments and other typed text start as the workbook's, from ${templateWeek || 'its week'} — change them with ✎ Edit A3.` });

  const calc = createCalc(sheets, { recalc: (n) => n === a3Info.name || n === dbInfo.name || !!sheets[n]?.recalc, override: (sh, ref) => over.get(`${sh}!${ref}`) });
  const typeOf = (v) => (isErr(v) ? 'e' : typeof v === 'string' ? 's' : typeof v === 'boolean' ? 'b' : 'n');
  const errorsInA3 = [];
  const recomputed = (sh, name, isA3) => {
    const cells = new Map();
    for (const c of sh.cells.values()) {
      let v = calc.value(name, c.r);
      if (isA3 && isErr(v)) { errorsInA3.push(`${c.r} ${v.error}`); v = ''; } // shown blank rather than #DIV/0! on a built A3
      cells.set(c.r, { ...c, v: isErr(v) ? v.error : v, t: typeOf(v) });
    }
    return { ...sh, cells };
  };
  const dbNew = recomputed(dbs, dbInfo.name, false);
  const a3New = recomputed(a3, a3Info.name, true);
  // charts: series read again from the cells they point at
  const rangeValues = (text) => {
    const m = String(text || '').match(/^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/);
    if (!m) return null;
    const sheet = (m[1] || m[2]).replace(/''/g, "'");
    const a = parseRef(`${m[3]}${m[4]}`); const b = parseRef(`${m[5] || m[3]}${m[6] || m[4]}`);
    const out = [];
    for (let r = a.row; r <= b.row; r++) for (let c = a.col; c <= b.col; c++) { const v = calc.value(sheet, `${colLetters(c)}${r}`); out.push(isErr(v) ? null : v); }
    return out;
  };
  const book2 = Object.create(book);
  book2.sheet = (n) => (n === a3Info.name ? a3New : n === dbInfo.name ? dbNew : book.sheet(n));
  book2.chart = (part) => {
    const spec = book.chart(part);
    for (const g of spec.groups) for (const s of g.series) {
      const vals = rangeValues(s.refs?.val); const cats = rangeValues(s.refs?.cat); const name = rangeValues(s.refs?.name);
      if (vals) s.vals = vals.map((v) => (typeof v === 'number' ? v : null));
      if (cats) s.cats = cats.map((v) => (v === null || v === undefined ? '' : String(v)));
      if (name && name[0] !== null && name[0] !== undefined) s.name = String(name[0]);
      s.ptFormats = {};
    }
    return spec;
  };
  const a3cf = symbolColours(a3New, conditionalStyles(book2, a3New));
  const views = { a3: sheetView(book2, a3New, a3cf), database: sheetView(book2, dbNew, conditionalStyles(book2, dbNew)) };
  views.a3.edit = editKinds(book2, a3New, views.a3);
  const values = Object.fromEntries([...dbNew.cells.values()].filter((c) => c.v !== null && c.v !== '' && c.t !== 'e').map((c) => [c.r, c.v]));
  const pkg = buildA3Package(book2, a3New, a3cf, { title: `A3 Weekly Report ${week}` });
  return {
    week, year: parts?.year ?? null, month: weekRow.month, views, values, pkg, sheets: { a3: a3Info.name, database: dbInfo.name },
    errors: errorsInA3, flags, template_week: templateWeek,
  };
}

// "…\{year}\Weekly\WK{wk}" → a real path for this week.
function fillPattern(pattern, week) {
  const p = weekParts(week) || { yy: '', year: '', wk: '', part: '' };
  return String(pattern || '').replace(/\{year\}/g, p.year).replace(/\{yy\}/g, p.yy).replace(/\{wk\}/g, p.wk).replace(/\{week\}/g, week).replace(/\{part\}/g, p.part);
}

module.exports = { loadWeek, buildWeek, applyEdits, editKinds, forecastSheet, symbolColours, SYMBOL_COLOURS, sheetView, prepareChart, buildA3Package, exportA3, weekParts, fillPattern, colPx, isErr, decode, parseRef, section, resolvePart, relsPathOf };
