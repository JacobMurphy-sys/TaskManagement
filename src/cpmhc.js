'use strict';
// 👷 Headcount (📐 Capacity planning): the forecast turned into the working hours it takes and the people to do them,
// month by month, against the people there are — as the old HC Forecast sheet did, on Capacity planning's own
// forecast (with its flex and scenarios, its customers' split across DOD / Emboss / Laser and its working days).
//
//   perso hours    = Σ technologies: cards × the customer's share for it ÷ cards an hour (a person's rate)
//   matching hours = cards × its share through Matching × Σ methods (OTTO, by hand): its share for it ÷ cards an hour
//                    (the shares as Configuration › Customers, Matching picked, sets them — as CPM Monthly and Daily)
//   other work     = Σ activities: hours a working day × working days (+ one-off hours that month)
//   hours there    = (permanent + agency + temporary − long-term sick) × hours a day × working days × efficiency
//   people needed  = hours needed ÷ (hours a day × working days × efficiency)
// Kept in settings: cpm_hc (the rates, the matching split per customer, the other work, the people per month).

const db = require('./db');
const cpm = require('./cpm');
const { readBook, openZip, items, attr } = require('./xlsxread');

const PERSO = cpm.TECHS; // DOD, Emboss, Laser
const MATCH = ['OTTO', 'HMT']; // automatic matching, and by hand
const MATCH_LABEL = { OTTO: 'OTTO (machine)', HMT: 'By hand' };
const STAFF = ['perm', 'agency', 'sick']; // permanent, agency / temporary (one: in practice the same), long-term sick
const DEFAULT = { rates: {}, day_hours: 7.5, efficiency: 0.9, match_default: { OTTO: 1, HMT: 0 }, match: {}, other: [], extra: {}, staff: {} };
const kv = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value;
const setKv = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
const json = (s, d) => { try { const v = JSON.parse(s || ''); return v ?? d; } catch { return d; } };
const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });

// a month's people: agency and temporary were kept apart once — now one (added together)
const oneAgency = (r) => (r && 'temp' in r ? (({ temp, ...x }) => ({ ...x, agency: (Number(x.agency) || 0) + (Number(temp) || 0) }))(r) : r);
const config = () => { const c = { ...DEFAULT, ...json(kv('cpm_hc'), {}) }; c.staff = Object.fromEntries(Object.entries(c.staff || {}).map(([m, r]) => [m, oneAgency(r)])); return c; };

// the set-up, checked and tidied: only what's given changes
function save(body = {}) {
  const c = config();
  if (body.rates) for (const k of [...PERSO, ...MATCH]) if (k in body.rates) { const v = num(body.rates[k]); if (v !== null && v <= 0) throw err400(`${k}: cards an hour must be more than 0`); c.rates[k] = v; }
  if ('day_hours' in body) { const v = num(body.day_hours); if (!(v > 0 && v <= 24)) throw err400('Hours a day: between 0 and 24'); c.day_hours = v; }
  if ('efficiency' in body) { let v = num(body.efficiency); if (v > 1) v /= 100; if (!(v > 0 && v <= 1)) throw err400('Efficiency: between 1% and 100%'); c.efficiency = v; }
  const matchOf = (x) => { let o = num(x?.OTTO); if (o === null) return null; if (o > 1) o /= 100; if (o < 0 || o > 1) throw err400('A matching split is between 0% and 100%'); return { OTTO: o, HMT: 1 - o }; };
  if (body.match_default) c.match_default = matchOf(body.match_default) || DEFAULT.match_default;
  if (body.match) for (const [k, v] of Object.entries(body.match)) { const m = v === null ? null : matchOf(v); if (m) c.match[k] = m; else delete c.match[k]; }
  if (body.other) {
    if (!Array.isArray(body.other)) throw err400('Other work is a list');
    c.other = body.other.map((x) => ({ name: String(x.name || '').trim().slice(0, 80), per_day: num(x.per_day) })).filter((x) => x.name || x.per_day)
      .map((x) => { if (!x.name) throw err400('Each piece of other work needs a name'); if (!(x.per_day >= 0)) throw err400(`${x.name}: hours a working day`); return x; });
  }
  if (body.extra) for (const [m, v] of Object.entries(body.extra)) { if (!/^\d{4}-\d{2}$/.test(m)) continue; const h = num(v); if (h) c.extra[m] = h; else delete c.extra[m]; }
  if (body.staff) for (const [m, v] of Object.entries(body.staff)) {
    if (!/^\d{4}-\d{2}$/.test(m)) continue;
    if (v === null) { delete c.staff[m]; continue; }
    const row = {}; const w = oneAgency(v); for (const k of STAFF) { const n = num(w[k]); if (n !== null && n < 0) throw err400('People can\'t be fewer than 0'); row[k] = n ?? 0; }
    c.staff[m] = row;
  }
  setKv('cpm_hc', JSON.stringify(c));
  return c;
}

