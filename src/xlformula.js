'use strict';
// A small Excel formula evaluator, enough for conditional formatting rules
// (comparisons, AND/OR/IF, text search, maths, COUNTIF…), working on the values a
// workbook has cached. Plus: which conditional format applies to each cell.

const { parseRef, colNum, shiftFormula, readStyles } = require('./xlsxread');

class XlError { constructor(code) { this.error = code; } toString() { return this.error; } }
const ERR = (c) => new XlError(c);
const isErr = (v) => v instanceof XlError;

// ---- tokens & parser ----------------------------------------------------------------------

function tokenize(src) {
  const out = []; let i = 0;
  const s = String(src).replace(/^=/, '');
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '"') {
      let j = i + 1; let str = '';
      for (; j < s.length; j++) { if (s[j] === '"') { if (s[j + 1] === '"') { str += '"'; j++; } else break; } else str += s[j]; }
      out.push({ t: 'str', v: str }); i = j + 1; continue;
    }
    if (ch === '#') { const m = s.slice(i).match(/^#(?:N\/A|NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|SPILL!|CALC!|GETTING_DATA)/i); if (m) { out.push({ t: 'err', v: m[0].toUpperCase() }); i += m[0].length; continue; } }
    // reference: optional sheet, then A1 / A1:B2 / A:A / 1:1
    const ref = s.slice(i).match(/^(?:('(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![\w(])/);
    if (ref) {
      const sheet = ref[1] ? ref[1].replace(/^'|'$/g, '').replace(/''/g, "'") : null;
      out.push({ t: 'ref', sheet, v: ref[2].replace(/\$/g, '') });
      i += ref[0].length;
      continue;
    }
    const num = s.slice(i).match(/^\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|^\.\d+(?:[eE][+-]?\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^(?:_xlfn\.|_xlws\.)*([A-Za-z_][\w.]*)/);
    if (id) {
      const name = id[1].toUpperCase();
      i += id[0].length;
      if (s[i] === '(') { out.push({ t: 'fn', v: name }); i++; continue; }
      if (name === 'TRUE' || name === 'FALSE') { out.push({ t: 'bool', v: name === 'TRUE' }); continue; }
      out.push({ t: 'name', v: id[1] }); continue;
    }
    const two = s.slice(i, i + 2);
    if (['<=', '>=', '<>'].includes(two)) { out.push({ t: 'op', v: two }); i += 2; continue; }
    if ('+-*/^&=<>%'.includes(ch)) { out.push({ t: 'op', v: ch }); i++; continue; }
    if (ch === '(' || ch === ')' || ch === ',' || ch === ';') { out.push({ t: ch === ';' ? ',' : ch }); i++; continue; }
    if (ch === '{') { // array constant → list of values
      const j = s.indexOf('}', i);
      out.push({ t: 'arr', v: s.slice(i + 1, j).split(/[,;]/).map((x) => (/^".*"$/.test(x) ? x.slice(1, -1) : Number.isNaN(Number(x)) ? x : Number(x))) });
      i = j + 1; continue;
    }
    throw new Error(`Unexpected "${ch}" in formula`);
  }
  return out;
}

function parse(src) {
  const tk = tokenize(src); let p = 0;
  const peek = () => tk[p]; const next = () => tk[p++];
  const isOp = (...ops) => peek() && peek().t === 'op' && ops.includes(peek().v);
  const binary = (sub, ops) => () => { let l = sub(); while (isOp(...ops)) { const op = next().v; l = { k: 'bin', op, l, r: sub() }; } return l; };
  const primary = () => {
    const t = next();
    if (!t) throw new Error('Formula ends too soon');
    if (t.t === 'num' || t.t === 'str' || t.t === 'bool') return { k: 'lit', v: t.v };
    if (t.t === 'err') return { k: 'lit', v: ERR(t.v) };
    if (t.t === 'arr') return { k: 'arr', v: t.v };
    if (t.t === 'ref') return { k: 'ref', sheet: t.sheet, v: t.v };
    if (t.t === 'name') return { k: 'name', v: t.v };
    if (t.t === '(') { const e = cmp(); if (next()?.t !== ')') throw new Error('Missing )'); return e; }
    if (t.t === 'fn') {
      const args = [];
      if (peek()?.t === ')') { next(); return { k: 'fn', v: t.v, args }; }
      for (;;) {
        args.push(peek()?.t === ',' || peek()?.t === ')' ? { k: 'lit', v: null } : cmp());
        const sep = next();
        if (sep?.t === ')') break;
        if (sep?.t !== ',') throw new Error('Expected , or )');
      }
      return { k: 'fn', v: t.v, args };
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) { const e = postfix(); return t.v === '-' ? { k: 'neg', e } : e; }
    throw new Error('Unexpected token in formula');
  };
  const postfix = () => { let e = primary(); while (isOp('%')) { next(); e = { k: 'pct', e }; } return e; };
  const unary = () => (isOp('-', '+') ? (next().v === '-' ? { k: 'neg', e: unary() } : unary()) : postfix());
  const pow = binary(unary, ['^']);
  const mul = binary(pow, ['*', '/']);
  const add = binary(mul, ['+', '-']);
  const cat = binary(add, ['&']);
  const cmp = binary(cat, ['=', '<>', '<', '>', '<=', '>=']);
  const tree = cmp();
  if (p < tk.length) throw new Error('Unexpected text at the end of the formula');
  return tree;
}

// ---- values -------------------------------------------------------------------------------

const toNum = (v) => {
  if (isErr(v)) return v;
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const n = Number(String(v).trim().replace(/%$/, ''));
  if (String(v).trim() === '' || Number.isNaN(n)) return ERR('#VALUE!');
  return /%$/.test(String(v).trim()) ? n / 100 : n;
};
const toStr = (v) => (v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(Number(v.toPrecision(15))) : String(v));
const toBool = (v) => (isErr(v) ? v : typeof v === 'boolean' ? v : typeof v === 'string' ? (/^true$/i.test(v) ? true : /^false$/i.test(v) ? false : ERR('#VALUE!')) : toNum(v) !== 0);
const rank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2);
function compare(a, b) { // like Excel: blank matches the other side's type; numbers < text < logicals
  if (a === null || a === undefined) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null || b === undefined) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === 'string') { const x = a.toLowerCase(); const y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Criteria like ">5", "<>x", "a*" for COUNTIF / SUMIF.
function criteria(c) {
  if (typeof c === 'number' || typeof c === 'boolean') return (v) => compare(v, c) === 0 && rank(v) === rank(c);
  const m = String(c ?? '').match(/^(<=|>=|<>|<|>|=)?([\s\S]*)$/);
  const op = m[1] || '='; const raw = m[2];
  const n = raw !== '' && !Number.isNaN(Number(raw)) ? Number(raw) : null;
  if (n !== null) return (v) => { if (typeof v !== 'number') return op === '<>'; const d = v - n; return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op]; };
  if ((op === '=' || op === '<>') && /[*?]/.test(raw)) {
    const re = new RegExp(`^${raw.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/~\?/g, '\u0002').replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '.').replace(/\u0001/g, '\\*').replace(/\u0002/g, '\\?')}$`, 'i');
    return (v) => (op === '=') === (typeof v === 'string' && re.test(v));
  }
  if (raw === '' && op === '=') return (v) => v === null || v === '';
  if (raw === '' && op === '<>') return (v) => v !== null && v !== '';
  return (v) => { if (typeof v !== 'string') return op === '<>'; const d = compare(v, raw); return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op]; };
}

// ---- evaluation ---------------------------------------------------------------------------

// ctx: { sheet: name, cell(sheetName, row, col) → value, now?: Date, names?: {} }
function evaluate(formula, ctx) {
  let tree;
  try { tree = parse(formula); } catch { return ERR('#NAME?'); }
  try { return scalar(ev(tree, ctx), ctx); } catch (e) { return isErr(e) ? e : ERR('#VALUE!'); }
}

function rangeOf(node, ctx) {
  const [a, b] = node.v.split(':');
  const sheet = node.sheet || ctx.sheet;
  if (/^\d+$/.test(a)) return { sheet, top: Number(a), bottom: Number(b), left: 1, right: 16384 };
  if (/^[A-Z]+$/.test(a)) return { sheet, top: 1, bottom: 1048576, left: colNum(a), right: colNum(b) };
  const p = parseRef(a); const q = parseRef(b || a);
  return { sheet, top: Math.min(p.row, q.row), bottom: Math.max(p.row, q.row), left: Math.min(p.col, q.col), right: Math.max(p.col, q.col) };
}
// Values of a range (bounded by what the sheet uses).
function rangeValues(r, ctx) {
  const lim = ctx.bounds ? ctx.bounds(r.sheet) : { rows: 1000, cols: 100 };
  const out = [];
  for (let row = r.top; row <= Math.min(r.bottom, lim.rows); row++) for (let col = r.left; col <= Math.min(r.right, lim.cols); col++) out.push(ctx.cell(r.sheet, row, col));
  return out;
}
function scalar(v, ctx) {
  if (v && v.range) { const r = v.range; return r.top === r.bottom && r.left === r.right ? ctx.cell(r.sheet, r.top, r.left) ?? null : ctx.cell(r.sheet, r.top, r.left) ?? null; }
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
const flat = (args, ctx) => args.flatMap((v) => (v && v.range ? rangeValues(v.range, ctx) : Array.isArray(v) ? v : [v]));

function ev(n, ctx) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'arr': return n.v;
    case 'ref': return { range: rangeOf(n, ctx) };
    case 'name': { const v = ctx.names?.[n.v]; if (v === undefined) throw ERR('#NAME?'); return v; }
    case 'neg': { const v = toNum(scalar(ev(n.e, ctx), ctx)); if (isErr(v)) throw v; return -v; }
    case 'pct': { const v = toNum(scalar(ev(n.e, ctx), ctx)); if (isErr(v)) throw v; return v / 100; }
    case 'bin': {
      const l = scalar(ev(n.l, ctx), ctx); const r = scalar(ev(n.r, ctx), ctx);
      if (isErr(l)) throw l; if (isErr(r)) throw r;
      if (n.op === '&') return toStr(l) + toStr(r);
      if (['=', '<>', '<', '>', '<=', '>='].includes(n.op)) {
        const d = compare(l, r);
        return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[n.op];
      }
      const a = toNum(l); const b = toNum(r);
      if (isErr(a)) throw a; if (isErr(b)) throw b;
      if (n.op === '+') return a + b;
      if (n.op === '-') return a - b;
      if (n.op === '*') return a * b;
      if (n.op === '/') { if (b === 0) throw ERR('#DIV/0!'); return a / b; }
      if (n.op === '^') return a ** b;
      throw ERR('#VALUE!');
    }
    case 'fn': return callFn(n, ctx);
    default: throw ERR('#VALUE!');
  }
}

