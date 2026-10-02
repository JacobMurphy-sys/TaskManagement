'use strict';
// Tables as the Obsidian plugin "Sheets Extended" (obsidian-sheets) draws them,
// following its source (tableModel.ts, tableAugmenter.ts, sheetElement.ts):
//
//   Ordinary Markdown tables
//     <        merge into the cell on the left      ^  merge into the cell above
//              (merges stack into rectangles)
//     a column of only dashes (-) marks the columns before it as row headings
//              and is itself hidden
//     text ~ .class { "css": "value" }   style a cell; everything after ~ is hidden
//              (~~strike~~ and \~ are not separators)
//   ```sheet code blocks
//     { classes: { name: { color: 'red' } } }   JSON5 metadata, then a line
//     --- ~ .name { … }                        (optional style for the whole table)
//     then the table: the first all-dash row is the header boundary (rows above it
//     are headings) and its cells can carry alignment and ~ styles for their column;
//     likewise an all-dash column for rows.
//   A note with `disable-sheet: true` in its properties renders tables natively.

const STYLE_SEP = /(?<![\\~])~(?!~)/;
const DASH_ONLY = /^\s*:?-+:?\s*$/;
const HEADER_RE = /^\s*(:)?-+(:)?\s*(?:(?<!\\)~(.*))?$/;

// ---- JSON5 (unquoted keys, 'single quotes', trailing commas, comments) -------------
function parseJson5(src) {
  const s = String(src);
  let i = 0;
  const fail = (msg) => { throw new Error(`${msg} at position ${i}`); };
  const ws = () => {
    for (;;) {
      if (/\s/.test(s[i] || '')) i++;
      else if (s.startsWith('//', i)) { while (i < s.length && s[i] !== '\n') i++; } else if (s.startsWith('/*', i)) {
        const end = s.indexOf('*/', i + 2);
        if (end < 0) fail('Unclosed comment');
        i = end + 2;
      } else return;
    }
  };
  const str = () => {
    const q = s[i++];
    let out = '';
    while (i < s.length && s[i] !== q) {
      if (s[i] === '\\') {
        const c = s[++i];
        out += { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '\n': '' }[c] ?? (c === 'u' ? String.fromCharCode(parseInt(s.slice(i + 1, i += 4), 16)) : c);
        i++;
      } else out += s[i++];
    }
    if (s[i] !== q) fail('Unclosed string');
    i++;
    return out;
  };
  const ident = () => {
    const m = s.slice(i).match(/^[A-Za-z_$][\w$-]*/);
    if (!m) fail('Unexpected character');
    i += m[0].length;
    return m[0];
  };
  const value = () => {
    ws();
    const c = s[i];
    if (c === '{') {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (s[i] === '}') { i++; return obj; }
        const key = s[i] === '"' || s[i] === "'" ? str() : ident();
        ws();
        if (s[i++] !== ':') fail('Expected :');
        obj[key] = value();
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; return obj; }
        fail('Expected , or }');
      }
    }
    if (c === '[') {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (s[i] === ']') { i++; return arr; }
        arr.push(value());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; return arr; }
        fail('Expected , or ]');
      }
    }
    if (c === '"' || c === "'") return str();
    const num = s.slice(i).match(/^[+-]?(0x[0-9a-f]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)/i);
    if (num) { i += num[0].length; return Number(num[0]); }
    const word = ident();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return fail(`Unexpected "${word}"`);
  };
  const v = value();
  ws();
  if (i < s.length) fail('Unexpected text after the value');
  return v;
}

// ---- styles -------------------------------------------------------------------------

