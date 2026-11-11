'use strict';
// 🚚 OTD entry (Reporting's OTD tab, the Despatch module): late deliveries logged in SITHUB instead of the
// Excel OTD report. Logistics picks a work order the planner knows (open, or finished in the last few weeks)
// and says whether the delay was the Service Center's (internal) or the customer's (external), and why. The
// rest comes from the planner: customer, cards, due out, and so the reporting week and month.
//
// Once Sources says OTD delays come from here (setting kpi_otd_from = 'entered'), the entries ARE the OTD
// source: they're written into kpi_rows as source 'otd' (the typed week = the entry's week), so the Weekly SC
// Report, Quality's OTD chart and 🏭 Operations count them exactly as they counted the Excel report. Until then
// they're kept and listed, but not counted, so nothing is counted twice.

const db = require('./db');
const kpiData = require('./kpidata');

const RECENT_DAYS = 28; // a work order finished this long ago can still be logged as late
const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

let ready = false;
function ensure() {
  if (ready) return;
  kpiData.ensure(); // the table itself is in schema.js (backed up, restored and in the activity log)
  db.conn.exec('CREATE INDEX IF NOT EXISTS otd_entries_week ON otd_entries (week)');
  ready = true;
}

// where OTD delays are counted from: 'report' (the Excel OTD report, as before) or 'entered' (here)
let pref = () => 'report';
const useOtdPref = (fn) => { pref = fn; };
const counted = () => pref() === 'entered';

// the working days (0 Sun … 6 Sat) and closed days (YYYY-MM-DD) the next pickup skips: Planning's and
// Capacity planning's settings (set from api.js)
let calendar = () => ({ workDays: new Set([1, 2, 3, 4, 5]), holidays: new Set() });
const useCalendar = (fn) => { calendar = fn; };
const pad = (n) => String(n).padStart(2, '0');
const localStamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
// the shipper's pickup: each working day at its cut-off (the planner's Shipping Time, kept as the time of the
// deadline). The first one after `from` (a local 'YYYY-MM-DDTHH:MM'): the next one for an open work order, the
// one it could go with for a finished one. null when the planner has no shipping time for it.
function pickupAfter(cutoff, from) {
  if (!cutoff || !from) return null;
  const { workDays, holidays } = calendar();
  const [y, m, d] = from.slice(0, 10).split('-').map(Number);
  for (let i = 0; i < 21; i++) {
    const day = new Date(y, m - 1, d + i);
    const iso = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    if (!workDays.has(day.getDay()) || holidays.has(iso)) continue;
    const at = `${iso}T${cutoff}`;
    if (at > from) return at;
  }
  return null;
}

// a work order as the planner knows it: its lines (WO + PER) together
function woOf(wo, today = new Date()) {
  const lines = db.all('SELECT key, wo, per, customer, qty, due, deadline, prio, shipper, done_at, late_minutes, last_seen FROM plan_history_jobs WHERE upper(wo) = ? ORDER BY deadline, per', [String(wo || '').trim().toUpperCase()]);
  if (!lines.length) return null;
  const seenSince = new Date(today - 3 * 86400000).toISOString().slice(0, 10);
  const open = lines.filter((l) => !l.done_at && String(l.last_seen || '') >= seenSince);
  const deadlines = lines.map((l) => l.deadline).filter(Boolean).sort();
  const done = lines.map((l) => l.done_at).filter(Boolean).sort();
  return {
    wo: lines[0].wo.toUpperCase(), customer: lines.find((l) => l.customer)?.customer?.toUpperCase() || null,
    qty: lines.reduce((t, l) => t + (Number(l.qty) || 0), 0), deadline: deadlines[0] || null, due: (deadlines[0] || lines[0].due || '').slice(0, 10) || null,
    prio: lines.find((l) => l.prio)?.prio || null, renewal: lines.some((l) => /^low/i.test(String(l.prio || ''))),
    open: open.length > 0, done_at: open.length ? null : done[done.length - 1] || null,
    late_minutes: Math.max(0, ...lines.map((l) => Number(l.late_minutes) || 0)) || null,
    ...pickupOf(lines, open.length > 0, done[done.length - 1], today),
    lines: lines.map((l) => ({ per: l.per, qty: l.qty, deadline: l.deadline, done_at: l.done_at, late_minutes: l.late_minutes })),
  };
}

