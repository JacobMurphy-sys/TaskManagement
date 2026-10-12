'use strict';
// ⏱ Production actuals: the daily timing reports (perso's DailyPersoTiming, and Otto's matching
// report) — each row a job run on a machine, with its start and end — kept in prod_runs as the
// reports roll over, so the history builds up. Runs that can't be right (far too quick, far too
// long) are picked out, so they don't skew the Gantt, the load or the speeds.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { readBook } = require('./xlsxread');

const SOURCES = { perso: 'Perso', otto: 'Otto' };

// Header names each field may go by (the first found wins); compared without case, spaces or
// punctuation, so "Machine  Name" is "machine name".
const FIELDS = {
  job: ['job', 'job name', 'name', 'work order', 'wo'],
  qty: ['qty persoed', 'qty produced', 'items done', 'items produced', 'items', 'quantity', 'qty'],
  job_qty: ['job qty', 'job quantity', 'job items'],
  start_date: ['start date', 'start', 'started', 'start datetime'],
  start_time: ['start time'],
  end_date: ['end date', 'end', 'finish', 'finished', 'end datetime', 'finish date'],
  end_time: ['end time', 'finish time'],
  machine: ['machine name', 'machine'],
  station: ['machine ws name', 'workstation', 'ws name', 'station'],
  remake: ['remake'],
  mode: ['production mode', 'mode'],
  product: ['product type', 'type'],
  item: ['item axref', 'item ax ref', 'ax ref', 'card ax', 'item'],
  item_name: ['item name', 'card name'],
  customer: ['customer name', 'customer'],
  trigram: ['co ref', 'trigram'],
  due: ['due date', 'plan date'],
};
const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const pad = (n) => String(n).padStart(2, '0');
const stamp = (y, mo, d, h = 0, mi = 0, s = 0) => `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}`;

// A date, a time, or both, from an Excel serial number or text (day first, or ISO).
// → { date: [y, m, d] | null, time: [h, m, s] | null }
function partsOf(v) {
  if (v === null || v === undefined || v === '') return { date: null, time: null };
  if (typeof v === 'number' && Number.isFinite(v)) {
    const day = Math.floor(v); const secs = Math.round((v - day) * 86400);
    const time = [Math.floor(secs / 3600) % 24, Math.floor(secs / 60) % 60, secs % 60];
    if (day < 1) return { date: null, time };
    const d = new Date(Date.UTC(1899, 11, 30) + day * 86400000);
    return { date: [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()], time: v % 1 ? time : null };
  }
  if (v instanceof Date) return { date: [v.getFullYear(), v.getMonth() + 1, v.getDate()], time: [v.getHours(), v.getMinutes(), v.getSeconds()] };
  const s = String(v).trim();
  let date = null; let time = null; let m;
  if ((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) date = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/))) date = [Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1])];
  if ((m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i))) {
    let h = Number(m[1]);
    if (m[4]) { if (/pm/i.test(m[4]) && h < 12) h += 12; if (/am/i.test(m[4]) && h === 12) h = 0; }
    time = [h, Number(m[2]), Number(m[3] || 0)];
  }
  return { date, time };
}
// "YYYY-MM-DDTHH:MM:SS" (local time, as the report gives it) from a date cell and a time cell;
// either may hold the whole date-time.
function dateTime(dateV, timeV) {
  const a = partsOf(dateV); const b = partsOf(timeV);
  const date = a.date || b.date; const time = b.time || a.time || [0, 0, 0];
  return date ? stamp(...date, ...time) : null;
}
const dayOf = (v) => { const p = partsOf(v).date; return p ? stamp(...p).slice(0, 10) : null; };
// The customer from the work order, as Planning does: characters 2–4 of the job (CADXS2610… → ADX);
// else the report's own customer code (CO Ref).
const trigramOf = (job, own = null) => { const m = String(job || '').trim().match(/^[A-Z]([A-Z]{3})/i); return m ? m[1].toUpperCase() : (own ? String(own).trim().toUpperCase() || null : null); };
const yes = (v) => /^(yes|y|true|1|ja|oui)$/i.test(String(v ?? '').trim());
const intOf = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));

