'use strict';
// 🏭 Planning history: each new version of the open work orders export (by its saved time) is
// recorded once. A job seen open and missing from the next export is done at that export's
// time (to within the export interval, e.g. an hour); it's on time when that's not after its
// deadline. A job that comes back is open again. An export with no jobs is ignored, so a
// failed export can't mark everything done.

const db = require('./db');
const planning = require('./planning');

// "2026-10-06T16:00" (local) → Date
const localDate = (s) => { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = (t || '23:59').split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };

// Records one export (its parsed lines and saved time). Returns what changed, or null when
// that version was already recorded.
function ingest(lines, modifiedIso, file = null) {
  if (!lines?.length) return null;
  if (db.get('SELECT id FROM plan_history_reads WHERE file_modified = ?', [modifiedIso])) return null;
  const last = db.get('SELECT file_modified, file FROM plan_history_reads ORDER BY id DESC LIMIT 1'); // the one read last
  // a different file linked: jobs only seen in the old one weren't done — they're dropped, not counted
  const switched = !!(last && file && last.file && last.file.toLowerCase() !== file.toLowerCase());
  // an older copy of the same file: history only moves forward (another file's saved times don't count)
  if (last && !switched && modifiedIso < last.file_modified) return null;
  const jobs = planning.jobsOf(lines);
  const at = new Date(modifiedIso);
  let done = 0; let reopened = 0;
  db.tx(() => {
    const seen = new Set();
    for (const j of jobs) {
      seen.add(j.key);
      // its cards and how many, as this export has them (a card on several lines counted together)
      const byCard = new Map();
      for (const a of j.articles) if (a.article) byCard.set(a.article, (byCard.get(a.article) || 0) + (a.qty || 0));
      for (const [article, qty] of byCard) db.run('INSERT INTO plan_history_lines (key, wo, article, qty) VALUES (?, ?, ?, ?) ON CONFLICT(key, article) DO UPDATE SET qty = excluded.qty', [j.key, j.wo, article, qty]);
      const old = db.get('SELECT * FROM plan_history_jobs WHERE key = ?', [j.key]);
      if (!old) {
        db.run(`INSERT INTO plan_history_jobs (key, wo, per, customer, qty, due, deadline, prio, shipper, first_seen, last_seen, started_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [j.key, j.wo, j.per, j.customer, j.qty, j.due, j.deadline, j.prio, j.shipper, modifiedIso, modifiedIso, j.running ? modifiedIso : null]);
      } else {
        if (old.done_at) reopened++;
        db.run(`UPDATE plan_history_jobs SET qty = ?, due = ?, deadline = ?, prio = ?, shipper = ?, last_seen = ?, done_at = NULL, late_minutes = NULL,
          started_at = COALESCE(started_at, ?) WHERE id = ?`, [j.qty, j.due, j.deadline, j.prio, j.shipper, modifiedIso, j.running ? modifiedIso : null, old.id]);
      }
    }
    for (const o of db.all('SELECT * FROM plan_history_jobs WHERE done_at IS NULL')) {
      if (seen.has(o.key)) continue;
      if (switched) { db.run('DELETE FROM plan_history_jobs WHERE id = ?', [o.id]); continue; }
      const late = o.deadline ? Math.round((at - localDate(o.deadline)) / 60000) : null;
      db.run('UPDATE plan_history_jobs SET done_at = ?, late_minutes = ? WHERE id = ?', [modifiedIso, late, o.id]);
      done++;
    }
    db.run('INSERT INTO plan_history_reads (file_modified, file, read_at, jobs, cards, running, done) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [modifiedIso, file, new Date().toISOString(), jobs.length, jobs.reduce((t, j) => t + j.qty, 0), jobs.filter((j) => j.running).length, done]);
  });
  return { jobs: jobs.length, done, reopened };
}

// Matching (and 🚚 Dispatch, in its own tables with its GROUP as via): each new version of its export (parsed jobs, saved time), recorded once. A job is done when the
// export says so (Is Done / a finished status) or it's gone from it; late against its plan date and time.
function ingestOtto(jobs, modifiedIso, file = null, { reads = 'plan_otto_reads', table = 'plan_otto_jobs', via = (j) => j.machine } = {}) {
  const list = (jobs || []).filter((j) => !j.test);
  if (!list.length) return null;
  if (db.get(`SELECT id FROM ${reads} WHERE file_modified = ?`, [modifiedIso])) return null;
  const last = db.get(`SELECT file_modified, file FROM ${reads} ORDER BY id DESC LIMIT 1`);
  const switched = !!(last && file && last.file && last.file.toLowerCase() !== file.toLowerCase());
  if (last && !switched && modifiedIso < last.file_modified) return null;
  const at = new Date(modifiedIso);
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  let added = 0; let done = 0;
  db.tx(() => {
    const seen = new Set();
    const finish = (row) => { const late = row.deadline ? Math.round((at - localDate(row.deadline)) / 60000) : null; db.run(`UPDATE ${table} SET done_at = ?, late_minutes = ? WHERE id = ?`, [modifiedIso, late, row.id]); done++; };
    for (const j of list) {
      seen.add(j.key);
      const deadline = j.due ? `${j.due}T${hm(j.time ?? 23 * 60 + 59)}` : null;
      let row = db.get(`SELECT * FROM ${table} WHERE key = ?`, [j.key]);
      if (!row) {
        db.run(`INSERT INTO ${table} (key, wo, customer, qty, due, deadline, prio, machine, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [j.key, j.wo, j.customer, j.qty, j.due, deadline, j.prio, via(j) || null, modifiedIso, modifiedIso]);
        added++; row = db.get(`SELECT * FROM ${table} WHERE key = ?`, [j.key]);
      } else {
        db.run(`UPDATE ${table} SET qty = ?, due = ?, deadline = ?, prio = ?, machine = COALESCE(?, machine), last_seen = ? WHERE id = ?`, [j.qty, j.due, deadline, j.prio, via(j) || null, modifiedIso, row.id]);
        row = { ...row, deadline };
        if (!j.done && row.done_at) db.run(`UPDATE ${table} SET done_at = NULL, late_minutes = NULL WHERE id = ?`, [row.id]); // open again
      }
      if (j.done && !row.done_at) finish(row);
    }
    for (const o of db.all(`SELECT * FROM ${table} WHERE done_at IS NULL`)) {
      if (seen.has(o.key)) continue;
      if (switched) { db.run(`DELETE FROM ${table} WHERE id = ?`, [o.id]); continue; }
      finish(o);
    }
    db.run(`INSERT INTO ${reads} (file_modified, file, read_at, jobs) VALUES (?, ?, ?, ?)`, [modifiedIso, file, new Date().toISOString(), list.length]);
  });
  return { jobs: list.length, added, done };
}

// Completions per day, on time or late, and the latest ones (half: perso, otto = Matching, disp = 🚚 Dispatch).
const HISTORY = { perso: ['plan_history_jobs', 'plan_history_reads'], otto: ['plan_otto_jobs', 'plan_otto_reads'], disp: ['plan_disp_jobs', 'plan_disp_reads'] };
function summary({ days = 14, half = 'perso' } = {}) {
  const [jobsT, readsT] = HISTORY[half] || HISTORY.perso;
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  const done = db.all(`SELECT * FROM ${jobsT} WHERE done_at IS NOT NULL AND done_at >= ? ORDER BY done_at DESC`, [since.toISOString()]);
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since); d.setDate(since.getDate() + i);
    const list = done.filter((j) => ymd(new Date(j.done_at)) === ymd(d));
    const onTime = list.filter((j) => j.late_minutes === null || j.late_minutes <= 0);
    daily.push({ date: ymd(d), jobs: list.length, cards: list.reduce((t, j) => t + (j.qty || 0), 0), on_time_jobs: onTime.length, on_time_cards: onTime.reduce((t, j) => t + (j.qty || 0), 0) });
  }
  const reads = db.get(`SELECT COUNT(*) AS n, MIN(file_modified) AS first, MAX(file_modified) AS last FROM ${readsT}`);
  const pct = (list) => (list.length ? Math.round((list.filter((j) => j.late_minutes === null || j.late_minutes <= 0).length / list.length) * 1000) / 10 : null);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const week = done.filter((j) => j.done_at >= weekAgo);
  // lead time: first seen → done (hours), for the week's jobs seen arriving after the history began
  const leads = week.filter((j) => j.first_seen > reads.first).map((j) => (new Date(j.done_at) - new Date(j.first_seen)) / 3600000);
  return {
    half: HISTORY[half] ? half : 'perso', reads: reads.n, since: reads.first, last: reads.last, days, daily,
    week: { jobs: week.length, cards: week.reduce((t, j) => t + (j.qty || 0), 0), on_time_pct: pct(week), lead_hours: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null },
    recent: done.slice(0, 60),
  };
}

const ingestDisp = (jobs, modifiedIso, file) => ingestOtto(jobs, modifiedIso, file, { reads: 'plan_disp_reads', table: 'plan_disp_jobs', via: (j) => j.group });
module.exports = { ingest, ingestOtto, ingestDisp, summary };
