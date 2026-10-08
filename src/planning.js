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

// ---- Otto: the other half of production, from its own export -----------------------------
// One row per Otto job: Name (starts with the perso work order, e.g. CADXS26010101MAT0001 →
// CADXS26010101; customer = characters 2–4), Prod. Status, Items, Plan Date (+ PlanTime) …
const OTTO_COLUMNS = { name: 'Name', status: 'Prod. Status', qty: 'Items', due: 'Plan Date', time: 'PlanTime', prio: 'Priority', done: 'Is Done', test: 'Is Test',
  machine: 'Machine', customer_name: 'Customer', sub_customer: 'Sub Customer', group: 'Plan Group', start: 'Start Date', end: 'End Date', comment: 'Comment' };
const truthy = (v) => v === true || /^(true|yes|ja|1|x)$/i.test(String(v ?? '').trim());
// The work order a Name starts with: C + customer + site letter + 8 digits, else its first 12 characters.
const woOfName = (name) => (name.match(/^[A-Z]{5}\d{8}/i)?.[0] || name.slice(0, 12)).toUpperCase();
const OTTO_DONE = /finish|done|complete|closed|shipped/i;
function parseOtto(buf) {
  const book = readBook(buf);
  const info = book.sheets[0];
  if (!info) throw new Error('The file has no sheets');
  const sh = book.sheet(info.name);
  const text = (c) => String(c?.v ?? '').trim().toLowerCase();
  let headRow = 0; const col = {};
  for (let r = 1; r <= Math.min(sh.maxRow, 30) && !headRow; r++) {
    const found = {};
    for (const c of sh.cells.values()) if (c.row === r) for (const [k, h] of Object.entries(OTTO_COLUMNS)) if (!found[k] && text(c) === h.toLowerCase()) found[k] = c.col;
    if (found.name && found.qty && found.due) { headRow = r; Object.assign(col, found); }
  }
  if (!headRow) throw new Error(`Can't find the Otto column headings (Name, Items, Plan Date) in ${info.name}`);
  const L = (n) => { let t = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) t = String.fromCharCode(65 + ((n - 1) % 26)) + t; return t; };
  const jobs = []; const skipped = [];
  for (let r = headRow + 1; r <= sh.maxRow; r++) {
    const g = (k) => (col[k] ? sh.cells.get(`${L(col[k])}${r}`)?.v ?? null : null);
    const name = String(g('name') ?? '').trim();
    if (!name) continue;
    const day = parseDay(g('due'));
    let time = parseTime(g('time'));
    if (time !== null && time > 23 * 60 + 59) time = 23 * 60 + 59;
    const status = String(g('status') ?? '').trim() || null;
    const job = {
      key: name, name, wo: woOfName(name), customer: name.length >= 4 ? name.slice(1, 4).toUpperCase() : null,
      qty: Number(g('qty')) || 0, due: day ? iso(day) : null, time, status, prio: String(g('prio') ?? '').trim() || null,
      done: truthy(g('done')) || OTTO_DONE.test(status || ''), test: truthy(g('test')),
      machine: String(g('machine') ?? '').trim() || null, customer_name: String(g('customer_name') ?? '').trim() || null,
      sub_customer: String(g('sub_customer') ?? '').trim() || null, group: String(g('group') ?? '').trim() || null,
      comment: String(g('comment') ?? '').trim() || null,
    };
    const endDay = parseDay(g('end'));
    job.end_date = endDay ? iso(endDay) : null; // when a finished job was finished
    job.running = !job.done && /progress|started|running|busy/i.test(status || '');
    job.deadline = job.due ? `${job.due}T${hhmm(time ?? 24 * 60 - 1)}` : null;
    if (!day) skipped.push({ row: r, wo: name, why: `plan date “${g('due') ?? ''}” not understood` });
    jobs.push(job);
  }
  return { sheet: info.name, jobs, skipped };
}
// Otto first by plan date and time, then Urgent / High before the rest, then name.
const OTTO_PRIO = (p) => (/urgent/i.test(p || '') ? 0 : /high/i.test(p || '') ? 1 : /low/i.test(p || '') ? 3 : 2);
function orderOtto(jobs) {
  return [...jobs].sort((a, b) => ((a.deadline || '9') !== (b.deadline || '9') ? ((a.deadline || '9') < (b.deadline || '9') ? -1 : 1)
    : OTTO_PRIO(a.prio) - OTTO_PRIO(b.prio) || a.name.localeCompare(b.name)));
}
// Perso jobs ↔ Otto jobs by work order: each Otto job lists the perso jobs still open for its WO
// (and when the last is projected to finish); each perso job lists its WO's Otto jobs.
function linkOtto(persoJobs, ottoJobs) {
  const byWo = new Map();
  for (const j of persoJobs) { const k = String(j.wo).toUpperCase(); if (!byWo.has(k)) byWo.set(k, []); byWo.get(k).push(j); }
  const ottoByWo = new Map();
  for (const o of ottoJobs) { if (!ottoByWo.has(o.wo)) ottoByWo.set(o.wo, []); ottoByWo.get(o.wo).push(o); }
  for (const o of ottoJobs) {
    const ps = byWo.get(o.wo) || [];
    o.perso = ps.map((j) => ({ key: j.key, qty: j.qty, status: j.status, finish_at: j.finish_at || null, deadline: j.deadline }));
    o.perso_open = ps.length > 0;
    const fins = ps.map((j) => j.finish_at).filter(Boolean).sort();
    o.perso_finish_at = ps.length && fins.length === ps.length ? fins[fins.length - 1] : null;
  }
  for (const j of persoJobs) j.otto = (ottoByWo.get(String(j.wo).toUpperCase()) || []).map((o) => ({ name: o.name, due: o.due, deadline: o.deadline, status: o.status, qty: o.qty, done: o.done }));
}

