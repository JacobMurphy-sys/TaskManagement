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

// ⏱ When each perso job that left the export was really done. The export only says *that* it's done
// (it's gone), and only as of the read that noticed — hours or days late if no copy of the app was
// running. The timing reports (prod_runs, every run since 1 January, re-read each hour) say *when*:
// the end of its last run, remakes left out (a run named …PER0001 is that job; one without a PER
// counts for every job of its work order). done_by:
//   'runs'   — the last run's end (never after the export noticed it gone)
//   'export' — no runs: when it left the export, read within GAP_HOURS of the read before
//   'gap'    — no runs, and the export wasn't read for longer: done somewhere in [gap_from, done_at].
//              On time if its deadline is after the gap, late if before it; otherwise unknown
//              (late_unknown) — left out of the on-time %, and out of the pace.
const GAP_HOURS = 4;
const localIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
function withFinish(jobs) {
  if (!jobs.length) return [];
  const oldest = jobs.reduce((m, j) => (j.first_seen && j.first_seen < m ? j.first_seen : m), jobs[0].first_seen || jobs[0].done_at);
  const from = new Date(new Date(oldest).getTime() - 30 * 86400000);
  let runs = [];
  try { runs = db.all("SELECT job, MAX(end_at) AS end_at, SUM(qty) AS cards FROM prod_runs WHERE source = 'perso' AND remake = 0 AND end_at IS NOT NULL AND job NOT LIKE 'M%' AND end_at >= ? GROUP BY job", [localIso(from)]); } catch { /* no runs yet */ }
  const byKey = new Map(); const byWo = new Map();
  const put = (m, k, r) => { const x = m.get(k); if (!x) m.set(k, { end_at: r.end_at, cards: r.cards || 0 }); else { if (r.end_at > x.end_at) x.end_at = r.end_at; x.cards += r.cards || 0; } };
  for (const r of runs) {
    const J = String(r.job || '').trim().toUpperCase(); const wo = J.match(/^[A-Z]{5}\d{8}/)?.[0]; if (!wo) continue;
    const per = J.slice(wo.length).match(/^\D*(\d+)/)?.[1];
    if (per) put(byKey, `${wo}/${per.padStart(4, '0')}`, r); else put(byWo, wo, r);
  }
  const reads = db.all('SELECT file_modified FROM plan_history_reads ORDER BY file_modified').map((r) => r.file_modified);
  const before = (iso) => { let lo = 0; let hi = reads.length - 1; let ans = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (reads[mid] < iso) { ans = reads[mid]; lo = mid + 1; } else hi = mid - 1; } return ans; };
  return jobs.map((j) => {
    if (!j.done_at) return j;
    const doneAt = new Date(j.done_at); const dl = j.deadline ? localDate(j.deadline) : null;
    const r = byKey.get(String(j.key).toUpperCase()) || byWo.get(String(j.wo || '').toUpperCase());
    if (r) {
      let f = localDate(r.end_at.slice(0, 16)); if (f > doneAt) f = doneAt;
      return { ...j, done_at: f.toISOString(), left_export_at: j.done_at, late_minutes: dl ? Math.round((f - dl) / 60000) : null, done_by: 'runs', run_cards: r.cards };
    }
    const prev = before(j.done_at);
    if (prev && doneAt - new Date(prev) > GAP_HOURS * 3600000) {
      const p = new Date(prev);
      const late = !dl ? null : dl >= doneAt ? Math.round((doneAt - dl) / 60000) : dl < p ? Math.round((p - dl) / 60000) : null;
      return { ...j, done_by: 'gap', gap_from: prev, late_minutes: late, late_unknown: !!dl && late === null };
    }
    return { ...j, done_by: 'export' };
  });
}
// The perso jobs done since a time, with their real done times (for the backlog's pace): [{ date, qty }]
// by the day they were done; the ones done during a gap in the record are left out.
function donePerDay(sinceIso, ymd) {
  const from = new Date(new Date(sinceIso).getTime() - 7 * 86400000).toISOString(); // a job leaves the export after its last run
  return withFinish(db.all('SELECT * FROM plan_history_jobs WHERE done_at IS NOT NULL AND done_at >= ?', [from]))
    .filter((j) => j.done_by !== 'gap' && j.done_at >= sinceIso).map((j) => ({ date: ymd(j.done_at), qty: j.qty }));
}

// ⏱ Perso, the same on every PC: built only from the timing report (every run since 1 January, read
// whole each time), never from what one copy of the app happened to record. Cards persoed on the day
// their run ended (remakes and M work orders left out); on time when that day isn't after the job's
// due date in the report (no due date: not known). A job is done when its runs reach its quantity —
// on the day its last run ended. Lead time: the report's import date → that last run.
const runKey = (job) => { const J = String(job || '').trim().toUpperCase(); const wo = J.match(/^[A-Z]{5}\d{8}/)?.[0]; if (!wo) return { key: J, wo: J, per: null };
  const per = J.slice(wo.length).match(/^\D*(\d+)/)?.[1]; return { key: per ? `${wo}/${per.padStart(4, '0')}` : wo, wo, per: per ? per.padStart(4, '0') : null }; };
