'use strict';
// 📦 Volume extensions. Some customers' due dates may move on by a working day or two when they send a
// lot at once: everything a customer submits in one day for one due date (D+0: due the day it came in,
// D+1: the next working day), counted in cards, against the customer's rules (Production › Setup).
// Suggested from the planner's history (each work order's arrival is the export it first appeared in),
// then applied — or dismissed — by a person. An applied extension is the work orders' due date from then
// on: in the plan (ordering, late flags, sheets), and in the history, so "on time" (D+, Insights) is
// judged against the final due date.
// the database (and D+, which uses it) only when it's needed: the date helpers below stay pure, so a test can use them without opening one
const dbProxy = { get: (...a) => require('./db').get(...a), all: (...a) => require('./db').all(...a), run: (...a) => require('./db').run(...a), tx: (...a) => require('./db').tx(...a) };
const db = dbProxy;
const workingDaysBetween = (...a) => require('./dplus').workingDaysBetween(...a);

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOf = (iso) => ymd(new Date(iso)); // a stored time → its local day
const key = (customer, arrived, due) => `${String(customer || '').toUpperCase()}|${arrived}|${due}`;
// "2026-10-06T16:00" (local) → Date
const localDate = (s) => { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = (t || '23:59').split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };

// A day plus n working days (workDays: a Set of 0–6, Sunday 0).
function addWorkingDays(day, n, workDays) {
  const d = new Date(`${day}T12:00:00`);
  let left = n;
  for (let guard = 0; left > 0 && guard < 60; guard++) { d.setDate(d.getDate() + 1); if (workDays.has(d.getDay())) left--; }
  return ymd(d);
}

const rules = () => db.all('SELECT * FROM plan_volume_rules ORDER BY customer, min_cards');
const decisions = () => db.all('SELECT * FROM plan_volume_ext ORDER BY arrived DESC, customer');
// applied ones by customer|arrived|due
const appliedMap = () => new Map(db.all("SELECT * FROM plan_volume_ext WHERE status = 'applied'").map((r) => [key(r.customer, r.arrived, r.due), r]));

// The rule that counts for a submission: the customer's, for its notice, the most cards it reaches.
function ruleFor(all, customer, notice, cards) {
  return all.filter((r) => r.customer.toUpperCase() === String(customer).toUpperCase() && (r.notice === 'both' || Number(r.notice) === notice) && cards > r.min_cards)
    .sort((a, b) => b.extra_days - a.extra_days || b.min_cards - a.min_cards)[0] || null;
}

// Each customer's submissions by arrival day and due date (D+0 / D+1 only), from the perso history:
// [{ customer, arrived, due, notice, cards, work_orders, rule, new_due, decision }]. Only work orders that
// arrived after the history began have a known arrival day. days: how far back to look (arrival days).
function submissions({ workDays, days = 21, today = ymd(new Date()) } = {}) {
  const first = db.get('SELECT min(file_modified) AS f FROM plan_history_reads')?.f;
  if (!first) return [];
  const from = ymd(new Date(new Date(`${today}T12:00:00`).getTime() - days * 86400000));
  const groups = new Map();
  for (const j of db.all('SELECT wo, customer, qty, due, first_seen FROM plan_history_jobs WHERE first_seen > ? AND due IS NOT NULL AND customer IS NOT NULL', [first])) {
    const arrived = dayOf(j.first_seen);
    if (arrived < from) continue;
    const notice = workingDaysBetween(arrived, j.due, workDays);
    if (notice !== 0 && notice !== 1) continue;
    const k = key(j.customer, arrived, j.due);
    const g = groups.get(k) || { customer: String(j.customer).toUpperCase(), arrived, due: j.due, notice, cards: 0, wos: new Set() };
    g.cards += j.qty || 0; g.wos.add(j.wo);
    groups.set(k, g);
  }
  const all = rules();
  const decided = new Map(decisions().map((r) => [key(r.customer, r.arrived, r.due), r]));
  return [...groups.values()].map((g) => {
    const rule = ruleFor(all, g.customer, g.notice, g.cards);
    const decision = decided.get(key(g.customer, g.arrived, g.due)) || null;
    return { customer: g.customer, arrived: g.arrived, due: g.due, notice: g.notice, cards: g.cards, work_orders: g.wos.size, rule,
      new_due: rule ? addWorkingDays(g.due, rule.extra_days, workDays) : null, decision };
  }).sort((a, b) => b.arrived.localeCompare(a.arrived) || b.cards - a.cards);
}
// The ones waiting for someone to apply or dismiss: a rule met, nothing decided yet.
const pending = (opts) => submissions(opts).filter((s) => s.rule && !s.decision);

// The live plan's jobs with their final due date: a job whose customer, arrival day and due date have
// an applied extension gets its due date and deadline moved (the export's kept as due_orig).
function applyToJobs(jobs) {
  const applied = appliedMap();
  if (!applied.size || !jobs.length) return jobs;
  const seen = new Map(db.all('SELECT key, first_seen FROM plan_history_jobs').map((r) => [r.key, r.first_seen]));
  for (const j of jobs) {
    const fs = seen.get(j.key); if (!fs || !j.due) continue;
    const ext = applied.get(key(j.customer, dayOf(fs), j.due));
    if (!ext) continue;
    j.due_orig = j.due; j.due = ext.new_due;
    j.deadline = `${ext.new_due}${j.deadline ? j.deadline.slice(10) : 'T23:59'}`;
    j.volume_ext = { id: ext.id, extra_days: ext.extra_days, cards: ext.cards, arrived: ext.arrived, due_orig: ext.due, new_due: ext.new_due, by: ext.decided_by };
  }
  return jobs;
}

// The history's deadlines follow the decisions: an applied extension moves its work orders' deadline
// (the export's due date stays in `due`), an undone one puts it back; a done job's lateness is worked
// out again. Run after each export is recorded and after each decision.
function syncHistory() {
  const applied = appliedMap();
  let changed = 0;
  // the jobs of customers with an extension, and any whose deadline isn't on its due date any more
  const custs = [...new Set([...applied.values()].map((r) => r.customer.toUpperCase()))];
  const rows = db.all(`SELECT id, customer, due, deadline, first_seen, done_at, late_minutes FROM plan_history_jobs
    WHERE due IS NOT NULL AND deadline IS NOT NULL AND (substr(deadline, 1, 10) <> due${custs.length ? ` OR upper(customer) IN (${custs.map(() => '?').join(',')})` : ''})`, custs);
  db.tx(() => {
    for (const r of rows) {
      const ext = r.first_seen ? applied.get(key(r.customer, dayOf(r.first_seen), r.due)) : null;
      const want = `${ext ? ext.new_due : r.due}${r.deadline.slice(10)}`;
      if (want === r.deadline) continue;
      const late = r.done_at ? Math.round((new Date(r.done_at) - localDate(want)) / 60000) : r.late_minutes;
      db.run('UPDATE plan_history_jobs SET deadline = ?, late_minutes = ? WHERE id = ?', [want, late, r.id]);
      changed++;
    }
  });
  return changed;
}

// Applied extensions over a time frame of due dates (for Reporting's OTD: the final due date counts).
const appliedBetween = (from, to) => db.all("SELECT * FROM plan_volume_ext WHERE status = 'applied' AND due <= ? AND new_due >= ? ORDER BY due, customer", [to, from]);

module.exports = { rules, decisions, submissions, pending, applyToJobs, syncHistory, addWorkingDays, ruleFor, appliedBetween, key };