// Otto machines: name, items per hour, and optionally the text that identifies it in the export's
// Machine column (e.g. "HMT PC#1"). Speed per customer (trigram) wins over the machine's own.
const ottoMatches = (m, job) => {
  const key = String(m.match || '').trim().toLowerCase();
  return !!key && String(job.machine || '').toLowerCase().includes(key);
};
// Plans each Otto job, in the list's order (running first), on the running machine where it can
// start first — never before its perso work order is projected to be done. A job whose Machine
// in the export names one of the machines goes on that one. Adds machine, start, finish, late.
function projectOtto(running, queue, machines, speeds, { start = 360, end = 1320, days = [1, 2, 3, 4, 5] }, now = new Date()) {
  const active = machines.filter((m) => m.active !== 0 && m.active !== false);
  if (!active.length) return false;
  const cal = { start, end, days };
  const free = new Map(active.map((m) => [m.id, now]));
  const bySpeed = new Map(speeds.map((r) => [String(r.customer).toUpperCase(), Number(r.speed)]));
  const load = new Map(active.map((m) => [m.id, { id: m.id, name: m.name, items: 0, jobs: 0, minutes: 0, until: null, days: {} }]));
  for (const j of [...running, ...queue]) {
    Object.assign(j, { machine_planned: null, start_at: null, finish_at: null, late_minutes: null, plan_minutes: null, unplanned: null, speed: null, waited_perso: false });
    const named = active.filter((m) => ottoMatches(m, j));
    const able = named.length ? named : active;
    // perso still open: not before its projected finish (now when it isn't projected)
    const release = j.perso_finish_at ? new Date(j.perso_finish_at) : now;
    let best = null;
    for (const m of able) {
      const speed = bySpeed.get(String(j.customer || '').toUpperCase()) ?? (Number(m.speed) > 0 ? Number(m.speed) : null);
      if (!speed) continue;
      const from = free.get(m.id) > release ? free.get(m.id) : release;
      const s = addWorking(from, 0, cal);
      const minutes = (j.qty / speed) * 60;
      const f = addWorking(from, minutes, cal);
      if (!s || !f) continue;
      if (!best || f < best.f) best = { m, s, f, minutes, speed, waited: release > now && release > free.get(m.id) };
    }
    if (!best) {
      j.unplanned = able.some((m) => bySpeed.has(String(j.customer || '').toUpperCase()) || Number(m.speed) > 0) ? 'time' : 'speed';
      continue;
    }
    free.set(best.m.id, best.f);
    j.machine_planned = best.m.name; j.speed = best.speed; j.plan_minutes = best.minutes;
    j.waited_perso = best.waited; // its start is held by the perso work
    j.start_at = best.s.toISOString(); j.finish_at = best.f.toISOString();
    j.late_minutes = j.deadline ? Math.round((best.f - localDate(j.deadline)) / 60000) : null;
    const l = load.get(best.m.id); l.items += j.qty; l.jobs++; l.minutes += best.minutes; l.until = j.finish_at;
    for (const [day, min] of Object.entries(minutesByDay(best.s, best.f, cal))) {
      const d = l.days[day] || (l.days[day] = { minutes: 0, items: 0 });
      d.minutes += min; d.items += best.minutes ? (j.qty * min) / best.minutes : 0;
    }
  }
  return [...load.values()];
}

