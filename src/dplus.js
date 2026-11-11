'use strict';
// 📆 D+ (due out): how much notice work orders come with. Each work order's arrival — the day it first
// appeared in its export (the plan history: perso's open work orders, Matching's jobs) — against its
// due-out day (Matching: its plan date), in working days (Planning's working days): D+0 due the day it
// came in, D+1 the next working day, and so on. Counted by work order (its jobs together; perso and
// Matching apart), over a time frame of arrival days, as totals and as an average a working day; one
// bucket opened up: its customers, job sizes, shippers (Matching: machines), priorities, weekdays and
// how they went (done on time or late, how long they took).
const db = require('./db');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (iso) => ymd(new Date(iso)); // a stored time → its local day
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (n, all) => (all ? r1((n / all) * 100) : null);
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SIZES = [[1, 1, '1'], [2, 10, '2–10'], [11, 100, '11–100'], [101, 500, '101–500'], [501, 2000, '501–2,000'], [2001, Infinity, 'Over 2,000']];
const MAX_D = 5;
const SIDE = { perso: 'Perso', otto: 'Matching', disp: 'Dispatch' }; // D+5 and more together

// Working days from `from` to `to` (days): 0 the same day, 1 the next working day, -1 already past.
function workingDaysBetween(from, to, workDays) {
  if (to < from) return -1;
  let n = 0;
  for (let d = from; d < to; d = addDays(d, 1)) if (workDays.has(new Date(`${addDays(d, 1)}T12:00:00`).getDay())) n++;
  return n;
}
const bucketOf = (n) => (n < 0 ? 'past' : n >= MAX_D ? `d${MAX_D}` : `d${n}`);
const BUCKETS = [{ key: 'past', label: 'Past due', what: 'already past its due-out day when it came in' },
  ...Array.from({ length: MAX_D + 1 }, (_, i) => ({ key: `d${i}`, label: i === MAX_D ? `D+${i} or more` : `D+${i}`, what: i === 0 ? 'due out the day it came in' : i === 1 ? 'due out the next working day' : i === MAX_D ? `due out ${i} or more working days on` : `due out ${i} working days on` }))];

// The work orders that arrived while the export was being read (those already there at the first read
// have no known arrival): { source, wo, customer, via (shipper / machine), prio, arrived (day), at, due, qty, jobs, done_at, late_minutes, n, bucket }
const SOURCES = {
  perso: { reads: 'plan_history_reads', jobs: 'SELECT wo, customer, shipper AS via, prio, qty, due, first_seen, done_at, late_minutes FROM plan_history_jobs' },
  otto: { reads: 'plan_otto_reads', jobs: "SELECT coalesce(wo, key) AS wo, customer, machine AS via, prio, qty, due, first_seen, done_at, late_minutes FROM plan_otto_jobs" },
  disp: { reads: 'plan_disp_reads', jobs: "SELECT coalesce(wo, key) AS wo, customer, machine AS via, prio, qty, due, first_seen, done_at, late_minutes FROM plan_disp_jobs" },
};
// ⏱ Perso from the production report (the timing report, or 📊 DailyPersoData when linked): each job's Import Date
// is when it came in and its Due Date when it's due out, whether or not SITHUB was open that day. A work order
// that hasn't run yet isn't in the report: it comes from the plan history (first seen in the export), as before.
// Its shipper and priority come from the plan history where it's there. null: no report read.
function persoFromReport(workDays) {
  let runs = [];
  try { runs = require('./planhistory').persoRuns('2000-01-01'); } catch { return null; }
  if (!runs.length) return null;
  const since = runs.reduce((m, r) => (r.end_at < m ? r.end_at : m), runs[0].end_at).slice(0, 10); // the report's first day
  const jobs = [...require('./planhistory').jobsOfRuns(runs).values()].filter((j) => j.imported && j.due && dayOf(j.imported) >= since);
  const hist = new Map();
  try { for (const h of db.all('SELECT wo, shipper, prio, first_seen, due, qty, done_at, late_minutes, customer FROM plan_history_jobs')) { const k = String(h.wo).toUpperCase(); (hist.get(k) || hist.set(k, []).get(k)).push(h); } } catch { /* none */ }
  const byWo = new Map();
  for (const j of jobs) {
    const k = String(j.wo).toUpperCase(); const h = hist.get(k)?.[0];
    const qty = Math.max(j.job_qty || 0, j.cards || 0);
    const doneAt = j.complete ? j.last : null; const lateDays = doneAt ? workingDaysBetween(j.due, dayOf(doneAt), new Set([0, 1, 2, 3, 4, 5, 6])) : null;
    const w = byWo.get(k);
    if (!w) { byWo.set(k, { source: 'perso', wo: j.wo, customer: j.customer || h?.customer || '—', via: h?.shipper || '—', prio: h?.prio || '—', at: j.imported, due: j.due, qty, jobs: 1, done: doneAt ? [doneAt] : [], open: doneAt ? 0 : 1, late: lateDays > 0 ? [lateDays * 1440] : [], from: 'report' }); continue; }
    w.qty += qty; w.jobs++; if (j.imported < w.at) w.at = j.imported; if (j.due < w.due) w.due = j.due;
    if (doneAt) w.done.push(doneAt); else w.open++;
    if (lateDays > 0) w.late.push(lateDays * 1440);
  }
  // not run yet (not in the report): from the plan history, arrived after its first read
  const first = db.get('SELECT MIN(file_modified) AS f FROM plan_history_reads').f;
  if (first) for (const [k, hs] of hist) {
    if (byWo.has(k)) continue;
    const l = hs.filter((h) => h.first_seen > first && h.due && !h.done_at); if (!l.length) continue;
    byWo.set(k, { source: 'perso', wo: l[0].wo, customer: l[0].customer || '—', via: l[0].shipper || '—', prio: l[0].prio || '—', at: l.reduce((m, h) => (h.first_seen < m ? h.first_seen : m), l[0].first_seen),
      due: l.reduce((m, h) => (h.due < m ? h.due : m), l[0].due), qty: l.reduce((t, h) => t + (h.qty || 0), 0), jobs: l.length, done: [], open: l.length, late: [], from: 'export' });
  }
  const list = [...byWo.values()].map((w) => {
    const arrived = dayOf(w.at); const n = workingDaysBetween(arrived, w.due, workDays);
    const doneAt = !w.open && w.done.length ? w.done.sort().pop() : null;
    return { ...w, arrived, n, bucket: bucketOf(n), done_at: doneAt, late_minutes: w.late.length ? Math.max(...w.late) : doneAt ? 0 : null };
  }).sort((x, y) => (x.at < y.at ? -1 : 1));
  return { list, since, basis: 'report' };
}