// The report's rows (first sheet; the header row is found among the first ten).
function parse(buf) {
  const book = readBook(buf);
  const sheetInfo = book.sheets[0];
  if (!sheetInfo) throw new Error('The file has no sheets');
  const sh = book.sheet(sheetInfo.name);
  const grid = [];
  for (const c of sh.cells.values()) (grid[c.row] ||= [])[c.col - 1] = c.v;
  let headRow = null; let col = null;
  for (let r = 1; r <= Math.min(10, grid.length - 1); r++) {
    const names = (grid[r] || []).map(norm);
    const find = (aliases) => { for (const a of aliases) { const i = names.indexOf(a); if (i >= 0) return i; } return -1; };
    const c = Object.fromEntries(Object.entries(FIELDS).map(([k, al]) => [k, find(al)]));
    if (c.job >= 0 && c.start_date >= 0) { headRow = r; col = c; break; }
  }
  if (!headRow) throw new Error(`Couldn't find the job and start columns in the first rows of "${sheetInfo.name}"`);
  if (col.machine < 0) throw new Error('No machine column');
  const at = (row, k) => (col[k] >= 0 ? row[col[k]] : null);
  const rows = []; let skipped = 0;
  for (let r = headRow + 1; r < grid.length; r++) {
    const row = grid[r];
    if (!row || !String(at(row, 'job') ?? '').trim()) continue;
    const start = dateTime(at(row, 'start_date'), at(row, 'start_time'));
    if (!start) { skipped++; continue; }
    rows.push({
      job: String(at(row, 'job')).trim(),
      machine: String(at(row, 'machine') ?? '').trim(),
      station: String(at(row, 'station') ?? '').trim() || null,
      start_at: start,
      end_at: dateTime(at(row, 'end_date'), at(row, 'end_time')),
      qty: intOf(at(row, 'qty')),
      job_qty: intOf(at(row, 'job_qty')),
      remake: yes(at(row, 'remake')) ? 1 : 0,
      mode: String(at(row, 'mode') ?? '').trim() || null,
      product: String(at(row, 'product') ?? '').trim() || null,
      item: String(at(row, 'item') ?? '').trim() || null,
      item_name: String(at(row, 'item_name') ?? '').trim() || null,
      customer: String(at(row, 'customer') ?? '').trim() || null,
      trigram: trigramOf(at(row, 'job'), at(row, 'trigram')),
      due: dayOf(at(row, 'due')),
    });
  }
  return { sheet: sheetInfo.name, rows, skipped };
}

// Adds the runs (a run seen again is updated: its end or count may have been filled in since).
function store(source, rows, file) {
  const now = new Date().toISOString();
  let added = 0; let updated = 0;
  db.tx(() => {
    for (const r of rows) {
      const had = db.get('SELECT id FROM prod_runs WHERE source = ? AND job = ? AND machine = ? AND start_at = ?', [source, r.job, r.machine, r.start_at]);
      db.run(`INSERT INTO prod_runs (source, job, machine, station, start_at, end_at, qty, job_qty, remake, mode, product, item, item_name, customer, trigram, due, file, read_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (source, job, machine, start_at) DO UPDATE SET end_at = excluded.end_at, qty = excluded.qty, job_qty = excluded.job_qty, station = excluded.station,
          remake = excluded.remake, mode = excluded.mode, product = excluded.product, item = excluded.item, item_name = excluded.item_name, customer = excluded.customer,
          trigram = excluded.trigram, due = excluded.due, file = excluded.file, read_at = excluded.read_at`,
      [source, r.job, r.machine, r.station, r.start_at, r.end_at, r.qty, r.job_qty, r.remake, r.mode, r.product, r.item, r.item_name, r.customer, r.trigram, r.due, file, now]);
      if (had) updated++; else added++;
    }
  });
  return { added, updated };
}