// ---- 🛟 mitigation: as many jobs on time as possible ---------------------------------------
// Jobs not yet overdue and due within the horizon (e.g. 5 working days) that can still make their
// deadline go first (by deadline); those already overdue — and, with a capacity, those that would
// be late even so — go after, oldest deadline first; jobs due beyond the horizon come last. Which
// can't be saved is found as Moore–Hodgson does: work through by deadline and, whenever one would
// finish late, set aside the longest job so far — the fewest jobs late. Pinned jobs stay first.
// project(running, queue) runs the plan (adding finish / late_minutes) and says if it could.
// The date `n` working days after `from` (days: 0 = Sunday … 6 = Saturday), as YYYY-MM-DD.
function workingDaysAhead(from, n, days = [1, 2, 3, 4, 5]) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let left = n; left > 0;) { d.setDate(d.getDate() + 1); if (!days.length || days.includes(d.getDay())) left--; }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mitigate(running, queue, { project = null, now = new Date(), horizon = null, maxRounds = 400 } = {}) {
  const pinned = queue.filter((j) => j.pinned);
  const rest = queue.filter((j) => !j.pinned);
  const overdue = rest.filter((j) => j.deadline && localDate(j.deadline) <= now);
  // beyond the horizon (due date after it): after the overdue
  const beyond = (j) => { const d = j.due || j.deadline?.slice(0, 10); return !!(horizon && d && d > horizon); };
  const later = rest.filter((j) => !overdue.includes(j) && beyond(j));
  let saveable = rest.filter((j) => !overdue.includes(j) && !beyond(j)); // in deadline order already (FIFO)
  const setAside = [];
  if (project) {
    for (let round = 0; round < maxRounds; round++) {
      if (!project(running, [...pinned, ...saveable])) break;
      const first = saveable.findIndex((j) => j.late_minutes > 0);
      if (first < 0) break;
      // the longest job up to the first late one makes room for the most others
      let worst = 0;
      for (let i = 1; i <= first; i++) if ((saveable[i].plan_minutes || 0) > (saveable[worst].plan_minutes || 0)) worst = i;
      setAside.push(saveable[worst]);
      saveable = saveable.filter((_, i) => i !== worst);
    }
  }
  const byDeadline = (a, b) => ((a.deadline || '9') < (b.deadline || '9') ? -1 : (a.deadline || '9') > (b.deadline || '9') ? 1 : 0);
  for (const j of pinned) j.mitigation = 'pinned';
  for (const j of saveable) j.mitigation = 'on_time';
  for (const j of setAside) j.mitigation = 'late_anyway';
  for (const j of overdue) j.mitigation = 'overdue';
  for (const j of later) j.mitigation = 'later';
  return [...pinned, ...saveable, ...[...setAside, ...overdue].sort(byDeadline), ...later];
}

// ---- backlog: overdue work and how long catching up takes at the recent pace ----------------
// done: [{ date: 'YYYY-MM-DD', qty }] finished; due: [{ date, qty }] all work due (done or not);
// over the last `days` full days (from `from`, when the record starts later), counting working
// days only. rate = done a working day, demand = due a working day. Clearing the overdue alone
// takes overdue ÷ rate; with new work still arriving it takes overdue ÷ (rate − demand).
function catchUp({ overdue, done, due, days = 7, workDays = [1, 2, 3, 4, 5], from = null, now = new Date() }) {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start = new Date(today); start.setDate(start.getDate() - days);
  if (from) { const f = new Date(from); const next = new Date(f.getFullYear(), f.getMonth(), f.getDate() + 1); if (next > start) start = next; } // first full day on record
  const dates = [];
  for (let d = new Date(start); d < today; d.setDate(d.getDate() + 1)) if (workDays.includes(d.getDay())) dates.push(ymd(d));
  const set = new Set(dates);
  const doneQty = done.filter((x) => set.has(x.date)).reduce((t, x) => t + x.qty, 0);
  const dueQty = due.filter((x) => set.has(x.date)).reduce((t, x) => t + x.qty, 0);
  const out = { overdue, basis_days: dates.length, from: dates[0] || null, to: dates[dates.length - 1] || null, rate: null, demand: null, clear_days: null, catch_days: null, catch_date: null, status: 'ok' };
  if (!dates.length) return { ...out, status: 'no_record' };
  out.rate = Math.round(doneQty / dates.length);
  out.demand = Math.round(dueQty / dates.length);
  if (!overdue) return { ...out, status: 'none_overdue' };
  if (!doneQty) return { ...out, status: 'nothing_done' };
  out.clear_days = Math.round((overdue / (doneQty / dates.length)) * 10) / 10;
  const net = (doneQty - dueQty) / dates.length;
  if (net <= 0) return { ...out, status: 'not_catching_up' };
  out.catch_days = Math.round((overdue / net) * 10) / 10;
  // the working day it's reached
  let left = Math.ceil(out.catch_days); const d = new Date(today);
  while (left > 0) { d.setDate(d.getDate() + 1); if (workDays.includes(d.getDay())) left--; }
  out.catch_date = ymd(d);
  return out;
}
// Jobs due more than maxAge days ago are likely errors: left out. maxAge 0: keep everything.
const tooOld = (due, maxAge, now = new Date()) => {
  if (!(maxAge > 0) || !due) return false;
  const c = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxAge);
  return due < `${c.getFullYear()}-${String(c.getMonth() + 1).padStart(2, '0')}-${String(c.getDate()).padStart(2, '0')}`;
};