const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
// An inline style attribute from a { property: value } object. Only plain values:
// no url(), expressions or anything that could break out of the attribute.
function cssText(style) {
  return Object.entries(style || {}).map(([k, v]) => {
    const prop = kebab(String(k));
    const val = String(v ?? '').trim();
    if (!/^-?[a-z][a-z-]*$/.test(prop) || !val || /[;{}<>"\\]|url\s*\(|expression|javascript:|@import/i.test(val)) return '';
    return `${prop}: ${val}`;
  }).filter(Boolean).join('; ');
}

// "~ .c1 .c2 { color: 'red' }" -> { classes, style }
function parseDirective(directive, classDefs) {
  const inline = (directive.match(/\{[\s\S]*\}/) || [])[0];
  const classPart = inline ? directive.replace(inline, '') : directive;
  const classes = (classPart.match(/(?<=\.)[\w-]+/g) || []);
  let style = {};
  for (const c of classes) style = { ...style, ...(classDefs?.[c] || {}) };
  if (inline) { try { style = { ...style, ...parseJson5(inline) }; } catch { /* ignore a bad style, as the plugin does */ } }
  return { classes, style };
}

const alignOf = (m) => (m[1] && m[2] ? 'center' : m[2] ? 'right' : m[1] ? 'left' : '');

// ---- the table -------------------------------------------------------------------

// grid: visual rows (no delimiter row) of raw cell text.
// opts: { headRows, headerCol, colStyles[], rowStyles[], tableStyle, classDefs, renderCell(text) -> html }
function buildTable(grid, opts) {
  const width = Math.max(...grid.map((r) => r.length));
  const anchor = grid.map(() => []);
  const cells = new Map(); // anchor key -> cell
  const rowsOut = grid.map(() => []);
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < width; c++) {
      if (c === opts.headerCol) continue;
      const raw = String(grid[r][c] ?? '');
      const [content, ...rest] = raw.split(STYLE_SEP);
      const text = content.trim();
      let a = null;
      if (text === '<' && anchor[r][c - 1]) a = anchor[r][c - 1];
      else if (text === '^' && r > 0 && anchor[r - 1][c]) a = anchor[r - 1][c];
      else if (r > 0 && anchor[r - 1][c] && anchor[r][c - 1] && anchor[r - 1][c] === anchor[r][c - 1]) a = anchor[r][c - 1];
      if (a) {
        anchor[r][c] = a;
        a.colspan = Math.max(a.colspan, c - a.c + 1 - (opts.headerCol > a.c && opts.headerCol < c ? 1 : 0));
        a.rowspan = Math.max(a.rowspan, r - a.r + 1);
        continue;
      }
      const head = r < opts.headRows;
      const rowHead = opts.headerCol > 0 && c < opts.headerCol;
      let style = { ...(opts.tableStyle || {}), ...(opts.rowStyles?.[r] || {}), ...(opts.colStyles?.[c] || {}) };
      let classes = [];
      if (rest.length) {
        const d = parseDirective(rest.join('~'), opts.classDefs);
        style = { ...style, ...d.style };
        classes = d.classes;
      }
      const cell = { r, c, tag: head || rowHead ? 'th' : 'td', rowHead: rowHead && !head, html: opts.renderCell(text), style, classes, colspan: 1, rowspan: 1 };
      anchor[r][c] = cell;
      cells.set(`${r}:${c}`, cell);
      rowsOut[r].push(cell);
    }
  }
  const td = (x) => {
    const css = cssText(x.style);
    const cls = [x.rowHead ? 'sx-row-head' : '', ...x.classes.map((k) => `sx-${k}`)].filter(Boolean).join(' ');
    return `<${x.tag}${x.colspan > 1 ? ` colspan="${x.colspan}"` : ''}${x.rowspan > 1 ? ` rowspan="${x.rowspan}"` : ''}`
      + `${cls ? ` class="${cls.replace(/[^\w -]/g, '')}"` : ''}${css ? ` style="${css}"` : ''}>${x.html}</${x.tag}>`;
  };
  const tr = (row) => `<tr>${row.map(td).join('')}</tr>`;
  const head = rowsOut.slice(0, opts.headRows);
  const body = rowsOut.slice(opts.headRows);
  return `<div class="md-table"><table class="sx-table">${head.length ? `<thead>${head.map(tr).join('')}</thead>` : ''}`
    + `<tbody>${body.map(tr).join('')}</tbody></table></div>`;
}

