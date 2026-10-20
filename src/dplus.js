'use strict';
// 📆 D+ (due out): how much notice work orders come with. Each work order's arrival — the day it first
// appeared in the open work orders export (the plan history) — against its due-out day, in working
// days (Planning's working days): D+0 due out the day it came in, D+1 the next working day, and so on.
// Counted by work order (its jobs together), over a time frame of arrival days, as totals and as an
// average a working day; one bucket opened up: its customers, job sizes, shippers, priorities,
// weekdays and how they went (done on time or late, how long they took).
const db = require('./db');

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (iso) => ymd(new Date(iso)); // a stored time → its local day
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const pct = (n, all) => (all ? r1((n / all) * 100) : null);
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SIZES = [[1, 1, '1 card'], [2, 10, '2–10'], [11, 100, '11–100'], [101, 500, '101–500'], [501, 2000, '501–2,000'], [2001, Infinity, 'Over 2,000']];
const MAX_D = 5; // D+5 and more together

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
// have no known arrival): { wo, customer, shipper, prio, arrived (day), at, due, qty, jobs, done_at, late_minutes, n, bucket }
function workorders(workDays) {
  const first = db.get('SELECT MIN(file_modified) AS f FROM plan_history_reads').f;
  if (!first) return { list: [], since: null };
  const rows = db.all('SELECT wo, customer, shipper, prio, qty, due, first_seen, done_at, late_minutes FROM plan_history_jobs WHERE first_seen > ? AND due IS NOT NULL ORDER BY first_seen', [first]);
  const byWo = new Map();
  for (const r of rows) {
    const w = byWo.get(r.wo);
    if (!w) { byWo.set(r.wo, { wo: r.wo, customer: r.customer || '—', shipper: r.shipper || '—', prio: r.prio || '—', at: r.first_seen, due: r.due, qty: r.qty || 0, jobs: 1, done: r.done_at ? [r.done_at] : [], open: r.done_at ? 0 : 1, late: r.late_minutes > 0 ? [r.late_minutes] : [] }); continue; }
    w.qty += r.qty || 0; w.jobs++; if (r.first_seen < w.at) w.at = r.first_seen; if (r.due < w.due) w.due = r.due;
    if (r.done_at) w.done.push(r.done_at); else w.open++;
    if (r.late_minutes > 0) w.late.push(r.late_minutes);
  }
  const list = [...byWo.values()].map((w) => {
    const arrived = dayOf(w.at); const n = workingDaysBetween(arrived, w.due, workDays);
    const doneAt = !w.open && w.done.length ? w.done.sort().pop() : null;
    return { ...w, arrived, n, bucket: bucketOf(n), done_at: doneAt, late_minutes: w.late.length ? Math.max(...w.late) : doneAt ? 0 : null };
  });
  return { list, since: dayOf(first) };
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
function profile({ from, to, bucket = null, workDays = new Set([1, 2, 3, 4, 5]), custNames = new Map() } = {}) {
  const { list: everything, since } = workorders(workDays);
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
      shippers: breakdown(l, (w) => w.shipper), prios: breakdown(l, (w) => w.prio),
      weekdays: breakdown(l, (w) => WEEKDAYS[new Date(`${w.arrived}T12:00:00`).getDay()], (k) => (WEEKDAYS.indexOf(k) + 6) % 7),
      outcome: { done: done.length, open: l.length - done.length, late: late.length, late_pct: pct(late.length, done.length), avg_late: late.length ? Math.round(late.reduce((t, w) => t + w.late_minutes, 0) / late.length) : null,
        median_hours: r1(median(hours)) },
      largest: [...l].sort((a, b) => b.qty - a.qty).slice(0, 10).map((w) => ({ wo: w.wo, customer: w.customer, qty: w.qty, jobs: w.jobs, arrived: w.at, due: w.due, done_at: w.done_at, late_minutes: w.late_minutes })) };
  }
  return { from: fromDay, to: toDay, since, working_days: workingDays, all_working_days: allDays, total: { ...total, per_day: workingDays ? r1(total.wos / workingDays) : null, all_per_day: allDays ? r1(everything.length / allDays) : null },
    buckets, daily, detail };
}

module.exports = { profile, workingDaysBetween, BUCKETS };