// ---- ⚖ priority modifiers (the Production Planning workbook's Planner score) ------------------
// A job's score is the sum of the modules switched on:
//  Deadline — overdue: base + per day overdue (up to max extra); before it: lead ÷ (1 + days left)
//  lists    — rule lists (e.g. Matching, Dispatch, Manual): a row matches on customer, card tag and
//             card type (blank = any); in each list the most specific matching row counts
//  Shift    — a value per customer for the shift running now (Night / Morning / Afternoon)
const SHIFTS = ['night', 'morning', 'afternoon'];
// The shift at a time of day (minutes), from each shift's start: the latest start before it.
function shiftAt(min, starts) {
  const list = SHIFTS.map((k) => ({ k, at: starts[k] })).filter((x) => x.at !== null && x.at !== undefined).sort((a, b) => a.at - b.at);
  if (!list.length) return null;
  const before = list.filter((x) => x.at <= min);
  return (before.length ? before[before.length - 1] : list[list.length - 1]).k;
}
const DEADLINE_DEFAULTS = { base: 100, per_day: 20, max_extra: 100, lead: 10 };
function deadlineScore(deadline, now, p = DEADLINE_DEFAULTS) {
  if (!deadline) return 0;
  const days = (localDate(deadline) - now) / 86400000;
  if (days < 0) return p.base + Math.min(p.max_extra, Math.abs(days) * p.per_day);
  return Math.max(0, Math.min(p.lead, p.lead / (1 + days)));
}
function scoreJobs(jobs, { now = new Date(), deadline = DEADLINE_DEFAULTS, rules = [], shifts = [], shiftStarts = { night: 1305, morning: 345, afternoon: 825 }, off = [], tagOf = () => null } = {}) {
  const isOff = new Set(off.map((x) => String(x).toLowerCase()));
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const live = rules.filter((r) => !isOff.has(String(r.list).toLowerCase()) && (!r.until || r.until >= today));
  const lists = [...new Set(live.map((r) => r.list))];
  const shift = shiftAt(now.getHours() * 60 + now.getMinutes(), shiftStarts);
  const shiftBy = new Map(shifts.map((r) => [String(r.customer).toUpperCase(), r]));
  const low = (v) => String(v || '').trim().toLowerCase();
  for (const j of jobs) {
    const cust = low(j.customer);
    const tags = new Set(j.articles.map((a) => low(a.card?.tag || tagOf(a.article))).filter(Boolean));
    const types = new Set(j.articles.map((a) => low(a.card?.type)).filter(Boolean));
    j.tags = [...new Set(j.articles.map((a) => a.card?.tag || tagOf(a.article)).filter(Boolean))];
    const parts = [];
    if (!isOff.has('deadline')) parts.push({ module: 'Deadline', value: Math.round(deadlineScore(j.deadline, now, deadline) * 100) / 100 });
    for (const list of lists) {
      const hits = live.filter((r) => r.list === list && (!r.customer || low(r.customer) === cust) && (!r.tag || tags.has(low(r.tag))) && (!r.type || types.has(low(r.type))));
      if (!hits.length) continue;
      const spec = (r) => (r.customer ? 4 : 0) + (r.tag ? 2 : 0) + (r.type ? 1 : 0);
      const best = hits.reduce((b, r) => (spec(r) > spec(b) || (spec(r) === spec(b) && Number(r.value) > Number(b.value)) ? r : b));
      parts.push({ module: list, value: Number(best.value) || 0, note: best.note || null, authoriser: best.authoriser || null, rule: best.id ?? null });
    }
    if (!isOff.has('shift') && shift) { const r = shiftBy.get(String(j.customer || '').toUpperCase()); if (r && Number(r[shift])) parts.push({ module: 'Shift', value: Number(r[shift]), note: shift }); }
    j.score_parts = parts;
    j.score = Math.round(parts.reduce((t, x) => t + x.value, 0) * 100) / 100;
  }
  return { shift };
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
    j.articles.push({ article: l.article, qty: l.qty, status: l.status, card: l.card || null, speed: l.speed ?? null, speed_from: l.speed_from || null, oee: l.oee ?? null, minutes: l.minutes ?? null });
    if (/progress/i.test(l.status || '')) j.status = l.status; // any line running → the job is running
    if (l.cutoff !== null && (j.cutoff === null || l.cutoff < j.cutoff)) j.cutoff = l.cutoff;
    if (PRIO_RANK[String(l.prio).toLowerCase()] < (PRIO_RANK[String(j.prio).toLowerCase()] ?? 9)) j.prio = l.prio;
  }
  for (const j of map.values()) {
    // production time: each card line at its own speed (null when a line has none)
    j.minutes = j.articles.every((a) => a.minutes !== null) ? j.articles.reduce((t, a) => t + a.minutes, 0) : null;
    j.no_speed = j.articles.filter((a) => a.minutes === null).length;
    j.no_card = j.articles.filter((a) => !a.card).length;
    const byKind = new Map();
    for (const a of j.articles) { const k = a.card ? [a.card.type, a.card.material].filter(Boolean).join(' · ') : ''; if (k) byKind.set(k, (byKind.get(k) || 0) + a.qty); }
    j.kind = [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    j.running = /progress/i.test(j.status || '');
    j.no_cutoff = j.cutoff === null;
    j.deadline = j.due ? `${j.due}T${hhmm(j.cutoff ?? 24 * 60 - 1)}` : null;
  }
  return [...map.values()];
}