// its shipper's cut-off (the earliest of its lines that has one) and the pickup it can go with: the next one
// from now while it's open, the first after it was finished otherwise
function pickupOf(lines, isOpen, doneAt, today) {
  const cut = lines.map((l) => String(l.deadline || '').slice(11, 16)).filter((t) => /^\d\d:\d\d$/.test(t) && t !== '23:59').sort()[0] || null;
  const shipper = lines.find((l) => l.shipper)?.shipper || null;
  const from = isOpen ? localStamp(today) : doneAt ? localStamp(new Date(doneAt)) : null;
  return { shipper, cutoff: cut, pickup: pickupAfter(cut, from), pickup_kind: isOpen ? 'next' : doneAt ? 'went' : null };
}

// work orders to pick from as the user types: open on the planner, or finished in the last few weeks
function search(q, { names = new Map(), today = new Date() } = {}) {
  ensure();
  const t = String(q || '').trim();
  if (t.length < 2) return [];
  const since = new Date(today - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const seenSince = new Date(today - 3 * 86400000).toISOString().slice(0, 10); // still on the planner
  const wos = db.all(`SELECT upper(wo) AS wo, max(last_seen) AS seen FROM plan_history_jobs
    WHERE (lower(wo) LIKE ? ESCAPE '\\' OR lower(customer) LIKE ? ESCAPE '\\') AND ((done_at IS NULL AND last_seen >= ?) OR done_at >= ?)
    GROUP BY upper(wo) ORDER BY (upper(wo) LIKE ? ESCAPE '\\') DESC, seen DESC LIMIT 15`, [like(t.toLowerCase()), like(t.toLowerCase()), seenSince, since, `${t.toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`]);
  const logged = new Map(db.all(`SELECT upper(wo) AS wo, COUNT(*) AS n, SUM(qty) AS q FROM otd_entries WHERE upper(wo) IN (${wos.map(() => '?').join(',') || "''"}) GROUP BY upper(wo)`, wos.map((w) => w.wo)).map((r) => [r.wo, r]));
  return wos.map((w) => woOf(w.wo, today)).filter(Boolean).map((w) => ({ ...w, name: names.get(w.customer) || null, logged: logged.get(w.wo) || null }));
}

// the reporting week of a delay: the week its work order was due out (a weekend day of a week split across
// two months goes to its own month's part, so it's always counted)
const weekOfDay = (day) => (day ? kpiData.weekCode(day, { splitWeekends: true }) : null);

function clean(body, user, { today = new Date() } = {}) {
  const wo = woOf(body.wo, today);
  if (!wo) throw Object.assign(new Error('Pick a work order from the list: that one isn\'t known to the planner'), { status: 400 });
  const type = /^int/i.test(body.type || '') ? 'Internal' : /^ext/i.test(body.type || '') ? 'External' : null;
  if (!type) throw Object.assign(new Error('Say whether the delay was internal (the Service Center) or external (the customer)'), { status: 400 });
  const reason = String(body.reason || '').trim().slice(0, 200);
  if (!reason) throw Object.assign(new Error('Give a reason for the delay'), { status: 400 });
  const qty = body.qty === undefined || body.qty === null || body.qty === '' ? wo.qty : Math.round(Number(body.qty));
  if (!Number.isFinite(qty) || qty < 1) throw Object.assign(new Error('The cards delayed should be a whole number above 0'), { status: 400 });
  if (wo.qty && qty > wo.qty) throw Object.assign(new Error(`${wo.wo} has ${wo.qty.toLocaleString('en-GB')} cards: no more can be late`), { status: 400 });
  const week = body.week ? kpiData.typedWeekCode(body.week, { day: wo.due }) : weekOfDay(wo.due);
  if (!week) throw Object.assign(new Error(wo.due ? 'That week isn\'t one (e.g. W2644, or W2644_1 for a split week)' : `${wo.wo} has no due date: give the week`), { status: 400 });
  return { wo: wo.wo, customer: wo.customer, qty, wo_qty: wo.qty || null, due: wo.due, week, type, reason, note: String(body.note || '').trim().slice(0, 500) || null, by: user };
}

function add(body, user, opts) {
  ensure();
  const e = clean(body, user, opts);
  const now = new Date().toISOString();
  const r = db.run('INSERT INTO otd_entries (wo, customer, qty, wo_qty, due, week, type, reason, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [e.wo, e.customer, e.qty, e.wo_qty, e.due, e.week, e.type, e.reason, e.note, user, now]);
  sync();
  return get(r.lastInsertRowid);
}
function update(id, body, user, opts) {
  ensure();
  const old = get(id); if (!old) throw Object.assign(new Error('That delay isn\'t there any more'), { status: 404 });
  const e = clean({ ...old, ...body }, user, opts);
  db.run('UPDATE otd_entries SET wo = ?, customer = ?, qty = ?, wo_qty = ?, due = ?, week = ?, type = ?, reason = ?, note = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    [e.wo, e.customer, e.qty, e.wo_qty, e.due, e.week, e.type, e.reason, e.note, user, new Date().toISOString(), id]);
  sync();
  return get(id);
}
function remove(id) {
  ensure();
  const old = get(id); if (!old) return null;
  db.run('DELETE FROM otd_entries WHERE id = ?', [id]);
  sync();
  return old;
}
const get = (id) => { ensure(); return db.get('SELECT * FROM otd_entries WHERE id = ?', [id]) || null; };

// the entries become the OTD source (when that's where OTD is counted from)
function sync() {
  ensure();
  if (!counted()) return false;
  const rows = db.all('SELECT * FROM otd_entries ORDER BY due, id');
  const ins = db.conn.prepare('INSERT INTO kpi_rows (source, day, week, customer, type, qty, scrap, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let first = null; let last = null;
  db.tx(() => {
    db.run("DELETE FROM kpi_rows WHERE source = 'otd'");
    for (const r of rows) {
      if (r.due && (!first || r.due < first)) first = r.due;
      if (r.due && (!last || r.due > last)) last = r.due;
      ins.run('otd', r.due || '', r.week, r.customer, r.type, r.qty, 0, JSON.stringify({ reason: r.reason, typed_week: r.week, date_week: r.due ? kpiData.weekCode(r.due) : null,
        week_raw: r.week, month_raw: null, wo: r.wo, entry: r.id, by: r.created_by, renewal: woOf(r.wo)?.renewal ?? null })); // a renewal: the planner's Low priority
    }
    db.run(`INSERT INTO kpi_sources (source, file, modified, imported_at, rows, skipped, first_day, last_day) VALUES ('otd', ?, NULL, ?, ?, 0, ?, ?)
      ON CONFLICT(source) DO UPDATE SET file = excluded.file, modified = NULL, imported_at = excluded.imported_at, rows = excluded.rows, skipped = 0,
      first_day = excluded.first_day, last_day = excluded.last_day`, [ENTERED, new Date().toISOString(), rows.length, first, last]);
  });
  return true;
}
const ENTERED = 'Entered on Reporting › 🚚 OTD';

// the tab: the chosen week's delays, what the week adds up to, and reasons used before (to pick from)
function page(week, { names = new Map(), splitWeekends = false, today = new Date() } = {}) {
  ensure();
  const thisWeek = kpiData.weekCode(today.toISOString().slice(0, 10), { splitWeekends: true });
  const wk = kpiData.WEEK_RE.test(String(week || '')) ? String(week).toUpperCase() : thisWeek;
  const y = 2000 + Number(wk.slice(1, 3));
  const weeks = [...kpiData.weeksOf(y - 1), ...kpiData.weeksOf(y), ...kpiData.weeksOf(y + 1)].filter((w) => w.week <= thisWeek || w.week === wk);
  const months = new Map(weeks.map((w) => [w.week, w.month]));
  const entries = db.all('SELECT * FROM otd_entries WHERE week = ? ORDER BY created_at DESC, id DESC', [wk]).map((e) => {
    const w = woOf(e.wo, today);
    return { ...e, name: names.get(e.customer) || null, renewal: w ? w.renewal : null, prio: w?.prio || null, shipper: w?.shipper || null, cutoff: w ? w.cutoff : null, pickup: w?.pickup || null, pickup_kind: w?.pickup_kind || null, open: w?.open ?? null };
  });
  const sum = (t) => entries.filter((e) => e.type === t).reduce((s, e) => s + e.qty, 0);
  // cards shipped that week (the shipped export, as the Weekly SC Report counts OTD against)
  const shipped = safe(() => db.get("SELECT SUM(qty) AS q FROM kpi_rows WHERE source = 'shipped' AND week = ? AND lower(type) LIKE '%card%'", [wk]).q);
  const counts = new Map(db.all('SELECT week, COUNT(*) AS n FROM otd_entries GROUP BY week').map((r) => [r.week, r.n]));
  const reasons = db.all(`SELECT reason, COUNT(*) AS n FROM (SELECT reason FROM otd_entries UNION ALL
    SELECT json_extract(extra, '$.reason') AS reason FROM kpi_rows WHERE source = 'otd' AND json_extract(extra, '$.entry') IS NULL)
    WHERE reason IS NOT NULL AND trim(reason) <> '' GROUP BY lower(trim(reason)) ORDER BY n DESC LIMIT 40`).map((r) => r.reason.trim());
  return {
    week: wk, month: months.get(wk) || null, this_week: thisWeek,
    weeks: weeks.slice().reverse().slice(0, 80).map((w) => ({ week: w.week, month: w.month, n: counts.get(w.week) || 0 })),
    counted: counted(), entries, internal: sum('Internal'), external: sum('External'), shipped,
    otd_sc: shipped ? 1 - sum('Internal') / shipped : null, otd_c: shipped ? 1 - sum('External') / shipped : null,
    reasons, total: db.get('SELECT COUNT(*) AS n FROM otd_entries').n, days: daysOf(wk, today),
  };
}
// 📅 the week day by day: cards shipped (the shipped export) against the delays logged for work orders due out
// that day (OTD SC and C, as the week's), and, from the planner, the cards due that day and how many were
// finished by their deadline, which is there even when nothing's logged
function daysOf(wk, today) {
  const end = kpiData.weekEnd(wk); if (!end) return [];
  const todayIso = localStamp(today).slice(0, 10);
  const days = [];
  for (let i = 6; i >= -1; i--) {
    const d = new Date(`${end}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - i); const day = d.toISOString().slice(0, 10);
    if (kpiData.weekCode(day, { splitWeekends: true }) === wk && !days.includes(day)) days.push(day);
  }
  const shipped = new Map(db.all(`SELECT day, SUM(qty) AS q FROM kpi_rows WHERE source = 'shipped' AND lower(type) LIKE '%card%' AND day IN (${days.map(() => '?').join(',')}) GROUP BY day`, days).map((r) => [r.day, r.q]));
  const logged = db.all(`SELECT due, type, SUM(qty) AS q FROM otd_entries WHERE due IN (${days.map(() => '?').join(',')}) GROUP BY due, type`, days);
  const jobs = db.all(`SELECT substr(deadline, 1, 10) AS day, qty, done_at, late_minutes FROM plan_history_jobs WHERE substr(deadline, 1, 10) IN (${days.map(() => '?').join(',')})`, days);
  return days.map((day) => {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    const s = shipped.get(day) || 0;
    const internal = logged.filter((r) => r.due === day && r.type === 'Internal').reduce((t, r) => t + r.q, 0);
    const external = logged.filter((r) => r.due === day && r.type === 'External').reduce((t, r) => t + r.q, 0);
    const js = jobs.filter((j) => j.day === day);
    const due = js.reduce((t, j) => t + (Number(j.qty) || 0), 0);
    const onTime = js.filter((j) => j.done_at && !(Number(j.late_minutes) > 0)).reduce((t, j) => t + (Number(j.qty) || 0), 0);
    const late = js.filter((j) => j.done_at && Number(j.late_minutes) > 0).reduce((t, j) => t + (Number(j.qty) || 0), 0);
    return { day, weekend: dow === 0 || dow === 6, future: day > todayIso, shipped: s, internal, external,
      otd_sc: s ? 1 - internal / s : null, otd_c: s ? 1 - external / s : null,
      due, on_time: onTime, late, open: due - onTime - late, planner_pct: onTime + late ? onTime / (onTime + late) : null };
  });
}
function safe(fn) { try { const v = fn(); return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null; } catch { return null; } }

module.exports = { useCalendar, pickupAfter, search, woOf, add, update, remove, get, page, sync, useOtdPref, counted, ENTERED, ensure, weekOfDay };