function persoRuns(fromDay) {
  try {
    return db.all(`SELECT job, machine, end_at, qty, job_qty, due, imported, trigram, customer FROM prod_runs
      WHERE source = 'perso' AND remake = 0 AND end_at IS NOT NULL AND job NOT LIKE 'M%' AND end_at >= ? ORDER BY end_at`, [fromDay]);
  } catch { return []; }
}
// The jobs in a set of runs: { key → { key, wo, per, customer, cards, job_qty, due, imported, last, machines, complete } }
function jobsOfRuns(runs) {
  const m = new Map();
  for (const r of runs) {
    const k = runKey(r.job);
    const j = m.get(k.key) || m.set(k.key, { ...k, customer: r.trigram || r.customer || null, cards: 0, job_qty: 0, due: null, imported: null, last: null, machines: new Set() }).get(k.key);
    j.cards += r.qty || 0; j.job_qty = Math.max(j.job_qty, r.job_qty || 0);
    if (r.due && (!j.due || r.due > j.due)) j.due = r.due;
    if (r.imported && (!j.imported || r.imported < j.imported)) j.imported = r.imported;
    if (!j.last || r.end_at > j.last) j.last = r.end_at;
    if (r.machine) j.machines.add(r.machine);
  }
  for (const j of m.values()) { j.complete = !j.job_qty || j.cards >= j.job_qty; j.machines = [...j.machines].join(', '); }
  return m;
}
function persoRunsSummary(days) {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  const sinceDay = ymd(since);
  // a job's earlier runs may be before the window: look back a month for them
  const back = new Date(since); back.setDate(back.getDate() - 31);
  const runs = persoRuns(ymd(back));
  const inWin = runs.filter((r) => r.end_at.slice(0, 10) >= sinceDay);
  const onTime = (r) => (r.due ? r.end_at.slice(0, 10) <= r.due : null);
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since); d.setDate(since.getDate() + i); const day = ymd(d);
    const list = inWin.filter((r) => r.end_at.slice(0, 10) === day);
    const sum = (l) => l.reduce((t, r) => t + (r.qty || 0), 0);
    daily.push({ date: day, jobs: new Set(list.map((r) => runKey(r.job).key)).size, cards: sum(list), on_time_cards: sum(list.filter((r) => onTime(r) === true)), unknown_cards: sum(list.filter((r) => onTime(r) === null)), gap_cards: 0 });
  }
  // jobs done: complete, last run in the window
  const jobs = [...jobsOfRuns(runs).values()].filter((j) => j.complete && j.last.slice(0, 10) >= sinceDay).sort((a, b) => (a.last < b.last ? 1 : -1));
  const lateDays = (j) => (j.due ? Math.round((new Date(`${j.last.slice(0, 10)}T12:00`) - new Date(`${j.due}T12:00`)) / 86400000) : null);
  const weekFrom = new Date(); weekFrom.setDate(weekFrom.getDate() - 7); const wf = ymd(weekFrom);
  const weekRuns = inWin.filter((r) => r.end_at.slice(0, 10) > wf);
  const known = weekRuns.filter((r) => onTime(r) !== null);
  const weekJobs = jobs.filter((j) => j.last.slice(0, 10) > wf);
  const leads = weekJobs.filter((j) => j.imported).map((j) => (new Date(j.last) - new Date(j.imported)) / 3600000).filter((x) => x >= 0);
  const stamp = (() => { try { return db.get("SELECT COUNT(*) AS n, MIN(start_at) AS first, MAX(end_at) AS last, MAX(read_at) AS read_at FROM prod_runs WHERE source = 'perso'"); } catch { return {}; } })();
  return {
    half: 'perso', from: 'runs', days, daily, reads: stamp.n || 0, since: stamp.first || null, last: stamp.last || null, read_at: stamp.read_at || null,
    week: { jobs: weekJobs.length, cards: weekRuns.reduce((t, r) => t + (r.qty || 0), 0),
      on_time_pct: known.length ? Math.round((known.filter((r) => onTime(r)).reduce((t, r) => t + (r.qty || 0), 0) / known.reduce((t, r) => t + (r.qty || 0), 0)) * 1000) / 10 : null,
      lead_hours: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null },
    recent: jobs.slice(0, 60).map((j) => ({ done_at: j.last, wo: j.wo, per: j.per, key: j.key, customer: j.customer, qty: j.job_qty || j.cards, deadline: j.due, late_days: lateDays(j), machines: j.machines, done_by: 'runs' })),
  };
}
// The backlog's pace from the same: cards persoed per day ({ date, qty }), cards due per day — the jobs
// in the timing report by their due date, plus the open jobs not run yet — and the first day on record.
function persoPace(sinceDay, openJobs = []) {
  const runs = persoRuns(sinceDay);
  const done = runs.map((r) => ({ date: r.end_at.slice(0, 10), qty: r.qty || 0 }));
  const byJob = jobsOfRuns(persoRuns((() => { const d = new Date(`${sinceDay}T12:00`); d.setDate(d.getDate() - 60); return d.toISOString().slice(0, 10); })()));
  const due = [...byJob.values()].filter((j) => j.due && j.due >= sinceDay).map((j) => ({ date: j.due, qty: j.job_qty || j.cards }));
  for (const o of openJobs) if (o.due && o.due >= sinceDay && !byJob.has(String(o.key).toUpperCase())) due.push({ date: o.due, qty: o.qty || 0 });
  let first = null; try { first = db.get("SELECT MIN(start_at) AS f FROM prod_runs WHERE source = 'perso'")?.f || null; } catch { /* none */ }
  return { done, due, from: first, any: runs.length > 0 || !!first };
}