const seenKey = (source) => `prod_seen_${source}`;
// Reads the linked report if it changed since the last read. → { status, ... }
function readLinked(source, file, { force = false } = {}) {
  if (!file) return { source, status: 'none' };
  let stat;
  try { stat = fs.statSync(file); } catch { return { source, status: 'missing', file }; }
  const sig = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (!force && db.get('SELECT value FROM settings WHERE key = ?', [seenKey(source)])?.value === sig) return { source, status: 'unchanged', file };
  try {
    const parsed = parse(fs.readFileSync(file));
    const r = store(source, parsed.rows, path.basename(file));
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [seenKey(source), sig]);
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [`prod_read_${source}`, JSON.stringify({ at: new Date().toISOString(), file, modified: stat.mtime.toISOString(), rows: parsed.rows.length, ...r })]);
    return { source, status: 'read', file, rows: parsed.rows.length, skipped: parsed.skipped, ...r };
  } catch (err) {
    return { source, status: 'error', file, error: err.code === 'EBUSY' ? 'the file is open elsewhere and locked' : err.message };
  }
}

// ---- anomalies ---------------------------------------------------------------------------------
// What a run should take on its machine: set-up plus cards × the time a card, both learned from
// the machine's own runs (the time a card from its bigger jobs, the set-up from what's left over).
// A run is an anomaly when it's well off that — at least `ratio` times quicker or slower — and
// further out than `z` spreads (the median absolute deviation of the machine's runs, measured on
// the logarithm, so 3× quicker counts as much as 3× slower). A few rules catch the impossible.
const SENSITIVITY = { strict: { ratio: 2, z: 2.5 }, normal: { ratio: 3, z: 3.5 }, loose: { ratio: 5, z: 5 } };
const MAX_MINUTES = 24 * 60;
const minutesOf = (r) => (r.end_at ? (new Date(r.end_at) - new Date(r.start_at)) / 60000 : null);
const median = (xs) => { if (!xs.length) return null; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
function modelOf(list) {
  if (list.length < 8) return null;
  // the time a card: the median slope between pairs of runs of clearly different sizes (Theil–Sen,
  // which outliers barely move); set-up: the median of what's left. Up to 400 runs are compared.
  const pts = list.length > 400 ? list.filter((_, i) => i % Math.ceil(list.length / 400) === 0) : list;
  const slopes = [];
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
    const dq = pts[b].qty - pts[a].qty;
    if (Math.abs(dq) >= Math.max(20, 0.2 * Math.max(pts[a].qty, pts[b].qty))) slopes.push((pts[b].min - pts[a].min) / dq);
  }
  const perCard = Math.max(1e-6, slopes.length >= 10 ? median(slopes) : median(list.map((x) => x.min / x.qty)));
  const setup = Math.max(0, median(list.map((x) => x.min - x.qty * perCard)));
  const res = list.map((x) => Math.log(x.min / (setup + x.qty * perCard || 1e-6)));
  const med = median(res);
  return { perCard, setup, med, mad: Math.max(median(res.map((v) => Math.abs(v - med))), 0.05), n: list.length };
}
function baselines(runs) {
  const per = new Map(); const all = [];
  for (const r of runs) {
    const min = minutesOf(r);
    if (!(min > 0) || min > MAX_MINUTES || !(r.qty > 0)) continue;
    const x = { min, qty: r.qty };
    (per.get(r.machine) || per.set(r.machine, []).get(r.machine)).push(x); all.push(x);
  }
  const out = new Map([...per].map(([m, list]) => [m, modelOf(list)]));
  out.all = modelOf(all);
  return out;
}
const times = (r) => (r >= 10 ? Math.round(r) : Math.round(r * 10) / 10);
const fmtSec = (s) => (s >= 90 ? `${Math.round(s / 6) / 10} min` : `${Math.round(s * 10) / 10} s`);
const fmtMin = (m) => (m >= 90 ? `${Math.round(m / 6) / 10} h` : m >= 1 ? `${Math.round(m)} min` : `${Math.round(m * 60)} s`);
// Each run with minutes, seconds a card, what it should have taken, and anomaly (null or { kind, text }).
function judge(runs, base, sens = SENSITIVITY.normal) {
  return runs.map((r) => {
    const min = minutesOf(r);
    const out = { ...r, minutes: min, spc: min > 0 && r.qty > 0 ? (min * 60) / r.qty : null, usual: null, anomaly: null };
    if (!r.end_at) { out.anomaly = { kind: 'open', text: 'no end time (still running when the report was made?)' }; return out; }
    if (!(min > 0)) { out.anomaly = { kind: 'invalid', text: 'ends before it starts' }; return out; }
    if (!(r.qty > 0)) { out.anomaly = { kind: 'invalid', text: 'no cards made' }; return out; }
    if (min > MAX_MINUTES) { out.anomaly = { kind: 'slow', text: `${fmtMin(min)} — over 24 hours` }; return out; }
    const b = base.get(r.machine) || base.all;
    if (!b) return out;
    const expected = (b.setup + r.qty * b.perCard) * Math.exp(b.med);
    out.usual = { minutes: expected, spc: b.perCard * 60 };
    const x = Math.log(min / expected);
    const ratio = Math.exp(Math.abs(x));
    if (ratio < sens.ratio || (0.6745 * Math.abs(x)) / b.mad < sens.z) return out;
    const what = `${fmtMin(min)} for ${r.qty} card${r.qty === 1 ? '' : 's'}, usually about ${fmtMin(expected)}`;
    out.anomaly = x > 0 ? { kind: 'slow', text: `${times(ratio)}× slower than usual on ${r.machine} (${what})` } : { kind: 'quick', text: `${times(ratio)}× quicker than usual on ${r.machine} (${what})` };
    return out;
  });
}