// the people of a month: as set for it, else as last set before it (set once, it carries on)
function staffAt(c, month) {
  if (c.staff[month]) return { ...c.staff[month], set: true };
  const before = Object.keys(c.staff).filter((m) => m < month).sort().pop();
  return before ? { ...c.staff[before], set: false, from: before } : null;
}

/**
 * A year's headcount by month, on Capacity planning's forecast (flex and a scenario's changes as compute() takes them).
 */
function headcount({ year, changes = [], useFlex = true, cards = null }) {
  const c = config();
  const plan = cpm.compute({ year, period: 'month', changes, useFlex, cards });
  const warnings = [];
  // each technology's rate: set here, else Production's machine speed (said: a person's rate is usually not a machine's)
  const rate = {}; const rateFrom = {};
  for (const t of PERSO) { if (c.rates[t] > 0) { rate[t] = c.rates[t]; rateFrom[t] = 'set'; } else if (plan.speeds?.[t] > 0) { rate[t] = plan.speeds[t]; rateFrom[t] = 'production'; } else rateFrom[t] = null; }
  for (const k of MATCH) { if (c.rates[k] > 0) { rate[k] = c.rates[k]; rateFrom[k] = 'set'; } else rateFrom[k] = null; }
  const noRate = PERSO.filter((t) => !rate[t]); if (noRate.length) warnings.push(`No cards an hour for ${noRate.join(', ')} — set it under Rates, or its hours aren't counted`);
  if (PERSO.some((t) => rateFrom[t] === 'production')) warnings.push(`${PERSO.filter((t) => rateFrom[t] === 'production').join(', ')}: Production's machine speed is used as the cards an hour — set a person's rate under Rates`);
  // customers: Capacity planning's detail (each customer and technology, with its cards, split per month)
  const byCust = new Map();
  for (const D of plan.detail) {
    const key = D.trigram || D.name; const C = byCust.get(key) || byCust.set(key, { key, trigram: D.trigram || null, name: D.name, months: {} }).get(key);
    for (const [m, x] of Object.entries(D.months)) { const M = C.months[m] || (C.months[m] = { cards: x.fc, raw: x.raw, split: {} }); M.split[D.tech] = (M.split[D.tech] || 0) + x.split; }
  }
  // its Matching: as Configuration › Customers (Matching picked) has it — the share of its cards through Matching and of
  // those the part by hand (typed there, else learned; kept to OTTO / hand match there counts) — so changing it there
  // changes the hours here. (The split once typed on this tab, or read from the HC Forecast workbook, isn't used.)
  let MS = null; try { MS = require('./cpmmatch').matchShares(); } catch (e) { warnings.push(`Matching's shares couldn't be read (${e.message}) — all cards counted on OTTO`); }
  const msMemo = new Map();
  const shareOf = (C) => { const k = C.trigram || C.key; if (!msMemo.has(k)) msMemo.set(k, MS ? MS.of(C.trigram || '') : { ratio: 1, ratio_from: 'none', hand: 0, hand_from: 'none' }); return msMemo.get(k); };
  const matchOf = (C) => { const s = shareOf(C); return { OTTO: s.ratio * (1 - s.hand), HMT: s.ratio * s.hand }; };
  const missMatch = MATCH.filter((k) => !rate[k] && [...byCust.values()].some((C) => (matchOf(C)[k] || 0) > 0));
  if (missMatch.length) warnings.push(`No cards an hour for matching ${missMatch.map((k) => MATCH_LABEL[k]).join(' and ')} — set it under Rates, or matching isn't counted`);
  const customers = [...byCust.values()].map((C) => {
    const mx = matchOf(C);
    const hours = Array(12).fill(0); const cardsBy = Array(12).fill(0);
    const by = Object.fromEntries([...PERSO, ...MATCH].map((k) => [k, Array(12).fill(0)])); // its hours by technology and matching method
    for (let m = 1; m <= 12; m++) {
      const M = C.months[m]; if (!M) continue;
      const share = Object.values(M.split).reduce((a, b) => a + b, 0); const q = M.cards * share;
      let h = 0; for (const [t, s] of Object.entries(M.split)) if (rate[t]) { const x = (M.cards * s) / rate[t]; h += x; if (by[t]) by[t][m - 1] += x; }
      for (const k of MATCH) if (rate[k] && mx[k]) { const x = (q * mx[k]) / rate[k]; h += x; by[k][m - 1] += x; }
      hours[m - 1] = h; cardsBy[m - 1] = q;
    }
    const sh = shareOf(C);
    return { key: C.key, trigram: C.trigram, name: C.name, match: mx, match_ratio: sh.ratio, match_ratio_from: sh.ratio_from, match_hand: sh.hand, match_hand_from: sh.hand_from, match_forced: sh.forced || null, hours, cards: cardsBy, by, total: hours.reduce((a, b) => a + b, 0) };
  }).filter((x) => x.total > 0 || x.cards.some((q) => q > 0)).sort((a, b) => b.total - a.total);
  const otherPerDay = c.other.reduce((a, x) => a + (x.per_day || 0), 0);
  const months = plan.periods.map((P, i) => {
    const m = i + 1; const month = P.key; const wd = P.workdays;
    const perso = Object.fromEntries(PERSO.map((t) => [t, 0])); const match = Object.fromEntries(MATCH.map((k) => [k, 0])); let cardsM = 0;
    for (const C of byCust.values()) {
      const M = C.months[m]; if (!M) continue; const mx = matchOf(C);
      for (const [t, s] of Object.entries(M.split)) { if (perso[t] !== undefined && rate[t]) perso[t] += (M.cards * s) / rate[t]; cardsM += M.cards * s; }
      const q = M.cards * Object.values(M.split).reduce((a, b) => a + b, 0);
      for (const k of MATCH) if (rate[k] && mx[k]) match[k] += (q * mx[k]) / rate[k];
    }
    const core = Object.values(perso).reduce((a, b) => a + b, 0) + Object.values(match).reduce((a, b) => a + b, 0);
    const other = c.other.map((x) => ({ name: x.name, hours: (x.per_day || 0) * wd }));
    const extra = c.extra[month] || 0;
    const otherTotal = otherPerDay * wd + extra;
    const total = core + otherTotal;
    const st = staffAt(c, month);
    const heads = st ? (st.perm || 0) + (st.agency || 0) - (st.sick || 0) : null;
    const perHead = c.day_hours * wd * c.efficiency;
    const avail = heads === null ? null : heads * perHead;
    const fte = perHead ? total / perHead : null;
    return { month, label: P.label, workdays: wd, cards: cardsM, perso, match, core, other, extra, other_total: otherTotal, total, staff: st, heads, per_head: perHead, available: avail,
      fte_needed: fte, gap_hours: avail === null ? null : avail - total, gap_fte: heads === null || fte === null ? null : heads - fte };
  });
  if (!Object.keys(c.staff).length) warnings.push('No people set yet — fill in People per month to see the hours there against the hours needed');
  return { year, months, customers, config: c, rates: rate, rate_from: rateFrom, techs: PERSO, methods: MATCH, method_labels: MATCH_LABEL,
    forecast_as_of: plan.forecast_as_of, unmapped_qty: plan.unmapped_qty, flex: plan.flex ? { overall: plan.flex.overall } : null, warnings: [...new Set([...warnings, ...plan.warnings.filter((w) => /forecast|split/i.test(w))])] };
}