// Completions per day, on time or late, and the latest ones (half: perso, otto = Matching, disp = 🚚 Dispatch).
// Perso uses the real done times (withFinish); Matching and Dispatch when they left their export.
const HISTORY = { perso: ['plan_history_jobs', 'plan_history_reads'], otto: ['plan_otto_jobs', 'plan_otto_reads'], disp: ['plan_disp_jobs', 'plan_disp_reads'] };
function summary({ days = 14, half = 'perso' } = {}) {
  // Perso: from the timing report alone, once there is one — the same figures on every PC
  if ((!HISTORY[half] || half === 'perso') && (() => { try { return !!db.get("SELECT 1 FROM prod_runs WHERE source = 'perso' LIMIT 1"); } catch { return false; } })()) return persoRunsSummary(days);
  const [jobsT, readsT] = HISTORY[half] || HISTORY.perso;
  const perso = !HISTORY[half] || half === 'perso';
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const since = new Date(); since.setHours(0, 0, 0, 0); since.setDate(since.getDate() - (days - 1));
  // a job done (its last run) in the window may only have left the export a little later
  const fetchFrom = perso ? new Date(since.getTime() - 7 * 86400000) : since;
  const rows = db.all(`SELECT * FROM ${jobsT} WHERE done_at IS NOT NULL AND done_at >= ? ORDER BY done_at DESC`, [fetchFrom.toISOString()]);
  const done = (perso ? withFinish(rows) : rows).filter((j) => j.done_at >= since.toISOString()).sort((a, b) => (a.done_at < b.done_at ? 1 : -1));
  const known = (j) => !j.late_unknown;
  const onTimeOf = (j) => known(j) && (j.late_minutes === null || j.late_minutes <= 0);
  const qty = (l) => l.reduce((t, j) => t + (j.qty || 0), 0);
  const daily = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(since); d.setDate(since.getDate() + i);
    const list = done.filter((j) => ymd(new Date(j.done_at)) === ymd(d));
    const onTime = list.filter(onTimeOf); const unknown = list.filter((j) => !known(j));
    daily.push({ date: ymd(d), jobs: list.length, cards: qty(list), on_time_jobs: onTime.length, on_time_cards: qty(onTime), unknown_cards: qty(unknown), gap_cards: qty(list.filter((j) => j.done_by === 'gap')) });
  }
  const reads = db.get(`SELECT COUNT(*) AS n, MIN(file_modified) AS first, MAX(file_modified) AS last FROM ${readsT}`);
  const pct = (list) => { const k = list.filter(known); return k.length ? Math.round((k.filter(onTimeOf).length / k.length) * 1000) / 10 : null; };
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const week = done.filter((j) => j.done_at >= weekAgo);
  // lead time: first seen → done (hours), for the week's jobs seen arriving after the history began (not those done during a gap)
  const leads = week.filter((j) => j.first_seen > reads.first && j.done_by !== 'gap').map((j) => (new Date(j.done_at) - new Date(j.first_seen)) / 3600000).filter((x) => x >= 0); // (a job first seen after its last run: left out)
  const by = perso ? { runs: done.filter((j) => j.done_by === 'runs').length, export: done.filter((j) => j.done_by === 'export').length, gap: done.filter((j) => j.done_by === 'gap').length } : null;
  return {
    half: HISTORY[half] ? half : 'perso', reads: reads.n, since: reads.first, last: reads.last, days, daily, done_by: by,
    week: { jobs: week.length, cards: qty(week), on_time_pct: pct(week), lead_hours: leads.length ? Math.round((leads.reduce((a, b) => a + b, 0) / leads.length) * 10) / 10 : null },
    recent: done.slice(0, 60),
  };
}

const ingestDisp = (jobs, modifiedIso, file) => ingestOtto(jobs, modifiedIso, file, { reads: 'plan_disp_reads', table: 'plan_disp_jobs', via: (j) => j.group });
module.exports = { ingest, ingestOtto, ingestDisp, summary, withFinish, donePerDay, persoPace, runKey, GAP_HOURS };