function callFn(n, ctx) {
  const lazy = (i) => (n.args[i] ? ev(n.args[i], ctx) : null);
  const arg = (i) => scalar(lazy(i), ctx);
  const num = (i, def) => { if (!n.args[i] && def !== undefined) return def; const v = toNum(arg(i)); if (isErr(v)) throw v; return v; };
  const str = (i) => { const v = arg(i); if (isErr(v)) throw v; return toStr(v); };
  const all = () => flat(n.args.map((a) => ev(a, ctx)), ctx);
  const nums = () => all().filter((v) => typeof v === 'number');
  switch (n.v) {
    case 'AND': case 'OR': {
      const vals = all().filter((v) => v !== null && v !== '' && typeof v !== 'string');
      for (const v of vals) if (isErr(v)) throw v;
      const b = vals.map((v) => toBool(v));
      return n.v === 'AND' ? b.every(Boolean) : b.some(Boolean);
    }
    case 'NOT': { const b = toBool(arg(0)); if (isErr(b)) throw b; return !b; }
    case 'IF': { const c = toBool(arg(0)); if (isErr(c)) throw c; return c ? (n.args[1] ? arg(1) : true) : (n.args[2] ? arg(2) : false); }
    case 'IFERROR': { let v; try { v = arg(0); } catch (e) { if (isErr(e)) return arg(1); throw e; } return isErr(v) ? arg(1) : v; }
    case 'IFNA': { let v; try { v = arg(0); } catch (e) { if (isErr(e) && e.error === '#N/A') return arg(1); throw e; } return isErr(v) && v.error === '#N/A' ? arg(1) : v; }
    case 'ISERROR': case 'ISERR': case 'ISNA': {
      let v; try { v = arg(0); } catch (e) { if (isErr(e)) v = e; else throw e; }
      return n.v === 'ISNA' ? isErr(v) && v.error === '#N/A' : n.v === 'ISERR' ? isErr(v) && v.error !== '#N/A' : isErr(v);
    }
    case 'ISNUMBER': { const v = arg(0); return typeof v === 'number'; }
    case 'ISTEXT': return typeof arg(0) === 'string';
    case 'ISBLANK': { const v = arg(0); return v === null || v === undefined; }
    case 'ISLOGICAL': return typeof arg(0) === 'boolean';
    case 'SEARCH': case 'FIND': {
      const find = str(0); const within = str(1); const start = num(2, 1);
      let idx;
      if (n.v === 'FIND') idx = within.indexOf(find, start - 1);
      else {
        const re = new RegExp(find.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/~\?/g, '\u0002').replace(/\*/g, '[\\s\\S]*?').replace(/\?/g, '.').replace(/\u0001/g, '\\*').replace(/\u0002/g, '\\?'), 'i');
        const m = within.slice(start - 1).match(re);
        idx = m ? m.index + start - 1 : -1;
      }
      if (idx < 0) throw ERR('#VALUE!');
      return idx + 1;
    }
    case 'LEFT': return str(0).slice(0, num(1, 1));
    case 'RIGHT': { const s = str(0); const k = num(1, 1); return k ? s.slice(-k) : ''; }
    case 'MID': return str(0).substr(num(1) - 1, num(2));
    case 'LEN': return str(0).length;
    case 'UPPER': return str(0).toUpperCase();
    case 'LOWER': return str(0).toLowerCase();
    case 'TRIM': return str(0).trim().replace(/ +/g, ' ');
    case 'EXACT': return str(0) === str(1);
    case 'CHAR': return String.fromCharCode(num(0));
    case 'CODE': return str(0).charCodeAt(0) || ERR('#VALUE!');
    case 'VALUE': { const v = toNum(arg(0)); if (isErr(v)) throw v; return v; }
    case 'CONCAT': case 'CONCATENATE': return all().map(toStr).join('');
    case 'ABS': return Math.abs(num(0));
    case 'INT': return Math.floor(num(0));
    case 'MOD': { const d = num(1); if (!d) throw ERR('#DIV/0!'); const a = num(0); return a - d * Math.floor(a / d); }
    case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
      const f = 10 ** num(1, 0); const v = num(0) * f;
      const r = n.v === 'ROUND' ? Math.sign(v) * Math.round(Math.abs(v) + 1e-9) : n.v === 'ROUNDUP' ? Math.sign(v) * Math.ceil(Math.abs(v) - 1e-9) : Math.trunc(v);
      return r / f;
    }
    case 'SUM': return nums().reduce((a, b) => a + b, 0);
    case 'MIN': { const v = nums(); return v.length ? Math.min(...v) : 0; }
    case 'MAX': { const v = nums(); return v.length ? Math.max(...v) : 0; }
    case 'AVERAGE': { const v = nums(); if (!v.length) throw ERR('#DIV/0!'); return v.reduce((a, b) => a + b, 0) / v.length; }
    case 'COUNT': return nums().length;
    case 'COUNTA': return all().filter((v) => v !== null && v !== undefined && v !== '').length;
    case 'COUNTBLANK': return all().filter((v) => v === null || v === undefined || v === '').length;
    case 'COUNTIF': { const test = criteria(arg(1)); return flat([lazy(0)], ctx).filter((v) => test(v)).length; }
    case 'SUMIF': {
      const test = criteria(arg(1)); const r = flat([lazy(0)], ctx); const s = n.args[2] ? flat([lazy(2)], ctx) : r;
      return r.reduce((t, v, i) => (test(v) && typeof s[i] === 'number' ? t + s[i] : t), 0);
    }
    case 'TODAY': { const d = ctx.now || new Date(); return Math.floor((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 25569); }
    case 'NOW': { const d = ctx.now || new Date(); return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) / 86400000) + 25569; }
    case 'DATE': return Math.floor(Date.UTC(num(0), num(1) - 1, num(2)) / 86400000) + 25569;
    case 'YEAR': case 'MONTH': case 'DAY': case 'WEEKDAY': {
      const d = new Date(Math.round((num(0) - 25569) * 86400000));
      if (n.v === 'YEAR') return d.getUTCFullYear();
      if (n.v === 'MONTH') return d.getUTCMonth() + 1;
      if (n.v === 'DAY') return d.getUTCDate();
      const t = num(1, 1); const w = d.getUTCDay();
      return t === 2 ? ((w + 6) % 7) + 1 : t === 3 ? (w + 6) % 7 : w + 1;
    }
    case 'ANCHORARRAY': return lazy(0);
    default: throw ERR('#NAME?');
  }
}