function workorders(workDays, source = 'perso') {
  if (source === 'perso') { const r = persoFromReport(workDays); if (r) return r; }
  if (source === 'both') {
    const parts = ['perso', 'otto', 'disp'].map((k) => workorders(workDays, k));
    const since = parts.map((x) => x.since).filter(Boolean).sort()[0] || null;
    return { list: parts.flatMap((x) => x.list).sort((x, y) => (x.at < y.at ? -1 : 1)), since, basis: parts[0].basis === 'report' ? 'mixed' : 'export' };
  }
  const S = SOURCES[source] || SOURCES.perso;
  const first = db.get(`SELECT MIN(file_modified) AS f FROM ${S.reads}`).f;
  if (!first) return { list: [], since: null };
  const rows = db.all(`${S.jobs} WHERE first_seen > ? AND due IS NOT NULL ORDER BY first_seen`, [first]);
  const byWo = new Map();
  for (const r of rows) {
    const w = byWo.get(r.wo);
    if (!w) { byWo.set(r.wo, { source, wo: r.wo, customer: r.customer || '—', via: r.via || '—', prio: r.prio || '—', at: r.first_seen, due: r.due, qty: r.qty || 0, jobs: 1, done: r.done_at ? [r.done_at] : [], open: r.done_at ? 0 : 1, late: r.late_minutes > 0 ? [r.late_minutes] : [] }); continue; }
    w.qty += r.qty || 0; w.jobs++; if (r.first_seen < w.at) w.at = r.first_seen; if (r.due < w.due) w.due = r.due;
    if (r.done_at) w.done.push(r.done_at); else w.open++;
    if (r.late_minutes > 0) w.late.push(r.late_minutes);
  }
  const list = [...byWo.values()].map((w) => {
    const arrived = dayOf(w.at); const n = workingDaysBetween(arrived, w.due, workDays);
    const doneAt = !w.open && w.done.length ? w.done.sort().pop() : null;
    return { ...w, arrived, n, bucket: bucketOf(n), done_at: doneAt, late_minutes: w.late.length ? Math.max(...w.late) : doneAt ? 0 : null };
  });
  return { list, since: dayOf(first), basis: 'export' };
}

// a list of work orders summed: { wos, cards, jobs, avg_cards }
const sum = (l) => ({ wos: l.length, cards: l.reduce((t, w) => t + w.qty, 0), jobs: l.reduce((t, w) => t + w.jobs, 0), avg_cards: l.length ? Math.round(l.reduce((t, w) => t + w.qty, 0) / l.length) : null });
function breakdown(l, keyOf, order) {
  const m = new Map();
  for (const w of l) { const k = keyOf(w); (m.get(k) || m.set(k, []).get(k)).push(w); }
  const all = sum(l);
  const rows = [...m].map(([k, x]) => { const s = sum(x); return { label: k, ...s, wos_pct: pct(s.wos, all.wos), cards_pct: pct(s.cards, all.cards) }; });
  return order ? rows.sort((a, b) => order(a.label) - order(b.label)) : rows.sort((a, b) => b.wos - a.wos || b.cards - a.cards);
}