// FIFO: deadline, then WO. BAU: due day, then High/Normal/Low, then cut-off, then WO.
function order(jobs, mode = 'fifo', pins = []) {
  const rank = (j) => PRIO_RANK[String(j.prio).toLowerCase()] ?? 3;
  // pinned jobs first, in the order they were pinned
  const pinAt = new Map(pins.map((k, i) => [k, i]));
  for (const j of jobs) j.pinned = pinAt.has(j.key);
  const by = (a, b) => {
    if (pinAt.has(a.key) || pinAt.has(b.key)) return (pinAt.get(a.key) ?? 1e9) - (pinAt.get(b.key) ?? 1e9);
    if (mode === 'score' && (a.score ?? 0) !== (b.score ?? 0)) return (b.score ?? 0) - (a.score ?? 0); // highest score first
    if ((a.due || '9') !== (b.due || '9') && mode === 'bau') return (a.due || '9') < (b.due || '9') ? -1 : 1;
    if (mode === 'bau' && rank(a) !== rank(b)) return rank(a) - rank(b);
    if ((a.deadline || '9') !== (b.deadline || '9')) return (a.deadline || '9') < (b.deadline || '9') ? -1 : 1;
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  };
  return [...jobs].sort(by);
}

// Working time: days (0 = Sunday … 6 = Saturday) and hours of the day (minutes), local time.
// A day that ends at or before its start runs past midnight (22:00–06:00); the same time at
// both ends is round the clock. Walks `minutes` of production forward from `from`, through the
// working windows only (null when there's no working time at all).
const shiftLength = (cal) => (cal.end > cal.start ? cal.end - cal.start : cal.end - cal.start + 1440);
function addWorking(from, minutes, cal) {
  if (!cal.days?.length) return null;
  const len = shiftLength(cal);
  let left = minutes;
  let t = new Date(from.getTime());
  // the window that could hold t may have started the day before (a shift past midnight)
  let day = new Date(t.getFullYear(), t.getMonth(), t.getDate() - 1);
  for (let guard = 0; guard < 4000; guard++) {
    if (cal.days.includes(day.getDay())) {
      const ws = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, cal.start);
      const we = new Date(ws.getTime() + len * 60000);
      if (t < we) {
        if (t < ws) t = ws;
        const room = (we - t) / 60000;
        if (left <= room) return new Date(t.getTime() + left * 60000);
        left -= room;
        t = we;
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  }
  return null;
}
// The working windows between two times: [{ start, end }] (Dates), for drawing the plan.
function workingWindows(from, to, cal) {
  const out = [];
  if (!cal.days?.length) return out;
  const len = shiftLength(cal);
  for (let day = new Date(from.getFullYear(), from.getMonth(), from.getDate() - 1); day < to; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) {
    if (!cal.days.includes(day.getDay())) continue;
    const ws = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, cal.start);
    const we = new Date(ws.getTime() + len * 60000);
    if (we > from && ws < to) out.push({ start: ws < from ? from : ws, end: we > to ? to : we });
  }
  return out;
}
// Working minutes between s and f, per local date ("2026-10-06") they fall on.
function minutesByDay(s, f, cal) {
  const out = {};
  for (const w of workingWindows(s, f, cal)) {
    for (let t = w.start; t < w.end;) {
      const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
      const stop = next < w.end ? next : w.end;
      const key = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
      out[key] = (out[key] || 0) + (stop - t) / 60000;
      t = stop;
    }
  }
  return out;
}
const localDate = (s) => { const [d, tm] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = tm.split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };

// Projects each job's finish in the given order (running jobs first), from `now`, with
// rate cards/hour per line × lines. Adds start, finish, late_minutes (vs deadline) to each.
function project(running, queue, { rate, lines = 1, start = 360, end = 1320, days = [1, 2, 3, 4, 5], buffer = 0 }, now = new Date()) {
  const nLines = Math.max(1, Number(lines) || 1);
  const perHour = Number(rate) * nLines;
  const all = [...running, ...queue];
  // needs a time for every job: from the card speeds, else the flat rate
  if (!all.length || !all.every((j) => j.minutes !== null || perHour > 0)) return false;
  const cal = { start, end, days };
  let t = now;
  for (const j of all) {
    const startAt = addWorking(t, 0, cal) || t;
    const minutes = j.minutes !== null ? j.minutes / nLines : (j.qty / perHour) * 60;
    j.plan_minutes = minutes;
    const finish = addWorking(t, minutes, cal);
    j.start_at = startAt.toISOString();
    j.finish_at = finish ? finish.toISOString() : null;
    j.late_minutes = finish && j.deadline ? Math.round((finish - localDate(j.deadline)) / 60000 + (Number(buffer) || 0)) : null;
    if (finish) t = finish;
  }
  return true;
}

// ---- machines ------------------------------------------------------------------------------------

