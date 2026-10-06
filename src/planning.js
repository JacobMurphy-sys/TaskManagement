'use strict';
// 🏭 Production planning from the open perso work orders export (OpenPersoWorkorders_PerAx):
// one row per work order (WO) + perso job (PER) + card article (Card AX) with its quantity,
// due date, priority, status, shipping group, shipper and the shipper's cut-off time.
// Jobs (WO + PER) get a deadline — the due date at the cut-off — and are put in order
// (FIFO: by deadline; BAU: by due day, then High/Normal/Low, then cut-off). With a capacity
// (cards per hour per line × lines, working hours and days) each job's finish is projected.

const fs = require('fs');
const path = require('path');
const { readBook } = require('./xlsxread');

const COLUMNS = { wo: 'WO', per: 'PER', article: 'Card AX', qty: 'QNY', due: 'Due Out', prio: 'Prio', status: 'Status', group: 'GROUP', shipper: 'Shipper', cutoff: 'Shipping Time' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRIO_RANK = { high: 0, normal: 1, low: 2 };

// "Oct  6 2026 ", an Excel date serial, 2026-10-06 or 6/10/2026 → { y, m, d } (m 0-based), or null.
function parseDay(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const dt = new Date(Math.round((v - 25569) * 86400000));
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
  }
  const s = String(v ?? '').trim();
  let m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && MONTHS.includes(m[1].toLowerCase())) return { y: Number(m[3]), m: MONTHS.indexOf(m[1].toLowerCase()), d: Number(m[2]) };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return { y: Number(m[1]), m: Number(m[2]) - 1, d: Number(m[3]) };
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return { y: Number(m[3]), m: Number(m[2]) - 1, d: Number(m[1]) };
  return null;
}
// "16:00" → minutes after midnight (null for UNDEFINED / blank); an Excel time fraction works too.
function parseTime(v) {
  if (typeof v === 'number' && v >= 0 && v < 1) return Math.round(v * 1440);
  const m = String(v ?? '').trim().match(/^(\d{1,2})[:.](\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const iso = (day) => `${day.y}-${String(day.m + 1).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// The rows of the export (the sheet's first; headings found wherever they are).
function parse(buf) {
  const book = readBook(buf);
  const info = book.sheets[0];
  if (!info) throw new Error('The file has no sheets');
  const sh = book.sheet(info.name);
  const text = (c) => String(c?.v ?? '').trim().toLowerCase();
  let headRow = 0; const col = {};
  for (let r = 1; r <= Math.min(sh.maxRow, 30) && !headRow; r++) {
    const found = {};
    for (const c of sh.cells.values()) if (c.row === r) for (const [k, h] of Object.entries(COLUMNS)) if (!found[k] && text(c) === h.toLowerCase()) found[k] = c.col;
    if (found.wo && found.due && found.qty) { headRow = r; Object.assign(col, found); }
  }
  if (!headRow) throw new Error(`Can't find the column headings (${Object.values(COLUMNS).join(', ')}) in ${info.name}`);
  const L = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
  const lines = []; const skipped = [];
  for (let r = headRow + 1; r <= sh.maxRow; r++) {
    const g = (k) => (col[k] ? sh.cells.get(`${L(col[k])}${r}`)?.v ?? null : null);
    const wo = String(g('wo') ?? '').trim();
    if (!wo) continue;
    const day = parseDay(g('due'));
    const qty = Number(g('qty')) || 0;
    const line = {
      wo, per: String(g('per') ?? '').trim(), article: String(g('article') ?? '').trim(), qty,
      due: day ? iso(day) : null, prio: String(g('prio') ?? '').trim() || null, status: String(g('status') ?? '').trim() || null,
      group: String(g('group') ?? '').trim() || null, shipper: String(g('shipper') ?? '').trim() || null,
      cutoff: parseTime(g('cutoff')), cutoff_raw: String(g('cutoff') ?? '').trim() || null,
      customer: /^C[A-Z]{3}/.test(wo) ? wo.slice(1, 4) : null,
    };
    if (!day) skipped.push({ row: r, wo, why: `due date “${g('due') ?? ''}” not understood` });
    lines.push(line);
  }
  return { sheet: info.name, lines, skipped };
}

// Lines → jobs (WO + PER): cards summed, articles listed, deadline = due date at the cut-off
// (a job without a cut-off gets the end of the day, flagged).
function jobsOf(lines) {
  const map = new Map();
  for (const l of lines) {
    const key = `${l.wo}/${l.per}`;
    let j = map.get(key);
    if (!j) {
      j = { key, wo: l.wo, per: l.per, customer: l.customer, due: l.due, prio: l.prio, status: l.status, group: l.group, shipper: l.shipper,
        cutoff: l.cutoff, cutoff_raw: l.cutoff_raw, qty: 0, articles: [] };
      map.set(key, j);
    }
    j.qty += l.qty;
    j.articles.push({ article: l.article, qty: l.qty, status: l.status });
    if (/progress/i.test(l.status || '')) j.status = l.status; // any line running → the job is running
    if (l.cutoff !== null && (j.cutoff === null || l.cutoff < j.cutoff)) j.cutoff = l.cutoff;
    if (PRIO_RANK[String(l.prio).toLowerCase()] < (PRIO_RANK[String(j.prio).toLowerCase()] ?? 9)) j.prio = l.prio;
  }
  for (const j of map.values()) {
    j.running = /progress/i.test(j.status || '');
    j.no_cutoff = j.cutoff === null;
    j.deadline = j.due ? `${j.due}T${hhmm(j.cutoff ?? 24 * 60 - 1)}` : null;
  }
  return [...map.values()];
}

// FIFO: deadline, then WO. BAU: due day, then High/Normal/Low, then cut-off, then WO.
function order(jobs, mode = 'fifo') {
  const rank = (j) => PRIO_RANK[String(j.prio).toLowerCase()] ?? 3;
  const by = (a, b) => {
    if ((a.due || '9') !== (b.due || '9') && mode === 'bau') return (a.due || '9') < (b.due || '9') ? -1 : 1;
    if (mode === 'bau' && rank(a) !== rank(b)) return rank(a) - rank(b);
    if ((a.deadline || '9') !== (b.deadline || '9')) return (a.deadline || '9') < (b.deadline || '9') ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  return [...jobs].sort(by);
}

// Working time: days (0 = Sunday … 6 = Saturday) and hours of the day (minutes), local time.
// Walks `minutes` of production forward from `from`, through the working windows only.
function addWorking(from, minutes, cal) {
  let t = new Date(from.getTime());
  let left = minutes;
  for (let guard = 0; guard < 4000; guard++) {
    const dayStart = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, cal.start);
    const dayEnd = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, cal.end);
    if (!cal.days.includes(t.getDay()) || t >= dayEnd) { t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, cal.start); continue; }
    if (t < dayStart) t = dayStart;
    const room = (dayEnd - t) / 60000;
    if (left <= room) return new Date(t.getTime() + left * 60000);
    left -= room;
    t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 0, cal.start);
  }
  return null;
}
const localDate = (s) => { const [d, tm] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = tm.split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };

// Projects each job's finish in the given order (running jobs first), from `now`, with
// rate cards/hour per line × lines. Adds start, finish, late_minutes (vs deadline) to each.
function project(running, queue, { rate, lines = 1, start = 360, end = 1320, days = [1, 2, 3, 4, 5] }, now = new Date()) {
  const perHour = Number(rate) * Math.max(1, Number(lines) || 1);
  if (!(perHour > 0)) return false;
  const cal = { start, end, days };
  let t = now;
  for (const j of [...running, ...queue]) {
    const startAt = addWorking(t, 0, cal) || t;
    const finish = addWorking(t, (j.qty / perHour) * 60, cal);
    j.start_at = startAt.toISOString();
    j.finish_at = finish ? finish.toISOString() : null;
    j.late_minutes = finish && j.deadline ? Math.round((finish - localDate(j.deadline)) / 60000) : null;
    if (finish) t = finish;
  }
  return true;
}

// Cards due by each deadline (day + cut-off), in time order, with the running total.
function loadByDeadline(jobs) {
  const slots = new Map();
  for (const j of jobs) {
    if (!j.deadline) continue;
    const s = slots.get(j.deadline) || { deadline: j.deadline, due: j.due, cutoff: j.cutoff, jobs: 0, qty: 0, shippers: new Set(), late: 0 };
    s.jobs++; s.qty += j.qty; if (j.shipper) s.shippers.add(j.shipper);
    if (j.late_minutes > 0) s.late++;
    slots.set(j.deadline, s);
  }
  let total = 0;
  return [...slots.values()].sort((a, b) => (a.deadline < b.deadline ? -1 : 1))
    .map((s) => { total += s.qty; return { ...s, shippers: [...s.shippers], cumulative: total }; });
}

// ---- the source file: read when it changes (or uploaded once, for trying it out) --------------

let cache = null; // { key, parsed }
function readSource({ file, uploaded }) {
  const target = file || (uploaded && fs.existsSync(uploaded) ? uploaded : null);
  if (!target) return { status: 'none' };
  let stat;
  try { stat = fs.statSync(target); } catch { return { status: 'missing', file: target }; }
  const key = `${target}|${stat.mtimeMs}|${stat.size}`;
  if (!cache || cache.key !== key) {
    try { cache = { key, parsed: parse(fs.readFileSync(target)), read_at: new Date().toISOString() }; } catch (err) {
      return { status: 'error', file: target, error: err.code === 'EBUSY' ? 'the file is open and locked — try again in a moment' : err.message };
    }
  }
  return { status: 'ok', file: target, name: path.basename(target), uploaded: !file, modified: stat.mtime.toISOString(), read_at: cache.read_at, ...cache.parsed };
}

module.exports = { parse, parseDay, parseTime, jobsOf, order, project, addWorking, loadByDeadline, readSource, COLUMNS };