// ---- conditional formats ------------------------------------------------------------------

// The formats conditional formatting gives each cell of `sheet`:
// Map(ref → { font: {color,b,i,u,strike}, fill: {color}, numFmt }) — what Excel would show.
// book: from readBook(). Rules Excel can't be checked against cached values are skipped.
function conditionalStyles(book, sheet, { now } = {}) {
  const out = new Map();
  const cellVal = (name, row, col) => {
    const sh = !name || name === sheet.name ? sheet : book.sheet(name);
    if (!sh) throw ERR('#REF!');
    const c = sh.cells.get(`${colLetters(col)}${row}`);
    return c ? (c.t === 'e' ? ERR(c.v) : c.v) : null;
  };
  const ctx = { sheet: sheet.name, cell: cellVal, now, bounds: (name) => { const sh = !name || name === sheet.name ? sheet : book.sheet(name); return { rows: sh?.maxRow || 0, cols: sh?.maxCol || 0 }; } };
  const stopped = new Set();
  const dxfOf = (rule) => (rule.dxfId !== null && rule.dxfId !== undefined ? book.styles.dxfs[rule.dxfId] : rule.dxfXml ? dxfFromXml(rule.dxfXml, book) : null);
  const apply = (ref, dxf) => {
    if (!dxf) return;
    const cur = out.get(ref) || {};
    if (dxf.font) {
      cur.font = cur.font || {};
      for (const k of ['color', 'b', 'i', 'u', 'strike']) if (cur.font[k] === undefined && dxf.font[k] !== null && dxf.font[k] !== undefined && dxf.font[k] !== false) cur.font[k] = dxf.font[k];
    }
    if (dxf.fill && dxf.fill.color && !cur.fill) cur.fill = { color: dxf.fill.color };
    if (dxf.numFmt && !cur.numFmt) cur.numFmt = dxf.numFmt;
    if (dxf.border && !cur.border) cur.border = dxf.border;
    out.set(ref, cur);
  };
  for (const rule of sheet.cf) {
    const first = rule.ranges[0];
    if (!first) continue;
    const cells = [];
    for (const r of rule.ranges) {
      for (let row = r.top; row <= Math.min(r.bottom, Math.max(sheet.maxRow, r.top)); row++) {
        for (let col = r.left; col <= Math.min(r.right, Math.max(sheet.maxCol, r.left)); col++) cells.push({ row, col, ref: `${colLetters(col)}${row}` });
      }
    }
    const values = cells.map((c) => cellVal(null, c.row, c.col));
    const evalAt = (f, c) => evaluate(shiftFormula(f, c.row - first.top, c.col - first.left), ctx);
    const truthy = (v) => !isErr(v) && (typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : false);
    let test = null;
    const t = rule.type;
    if (t === 'expression' || ((/Text$|^beginsWith$|^endsWith$|Blanks$|Errors$|^timePeriod$/.test(t)) && rule.formulas.length)) {
      test = (c) => truthy(evalAt(rule.formulas[0], c));
    } else if (/Text$|^beginsWith$|^endsWith$/.test(t)) {
      const needle = String(rule.text || '').toLowerCase();
      test = (c, v) => { const s = toStr(v).toLowerCase(); return t === 'containsText' ? s.includes(needle) : t === 'notContainsText' ? !s.includes(needle) : t === 'beginsWith' ? s.startsWith(needle) : s.endsWith(needle); };
    } else if (t === 'containsBlanks' || t === 'notContainsBlanks') test = (c, v) => (t === 'containsBlanks') === (v === null || toStr(v).trim() === '');
    else if (t === 'containsErrors' || t === 'notContainsErrors') test = (c, v) => (t === 'containsErrors') === isErr(v);
    else if (t === 'cellIs') {
      test = (c, v) => {
        if (isErr(v)) return false;
        const a = evalAt(rule.formulas[0], c); const b = rule.formulas[1] !== undefined ? evalAt(rule.formulas[1], c) : null;
        if (isErr(a) || isErr(b)) return false;
        const d = compare(v, a);
        switch (rule.operator) {
          case 'equal': return d === 0; case 'notEqual': return d !== 0;
          case 'greaterThan': return d > 0; case 'lessThan': return d < 0;
          case 'greaterThanOrEqual': return d >= 0; case 'lessThanOrEqual': return d <= 0;
          case 'between': { const lo = compare(a, b) <= 0 ? a : b; const hi = lo === a ? b : a; return compare(v, lo) >= 0 && compare(v, hi) <= 0; }
          case 'notBetween': { const lo = compare(a, b) <= 0 ? a : b; const hi = lo === a ? b : a; return compare(v, lo) < 0 || compare(v, hi) > 0; }
          default: return false;
        }
      };
    } else if (t === 'duplicateValues' || t === 'uniqueValues') {
      const counts = new Map();
      for (const v of values) if (v !== null && v !== '' && !isErr(v)) { const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `n:${v}`; counts.set(k, (counts.get(k) || 0) + 1); }
      test = (c, v) => { if (v === null || v === '' || isErr(v)) return false; const k = typeof v === 'string' ? `s:${v.toLowerCase()}` : `n:${v}`; return (counts.get(k) > 1) === (t === 'duplicateValues'); };
    } else if (t === 'top10') {
      const nums = values.filter((v) => typeof v === 'number').sort((a, b) => b - a);
      const k = rule.percent ? Math.max(1, Math.floor(nums.length * rule.rank / 100)) : rule.rank;
      const cut = rule.bottom ? [...nums].reverse()[Math.min(k, nums.length) - 1] : nums[Math.min(k, nums.length) - 1];
      test = (c, v) => typeof v === 'number' && (rule.bottom ? v <= cut : v >= cut);
    } else if (t === 'aboveAverage') {
      const nums = values.filter((v) => typeof v === 'number');
      const avg = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
      test = (c, v) => typeof v === 'number' && (rule.aboveAverage ? v > avg : v < avg);
    } else if (t === 'colorScale' && rule.colorScale) {
      const scale = colorScaleOf(rule.colorScale, values, book);
      if (scale) cells.forEach((c, i) => { if (!stopped.has(c.ref) && typeof values[i] === 'number') { const cur = out.get(c.ref) || {}; if (!cur.fill) cur.fill = { color: scale(values[i]) }; out.set(c.ref, cur); } });
      continue;
    }
    if (!test) continue;
    const dxf = dxfOf(rule);
    cells.forEach((c, i) => {
      if (stopped.has(c.ref)) return;
      let ok = false;
      try { ok = test(c, values[i]); } catch { ok = false; }
      if (!ok) return;
      apply(c.ref, dxf);
      if (rule.stopIfTrue) stopped.add(c.ref);
    });
  }
  return out;
}
const colLetters = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

