'use strict';
// Recalculating a workbook's formulas outside Excel — enough of Excel (ranges as grids,
// element-wise maths, dynamic arrays that spill, LET, FILTER, INDEX/MATCH, XLOOKUP,
// SUMIFS/COUNTIFS…) to re-run a report sheet for different inputs. Cells are worked out
// on demand and remembered; a formula that can't be re-run (it reads another workbook,
// a table, or a function not covered here) keeps the value Excel saved.

const { parse, XlError, isErr, compare, toStr, toNum, toBool, criteria } = require('./xlformula');
const { colNum, colLetters, parseRef } = require('./xlsxread');

const ERR = (c) => new XlError(c);

// A grid of values (rows × cols); single cells come out as plain values.
class Grid {
  constructor(rows) { this.rows = rows; }
  get h() { return this.rows.length; }
  get w() { return this.rows[0] ? this.rows[0].length : 0; }
  at(r, c) { return this.rows[r]?.[c] ?? null; }
  map(fn) { return new Grid(this.rows.map((row, r) => row.map((v, c) => fn(v, r, c)))); }
  flat() { return this.rows.flat(); }
}
const isGrid = (v) => v instanceof Grid;
const isRef = (v) => v && typeof v === 'object' && v.ref;

// sheets: { name: { cells: Map(ref → { v, f, t }), maxRow, maxCol } }
// options.recalc(sheetName) → whether that sheet's formulas are re-run (others keep Excel's values)
// options.override(sheet, ref) → a value to use instead (undefined: none)
function createCalc(sheets, { recalc = () => true, override = () => undefined } = {}) {
  const memo = new Map();
  const busy = new Set();
  const frozen = new Map(); // `${sheet}!${ref}` → why the saved value was kept
  const sheetOf = (name) => sheets[name] || Object.values(sheets).find((s) => s.name?.toLowerCase() === String(name).toLowerCase()) || null;
  const keyOf = (sheet, row, col) => `${sheet}!${colLetters(col)}${row}`;
  // Cells inside a dynamic array's spill (Excel saves the range with the formula) → its anchor.
  const spillIndex = new Map();
  const spillOf = (sh) => {
    if (spillIndex.has(sh)) return spillIndex.get(sh);
    const map = new Map();
    for (const c of sh.cells.values()) {
      if (!c.f || !c.arrayRef || !/:/.test(c.arrayRef)) continue;
      const [a, b] = c.arrayRef.split(':').map(parseRef);
      for (let r = a.row; r <= b.row; r++) for (let k = a.col; k <= b.col; k++) if (r !== c.row || k !== c.col) map.set(`${colLetters(k)}${r}`, c);
    }
    spillIndex.set(sh, map);
    return map;
  };

  function formulaResult(sheet, ref, cell) {
    const k = `${sheet}!${ref}#f`;
    if (memo.has(k)) return memo.get(k);
    if (busy.has(k)) return ERR('#CIRC!');
    busy.add(k);
    let out;
    try {
      const tree = parse(cell.f);
      if (usesOtherSources(tree, sheet)) { frozen.set(`${sheet}!${ref}`, 'reads another sheet or file'); out = cell.t === 'e' ? ERR(cell.v) : cell.v; }
      else out = ev(tree, { sheet, names: {}, at: parseRef(ref) });
    } catch (e) {
      if (isErr(e)) out = e;
      else { frozen.set(`${sheet}!${ref}`, `not recalculated (${e.message})`); out = cell.t === 'e' ? ERR(cell.v) : cell.v; }
    }
    busy.delete(k);
    memo.set(k, out);
    return out;
  }
  // A formula reads only the recalculated sheets (or ones whose values are just kept)?
  const usesOtherSources = (tree, sheet) => {
    let bad = false;
    const walk = (n) => {
      if (!n || bad) return;
      if (n.k === 'ref' && n.sheet && !sheetOf(n.sheet)) bad = true;
      if (n.k === 'fn' && !FUNCS.has(n.v)) bad = true;
      for (const c of [n.l, n.r, n.e, ...(n.args || [])]) walk(c);
    };
    walk(tree);
    return bad;
  };

  // The value of one cell (formulas worked out; spilled results found from their anchor).
  function cellValue(sheetName, row, col) {
    const sh = sheetOf(sheetName);
    if (!sh) throw ERR('#REF!');
    const name = sh.name || sheetName;
    const ref = `${colLetters(col)}${row}`;
    const k = keyOf(name, row, col);
    if (memo.has(k)) return memo.get(k);
    const o = override(name, ref);
    if (o !== undefined) { memo.set(k, o); return o; }
    const cell = sh.cells.get(ref);
    let v;
    if (cell?.f && recalc(name)) {
      const res = formulaResult(name, ref, cell);
      v = isGrid(res) ? res.at(0, 0) : isRef(res) ? derefScalar(res) : res;
      if (v === null || v === undefined) v = 0; // a formula showing an empty cell shows 0
    } else if (cell?.f) v = cell.t === 'e' ? ERR(cell.v) : cell.v;
    else {
      v = cell ? (cell.t === 'e' ? ERR(cell.v) : cell.v) : null;
      const anchor = recalc(name) ? spillOf(sh).get(ref) : null;
      if (anchor) {
        const res = formulaResult(name, anchor.r, anchor);
        const g = isGrid(res) ? res : isRef(res) ? refGrid(res) : null;
        v = g ? (g.at(row - anchor.row, col - anchor.col) ?? '') : '';
        if (v === null) v = '';
      }
    }
    memo.set(k, v);
    return v;
  }
  // ---- references ---------------------------------------------------------------------------
  const rangeOf = (n, ctx) => {
    const [a, b] = n.v.split(':');
    const sheet = n.sheet || ctx.sheet;
    const sh = sheetOf(sheet);
    const maxRow = sh?.maxRow || 1; const maxCol = sh?.maxCol || 1;
    if (/^\d+$/.test(a)) return { sheet, top: Number(a), bottom: Number(b), left: 1, right: maxCol };
    if (/^[A-Z]+$/.test(a)) return { sheet, top: 1, bottom: maxRow, left: colNum(a), right: colNum(b) };
    const p = parseRef(a); const q = parseRef(b || a);
    return { sheet, top: Math.min(p.row, q.row), bottom: Math.max(p.row, q.row), left: Math.min(p.col, q.col), right: Math.max(p.col, q.col) };
  };
  // Ranges are read once per run (the values don't change while it runs): large lookup
  // tables like the forecast are read by dozens of formulas.
  const gridCache = new Map();
  const refGrid = (r) => {
    const key = `${String(r.ref.sheet).toLowerCase()}!${r.ref.top},${r.ref.left},${r.ref.bottom},${r.ref.right}`;
    const hit = gridCache.get(key);
    if (hit) return hit;
    const g = readGrid(r);
    if ((g.h * g.w) > 50) gridCache.set(key, g);
    return g;
  };
  const readGrid = (r) => {
    const sh = sheetOf(r.ref.sheet);
    const bottom = Math.min(r.ref.bottom, Math.max(sh?.maxRow || 0, r.ref.top));
    const right = Math.min(r.ref.right, Math.max(sh?.maxCol || 0, r.ref.left));
    const rows = [];
    for (let row = r.ref.top; row <= bottom; row++) { const line = []; for (let col = r.ref.left; col <= right; col++) line.push(cellValue(r.ref.sheet, row, col)); rows.push(line); }
    return new Grid(rows);
  };
  const derefScalar = (r) => cellValue(r.ref.sheet, r.ref.top, r.ref.left);
  // Anything → grid (refs read, scalars as 1×1).
  const grid = (v) => (isGrid(v) ? v : isRef(v) ? refGrid(v) : new Grid([[v]]));
  // Anything → a single value (a single-cell ref, or a 1×1 grid; else implicit intersection skipped: top-left).
  const one = (v) => { if (isRef(v)) return derefScalar(v); if (isGrid(v)) return v.at(0, 0); return v; };

  // Element-wise: grids broadcast against scalars / 1-wide / 1-high grids.
  function lift(a, b, fn) {
    if (!isGrid(a) && !isGrid(b) && !isRef(a) && !isRef(b)) return fn(a, b);
    const A = grid(a); const B = grid(b);
    const h = Math.max(A.h, B.h); const w = Math.max(A.w, B.w);
    const pick = (G, r, c) => G.at(G.h === 1 ? 0 : r, G.w === 1 ? 0 : c);
    const rows = [];
    for (let r = 0; r < h; r++) { const line = []; for (let c = 0; c < w; c++) { try { line.push(fn(pick(A, r, c), pick(B, r, c))); } catch (e) { if (isErr(e)) line.push(e); else throw e; } } rows.push(line); }
    return new Grid(rows);
  }
  const single = (single1) => (v) => (isGrid(v) || isRef(v) ? grid(v).map((x) => { try { return single1(x); } catch (e) { if (isErr(e)) return e; throw e; } }) : single1(v));

  function ifsOnce(kind, target, ranges, crits) {
    for (const k of crits) if (isErr(k)) throw k;
    const conds = ranges.map((range, j) => ({ range, test: criteria(crits[j]) }));
    const len = conds[0]?.range.length ?? target?.length ?? 0;
    let t = 0; let c = 0;
    for (let i = 0; i < len; i++) {
      if (!conds.every((k) => k.test(k.range[i] ?? null))) continue;
      c++;
      if (target && typeof target[i] === 'number') t += target[i];
    }
    if (kind === 'COUNTIFS') return c;
    if (kind === 'AVERAGEIFS') { if (!c) throw ERR('#DIV/0!'); return t / c; }
    return t;
  }

  // ---- evaluation ---------------------------------------------------------------------------
  function ev(n, ctx) {
    switch (n.k) {
      case 'lit': return n.v;
      case 'arr': return new Grid([n.v]);
      case 'ref': return { ref: rangeOf(n, ctx) };
      case 'name': {
        const key = String(n.v).replace(/^_xlpm\./i, '').toLowerCase();
        if (key in ctx.names) return ctx.names[key];
        throw ERR('#NAME?');
      }
      case 'neg': return single((x) => { const v = toNum(x); if (isErr(v)) throw v; return -v; })(ev(n.e, ctx));
      case 'pct': return single((x) => { const v = toNum(x); if (isErr(v)) throw v; return v / 100; })(ev(n.e, ctx));
      case 'bin': {
        const L = ev(n.l, ctx); const R = ev(n.r, ctx);
        const op = n.op;
        return lift(isRef(L) && single1(L) ? derefScalar(L) : L, isRef(R) && single1(R) ? derefScalar(R) : R, (l, r) => {
          if (isErr(l)) throw l; if (isErr(r)) throw r;
          if (op === '&') return toStr(l) + toStr(r);
          if (['=', '<>', '<', '>', '<=', '>='].includes(op)) { const d = compare(l, r); return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[op]; }
          const a = toNum(l); const b = toNum(r);
          if (isErr(a)) throw a; if (isErr(b)) throw b;
          if (op === '+') return a + b; if (op === '-') return a - b; if (op === '*') return a * b;
          if (op === '/') { if (b === 0) throw ERR('#DIV/0!'); return a / b; }
          if (op === '^') return a ** b;
          throw ERR('#VALUE!');
        });
      }
      case 'fn': return fn(n, ctx);
      default: throw ERR('#VALUE!');
    }
  }
  const single1 = (r) => r.ref.top === r.ref.bottom && r.ref.left === r.ref.right;

  function fn(n, ctx) {
    const raw = (i) => (n.args[i] ? ev(n.args[i], ctx) : null);
    const val = (i) => { const v = one(raw(i)); if (isErr(v)) throw v; return v; };
    const num = (i, def) => { if (!n.args[i] || (n.args[i].k === 'lit' && n.args[i].v === null)) { if (def !== undefined) return def; } const v = toNum(val(i)); if (isErr(v)) throw v; return v; };
    const values = () => n.args.flatMap((a) => { const v = ev(a, ctx); return isGrid(v) || isRef(v) ? grid(v).flat() : [v]; });
    const nums = (list) => list.filter((v) => typeof v === 'number');
    switch (n.v) {
      case 'LET': {
        const names = { ...ctx.names };
        const inner = { ...ctx, names };
        for (let i = 0; i + 1 < n.args.length; i += 2) {
          const key = String(n.args[i].v).replace(/^_xlpm\./i, '').toLowerCase();
          names[key] = ev(n.args[i + 1], inner);
        }
        return ev(n.args[n.args.length - 1], inner);
      }
      case 'IF': {
        const c = raw(0);
        if (isGrid(c) || (isRef(c) && !single1(c))) {
          const G = grid(c); const T = n.args[1] ? raw(1) : true; const F = n.args[2] ? raw(2) : false;
          return lift(lift(G, T, (a, t) => [a, t]), F, (pair, f) => { const b = toBool(pair[0]); if (isErr(b)) throw b; return b ? pair[1] : f; });
        }
        const b = toBool(one(c)); if (isErr(b)) throw b;
        return b ? (n.args[1] ? raw(1) : true) : (n.args[2] ? raw(2) : false);
      }
      case 'IFERROR': {
        let v;
        try { v = raw(0); } catch (e) { if (isErr(e)) return raw(1); throw e; }
        if (isGrid(v) || (isRef(v) && !single1(v))) { const alt = one(raw(1)); return grid(v).map((x) => (isErr(x) ? alt : x)); }
        const s = one(v);
        return isErr(s) ? raw(1) : v;
      }
      case 'AND': case 'OR': {
        const list = values().filter((v) => v !== null && v !== '' && typeof v !== 'string');
        for (const v of list) if (isErr(v)) throw v;
        const b = list.map(toBool);
        return n.v === 'AND' ? b.every(Boolean) : b.some(Boolean);
      }
      case 'NOT': { const b = toBool(val(0)); if (isErr(b)) throw b; return !b; }
      case 'ISERROR': case 'ISNA': case 'ISNUMBER': case 'ISTEXT': case 'ISBLANK': {
        let v; try { v = raw(0); } catch (e) { if (isErr(e)) v = e; else throw e; }
        const t = (x) => (n.v === 'ISERROR' ? isErr(x) : n.v === 'ISNA' ? isErr(x) && x.error === '#N/A' : n.v === 'ISNUMBER' ? typeof x === 'number' : n.v === 'ISTEXT' ? typeof x === 'string' : x === null);
        return isGrid(v) || (isRef(v) && !single1(v)) ? grid(v).map(t) : t(one(v));
      }
      case 'SEARCH': case 'FIND': return lift(raw(0), raw(1), (f, w) => {
        const i = n.v === 'FIND' ? toStr(w).indexOf(toStr(f)) : toStr(w).toLowerCase().indexOf(toStr(f).toLowerCase());
        if (i < 0) throw ERR('#VALUE!');
        return i + 1;
      });
      case 'LEFT': return single((s) => toStr(s).slice(0, num(1, 1)))(raw(0));
      case 'RIGHT': return single((s) => { const k = num(1, 1); return k ? toStr(s).slice(-k) : ''; })(raw(0));
      case 'MID': return single((s) => toStr(s).substr(num(1) - 1, num(2)))(raw(0));
      case 'LEN': return single((s) => toStr(s).length)(raw(0));
      case 'UPPER': return single((s) => toStr(s).toUpperCase())(raw(0));
      case 'LOWER': return single((s) => toStr(s).toLowerCase())(raw(0));
      case 'TRIM': return single((s) => toStr(s).trim().replace(/ +/g, ' '))(raw(0));
      case 'CHAR': return String.fromCharCode(num(0));
      case 'CONCAT': case 'CONCATENATE': return values().map(toStr).join('');
      case 'VALUE': { const v = toNum(val(0)); if (isErr(v)) throw v; return v; }
      case 'ABS': return Math.abs(num(0));
      case 'INT': return Math.floor(num(0));
      case 'ROUND': { const f = 10 ** num(1, 0); const v = num(0) * f; return (Math.sign(v) * Math.round(Math.abs(v) + 1e-9)) / f; }
      case 'MIN': { const v = nums(values()); return v.length ? Math.min(...v) : 0; }
      case 'MAX': { const v = nums(values()); return v.length ? Math.max(...v) : 0; }
      case 'SUM': { const list = values(); const e = list.find(isErr); if (e) throw e; return nums(list).reduce((a, b) => a + b, 0); }
      case 'AVERAGE': { const v = nums(values()); if (!v.length) throw ERR('#DIV/0!'); return v.reduce((a, b) => a + b, 0) / v.length; }
      case 'COUNT': return nums(values()).length;
      case 'COUNTA': return values().filter((v) => v !== null && v !== '').length;
      case 'SUMPRODUCT': {
        const gs = n.args.map((a) => grid(ev(a, ctx)));
        let t = 0;
        for (let r = 0; r < gs[0].h; r++) for (let c = 0; c < gs[0].w; c++) {
          let p = 1;
          for (const g of gs) { const v = g.at(r, c); if (isErr(v)) throw v; p *= typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : 0; }
          t += p;
        }
        return t;
      }
      case 'SUMIF': case 'COUNTIF': {
        const range = grid(raw(0)).flat(); const test = criteria(val(1));
        if (n.v === 'COUNTIF') return range.filter((v) => test(v)).length;
        const sum = n.args[2] ? grid(raw(2)).flat() : range;
        return range.reduce((t, v, i) => (test(v) && typeof sum[i] === 'number' ? t + sum[i] : t), 0);
      }
      case 'SUMIFS': case 'COUNTIFS': case 'AVERAGEIFS': {
        const start = n.v === 'COUNTIFS' ? 0 : 1;
        const target = n.v === 'COUNTIFS' ? null : grid(raw(0)).flat();
        const ranges = []; const crit = [];
        for (let i = start; i + 1 < n.args.length; i += 2) { ranges.push(grid(raw(i)).flat()); crit.push(raw(i + 1)); }
        // a list of criteria ({"ING","ING - Campaign"}) gives one result per item, as in Excel
        const many = crit.findIndex((k) => (isGrid(k) || (isRef(k) && !single1(k))) && grid(k).h * grid(k).w > 1);
        if (many >= 0) {
          const G = grid(crit[many]);
          return G.map((item) => ifsOnce(n.v, target, ranges, crit.map((k, j) => (j === many ? item : one(k)))));
        }
        return ifsOnce(n.v, target, ranges, crit.map((k) => one(k)));
      }
      case 'INDEX': {
        const G = grid(raw(0));
        const rArg = n.args[1] ? raw(1) : 0; const cArg = n.args[2] ? raw(2) : 0;
        const pick = (r, c) => {
          const rr = toNum(one(r)); const cc = toNum(one(c));
          if (isErr(rr)) throw rr; if (isErr(cc)) throw cc;
          let row = rr; let col = cc;
          if (G.h === 1 && !n.args[2]) { col = rr; row = 1; } // one row: the number picks the column
          if (row < 0 || col < 0 || row > G.h || col > G.w) throw ERR('#REF!');
          if (row === 0 && col === 0) return G;
          if (row === 0) return new Grid(G.rows.map((line) => [line[col - 1]]));
          if (col === 0) return G.w === 1 ? G.at(row - 1, 0) : new Grid([G.rows[row - 1]]);
          return G.at(row - 1, col - 1);
        };
        if (isGrid(rArg) || isGrid(cArg)) return lift(rArg, cArg, (r, c) => { const v = pick(r, c); return isGrid(v) ? v.at(0, 0) : v; });
        return pick(rArg, cArg);
      }
      case 'MATCH': {
        const want = val(0); const list = grid(raw(1)).flat(); const mode = n.args[2] ? num(2) : 1;
        if (mode === 0) { const i = list.findIndex((v) => v !== null && compare(v, want) === 0 && typeof v === typeof want); if (i < 0) throw ERR('#N/A'); return i + 1; }
        let best = -1;
        for (let i = 0; i < list.length; i++) { const v = list[i]; if (v === null) continue; const d = compare(v, want); if (mode === 1 ? d <= 0 : d >= 0) best = i; else break; }
        if (best < 0) throw ERR('#N/A');
        return best + 1;
      }
      case 'XLOOKUP': {
        const want = val(0);
        const L = grid(raw(1)); const Rt = grid(raw(2));
        const notFound = n.args[3] && !(n.args[3].k === 'lit' && n.args[3].v === null) ? raw(3) : undefined;
        const mode = n.args[4] ? num(4, 0) : 0; const search = n.args[5] ? num(5, 1) : 1;
        const vertical = L.w === 1;
        const list = L.flat();
        const order = search < 0 ? list.map((_, i) => list.length - 1 - i) : list.map((_, i) => i);
        let hit = -1;
        if (mode === 0 || mode === 2 || mode === 3) {
          const re = mode === 2 ? new RegExp(`^${toStr(want).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i') : mode === 3 ? new RegExp(toStr(want), 'i') : null;
          hit = order.find((i) => { const v = list[i]; if (v === null || v === undefined) return want === '' || want === null; return re ? re.test(toStr(v)) : compare(v, want) === 0 && (typeof v === typeof want || typeof want === 'string' && typeof v === 'string'); }) ?? -1;
        } else {
          let bestI = -1;
          for (const i of order) {
            const v = list[i]; if (v === null) continue;
            const d = compare(v, want);
            if (d === 0) { bestI = i; break; }
            if (mode === -1 && d < 0 && (bestI < 0 || compare(v, list[bestI]) > 0)) bestI = i;
            if (mode === 1 && d > 0 && (bestI < 0 || compare(v, list[bestI]) < 0)) bestI = i;
          }
          hit = bestI;
        }
        if (hit < 0 || hit === undefined) { if (notFound !== undefined) return notFound; throw ERR('#N/A'); }
        if (vertical) return Rt.w === 1 ? Rt.at(hit, 0) : new Grid([Rt.rows[hit]]);
        return Rt.h === 1 ? Rt.at(0, hit) : new Grid(Rt.rows.map((line) => [line[hit]]));
      }
      case 'FILTER': {
        const G = grid(raw(0)); const inc = grid(raw(1));
        const empty = n.args[2] ? raw(2) : undefined;
        const keepRow = inc.w === 1 && inc.h === G.h;
        const ok = (v) => { const b = toBool(v); return !isErr(b) && b; };
        const rows = keepRow ? G.rows.filter((_, r) => ok(inc.at(r, 0))) : [G.rows[0] ? G.rows.map((line) => line.filter((_, c) => ok(inc.at(0, c)))) : []].flat();
        if (!rows.length || !rows[0]?.length) { if (empty !== undefined) return empty; throw ERR('#CALC!'); }
        return new Grid(rows);
      }
      case 'SEQUENCE': {
        const r = num(0); const c = num(1, 1); const s = num(2, 1); const st = num(3, 1);
        const rows = [];
        for (let i = 0; i < r; i++) { const line = []; for (let j = 0; j < c; j++) line.push(s + (i * c + j) * st); rows.push(line); }
        return new Grid(rows);
      }
      case 'TRANSPOSE': { const G = grid(raw(0)); const rows = []; for (let c = 0; c < G.w; c++) rows.push(G.rows.map((line) => line[c])); return new Grid(rows); }
      case 'CHOOSE': { const i = num(0); if (i < 1 || i >= n.args.length) throw ERR('#VALUE!'); return raw(i); }
      case 'ANCHORARRAY': {
        const r = raw(0);
        if (!isRef(r)) return r;
        const anchor = cellRefFormula(r.ref.sheet, r.ref.top, r.ref.left);
        return anchor ?? derefScalar(r);
      }
      case 'EOMONTH': { const d = new Date(Math.round((num(0) - 25569) * 86400000)); const m = num(1); const e = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0)); return e.getTime() / 86400000 + 25569; }
      case 'YEAR': case 'MONTH': case 'DAY': { const d = new Date(Math.round((num(0) - 25569) * 86400000)); return n.v === 'YEAR' ? d.getUTCFullYear() : n.v === 'MONTH' ? d.getUTCMonth() + 1 : d.getUTCDate(); }
      case 'DATE': return Date.UTC(num(0), num(1) - 1, num(2)) / 86400000 + 25569;
      case 'TEXT': { const { formatValue } = require('./numfmt'); return formatValue(one(raw(0)), toStr(val(1))).text; }
      case 'NA': throw ERR('#N/A');
      default: throw ERR('#NAME?');
    }
  }
  // The whole spilled result of the formula at a cell (for ANCHORARRAY / A1#).
  function cellRefFormula(sheetName, row, col) {
    const sh = sheetOf(sheetName);
    const name = sh?.name || sheetName;
    const ref = `${colLetters(col)}${row}`;
    const cell = sh?.cells.get(ref);
    if (!cell?.f || !recalc(name)) return null;
    const res = formulaResult(name, ref, cell);
    return isGrid(res) ? res : isRef(res) ? refGrid(res) : null;
  }

  return {
    value: (sheet, ref) => { const p = parseRef(ref); return cellValue(sheet, p.row, p.col); },
    frozen,
  };
}

const FUNCS = new Set(['LET', 'IF', 'IFERROR', 'AND', 'OR', 'NOT', 'ISERROR', 'ISNA', 'ISNUMBER', 'ISTEXT', 'ISBLANK', 'SEARCH', 'FIND', 'LEFT', 'RIGHT', 'MID', 'LEN',
  'UPPER', 'LOWER', 'TRIM', 'CHAR', 'CONCAT', 'CONCATENATE', 'VALUE', 'ABS', 'INT', 'ROUND', 'MIN', 'MAX', 'SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'SUMPRODUCT', 'SUMIF',
  'COUNTIF', 'SUMIFS', 'COUNTIFS', 'AVERAGEIFS', 'INDEX', 'MATCH', 'XLOOKUP', 'FILTER', 'SEQUENCE', 'TRANSPOSE', 'CHOOSE', 'ANCHORARRAY', 'EOMONTH', 'YEAR', 'MONTH',
  'DAY', 'DATE', 'TEXT', 'NA']);

module.exports = { createCalc, Grid, isGrid };