// A machine runs the product types listed (card Type, e.g. "DOD, Laser"); none listed = any type.
const typesOf = (m) => String(m.types || '').split(/[,;/]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
const canRun = (m, type) => { const t = typesOf(m); return !t.length || t.includes(String(type || '').trim().toLowerCase()); };

// Plans each card line on a machine: jobs in the list's order (running first), each line on the
// machine able to run its type that comes free first. A job finishes with its last line.
// Lines no machine can run (or without a time) are left unplanned and their job flagged.
function projectMachines(running, queue, machines, { start = 360, end = 1320, days = [1, 2, 3, 4, 5], buffer = 0, changeover = 0 }, now = new Date()) {
  const active = machines.filter((m) => m.active !== 0 && m.active !== false);
  if (!active.length) return false;
  const cal = { start, end, days };
  const free = new Map(active.map((m) => [m.id, now]));
  const lastKind = new Map(); // what each machine ran last: a change of type or material costs a change-over
  const load = new Map(active.map((m) => [m.id, { id: m.id, name: m.name, types: m.types, cards: 0, minutes: 0, lines: 0, setups: 0, until: null, days: {} }]));
  for (const j of [...running, ...queue]) {
    let last = null; let first = null; let unplanned = 0; let minutes = 0;
    for (const a of j.articles) {
      const type = a.card?.type || null;
      // a card not in the card database (type unknown) can go on any running machine
      const able = type ? active.filter((m) => canRun(m, type)) : active;
      a.machine = null;
      if (a.minutes === null) { a.unplanned = 'speed'; unplanned++; continue; }
      if (!able.length) { a.unplanned = 'machine'; unplanned++; continue; }
      const m = able.reduce((best, x) => (free.get(x.id) < free.get(best.id) ? x : best));
      const kind = `${String(type || '').toLowerCase()}|${String(a.card?.material || '').toLowerCase()}`;
      const setup = changeover > 0 && lastKind.has(m.id) && lastKind.get(m.id) !== kind ? Number(changeover) : 0;
      const s = addWorking(free.get(m.id), 0, cal) || free.get(m.id);
      const f = addWorking(free.get(m.id), a.minutes + setup, cal);
      if (!f) { a.unplanned = 'time'; unplanned++; continue; }
      free.set(m.id, f);
      lastKind.set(m.id, kind);
      a.setup = setup;
      const l = load.get(m.id); l.cards += a.qty; l.minutes += a.minutes + setup; l.lines++; if (setup) l.setups++; l.until = f.toISOString();
      for (const [day, min] of Object.entries(minutesByDay(s, f, cal))) { // booked per day (cards in proportion)
        const d = l.days[day] || (l.days[day] = { minutes: 0, cards: 0 });
        d.minutes += min; d.cards += a.minutes + setup ? (a.qty * min) / (a.minutes + setup) : 0;
      }
      a.machine = m.name; a.start_at = s.toISOString(); a.finish_at = f.toISOString();
      minutes += a.minutes + setup;
      if (!first || s < first) first = s;
      if (!last || f > last) last = f;
    }
    j.machines = [...new Set(j.articles.map((a) => a.machine).filter(Boolean))];
    j.unplanned = unplanned;
    j.unplanned_why = [...new Set(j.articles.map((a) => a.unplanned).filter(Boolean))];
    j.plan_minutes = minutes;
    j.start_at = first ? first.toISOString() : null;
    j.finish_at = last && !unplanned ? last.toISOString() : null;
    // late when it finishes after the deadline less the buffer (packing, dispatch)
    j.late_minutes = j.finish_at && j.deadline ? Math.round((last - localDate(j.deadline)) / 60000 + (Number(buffer) || 0)) : null;
  }
  return [...load.values()];
}

// The most a day's work can make, per product type: each machine able to run it, for the
// working day, at that type's speed (the open cards' average at their speeds). Machines that
// run several types count for each of them — the ceiling for that type on its own.
function capacityByType(lines, machines, { start = 360, end = 1320, days = [1, 2, 3, 4, 5] }) {
  const active = machines.filter((m) => m.active !== 0 && m.active !== false);
  const hours = shiftLength({ start, end }) / 60;
  const types = new Map();
  for (const l of lines) {
    const type = l.card?.type || null;
    if (!type) continue;
    const t = types.get(type.toLowerCase()) || { type, cards: 0, minutes: 0, lines: 0 };
    t.cards += l.qty; t.lines++; if (l.minutes !== null) t.minutes += l.minutes;
    types.set(type.toLowerCase(), t);
  }
  return [...types.values()].map((t) => {
    const able = active.filter((m) => canRun(m, t.type));
    const speed = t.minutes > 0 ? t.cards / (t.minutes / 60) : null; // cards per hour on one machine
    const perDay = speed ? Math.round(speed * hours * able.length) : null;
    return { type: t.type, cards: t.cards, lines: t.lines, machines: able.map((m) => m.name), speed: speed ? Math.round(speed) : null, hours_per_day: hours, work_days: days.length,
      max_per_day: perDay, days_of_work: perDay ? Math.round((t.cards / perDay) * 10) / 10 : null };
  }).sort((a, b) => b.cards - a.cards);
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

// ---- the card database (Access): AX Ref → type, material, print sides, … ------------------------

const CARD_COLUMNS = { key: 'AX Ref', type: 'Type', material: 'Material', sides: 'Print Sides', name: 'Cardbody Name', customer: 'Customer Reference', trigram: 'Trigram', provider: 'Provider', front: 'Front DoD', back: 'Back DoD', persocode: 'PersoCode', tag: 'Tag' };
// "0002358794", 2358794 and "2358794 " are the same AX Ref.
const axKey = (v) => { const t = String(v ?? '').trim(); return /^\d+$/.test(t) ? String(Number(t)) : t.toUpperCase(); };
let cardCache = null;
function readCards({ file, table = 'Cards', columns = {} }) {
  if (!file) return { status: 'none' };
  let stat;
  try { stat = fs.statSync(file); } catch { return { status: 'missing', file }; }
  const key = `${file}|${table}|${JSON.stringify(columns)}|${stat.mtimeMs}|${stat.size}`;
  if (!cardCache || cardCache.key !== key) {
    try {
      let name; let cols; let rowsOf;
      if (/\.xls[xm]$/i.test(file)) { // an Excel export of the table (sheet of that name, or the first)
        const book = readBook(fs.readFileSync(file));
        const info = book.sheets.find((x) => x.name.toLowerCase() === String(table).toLowerCase()) || book.sheets[0];
        const sh = book.sheet(info.name);
        const head = new Map(); for (const c of sh.cells.values()) if (c.row === 1 && c.v !== null && c.v !== '') head.set(c.col, String(c.v).trim());
        name = info.name; cols = [...head.values()];
        rowsOf = () => { const out = []; for (let r = 2; r <= sh.maxRow; r++) { const o = {}; for (const [c, h] of head) { const L = (n) => { let x = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) x = String.fromCharCode(65 + ((n - 1) % 26)) + x; return x; }; o[h] = sh.cells.get(`${L(c)}${r}`)?.v ?? null; } out.push(o); } return out; };
      } else {
        const MDBReader = require('mdb-reader').default || require('mdb-reader');
        const reader = new MDBReader(fs.readFileSync(file));
        const names = reader.getTableNames();
        name = names.find((n) => n.toLowerCase() === String(table).toLowerCase());
        if (!name) throw new Error(`There's no table called "${table}" (it has ${names.join(', ')})`);
        const t = reader.getTable(name);
        cols = t.getColumnNames();
        rowsOf = (want) => t.getData({ columns: want });
      }
      const colOf = (want) => cols.find((c) => c.toLowerCase() === want.toLowerCase()) || null;
      const use = Object.fromEntries(Object.entries({ ...CARD_COLUMNS, ...columns }).map(([k, want]) => [k, colOf(want)]));
      if (!use.key) throw new Error(`The ${name} table has no "${columns.key || CARD_COLUMNS.key}" column (it has ${cols.join(', ')})`);
      const cards = new Map();
      for (const row of rowsOf(Object.values(use).filter(Boolean))) {
        const k = axKey(row[use.key]);
        if (!k) continue;
        const card = {};
        for (const [field, c] of Object.entries(use)) if (c && field !== 'key') card[field] = row[c] === null || row[c] === undefined ? null : String(row[c]).trim() || null;
        cards.set(k, card);
      }
      cardCache = { key, cards, table: name, columns: use, read_at: new Date().toISOString() };
    } catch (err) {
      return { status: 'error', file, error: /password|encrypt/i.test(err.message) ? 'the database is password protected — it can\'t be read directly' : err.code === 'EBUSY' ? 'the file is locked — try again in a moment' : err.message };
    }
  }
  return { status: 'ok', file, name: path.basename(file), modified: stat.mtime.toISOString(), read_at: cardCache.read_at, table: cardCache.table, columns: cardCache.columns, count: cardCache.cards.size, cards: cardCache.cards };
}

// The speed for a card: the most specific rule matching its type, material and print sides
// (a rule's blank field matches anything). rules: [{ id, type, material, sides, speed }].
const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
function speedFor(card, rules) {
  if (!card) return null;
  let best = null; let bestScore = -1;
  for (const r of rules) {
    if (!(Number(r.speed) > 0)) continue;
    const fields = ['type', 'material', 'sides'];
    if (!fields.every((f) => r[f] === null || r[f] === undefined || r[f] === '' || same(r[f], card[f]))) continue;
    const score = fields.filter((f) => r[f]).length;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}
// Each export line gets its card (from the database), speed and production minutes.
// oee: { by: Map(customer trigram → 0.85), fallback: 0.8 | null } — the machine speed × the
// customer's estimated OEE is what's planned (no OEE: the speed as it is).
function withSpeeds(lines, cards, rules, fallbackRate, oee = null) {
  for (const l of lines) {
    l.card = cards ? cards.get(axKey(l.article)) || null : null;
    const rule = speedFor(l.card, rules);
    l.speed = rule ? Number(rule.speed) : Number(fallbackRate) > 0 ? Number(fallbackRate) : null;
    l.speed_from = rule ? `rule:${rule.id}` : l.speed ? 'fallback' : null;
    l.minutes = l.speed ? (l.qty / l.speed) * 60 : null;
  }
  // no flat rate: a line without a speed gets the average of the others (cards per hour overall)
  const known = lines.filter((l) => l.minutes !== null && l.qty > 0);
  const avg = known.length ? known.reduce((t, l) => t + l.qty, 0) / (known.reduce((t, l) => t + l.minutes, 0) / 60) : null;
  if (avg) for (const l of lines) if (l.minutes === null) { l.speed = Math.round(avg); l.speed_from = 'average'; l.minutes = (l.qty / avg) * 60; }
  // estimated OEE per customer: the time at the machine's speed ÷ OEE
  for (const l of lines) {
    const f = oee?.by?.get(String(l.customer || '').toUpperCase()) ?? oee?.fallback ?? null;
    l.oee = f && f > 0 && f <= 1 ? f : null;
    if (l.oee && l.minutes !== null) l.minutes /= l.oee;
  }
  return lines;
}
// The kinds of card in the open work orders: type × material × print sides, with their cards.
function combos(lines, rules) {
  const map = new Map();
  for (const l of lines) {
    if (!l.card) continue;
    const k = [l.card.type, l.card.material, l.card.sides].map((x) => String(x ?? '').toLowerCase()).join('|');
    const c = map.get(k) || { type: l.card.type, material: l.card.material, sides: l.card.sides, lines: 0, qty: 0, articles: new Set() };
    c.lines++; c.qty += l.qty; c.articles.add(l.article);
    map.set(k, c);
  }
  return [...map.values()].map((c) => { const r = speedFor(c, rules); return { ...c, articles: c.articles.size, rule: r ? { id: r.id, speed: Number(r.speed), type: r.type, material: r.material, sides: r.sides } : null }; })
    .sort((a, b) => b.qty - a.qty);
}

// ---- the source file: read when it changes (or uploaded once, for trying it out) --------------

const caches = new Map(); // parser → { key, parsed }
function readSource({ file, uploaded, parser = parse }) {
  const target = file || (uploaded && fs.existsSync(uploaded) ? uploaded : null);
  if (!target) return { status: 'none' };
  let stat;
  try { stat = fs.statSync(target); } catch { return { status: 'missing', file: target }; }
  const key = `${target}|${stat.mtimeMs}|${stat.size}`;
  let cache = caches.get(parser);
  if (!cache || cache.key !== key) {
    try { cache = { key, parsed: parser(fs.readFileSync(target)), read_at: new Date().toISOString() }; caches.set(parser, cache); } catch (err) {
      return { status: 'error', file: target, error: err.code === 'EBUSY' ? 'the file is open and locked — try again in a moment' : err.message };
    }
  }
  return { status: 'ok', file: target, name: path.basename(target), uploaded: !file, modified: stat.mtime.toISOString(), read_at: cache.read_at, ...cache.parsed };
}

module.exports = { workingWindows, minutesByDay, projectMachines, capacityByType, canRun, readCards, speedFor, withSpeeds, combos, axKey, CARD_COLUMNS, parse, parseDay, parseTime, jobsOf, order, project, addWorking, loadByDeadline, readSource, COLUMNS, parseOtto, orderOtto, linkOtto, projectOtto, catchUp, tooOld, mitigate, workingDaysAhead, scoreJobs, deadlineScore, shiftAt, SHIFTS, DEADLINE_DEFAULTS, woOfName, OTTO_COLUMNS };