function dxfFromXml(xml, book) {
  const fake = readStyles(`<styleSheet><dxfs count="1">${xml}</dxfs></styleSheet>`, book.theme);
  return fake.dxfs[0] || null;
}

function colorScaleOf(xml, values, book) {
  const { cellColor } = require('./xlsxread');
  const nums = values.filter((v) => typeof v === 'number');
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const cfvos = [...xml.matchAll(/<cfvo\b[^>]*>/g)].map((m) => ({ type: (m[0].match(/type="([^"]+)"/) || [])[1], val: (m[0].match(/val="([^"]+)"/) || [])[1] }));
  const colors = [...xml.matchAll(/<color\b[^>]*\/?>/g)].map((m) => cellColor(m[0], book.theme) || 'FFFFFF');
  const point = (c) => {
    const v = Number(c.val);
    if (c.type === 'min') return sorted[0];
    if (c.type === 'max') return sorted[sorted.length - 1];
    if (c.type === 'percent') return sorted[0] + (sorted[sorted.length - 1] - sorted[0]) * v / 100;
    if (c.type === 'percentile') { const i = (sorted.length - 1) * v / 100; const lo = Math.floor(i); return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo); }
    return v;
  };
  const stops = cfvos.map((c, i) => ({ at: point(c), color: colors[i] }));
  const mix = (a, b, t) => [0, 2, 4].map((k) => Math.round(parseInt(a.slice(k, k + 2), 16) * (1 - t) + parseInt(b.slice(k, k + 2), 16) * t).toString(16).padStart(2, '0')).join('').toUpperCase();
  return (v) => {
    if (v <= stops[0].at) return stops[0].color;
    for (let i = 1; i < stops.length; i++) if (v <= stops[i].at) return mix(stops[i - 1].color, stops[i].color, (v - stops[i - 1].at) / ((stops[i].at - stops[i - 1].at) || 1));
    return stops[stops.length - 1].color;
  };
}

module.exports = { evaluate, parse, conditionalStyles, XlError, isErr, compare, toStr };