// ---- load: busy time per machine per day (overlapping runs on a machine counted once) ----------
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function loadOf(runs, from, to) {
  const per = new Map(); // machine → day → { iv: [[s, e]], cards, jobs }
  for (const r of runs) {
    const s0 = new Date(r.start_at); const e0 = new Date(r.end_at);
    const s = s0 < from ? from : s0; const e = e0 > to ? to : e0;
    if (!(e > s)) continue;
    const total = e0 - s0;
    for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d < e; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      const a = s > d ? s : d; const b = e < next ? e : next;
      if (!(b > a)) continue;
      const m = per.get(r.machine) || new Map(); per.set(r.machine, m);
      const day = m.get(localDay(d)) || { iv: [], cards: 0, jobs: new Set() }; m.set(localDay(d), day);
      day.iv.push([a.getTime(), b.getTime()]);
      day.cards += total > 0 ? ((r.qty || 0) * (b - a)) / total : 0;
      day.jobs.add(r.job);
    }
  }
  const union = (iv) => { iv.sort((x, y) => x[0] - y[0]); let t = 0; let cs = null; let ce = null; for (const [a, b] of iv) { if (ce === null || a > ce) { if (ce !== null) t += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b; } if (ce !== null) t += ce - cs; return t / 60000; };
  return [...per].map(([machine, days]) => {
    const out = { machine, days: {}, busy_minutes: 0, cards: 0, jobs: 0 };
    for (const [day, v] of days) {
      const busy = union(v.iv);
      out.days[day] = { busy_minutes: Math.round(busy), cards: Math.round(v.cards), jobs: v.jobs.size };
      out.busy_minutes += busy; out.cards += v.cards; out.jobs += v.jobs.size;
    }
    out.busy_minutes = Math.round(out.busy_minutes); out.cards = Math.round(out.cards);
    return out;
  }).sort((a, b) => a.machine.localeCompare(b.machine, undefined, { numeric: true }));
}