// ---- 📥 the old HC Forecast workbook: its rates, matching split, other work and people, read once ---------------
// The sheet with "HEADCOUNT" / "WORKING HOURS REQUIRED" in it; its months across row 1 from column D (Jan…Dec), the
// year in the cell after Dec, the working days in row 2. The rates and splits it looked up in the old SITHUB
// workbook's HCForecastReferences sheet are read from the copy Excel keeps of linked values.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function parseWorkbook(buf, { names = new Map() } = {}) {
  const book = readBook(buf);
  const info = book.sheets.find((s) => { const sh = book.sheet(s.name); return [...sh.cells.values()].some((x) => typeof x.v === 'string' && /^(headcount|working hours required)$/i.test(x.v.trim())); });
  if (!info) throw err400('This isn\'t an HC Forecast workbook (no HEADCOUNT section found)');
  const sh = book.sheet(info.name);
  const cell = (r) => sh.cells.get(r);
  const val = (r) => cell(r)?.v;
  // the month columns: row 1's Jan…Dec
  const cols = []; let yearCol = null;
  for (const x of sh.cells.values()) { if (x.row !== 1 || typeof x.v !== 'string') continue; const i = MONTHS.findIndex((mm) => x.v.trim().toLowerCase().startsWith(mm)); if (i >= 0) cols[i] = x.col; }
  if (cols.filter(Boolean).length < 12) throw err400('Couldn\'t find the months Jan…Dec across the first row');
  for (const x of sh.cells.values()) if (x.row === 1 && x.col > cols[11] && Number(x.v) > 2000 && Number(x.v) < 2100) yearCol = Number(x.v);
  const year = yearCol || new Date().getFullYear();
  const L = (col) => { let s = ''; let n = col; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const days = cols.map((col) => Number(val(`${L(col)}2`)) || 0);
  const rowOf = (re, from = 1) => { let best = null; for (const x of sh.cells.values()) if (x.row >= from && x.col <= 3 && typeof x.v === 'string' && re.test(x.v.trim()) && (best === null || x.row < best)) best = x.row; return best; };
  const out = { year, other: [], extra: {}, staff: {}, rates: {}, match: {}, day_hours: null, efficiency: null, unknown: [] };
  // other work: the rows under "OTHER SERVICES" in the hours part, up to its total — hours a working day from the cached values
  const hoursTop = rowOf(/^working hours required$/i) || 1;
  const oStart = rowOf(/^other services$/i, hoursTop + 1); const oEnd = rowOf(/^other services total$/i, (oStart || 0) + 1);
  if (oStart && oEnd) for (let r = oStart + 1; r < oEnd; r++) {
    const name = String(val(`C${r}`) ?? val(`A${r}`) ?? '').trim(); if (!name) continue;
    const hrs = cols.map((col) => Number(val(`${L(col)}${r}`)) || 0);
    const per = hrs.map((h, i) => (days[i] ? h / days[i] : null)).filter((x) => x !== null);
    const perDay = per.length ? per.reduce((a, b) => a + b, 0) / per.length : 0;
    // the same each working day: hours a day; else (a campaign, some months only) one-off hours in its months
    const steady = per.length && Math.max(...per) - Math.min(...per) <= Math.max(0.01, perDay * 0.01);
    if (steady) out.other.push({ name, per_day: Math.round(perDay * 100) / 100 });
    else hrs.forEach((h, i) => { if (h) { const k = `${year}-${String(i + 1).padStart(2, '0')}`; out.extra[k] = Math.round(((out.extra[k] || 0) + h) * 10) / 10; } });
  }
  out.other = out.other.filter((x) => x.per_day > 0);
  // people per month
  const rows = { perm: rowOf(/^direct permanent$/i), agency: rowOf(/^direct agency$/i), temp: rowOf(/^direct temporary$/i), sick: rowOf(/^long\s*-?\s*time sick|^long-?term sick/i) };
  // (its agency and temporary rows added together: one, agency / temporary)
  if (Object.values(rows).some(Boolean)) cols.forEach((col, i) => { const n = (k) => (rows[k] ? Number(val(`${L(col)}${rows[k]}`)) || 0 : 0); out.staff[`${year}-${String(i + 1).padStart(2, '0')}`] = { perm: n('perm'), agency: n('agency') + n('temp'), sick: n('sick') }; });
  // hours a day and efficiency, from the gross available hours formula: (…)*7.5*D2*0.9
  const gross = rowOf(/^gross available hours$/i);
  const f = gross ? String(cell(`${L(cols[0])}${gross}`)?.f || '') : '';
  const m = f.match(/\*\s*([\d.]+)\s*\*\s*[A-Z]+\$?2\s*\*\s*([\d.]+)/i); if (m) { out.day_hours = Number(m[1]); out.efficiency = Number(m[2]); }
  // the rates and matching split it looked up: the linked HCForecastReferences sheet, as Excel last saw it
  const z = book.zip || openZip(buf);
  const colN = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  for (const name of z.names || []) {
    if (!/^xl\/externalLinks\/externalLink\d+\.xml$/.test(name)) continue;
    const x = z.text(name); const sheetNames = items(x, 'sheetName').map((s) => attr(s, 'val'));
    const idx = sheetNames.findIndex((s) => /hcforecastreferences/i.test(s)); if (idx < 0) continue;
    const sd = x.match(new RegExp(`<sheetData sheetId="${idx}"[^>]*>([\\s\\S]*?)</sheetData>`)); if (!sd) continue;
    const ref = new Map(); // 'col|row' → value
    for (const [, c0, r0, v] of sd[1].matchAll(/<cell r="([A-Z]+)(\d+)"[^>]*>\s*<v>([^<]*)<\/v>/g)) ref.set(`${colN(c0)}|${r0}`, v);
    const at = (col, row) => ref.get(`${col}|${row}`);
    const CODE = { DOD: 'DOD', EMB: 'Emboss', LAS: 'Laser', OTTO: 'OTTO', HMT: 'HMT' };
    // the customer table: "Customer" in row 1, its method headings in the columns right after it
    let custCol = null; for (const [k, v] of ref) { const [c0, r0] = k.split('|'); if (r0 === '1' && /^customer$/i.test(v.trim())) custCol = Number(c0); }
    const head = {}; const headCols = new Set();
    if (custCol) for (let cc = custCol + 1; at(cc, 1) && CODE[at(cc, 1).trim().toUpperCase()]; cc++) { head[at(cc, 1).trim().toUpperCase()] = cc; headCols.add(cc); }
    // the rates: a method's code with its cards an hour in the next column (outside the customer table)
    for (const [k, v] of ref) {
      const [c0, r0] = k.split('|').map(Number); const code = v.trim().toUpperCase();
      if (!CODE[code] || headCols.has(c0)) continue;
      const sp = Number(at(c0 + 1, r0)); if (sp > 0) out.rates[CODE[code]] = sp;
    }
    if (custCol && (head.OTTO || head.HMT)) for (const [k, v] of ref) {
      const [c0, r0] = k.split('|').map(Number); if (c0 !== custCol || r0 === 1) continue;
      const o = Number(at(head.OTTO, r0)) || 0; const hh = Number(at(head.HMT, r0)) || 0; if (!(o + hh > 0)) continue;
      const tri = names.get(v.trim().toLowerCase()); const key = tri || v.trim();
      if (!tri) out.unknown.push(v.trim());
      out.match[key] = { OTTO: o / (o + hh) };
    }
  }
  return out;
}

module.exports = { config, save, headcount, parseWorkbook, staffAt, PERSO, MATCH, STAFF };