// First column whose cells are all dashes (the vertical-header marker), or -1.
function findHeaderColumn(grid, test = (t) => DASH_ONLY.test(t)) {
  const width = Math.max(0, ...grid.map((r) => r.length));
  for (let c = 0; c < width; c++) {
    const col = grid.filter((r) => c < r.length).map((r) => r[c]);
    if (col.length && col.every(test)) return c;
  }
  return -1;
}

// An ordinary Markdown table: head row, delimiter row (alignment), body rows.
function nativeTable(head, delimiter, body, renderCell) {
  const grid = [head, ...body];
  const width = Math.max(...grid.map((r) => r.length));
  const colStyles = Array.from({ length: width }, (_, k) => {
    const m = String(delimiter[k] ?? '').match(HEADER_RE);
    const align = m ? alignOf(m) : '';
    return align ? { textAlign: align } : {};
  });
  // Rows have as many cells as the header row, as in any Markdown table.
  const even = grid.map((r) => Array.from({ length: head.length }, (_, k) => r[k] ?? ''));
  return buildTable(even, { headRows: 1, headerCol: findHeaderColumn(even), colStyles, renderCell });
}

// A ```sheet code block.
function sheetBlock(source, renderCell) {
  const text = String(source).trim();
  const metaRe = /^---[ \t]*(?:~(.*?))?[ \t]*$/m;
  let classDefs = {};
  let tableStyle = {};
  let tableText = text;
  const m = text.match(metaRe);
  if (m) {
    const meta = text.slice(0, m.index).trim();
    tableText = text.slice(m.index + m[0].length);
    if (meta) {
      let data;
      try { data = parseJson5(meta); } catch (err) { throw new Error(`Metadata is not proper JSON: ${err.message}`); }
      classDefs = (data && typeof data.classes === 'object' && data.classes) || {};
    }
    if (m[1]) tableStyle = parseDirective(m[1], classDefs).style;
  }
  const lines = tableText.split('\n').filter((l) => /(?<!\\)\|/.test(l));
  const grid = lines.map((l) => {
    const cells = l.split(/(?<!\\)\|/).map((x) => x.trim());
    if (cells[0] !== '' || cells[cells.length - 1] !== '') throw new Error('Malformed table (every row must start and end with |)');
    return cells.slice(1, -1);
  });
  if (!grid.length) throw new Error('No table found');
  const width = Math.max(...grid.map((r) => r.length));
  const full = grid.map((r) => Array.from({ length: width }, (_, k) => r[k] ?? ''));
  const headerRow = full.findIndex((row) => row.every((x) => HEADER_RE.test(x)));
  const headerCol = findHeaderColumn(full, (x) => HEADER_RE.test(x));
  const lineStyle = (x) => {
    const mm = String(x).match(HEADER_RE);
    if (!mm) return {};
    const align = alignOf(mm);
    return { ...(align ? { textAlign: align } : {}), ...(mm[3] ? parseDirective(mm[3], classDefs).style : {}) };
  };
  const colStyles = headerRow >= 0 ? full[headerRow].map(lineStyle) : [];
  let rowStyles = headerCol >= 0 ? full.map((row) => lineStyle(row[headerCol])) : [];
  const visual = headerRow >= 0 ? full.filter((_, k) => k !== headerRow) : full;
  if (headerRow >= 0) rowStyles = rowStyles.filter((_, k) => k !== headerRow);
  return buildTable(visual, { headRows: Math.max(0, headerRow), headerCol, colStyles, rowStyles, tableStyle, classDefs, renderCell });
}

module.exports = { nativeTable, sheetBlock, parseJson5, cssText, STYLE_SEP };