/**
 * opts: { from, to (arrival days, YYYY-MM-DD), bucket (one opened up, or 'all'), workDays (Set of 0–6), custNames (Map) }
 */
function profile({ from, to, bucket = null, source = 'perso', workDays = new Set([1, 2, 3, 4, 5]), custNames = new Map() } = {}) {
  source = ['perso', 'otto', 'disp', 'both'].includes(source) ? source : 'perso';
  const { list: everything, since, basis } = workorders(workDays, source);
  const okDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const today = ymd(new Date());
  const toDay = okDay(to) ? to : today;
  const fromDay = okDay(from) ? from : addDays(toDay, -27);
  const list = everything.filter((w) => w.arrived >= fromDay && w.arrived <= toDay);
  // working days in the frame (from the first read on): the days an average is over
  const countFrom = since && since > fromDay ? since : fromDay;
  let workingDays = 0; for (let d = countFrom; d <= toDay; d = addDays(d, 1)) if (workDays.has(new Date(`${d}T12:00:00`).getDay())) workingDays++;
  let allDays = 0; if (since) for (let d = since; d <= today; d = addDays(d, 1)) if (workDays.has(new Date(`${d}T12:00:00`).getDay())) allDays++;
  const total = sum(list);
  const buckets = BUCKETS.map((b) => {
    const l = list.filter((w) => w.bucket === b.key); const s = sum(l);
    const longRun = everything.filter((w) => w.bucket === b.key).length;
    return { ...b, ...s, wos_pct: pct(s.wos, total.wos), cards_pct: pct(s.cards, total.cards),
      per_day: workingDays ? r1(s.wos / workingDays) : null, cards_per_day: workingDays ? Math.round(s.cards / workingDays) : null,
      all_per_day: allDays ? r1(longRun / allDays) : null };
  }).filter((b) => b.key !== 'past' || b.wos);
  // each arrival day: work orders by bucket
  const daily = []; for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
    const l = list.filter((w) => w.arrived === d);
    if (!l.length && !workDays.has(new Date(`${d}T12:00:00`).getDay())) continue;
    daily.push({ day: d, wos: l.length, cards: l.reduce((t, w) => t + w.qty, 0), by: Object.fromEntries(BUCKETS.map((b) => [b.key, l.filter((w) => w.bucket === b.key).length])) });
  }
  let detail = null;
  if (bucket) {
    const l = bucket === 'all' ? list : list.filter((w) => w.bucket === bucket);
    const done = l.filter((w) => w.done_at);
    const late = done.filter((w) => w.late_minutes > 0);
    const hours = done.map((w) => (new Date(w.done_at) - new Date(w.at)) / 3600000);
    const name = (c) => custNames.get(String(c).toUpperCase()) || null;
    detail = { bucket, label: bucket === 'all' ? 'All work orders' : BUCKETS.find((b) => b.key === bucket)?.label, ...sum(l),
      customers: breakdown(l, (w) => w.customer).map((x) => ({ ...x, name: name(x.label) })),
      sizes: breakdown(l, (w) => SIZES.find(([lo, hi]) => w.qty >= lo && w.qty <= hi)?.[2] || '0', (k) => SIZES.findIndex((s) => s[2] === k)),
      via: breakdown(l, (w) => (source === 'both' ? `${SIDE[w.source]} · ${w.via}` : w.via)), via_label: { otto: 'Machines', disp: 'Dispatch groups', both: 'Shippers (perso), machines (Matching) and groups (Dispatch)' }[source] || 'Shippers',
      sources: source === 'both' ? breakdown(l, (w) => SIDE[w.source]) : null, prios: breakdown(l, (w) => w.prio),
      weekdays: breakdown(l, (w) => WEEKDAYS[new Date(`${w.arrived}T12:00:00`).getDay()], (k) => (WEEKDAYS.indexOf(k) + 6) % 7),
      outcome: { done: done.length, open: l.length - done.length, late: late.length, late_pct: pct(late.length, done.length), avg_late: late.length ? Math.round(late.reduce((t, w) => t + w.late_minutes, 0) / late.length) : null,
        median_hours: r1(median(hours)) },
      largest: [...l].sort((a, b) => b.qty - a.qty).slice(0, 10).map((w) => ({ source: w.source, wo: w.wo, customer: w.customer, qty: w.qty, jobs: w.jobs, arrived: w.at, due: w.due, done_at: w.done_at, late_minutes: w.late_minutes })) };
  }
  return { source, basis: basis || 'export', from: fromDay, to: toDay, since, working_days: workingDays, all_working_days: allDays, total: { ...total, per_day: workingDays ? r1(total.wos / workingDays) : null, all_per_day: allDays ? r1(everything.length / allDays) : null },
    buckets, daily, detail };
}

module.exports = { profile, workingDaysBetween, BUCKETS };
