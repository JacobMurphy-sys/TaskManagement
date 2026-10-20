'use strict';
// 📅 Rescheduling: whenever a due date moves (a task, project, phase or idea) or a meeting's time,
// from any screen (the record's form, the 📅 Reschedule dialog, dragging on the calendar or Gantt),
// the move is logged: from, to, the reason given (reschedule_reason in the save), and who.
// Setting a first date isn't a reschedule; clearing one is (to nothing). A due date only counts as
// moved when its day changes.
const db = require('./db');
const collab = require('./collab');

const TARGETS = [
  [/^\/tasks\/(\d+)$/, 'tasks', 'task', 'due_at'],
  [/^\/projects\/(\d+)$/, 'projects', 'project', 'due_at'],
  [/^\/phases\/(\d+)$/, 'project_phases', 'phase', 'due_at'],
  [/^\/ideas\/(\d+)$/, 'ideas', 'idea', 'due_at'],
  [/^\/meetings\/(\d+)$/, 'meetings', 'meeting', 'held_at'],
];
const KINDS = Object.fromEntries(TARGETS.map(([, table, kind, field]) => [kind, { table, field }]));
// a due date's day, in local time (they're kept as the end of that day)
const day = (iso) => { if (!iso) return null; const d = new Date(iso); return Number.isNaN(d.getTime()) ? String(iso) : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const moved = (field, a, b) => (field === 'held_at' ? a !== b : day(a) !== day(b));

function middleware(req, res, next) {
  const t = TARGETS.find(([re]) => re.test(req.path));
  if (!t) return next();
  const [re, table, kind, field] = t;
  const id = Number(req.path.match(re)[1]);
  // deleted: its moves go too (an id can be used again)
  if (req.method === 'DELETE') { res.on('finish', () => { if (res.statusCode < 400) { try { db.run('DELETE FROM reschedules WHERE kind = ? AND record_id = ?', [kind, id]); } catch { /* fine */ } } }); return next(); }
  if (req.method !== 'PATCH' && req.method !== 'PUT') return next();
  const reason = req.body && typeof req.body === 'object' ? String(req.body.reschedule_reason ?? '').trim().slice(0, 500) || null : null;
  if (req.body && typeof req.body === 'object') delete req.body.reschedule_reason;
  if (!req.body || !(field in req.body)) return next();
  const before = db.get(`SELECT ${field} AS v FROM ${table} WHERE id = ?`, [id])?.v ?? null;
  res.on('finish', () => {
    if (res.statusCode >= 400 || before === null) return;
    try {
      const after = db.get(`SELECT ${field} AS v FROM ${table} WHERE id = ?`, [id])?.v ?? null;
      if (!moved(field, before, after)) return;
      db.run('INSERT INTO reschedules (kind, record_id, from_value, to_value, reason, by_name) VALUES (?, ?, ?, ?, ?, ?)', [kind, id, before, after, reason, collab.whoOf(req)]);
    } catch { /* the move itself is saved; only its log entry is missed */ }
  });
  next();
}

// A record's moves, newest first.
// (only moves made since the record was made: one deleted with its project leaves its moves behind)
const since = (kind) => `(SELECT created_at FROM ${KINDS[kind].table} x WHERE x.id = reschedules.record_id)`;
const historyOf = (kind, id) => db.all(`SELECT id, from_value, to_value, reason, by_name, created_at FROM reschedules WHERE kind = ? AND record_id = ? AND created_at >= ${since(kind)} ORDER BY id DESC`, [kind, Number(id)]);
// How many times each of these was moved: { id: n }.
function counts(kind, ids) {
  if (!ids.length) return {};
  const out = {};
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all(`SELECT record_id, COUNT(*) AS n FROM reschedules WHERE kind = ? AND record_id IN (${chunk.map(() => '?').join(',')}) AND created_at >= ${since(kind)} GROUP BY record_id`, [kind, ...chunk])) out[r.record_id] = r.n;
  }
  return out;
}

module.exports = { middleware, historyOf, counts, KINDS };
