'use strict';
// Reading an Excel workbook (.xlsx / .xlsm) for display: cached cell values, styles,
// merged cells, column widths, conditional formats, pictures and charts (from the
// values Excel stored with them). Only the parts asked for are unzipped, so a large
// workbook with big data sheets opens quickly. Nothing is recalculated.

const zlib = require('zlib');

// ---- zip ------------------------------------------------------------------------------

// The zip's directory; read(name) inflates one entry when it's needed.
function openZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not an Excel workbook (.xlsx / .xlsm)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('The workbook file is damaged');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const cache = new Map();
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (cache.has(name)) return cache.get(name);
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const raw = buf.subarray(start, start + e.size);
    const out = e.method === 0 ? Buffer.from(raw) : e.method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!out) throw new Error(`Unsupported compression in ${name}`);
    cache.set(name, out);
    return out;
  };
  return { names: [...entries.keys()], has: (n) => entries.has(n), read, text: (n) => { const b = read(n); return b ? b.toString('utf8') : null; } };
}

// ---- small helpers --------------------------------------------------------------------

const decode = (s) => String(s ?? '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
  .replace(/&amp;/g, '&');
const attr = (tag, name) => { const m = tag && tag.match(new RegExp(`\\s${name}="([^"]*)"`)); return m ? decode(m[1]) : null; };
const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const parseRef = (ref) => { const m = String(ref).replace(/\$/g, '').match(/^([A-Z]+)(\d+)$/); return m ? { col: colNum(m[1]), row: Number(m[2]) } : null; };
const refOf = (col, row) => `${colLetters(col)}${row}`;
// "A1:C3 E5" → [{ top, left, bottom, right }]
const parseSqref = (sqref) => String(sqref || '').trim().split(/\s+/).filter(Boolean).map((part) => {
  const [a, b] = part.replace(/\$/g, '').split(':');
  const p = parseRef(a); const q = parseRef(b || a);
  if (!p || !q) return null;
  return { top: Math.min(p.row, q.row), bottom: Math.max(p.row, q.row), left: Math.min(p.col, q.col), right: Math.max(p.col, q.col) };
}).filter(Boolean);
const textOf = (xml) => decode([...String(xml || '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(''));
const items = (xml, tag) => [...String(xml || '').matchAll(new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`, 'g'))].map((m) => m[0]);
const section = (xml, tag) => (String(xml || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';

function resolvePart(from, target) {
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const seg of target.replace(/^\//, '').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}
const relsPathOf = (part) => { const i = part.lastIndexOf('/'); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };

// ---- colours ----------------------------------------------------------------------------

const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00',
  '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366',
  'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF',
  '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600',
  '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];

const hexToRgb = (hex) => [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const rgbToHex = (rgb) => rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
function rgbToHsl([r, g, b]) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
// Excel's tint: towards black (negative) or white (positive), on lightness.
function applyTint(hex, tint) {
  if (!tint) return hex;
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return rgbToHex(hslToRgb([h, s, nl]));
}

// Theme colours in Excel's index order (lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink).
function readTheme(xml) {
  const scheme = section(xml, 'a:clrScheme');
  const get = (name) => {
    const m = scheme.match(new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`));
    if (!m) return '000000';
    return attr(m[1].match(/<a:srgbClr\b[^>]*>/)?.[0], 'val') || attr(m[1].match(/<a:sysClr\b[^>]*>/)?.[0], 'lastClr') || '000000';
  };
  const named = Object.fromEntries(['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((n) => [n, get(n)]));
  const fonts = { major: attr(section(xml, 'a:majorFont').match(/<a:latin\b[^>]*>/)?.[0], 'typeface'), minor: attr(section(xml, 'a:minorFont').match(/<a:latin\b[^>]*>/)?.[0], 'typeface') };
  return { named, indexed: [named.lt1, named.dk1, named.lt2, named.dk2, named.accent1, named.accent2, named.accent3, named.accent4, named.accent5, named.accent6, named.hlink, named.folHlink], fonts };
}

// A spreadsheet colour element (<color rgb|theme|indexed tint>) → "RRGGBB" or null.
function cellColor(tag, theme, indexed = INDEXED) {
  if (!tag || /\sauto="1"/.test(tag)) return null;
  let hex = null;
  const rgb = attr(tag, 'rgb');
  if (rgb) hex = rgb.length === 8 ? rgb.slice(2) : rgb;
  else if (attr(tag, 'theme') !== null) hex = theme.indexed[Number(attr(tag, 'theme'))] || null;
  else if (attr(tag, 'indexed') !== null) { const i = Number(attr(tag, 'indexed')); hex = i === 64 || i === 65 ? null : indexed[i] || null; }
  if (!hex) return null;
  return applyTint(hex.toUpperCase(), Number(attr(tag, 'tint') || 0));
}

// A DrawingML colour (inside a solidFill etc.) → "RRGGBB" or null.
function drawingColor(xml, theme, fallback = null) {
  if (!xml) return fallback;
  const m = xml.match(/<a:(srgbClr|schemeClr|sysClr|prstClr)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/a:\1>)/);
  if (!m) return fallback;
  const val = attr(`<x${m[2]}>`, 'val');
  const SCHEME = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2', phClr: 'accent1' };
  const PRESET = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '00FF00', blue: '0000FF', yellow: 'FFFF00', gray: '808080' };
  let hex = m[1] === 'srgbClr' ? val : m[1] === 'sysClr' ? attr(`<x${m[2]}>`, 'lastClr') || '000000'
    : m[1] === 'prstClr' ? PRESET[val] || '000000' : theme.named[SCHEME[val] || val] || '000000';
  let [h, s, l] = rgbToHsl(hexToRgb(hex));
  const mods = m[3] || '';
  const num = (name) => { const t = mods.match(new RegExp(`<a:${name}\\b[^>]*val="(-?\\d+)"`)); return t ? Number(t[1]) / 100000 : null; };
  if (num('lumMod') !== null) l *= num('lumMod');
  if (num('lumOff') !== null) l += num('lumOff');
  let rgb = hslToRgb([h, s, Math.min(1, Math.max(0, l))]);
  if (num('tint') !== null) rgb = rgb.map((c) => c + (1 - c) * (1 - num('tint')));
  if (num('shade') !== null) rgb = rgb.map((c) => c * num('shade'));
  hex = rgbToHex(rgb);
  const alpha = num('alpha');
  return alpha !== null && alpha < 1 ? `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase()}` : hex;
}

// ---- styles -----------------------------------------------------------------------------

const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'dd/mm/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
  22: 'dd/mm/yyyy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};

function readFont(xml, theme) {
  const has = (t) => new RegExp(`<${t}(?:\\s+val="(?:1|true)")?\\s*/>`).test(xml);
  const val = (t) => attr(xml.match(new RegExp(`<${t}\\b[^>]*>`))?.[0], 'val');
  return {
    b: has('b'), i: has('i'), strike: has('strike'), u: val('u') || (/<u\s*\/>/.test(xml) ? 'single' : null),
    sz: Number(val('sz')) || null, name: val('name'), color: cellColor(xml.match(/<color\b[^>]*\/?>/)?.[0], theme),
    vertAlign: val('vertAlign'),
  };
}
function readFill(xml, theme, dxf) {
  const pf = xml.match(/<patternFill\b([^>]*)(?:\/>|>([\s\S]*?)<\/patternFill>)/);
  if (pf) {
    const type = attr(`<x${pf[1]}>`, 'patternType') || (dxf ? 'solid' : 'none');
    if (type === 'none') return null;
    const fg = cellColor(pf[2]?.match(/<fgColor\b[^>]*\/?>/)?.[0], theme);
    const bg = cellColor(pf[2]?.match(/<bgColor\b[^>]*\/?>/)?.[0], theme);
    // In a conditional format a solid fill's colour is in bgColor; in a cell style, fgColor.
    return { color: dxf ? bg || fg : (type === 'solid' ? fg || bg : fg || bg), pattern: type };
  }
  const gf = xml.match(/<gradientFill\b[\s\S]*?<\/gradientFill>/);
  if (gf) { const stop = gf[0].match(/<color\b[^>]*\/?>/); return { color: cellColor(stop?.[0], theme), pattern: 'solid' }; }
  return null;
}
function readBorder(xml, theme) {
  const side = (name) => {
    const m = xml.match(new RegExp(`<${name}\\b([^>]*)(?:/>|>([\\s\\S]*?)</${name}>)`));
    const style = m && attr(`<x${m[1]}>`, 'style');
    return style ? { style, color: cellColor(m[2]?.match(/<color\b[^>]*\/?>/)?.[0], theme) || '000000' } : null;
  };
  return { left: side('left'), right: side('right'), top: side('top'), bottom: side('bottom') };
}

function readStyles(xml, theme) {
  const indexedOverride = items(section(xml, 'indexedColors'), 'rgbColor').map((t) => (attr(t, 'rgb') || '').slice(2));
  const indexed = indexedOverride.length ? indexedOverride : INDEXED;
  const color = (t) => cellColor(t, theme, indexed);
  const th = { ...theme };
  const numFmts = { ...BUILTIN_FORMATS };
  for (const t of items(section(xml, 'numFmts'), 'numFmt')) numFmts[Number(attr(t, 'numFmtId'))] = attr(t, 'formatCode');
  const fonts = items(section(xml, 'fonts'), 'font').map((f) => readFont(f, th));
  const fills = items(section(xml, 'fills'), 'fill').map((f) => readFill(f, th, false));
  const borders = items(section(xml, 'borders'), 'border').map((b) => readBorder(b, th));
  const xfs = items(section(xml, 'cellXfs'), 'xf').map((x) => {
    const open = x.match(/^<xf\b[^>]*>/)[0];
    const al = x.match(/<alignment\b[^>]*\/?>/)?.[0];
    return {
      numFmtId: Number(attr(open, 'numFmtId') || 0), fontId: Number(attr(open, 'fontId') || 0), fillId: Number(attr(open, 'fillId') || 0),
      borderId: Number(attr(open, 'borderId') || 0),
      align: al ? { h: attr(al, 'horizontal'), v: attr(al, 'vertical'), wrap: attr(al, 'wrapText') === '1' || attr(al, 'wrapText') === 'true',
        rotate: Number(attr(al, 'textRotation') || 0), indent: Number(attr(al, 'indent') || 0), shrink: attr(al, 'shrinkToFit') === '1' } : {},
    };
  });
  const dxfs = items(section(xml, 'dxfs'), 'dxf').map((d) => {
    const font = d.match(/<font\b[\s\S]*?<\/font>/)?.[0];
    const fill = d.match(/<fill\b[\s\S]*?<\/fill>/)?.[0];
    const nf = d.match(/<numFmt\b[^>]*\/>/)?.[0];
    const border = d.match(/<border\b[\s\S]*?<\/border>/)?.[0];
    return { font: font ? readFont(font, th) : null, fill: fill ? readFill(fill, th, true) : null,
      numFmt: nf ? attr(nf, 'formatCode') : null, border: border ? readBorder(border, th) : null, xml: d };
  });
  return { numFmts, fonts, fills, borders, xfs, dxfs, color, xml };
}

// ---- workbook ---------------------------------------------------------------------------

function readBook(buf) {
  const z = openZip(buf);
  const wbXml = z.text('xl/workbook.xml');
  if (!wbXml) throw new Error('This file has no workbook inside it');
  const rels = Object.fromEntries(items(z.text('xl/_rels/workbook.xml.rels'), 'Relationship').map((r) => [attr(r, 'Id'), resolvePart('xl/workbook.xml', attr(r, 'Target'))]));
  const sheets = items(wbXml, 'sheet').map((t) => ({ name: attr(t, 'name'), file: rels[attr(t, 'r:id')], hidden: !!attr(t, 'state') && attr(t, 'state') !== 'visible' }));
  const date1904 = /date1904="(1|true)"/.test(wbXml.match(/<workbookPr\b[^>]*>/)?.[0] || '');
  const theme = readTheme(z.text('xl/theme/theme1.xml') || '');
  const styles = readStyles(z.text('xl/styles.xml') || '', theme);
  let sst = null;
  const sharedStrings = () => {
    if (sst) return sst;
    const xml = z.text('xl/sharedStrings.xml') || '';
    sst = [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')));
    return sst;
  };
  const parsed = new Map();
  const book = { zip: z, sheets, theme, styles, date1904, workbookXml: wbXml };

  // skipRows(n) → true leaves that row out (a big table that's about to be replaced is not read).
  book.sheet = (name, { skipRows } = {}) => {
    if (!skipRows && parsed.has(name)) return parsed.get(name);
    const info = sheets.find((s) => s.name === name);
    if (!info) return null;
    let xml = z.text(info.file);
    if (skipRows) xml = xml.replace(/<row\b[^>]*?\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (m, n) => (skipRows(Number(n)) ? '' : m));
    const sheet = parseSheet(xml, sharedStrings);
    if (skipRows) { sheet.name = name; sheet.file = info.file; return sheet; }
    sheet.name = name;
    sheet.file = info.file;
    sheet.xml = xml;
    sheet.rels = Object.fromEntries(items(z.text(relsPathOf(info.file)) || '', 'Relationship').map((r) => [attr(r, 'Id'),
      { target: /TargetMode="External"/.test(r) ? attr(r, 'Target') : resolvePart(info.file, attr(r, 'Target')), type: attr(r, 'Type').split('/').pop() }]));
    parsed.set(name, sheet);
    return sheet;
  };

  // Pictures and charts on a sheet, anchored to cells.
  book.drawing = (sheet) => {
    const id = attr(sheet.xml.match(/<drawing\b[^>]*>/)?.[0], 'r:id');
    const part = id && sheet.rels[id]?.target;
    const xml = part && z.text(part);
    if (!xml) return { part: null, anchors: [] };
    const drels = Object.fromEntries(items(z.text(relsPathOf(part)) || '', 'Relationship').map((r) => [attr(r, 'Id'), resolvePart(part, attr(r, 'Target'))]));
    const pos = (x) => (x ? { col: Number(section(x, 'xdr:col')), colOff: Number(section(x, 'xdr:colOff')), row: Number(section(x, 'xdr:row')), rowOff: Number(section(x, 'xdr:rowOff')) } : null);
    const anchors = [];
    for (const m of xml.matchAll(/<xdr:(twoCellAnchor|oneCellAnchor|absoluteAnchor)\b[^>]*>[\s\S]*?<\/xdr:\1>/g)) {
      const a = m[0];
      const chartId = attr(a.match(/<c:chart\b[^>]*>/)?.[0], 'r:id');
      const blip = attr(a.match(/<a:blip\b[^>]*>/)?.[0], 'r:embed');
      const ext = a.match(/<xdr:ext\b[^>]*>/)?.[0];
      anchors.push({
        type: m[1], xml: a, name: attr(a.match(/<xdr:cNvPr\b[^>]*>/)?.[0], 'name'), hidden: attr(a.match(/<xdr:cNvPr\b[^>]*>/)?.[0], 'hidden') === '1',
        kind: chartId ? 'chart' : blip ? 'picture' : 'shape',
        from: pos(a.match(/<xdr:from>[\s\S]*?<\/xdr:from>/)?.[0]), to: pos(a.match(/<xdr:to>[\s\S]*?<\/xdr:to>/)?.[0]),
        ext: ext ? { cx: Number(attr(ext, 'cx')), cy: Number(attr(ext, 'cy')) } : null,
        chart: chartId ? drels[chartId] : null, image: blip ? drels[blip] : null,
      });
    }
    return { part, xml, rels: drels, anchors };
  };

  book.chart = (part) => chartSpec(z.text(part) || '', theme);

  // The Excel tables (ListObjects) in the workbook: { name, sheet, ref, range }.
  book.tables = () => sheets.flatMap((info) => items(z.text(relsPathOf(info.file)) || '', 'Relationship')
    .filter((r) => /\/table$/.test(attr(r, 'Type') || ''))
    .map((r) => {
      const xml = z.text(resolvePart(info.file, attr(r, 'Target'))) || '';
      const open = xml.match(/<table\b[^>]*>/)?.[0] || '';
      return { name: attr(open, 'name'), displayName: attr(open, 'displayName'), sheet: info.name, ref: attr(open, 'ref'), range: parseSqref(attr(open, 'ref'))[0] || null };
    }));
  return book;
}

// ---- sheets -----------------------------------------------------------------------------

function parseSheet(xml, sharedStrings) {
  const cells = new Map();
  let maxRow = 0; let maxCol = 0;
  const sharedF = new Map();
  const sheetData = xml.slice(Math.max(0, xml.indexOf('<sheetData')), xml.indexOf('</sheetData>') + 12 || undefined);
  const colCache = new Map();
  const colOf = (letters) => { let n = colCache.get(letters); if (n === undefined) { n = colNum(letters); colCache.set(letters, n); } return n; };
  // One pass over the cells; attributes read with plain string searches (fast on big sheets).
  const cellRe = /<c\s([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
  const attrOf = (a, name) => { const i = a.indexOf(` ${name}="`) >= 0 ? a.indexOf(` ${name}="`) + name.length + 3 : (a.startsWith(`${name}="`) ? name.length + 2 : -1); if (i < 0) return null; return a.slice(i, a.indexOf('"', i)); };
  let m;
  while ((m = cellRe.exec(sheetData))) {
    const a = m[1];
    const r = attrOf(a, 'r');
    const rm = r && /^([A-Z]+)(\d+)$/.exec(r);
    if (!rm) continue;
    const p = { col: colOf(rm[1]), row: Number(rm[2]) };
    const body = m[3] || '';
    const t = attrOf(a, 't') || 'n';
    let vRaw;
    const vs = body.indexOf('<v>');
    if (vs >= 0) vRaw = body.slice(vs + 3, body.indexOf('</v>', vs));
    let v = null;
    if (t === 's') v = vRaw !== undefined ? sharedStrings()[Number(vRaw)] ?? '' : null;
    else if (t === 'inlineStr') v = textOf(body.match(/<is>[\s\S]*?<\/is>/)?.[0] || '');
    else if (t === 'str') v = vRaw !== undefined ? decode(vRaw) : '';
    else if (t === 'b') v = vRaw === '1';
    else if (t === 'e') v = vRaw !== undefined ? decode(vRaw) : '#N/A';
    else if (vRaw !== undefined && vRaw !== '') v = Number(vRaw);
    let f = null; let arrayRef = null;
    if (body.includes('<f')) {
      const fm = body.match(/<f\b([^>]*)(?:\/>|>([\s\S]*?)<\/f>)/);
      if (fm) {
        const fa = `<f${fm[1]}>`;
        f = fm[2] !== undefined ? decode(fm[2]) : null;
        if (attr(fa, 't') === 'array') arrayRef = attr(fa, 'ref'); // a dynamic array: the range it spills over
        if (attr(fa, 't') === 'shared') {
          const si = attr(fa, 'si');
          if (f) sharedF.set(si, { f, at: p });
          else if (sharedF.has(si)) f = shiftFormula(sharedF.get(si).f, p.row - sharedF.get(si).at.row, p.col - sharedF.get(si).at.col);
        }
      }
    }
    const sAttr = attrOf(a, 's');
    cells.set(r, { r, row: p.row, col: p.col, s: sAttr ? Number(sAttr) : 0, t: t === 'e' ? 'e' : typeof v === 'string' ? 's' : typeof v === 'boolean' ? 'b' : 'n', v, f, ...(arrayRef ? { arrayRef } : {}) });
    if (p.row > maxRow) maxRow = p.row;
    if (p.col > maxCol) maxCol = p.col;
  }
  const rows = new Map();
  for (const m of sheetData.matchAll(/<row\b([^>]*)>/g)) {
    const a = `<row${m[1]}>`;
    rows.set(Number(attr(a, 'r')), { ht: attr(a, 'ht') ? Number(attr(a, 'ht')) : null, hidden: attr(a, 'hidden') === '1',
      s: attr(a, 'customFormat') === '1' ? Number(attr(a, 's') || 0) : null });
  }
  const cols = items(section(xml, 'cols'), 'col').map((t) => ({ min: Number(attr(t, 'min')), max: Number(attr(t, 'max')),
    width: attr(t, 'width') ? Number(attr(t, 'width')) : null, hidden: attr(t, 'hidden') === '1', s: attr(t, 'style') ? Number(attr(t, 'style')) : null }));
  const fmt = xml.match(/<sheetFormatPr\b[^>]*>/)?.[0];
  const merges = items(section(xml, 'mergeCells'), 'mergeCell').map((t) => parseSqref(attr(t, 'ref'))[0]).filter(Boolean);
  const view = xml.match(/<sheetView\b[^>]*>/)?.[0];
  return {
    cells, rows, cols, merges, maxRow, maxCol,
    defaultRowHeight: Number(attr(fmt, 'defaultRowHeight') || 15),
    defaultColWidth: attr(fmt, 'defaultColWidth') ? Number(attr(fmt, 'defaultColWidth')) : 8.43 + 0.71,
    showGrid: attr(view, 'showGridLines') !== '0',
    cf: readConditionalFormats(xml),
    validations: items(section(xml, 'dataValidations'), 'dataValidation').map((t) => ({ sqref: attr(t, 'sqref'), type: attr(t, 'type') })),
  };
}

// Moves the relative references in a formula (for shared formulas and conditional
// formats written for the top-left cell of their range).
function shiftFormula(f, dRow, dCol) {
  if (!dRow && !dCol) return f;
  let out = ''; let i = 0;
  const re = /("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g;
  let m;
  while ((m = re.exec(f))) {
    out += f.slice(i, m.index);
    i = re.lastIndex;
    if (m[1]) { out += m[1]; continue; }
    const prev = f[m.index - 1];
    if (prev && /[\w.]/.test(prev) && !m[2]) { out += m[0]; continue; } // part of a name
    const col = m[3] ? colNum(m[4]) : colNum(m[4]) + dCol;
    const row = m[5] ? Number(m[6]) : Number(m[6]) + dRow;
    out += `${m[2] || ''}${m[3]}${colLetters(Math.max(1, col))}${m[5]}${Math.max(1, row)}`;
  }
  return out + f.slice(i);
}

// Conditional formats: classic ones plus Excel 2010's (x14) kept in extLst, which can
// refer to other sheets and carry their own format.
function readConditionalFormats(xml) {
  const list = [];
  for (const m of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
    const sqref = attr(`<x${m[1]}>`, 'sqref');
    for (const r of items(m[2], 'cfRule')) {
      const open = r.match(/^<cfRule\b[^>]*>/)[0];
      list.push({ sqref, ranges: parseSqref(sqref), type: attr(open, 'type'), operator: attr(open, 'operator'), text: attr(open, 'text'),
        priority: Number(attr(open, 'priority') || 999), stopIfTrue: attr(open, 'stopIfTrue') === '1', dxfId: attr(open, 'dxfId') !== null ? Number(attr(open, 'dxfId')) : null,
        rank: Number(attr(open, 'rank') || 10), bottom: attr(open, 'bottom') === '1', percent: attr(open, 'percent') === '1',
        aboveAverage: attr(open, 'aboveAverage') !== '0', timePeriod: attr(open, 'timePeriod'),
        formulas: [...r.matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map((x) => decode(x[1])), colorScale: /<colorScale>/.test(r) ? r : null });
    }
  }
  for (const m of xml.matchAll(/<x14:conditionalFormatting\b[^>]*>([\s\S]*?)<\/x14:conditionalFormatting>/g)) {
    const sqref = decode(section(m[1], 'xm:sqref'));
    for (const r of items(m[1], 'x14:cfRule')) {
      const open = r.match(/^<x14:cfRule\b[^>]*>/)[0];
      list.push({ sqref, ranges: parseSqref(sqref), type: attr(open, 'type'), operator: attr(open, 'operator'), text: attr(open, 'text'),
        priority: Number(attr(open, 'priority') || 999), stopIfTrue: attr(open, 'stopIfTrue') === '1', dxfId: null,
        dxfXml: r.match(/<x14:dxf>[\s\S]*?<\/x14:dxf>/)?.[0].replace(/x14:dxf/g, 'dxf') || null,
        formulas: [...r.matchAll(/<xm:f>([\s\S]*?)<\/xm:f>/g)].map((x) => decode(x[1])), x14: true });
    }
  }
  return list.sort((a, b) => a.priority - b.priority);
}

// ---- charts -----------------------------------------------------------------------------

// What's needed to draw a chart as a picture, from the values cached in it.
function chartSpec(xml, theme) {
  const strip = (x) => String(x || '').replace(/<c:extLst>[\s\S]*?<\/c:extLst>/g, '');
  const X = strip(xml);
  const runsSize = (x, def) => { const sz = attr(x?.match(/<a:defRPr\b[^>]*>/)?.[0] || x?.match(/<a:rPr\b[^>]*>/)?.[0], 'sz'); return sz ? Number(sz) / 100 : def; };
  const defRPr = (x) => x?.match(/<a:defRPr\b[^>]*\/>|<a:defRPr\b[^>]*>[\s\S]*?<\/a:defRPr>/)?.[0];
  const textColor = (x, def = '595959') => drawingColor(defRPr(x)?.match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/)?.[0], theme, def);
  const bold = (x) => attr(x?.match(/<a:defRPr\b[^>]*>/)?.[0], 'b') === '1';
  const fillOf = (spPr) => {
    if (!spPr) return undefined;
    const noLnPart = spPr.replace(/<a:ln\b[\s\S]*?<\/a:ln>/g, '');
    if (/<a:noFill\/>/.test(noLnPart) && !/<a:solidFill>/.test(noLnPart)) return null;
    const s = noLnPart.match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/)?.[0];
    if (s) return drawingColor(s, theme);
    const g = noLnPart.match(/<a:gradFill\b[\s\S]*?<\/a:gradFill>/)?.[0];
    return g ? drawingColor(g, theme) : undefined;
  };
  const lineOf = (spPr) => {
    const ln = spPr?.match(/<a:ln\b[^>]*?(?:\/>|>[\s\S]*?<\/a:ln>)/)?.[0];
    if (!ln) return undefined;
    if (/<a:noFill\/>/.test(ln)) return null;
    return { color: drawingColor(ln.match(/<a:solidFill>[\s\S]*?<\/a:solidFill>/)?.[0], theme, null), width: attr(ln, 'w') ? Number(attr(ln, 'w')) / 12700 : null,
      dash: attr(ln.match(/<a:prstDash\b[^>]*>/)?.[0], 'val') || 'solid' };
  };
  const strCache = (x) => {
    const c = x?.match(/<c:(?:strCache|numCache)>[\s\S]*?<\/c:(?:strCache|numCache)>/)?.[0];
    if (!c) { const lit = x?.match(/<c:(?:strLit|numLit)>[\s\S]*?<\/c:(?:strLit|numLit)>/)?.[0]; if (!lit) return []; return toPts(lit); }
    return toPts(c);
  };
  const toPts = (c) => {
    const n = Number(attr(c.match(/<c:ptCount\b[^>]*>/)?.[0], 'val') || 0);
    const out = Array(n).fill(null);
    for (const p of c.matchAll(/<c:pt idx="(\d+)"[^>]*>\s*<c:v>([\s\S]*?)<\/c:v>/g)) out[Number(p[1])] = decode(p[2]);
    return out;
  };
  const multiLevel = (x) => { // multi-level categories: use the innermost level
    const lvl = x?.match(/<c:lvl>[\s\S]*?<\/c:lvl>/)?.[0];
    return lvl ? toPts(`<c:x>${lvl}</c:x>`.replace(/<c:lvl>/, `<c:ptCount val="${[...lvl.matchAll(/<c:pt /g)].length}"/>`)) : null;
  };
  const dLblsOf = (x, inherit) => {
    const d = x?.match(/<c:dLbls>[\s\S]*?<\/c:dLbls>/)?.[0];
    if (!d) return inherit || null;
    const flag = (n) => attr(d.match(new RegExp(`<c:${n}\\b[^>]*>`))?.[0], 'val') === '1';
    const general = d.replace(/<c:dLbl>[\s\S]*?<\/c:dLbl>/g, '');
    return { showVal: flag('showVal'), showSerName: flag('showSerName'), showCatName: flag('showCatName'), showPercent: flag('showPercent'),
      pos: attr(general.match(/<c:dLblPos\b[^>]*>/)?.[0], 'val'), numFmt: attr(general.match(/<c:numFmt\b[^>]*>/)?.[0], 'formatCode'),
      size: runsSize(general.match(/<c:txPr>[\s\S]*?<\/c:txPr>/)?.[0], 9), color: textColor(general.match(/<c:txPr>[\s\S]*?<\/c:txPr>/)?.[0], '404040'),
      bold: bold(general.match(/<c:txPr>[\s\S]*?<\/c:txPr>/)?.[0]),
      deleted: [...d.matchAll(/<c:dLbl>[\s\S]*?<c:idx val="(\d+)"\/>[\s\S]*?<c:delete val="1"\/>[\s\S]*?<\/c:dLbl>/g)].map((m) => Number(m[1])) };
  };
  const plot = X.match(/<c:plotArea>[\s\S]*<\/c:plotArea>/)?.[0] || '';
  const groups = [];
  let seriesNo = 0;
  for (const g of plot.matchAll(/<c:(barChart|bar3DChart|lineChart|line3DChart|areaChart|area3DChart|pieChart|pie3DChart|doughnutChart|scatterChart|radarChart)>([\s\S]*?)<\/c:\1>/g)) {
    const body = g[2];
    const val = (n) => attr(body.match(new RegExp(`<c:${n}\\b[^>]*>`))?.[0], 'val');
    const kind = g[1].replace(/3D/, '').replace('Chart', '');
    const groupLbls = dLblsOf(body.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, ''));
    const series = items(body, 'c:ser').map((s) => {
      const spPr = s.replace(/<c:dPt>[\s\S]*?<\/c:dPt>|<c:dLbls>[\s\S]*?<\/c:dLbls>|<c:marker>[\s\S]*?<\/c:marker>|<c:trendline>[\s\S]*?<\/c:trendline>/g, '')
        .match(/<c:spPr>[\s\S]*?<\/c:spPr>/)?.[0];
      const idx = Number(attr(s.match(/<c:idx\b[^>]*>/)?.[0], 'val') ?? seriesNo);
      seriesNo++;
      const catX = s.match(/<c:(?:cat|xVal)>[\s\S]*?<\/c:(?:cat|xVal)>/)?.[0];
      const valX = s.match(/<c:(?:val|yVal)>[\s\S]*?<\/c:(?:val|yVal)>/)?.[0];
      const marker = s.match(/<c:marker>[\s\S]*?<\/c:marker>/)?.[0];
      const dPts = items(s, 'c:dPt').map((d) => ({ idx: Number(attr(d.match(/<c:idx\b[^>]*>/)?.[0], 'val')), fill: fillOf(d.match(/<c:spPr>[\s\S]*?<\/c:spPr>/)?.[0]) }));
      const accent = theme.named[`accent${(idx % 6) + 1}`] || '4472C4';
      const fallback = idx >= 6 ? applyTint(accent, idx >= 12 ? 0.4 : -0.25) : accent;
      return {
        idx, order: Number(attr(s.match(/<c:order\b[^>]*>/)?.[0], 'val') ?? idx),
        name: (() => { const tx = s.match(/<c:tx>[\s\S]*?<\/c:tx>/)?.[0]; return tx ? (strCache(tx)[0] ?? textOf(tx)) : `Series${idx + 1}`; })(),
        fill: fillOf(spPr), line: lineOf(spPr), fallback,
        marker: marker ? { symbol: attr(marker.match(/<c:symbol\b[^>]*>/)?.[0], 'val') || 'auto', size: Number(attr(marker.match(/<c:size\b[^>]*>/)?.[0], 'val') || 5),
          fill: fillOf(marker.match(/<c:spPr>[\s\S]*?<\/c:spPr>/)?.[0]), line: lineOf(marker.match(/<c:spPr>[\s\S]*?<\/c:spPr>/)?.[0]) } : null,
        smooth: attr(s.match(/<c:smooth\b[^>]*>/)?.[0], 'val') === '1',
        cats: multiLevel(catX) || strCache(catX), vals: strCache(valX).map((v) => (v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v))),
        formatCode: decode(valX?.match(/<c:formatCode>([\s\S]*?)<\/c:formatCode>/)?.[1] || 'General'),
        ptFormats: Object.fromEntries([...(valX || '').matchAll(/<c:pt idx="(\d+)" formatCode="([^"]*)"/g)].map((m) => [m[1], decode(m[2])])),
        labels: dLblsOf(s, groupLbls), points: dPts,
        // the cells each part reads (to work the chart out again for other values)
        refs: { name: decode(s.match(/<c:tx>[\s\S]*?<c:f>([\s\S]*?)<\/c:f>/)?.[1] || '') || null, cat: decode(catX?.match(/<c:f>([\s\S]*?)<\/c:f>/)?.[1] || '') || null,
          val: decode(valX?.match(/<c:f>([\s\S]*?)<\/c:f>/)?.[1] || '') || null },
      };
    }).sort((a, b) => a.order - b.order);
    groups.push({ kind, barDir: val('barDir') || 'col', grouping: val('grouping') || (kind === 'line' ? 'standard' : 'clustered'),
      gapWidth: Number(val('gapWidth') ?? 150), overlap: Number(val('overlap') ?? 0), varyColors: val('varyColors') === '1',
      holeSize: Number(val('holeSize') ?? 50), firstSliceAng: Number(val('firstSliceAng') ?? 0),
      axIds: [...body.matchAll(/<c:axId val="(\d+)"\/>/g)].map((m) => m[1]), series });
  }
  const axes = {};
  for (const a of plot.matchAll(/<c:(catAx|valAx|dateAx|serAx)>([\s\S]*?)<\/c:\1>/g)) {
    const b = a[2];
    const val = (n) => attr(b.match(new RegExp(`<c:${n}\\b[^>]*>`))?.[0], 'val');
    const txPr = b.match(/<c:txPr>[\s\S]*?<\/c:txPr>/)?.[0];
    const sp = b.match(/<c:spPr>[\s\S]*?<\/c:spPr>/)?.[0];
    axes[val('axId')] = {
      kind: a[1], pos: val('axPos'), deleted: val('delete') === '1', crossAx: val('crossAx'),
      min: val('min') !== null ? Number(val('min')) : null, max: val('max') !== null ? Number(val('max')) : null,
      majorUnit: val('majorUnit') !== null ? Number(val('majorUnit')) : null, reverse: val('orientation') === 'maxMin',
      numFmt: attr(b.match(/<c:numFmt\b[^>]*>/)?.[0], 'formatCode'), sourceLinked: attr(b.match(/<c:numFmt\b[^>]*>/)?.[0], 'sourceLinked') === '1',
      gridlines: /<c:majorGridlines/.test(b), gridColor: lineOf(b.match(/<c:majorGridlines>[\s\S]*?<\/c:majorGridlines>/)?.[0])?.color || 'D9D9D9',
      tickLabels: val('tickLblPos') || 'nextTo', size: runsSize(txPr, 9), color: textColor(txPr), line: lineOf(sp),
      rotate: Number(attr(txPr?.match(/<a:bodyPr\b[^>]*>/)?.[0], 'rot') || 0) / 60000,
      title: (() => { const t = b.match(/<c:title>[\s\S]*?<\/c:title>/)?.[0]; return t ? textOf(t.match(/<c:tx>[\s\S]*?<\/c:tx>/)?.[0] || '') : ''; })(),
    };
  }
  const titleXml = X.match(/<c:chart>\s*<c:title>[\s\S]*?<\/c:title>/)?.[0];
  const autoDeleted = attr(X.match(/<c:autoTitleDeleted\b[^>]*>/)?.[0], 'val') === '1';
  let title = null;
  if (titleXml) {
    const txt = textOf(titleXml.match(/<c:tx>[\s\S]*?<\/c:tx>/)?.[0] || '');
    const one = groups.flatMap((g) => g.series);
    title = { text: txt || (one.length === 1 ? one[0].name : ''), size: runsSize(titleXml, 14), color: textColor(titleXml), bold: bold(titleXml) };
  } else if (!autoDeleted && groups.flatMap((g) => g.series).length === 1) {
    title = { text: groups[0].series[0].name, size: 14, color: '595959', bold: false };
  }
  const legendXml = X.match(/<c:legend>[\s\S]*?<\/c:legend>/)?.[0];
  const legend = legendXml ? {
    pos: attr(legendXml.match(/<c:legendPos\b[^>]*>/)?.[0], 'val') || 'r',
    deleted: [...legendXml.matchAll(/<c:legendEntry>\s*<c:idx val="(\d+)"\/>\s*<c:delete val="1"\/>/g)].map((m) => Number(m[1])),
    size: runsSize(legendXml.match(/<c:txPr>[\s\S]*?<\/c:txPr>/)?.[0], 9), color: textColor(legendXml.match(/<c:txPr>[\s\S]*?<\/c:txPr>/)?.[0]),
  } : null;
  const ml = plot.match(/^<c:plotArea>\s*<c:layout>\s*<c:manualLayout>([\s\S]*?)<\/c:manualLayout>/)?.[1];
  const layoutVal = (n) => Number(attr(ml?.match(new RegExp(`<c:${n}\\b[^>]*>`))?.[0], 'val'));
  const chartSpPr = X.match(/<\/c:chart>\s*<c:spPr>([\s\S]*?)<\/c:spPr>/)?.[0];
  const plotSpPr = plot.match(/<\/c:(?:catAx|valAx|dateAx|serAx)>\s*(?:<c:dTable>[\s\S]*?<\/c:dTable>\s*)?<c:spPr>[\s\S]*?<\/c:spPr>\s*<\/c:plotArea>/)?.[0];
  const roundedCorners = attr(X.match(/<c:roundedCorners\b[^>]*>/)?.[0], 'val') !== '0';
  const fill = fillOf(chartSpPr);
  const border = lineOf(chartSpPr);
  return {
    title, legend, groups, axes,
    plotLayout: ml && attr(ml.match(/<c:layoutTarget\b[^>]*>/)?.[0], 'val') !== 'outer' && !Number.isNaN(layoutVal('x'))
      ? { x: layoutVal('x'), y: layoutVal('y'), w: layoutVal('w'), h: layoutVal('h') } : null,
    background: fill === undefined ? 'FFFFFF' : fill, border: border === undefined ? { color: 'D9D9D9', width: 0.75 } : border,
    plotFill: plotSpPr ? fillOf(plotSpPr.match(/<c:spPr>[\s\S]*?<\/c:spPr>/)[0]) ?? null : null,
    rounded: roundedCorners, dispBlanksAs: attr(X.match(/<c:dispBlanksAs\b[^>]*>/)?.[0], 'val') || 'gap',
    font: [...X.matchAll(/<a:latin typeface="([^"]+)"/g)].map((m) => m[1]).find((f) => !f.startsWith('+')) || theme.fonts.minor || 'Calibri',
  };
}

module.exports = {
  openZip, readBook, parseSheet, shiftFormula, chartSpec, readStyles, readTheme, cellColor, drawingColor, applyTint,
  decode, attr, colNum, colLetters, parseRef, refOf, parseSqref, items, section, resolvePart, relsPathOf, textOf,
};