// The picture for [from, to): runs (judged), load, totals, the anomalies.
let baseCache = null;
function view(source, from, to, { sensitivity = 'normal', withAnomalies = false } = {}) {
  const k = SENSITIVITY[sensitivity] || SENSITIVITY.normal;
  const f = stamp(from.getFullYear(), from.getMonth() + 1, from.getDate(), from.getHours(), from.getMinutes());
  const t = stamp(to.getFullYear(), to.getMonth() + 1, to.getDate(), to.getHours(), to.getMinutes());
  // the usual for each machine: its runs over the 120 days before the end of the view
  const sig = `${source}|${t.slice(0, 10)}|${JSON.stringify(db.get('SELECT count(*) AS n, max(id) AS m, max(read_at) AS r FROM prod_runs WHERE source = ?', [source]))}`;
  if (!baseCache || baseCache.sig !== sig) {
    const since = new Date(to.getTime() - 120 * 86400000);
    const bs = stamp(since.getFullYear(), since.getMonth() + 1, since.getDate());
    baseCache = { sig, base: baselines(db.all('SELECT machine, start_at, end_at, qty FROM prod_runs WHERE source = ? AND start_at >= ? AND start_at < ?', [source, bs, t])) };
  }
  const runs = judge(db.all(`SELECT * FROM prod_runs WHERE source = ? AND start_at < ? AND coalesce(end_at, start_at) > ? ORDER BY machine, start_at`, [source, t, f]), baseCache.base, k);
  const good = runs.filter((r) => !r.anomaly);
  const used = withAnomalies ? runs.filter((r) => r.anomaly?.kind !== 'open' && r.anomaly?.kind !== 'invalid') : good;
  const load = loadOf(used, from, to);
  const sum = (xs, fn) => xs.reduce((a, x) => a + (fn(x) || 0), 0);
  const range = db.get('SELECT min(start_at) AS first, max(start_at) AS last, count(*) AS n FROM prod_runs WHERE source = ?', [source]);
  let last = null; try { last = JSON.parse(db.get('SELECT value FROM settings WHERE key = ?', [`prod_read_${source}`])?.value || 'null'); } catch { /* none */ }
  return {
    source, from: f, to: t, sensitivity: Object.keys(SENSITIVITY).find((x) => SENSITIVITY[x] === k),
    history: { runs: range?.n || 0, first: range?.first || null, last: range?.last || null, last_read: last },
    machines: [...new Set([...runs.map((r) => r.machine), ...load.map((l) => l.machine)])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
    runs: runs.map((r) => ({ id: r.id, job: r.job, machine: r.machine, station: r.station, start_at: r.start_at, end_at: r.end_at, qty: r.qty, job_qty: r.job_qty, remake: !!r.remake, mode: r.mode,
      item: r.item, item_name: r.item_name, customer: r.customer, trigram: trigramOf(r.job, r.trigram), due: r.due, minutes: r.minutes, spc: r.spc, usual: r.usual, anomaly: r.anomaly })),
    load,
    totals: { runs: good.length, cards: sum(good, (r) => r.qty), jobs: new Set(good.map((r) => r.job)).size, remakes: sum(good, (r) => (r.remake ? r.qty : 0)),
      busy_minutes: sum(load, (l) => l.busy_minutes), anomalies: runs.filter((r) => r.anomaly && r.anomaly.kind !== 'open').length, open: runs.filter((r) => r.anomaly?.kind === 'open').length,
      spc: sum(good.filter((r) => r.spc), (r) => r.minutes * 60) / Math.max(1, sum(good.filter((r) => r.spc), (r) => r.qty)) || null },
  };
}

module.exports = { trigramOf, SOURCES, SENSITIVITY, parse, store, readLinked, baselines, judge, loadOf, view, dateTime, partsOf };
