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
  kpiData.ensure();
  db.conn.exec(`CREATE TABLE IF NOT EXISTS otd_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wo TEXT NOT NULL, customer TEXT, qty INTEGER NOT NULL, wo_qty INTEGER, due TEXT, week TEXT NOT NULL,
    type TEXT NOT NULL, reason TEXT NOT NULL, note TEXT,
    created_by TEXT, created_at TEXT NOT NULL, updated_by TEXT, updated_at TEXT)`);
  db.conn.exec('CREATE INDEX IF NOT EXISTS otd_entries_week ON otd_entries (week)');
  ready = true;
}

// where OTD delays are counted from: 'report' (the Excel OTD report, as before) or 'entered' (here)
let pref = () => 'report';
const useOtdPref = (fn) => { pref = fn; };
const counted = () => pref() === 'entered';

// a work order as the planner knows it: its lines (WO + PER) together
function woOf(wo, today = new Date()) {
  const lines = db.all('SELECT key, wo, per, customer, qty, due, deadline, prio, done_at, late_minutes, last_seen FROM plan_history_jobs WHERE upper(wo) = ? ORDER BY deadline, per', [String(wo || '').trim().toUpperCase()]);
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
    lines: lines.map((l) => ({ per: l.per, qty: l.qty, deadline: l.deadline, done_at: l.done_at, late_minutes: l.late_minutes })),
  };
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
        week_raw: r.week, month_raw: null, wo: r.wo, entry: r.id, by: r.created_by }));
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
  const entries = db.all('SELECT * FROM otd_entries WHERE week = ? ORDER BY created_at DESC, id DESC', [wk]).map((e) => ({ ...e, name: names.get(e.customer) || null }));
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
    reasons, total: db.get('SELECT COUNT(*) AS n FROM otd_entries').n,
  };
}
function safe(fn) { try { const v = fn(); return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null; } catch { return null; } }

module.exports = { search, woOf, add, update, remove, get, page, sync, useOtdPref, counted, ENTERED, ensure, weekOfDay };
