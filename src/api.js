const express = require('express');
const db = require('./db');
const backup = require('./backup');
const { readBackup, restoreData, BadBackup } = require('./restore');
const { sanitizeHtml, htmlToText } = require('./richtext');
const log = require('./logger');
const config = require('./config');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseQuick, nextOccurrence, shiftKey, dateKey } = require('./dates');
const { buildXlsx } = require('./xlsx');
const { RECURRENCES } = require('./schema');
const charter = require('./charter');
const prod = require('./prodactual');
const planLearn = require('./planlearn');
const planFind = require('./planfind');
const accounts = require('./accounts');
const collab = require('./collab');
const reschedule = require('./reschedule');

const router = express.Router();

// Wraps handlers so errors (sync or async) reach the error middleware.
const h = (fn) => (req, res, next) => {
  try { Promise.resolve(fn(req, res, next)).catch(next); } catch (err) { next(err); }
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const notFound = (what) => new HttpError(404, `${what} not found`);

const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

// Normalises any date/time the client sends into canonical UTC ISO text.
function toIso(v, field) {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new HttpError(400, `Invalid ${field}`);
  return d.toISOString();
}

// Due dates are whole days: a plain YYYY-MM-DD is stored as the end of that day in
// the PC's local time, so it only counts as overdue once the day is over.
function toDueIso(v) {
  if (v === null || v === undefined || v === '') return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    if (Number.isNaN(d.getTime()) || d.getDate() !== Number(m[3])) throw new HttpError(400, 'Invalid due date');
    return d.toISOString();
  }
  return toIso(v, 'due date');
}

// Money typed as "1,250.50" or "£1250" -> 1250.5 (null when blank).
function parseMoney(v, label) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  if (Number.isNaN(n) || n < 0) throw new HttpError(400, `${label} must be a positive number`);
  return Math.round(n * 100) / 100;
}

const MONEY_FIELDS = { cost: 'Cost', budget: 'Budget', amount: 'Amount' };
const DATE_FIELDS = { start_date: 'start date', spent_on: 'date' };

// A task can have several owners, stored as one "Sam Patel, Maintenance" string so
// every list, export and report shows them as they are. Split on commas/semicolons.
const splitOwners = (v) => String(v ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
function normOwners(v) {
  const seen = new Set();
  const list = (Array.isArray(v) ? v.flatMap(splitOwners) : splitOwners(v))
    .filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
  return list.length ? list.join(', ') : null;
}
const ownsTask = (owner, name) => splitOwners(owner).some((o) => o.toLowerCase() === String(name).trim().toLowerCase());

// Picks only allowed keys from a body, turning '' into null and normalising values.
function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body[k] === undefined) continue;
    let v = body[k] === '' ? null : body[k];
    if (k === 'due_at') v = toDueIso(v);
    if (k === 'remind_at') v = toIso(v, k);
    if (k === 'held_at') v = toIso(v, 'meeting date/time');
    if (k === 'duration_min' && v !== null) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 5 || v > 1440) throw new HttpError(400, 'Duration must be between 5 minutes and 24 hours');
    }
    if (k === 'notes' && v !== null) v = sanitizeHtml(v) || null;
    if (k in DATE_FIELDS && v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Invalid ${DATE_FIELDS[k]}`);
    if (k in MONEY_FIELDS) v = parseMoney(v, MONEY_FIELDS[k]);
    if ((k === 'impact' || k === 'effort') && v !== null) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, `${k} must be 1 to 5`);
    }
    if (k === 'recurrence' && v !== null && !RECURRENCES.includes(v)) throw new HttpError(400, 'Invalid repeat setting');
    if (k === 'waiting_on') v = v === null ? null : (String(v).trim() || null);
    if (k === 'owner') v = normOwners(v);
    out[k] = v;
  }
  return out;
}

function insertRow(table, fields) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined); // unset -> column default
  return db.get(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`,
    keys.map((k) => fields[k]),
  );
}

function updateRow(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return db.get(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  return db.get(
    `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? RETURNING *`,
    [...keys.map((k) => fields[k]), id],
  );
}

// Triggers stamp updated_at/completed_at after the statement, so re-read to return them.
const fresh = (table, row) => (row ? db.get(`SELECT * FROM ${table} WHERE id = ?`, [row.id]) : row);

const parseJson = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };
const normProject = (p) => p && { ...p, baseline_snapshot: parseJson(p.baseline_snapshot),
  ...('current_phase' in p ? { current_phase: parseJson(p.current_phase) } : {}) };
const normTask = (t) => t && { ...t, is_baseline: !!t.is_baseline };
const normAudit = (e) => ({ ...e, old_data: parseJson(e.old_data), new_data: parseJson(e.new_data) });

const CHARTER_TEXT = ['project_code', 'sponsor', 'leader', 'policy_deployment', 'category', 'gm_effect', 'problem',
  'goals', 'in_scope', 'out_scope', 'benefits_quantified', 'benefits_other'];
const PROJECT_FIELDS = ['name', 'description', 'status', 'priority', 'start_date', 'due_at', 'budget', ...CHARTER_TEXT];

// A project needs the core of its charter; checked on create, and on edit for fields being changed.
function checkCharter(fields, creating) {
  for (const [k, labelText] of Object.entries(charter.REQUIRED)) {
    const present = k in fields;
    if ((creating || present) && !String(fields[k] ?? '').trim()) throw new HttpError(400, `${labelText} is required`);
  }
}
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'due_at', 'sort_order', 'parent_id',
  'start_date', 'waiting_on', 'recurrence', 'owner', 'phase_id'];
const PHASE_FIELDS = ['name', 'description', 'status', 'start_date', 'due_at'];

const TASK_SELECT = `
  SELECT t.*, p.name AS project_name, ph.name AS phase_name,
         (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
         (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtask_done,
         (SELECT count(*) FROM notes n WHERE n.task_id = t.id) AS note_count,
         (SELECT count(*) FROM attachments f WHERE f.task_id = t.id) AS attachment_count,
         (SELECT min(r.remind_at) FROM reminders r WHERE r.task_id = t.id AND r.status = 'pending') AS next_reminder
  FROM tasks t LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN project_phases ph ON ph.id = t.phase_id`;
// each with how many times its due date was moved (📅 reschedules)
const tasks = (where, params = []) => {
  const list = db.all(`${TASK_SELECT} ${where}`, params).map(normTask);
  const moved = reschedule.counts('task', list.map((t) => t.id));
  for (const t of list) t.moved = moved[t.id] || 0;
  return list;
};

// ------------------------------------------------------------------ projects

router.get('/projects', h((req, res) => {
  const includeArchived = req.query.all === '1';
  const rows = db.all(`
    SELECT p.*,
           count(t.id)                                                   AS task_count,
           count(t.id) FILTER (WHERE t.status = 'done')                  AS done_count,
           count(t.id) FILTER (WHERE t.status <> 'done' AND t.due_at < ?) AS overdue_count,
           count(t.id) FILTER (WHERE t.status = 'in_progress')            AS in_progress_count,
           count(t.id) FILTER (WHERE t.status = 'blocked')                AS blocked_count,
           (SELECT min(t2.due_at) FROM tasks t2 WHERE t2.project_id = p.id AND t2.status <> 'done') AS next_due_at,
           (SELECT max(created_at) FROM notes n WHERE n.project_id = p.id) AS last_note_at,
           (SELECT max(changed_at) FROM audit_log a WHERE a.project_id = p.id) AS last_activity_at,
           (SELECT coalesce(sum(amount), 0) FROM project_costs c WHERE c.project_id = p.id) AS spent,
           (SELECT count(*) FROM project_phases ph WHERE ph.project_id = p.id) AS phase_count,
           (SELECT count(*) FROM project_phases ph WHERE ph.project_id = p.id AND ph.status = 'done') AS phases_done,
           (SELECT json_object('id', ph.id, 'name', ph.name, 'due_at', ph.due_at, 'position',
              (SELECT count(*) FROM project_phases x WHERE x.project_id = p.id
                 AND (x.sort_order < ph.sort_order OR (x.sort_order = ph.sort_order AND x.id <= ph.id))))
            FROM project_phases ph WHERE ph.project_id = p.id AND ph.status = 'open'
            ORDER BY ph.sort_order, ph.id LIMIT 1) AS current_phase
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    ${includeArchived ? '' : "WHERE p.status <> 'archived'"}
    GROUP BY p.id
    ORDER BY (p.status = 'active') DESC, p.priority DESC, p.due_at IS NULL, p.due_at, p.name COLLATE NOCASE`,
  [nowIso()]);
  res.json(rows.map((p) => ({ ...normProject(p), charter_pct: charter.completeness(p, charterExtras(p.id)).pct })));
}));

// Team, KPIs and milestone rows that complete a project's charter.
function charterExtras(projectId) {
  return {
    team: ((deptOf) => db.all('SELECT * FROM project_team WHERE project_id = ? ORDER BY sort_order, id', [projectId])
      .map((m) => ({ ...m, department: deptOf(m.name) })))(departmentOf()),
    kpis: db.all('SELECT * FROM project_kpis WHERE project_id = ? ORDER BY sort_order, id', [projectId]),
    milestones: db.all(`SELECT id, title, status, owner, start_date, due_at, completed_at FROM tasks
      WHERE project_id = ? AND parent_id IS NULL ORDER BY sort_order, id`, [projectId]),
    phases: projectPhases(projectId),
    // All tasks, with when work actually started (first move to In progress / Done).
    tasks: db.all(`SELECT t.id, t.parent_id, t.title, t.status, t.owner, t.start_date, t.due_at, t.completed_at,
        (SELECT min(a.changed_at) FROM audit_log a WHERE a.table_name = 'tasks' AND a.record_id = t.id
          AND json_extract(a.new_data, '$.status') IN ('in_progress', 'done')) AS actual_start
      FROM tasks t WHERE t.project_id = ? ORDER BY t.sort_order, t.id`, [projectId]),
  };
}

// A project's phases in order, with progress worked out from their tasks (subtasks included).
function projectPhases(projectId) {
  return db.all(`
    SELECT ph.*,
      count(t.id) AS task_count,
      count(t.id) FILTER (WHERE t.status = 'done') AS done_count,
      count(t.id) FILTER (WHERE t.status = 'blocked') AS blocked_count,
      count(t.id) FILTER (WHERE t.status <> 'done' AND t.due_at < ?) AS overdue_count,
      count(t.id) FILTER (WHERE t.status IN ('in_progress', 'done')) AS started_count,
      min(t.start_date) AS first_task_start,
      max(t.due_at) AS last_task_due,
      (SELECT min(a.changed_at) FROM audit_log a JOIN tasks t2 ON t2.id = a.record_id
        WHERE a.table_name = 'tasks' AND t2.phase_id = ph.id
          AND json_extract(a.new_data, '$.status') IN ('in_progress', 'done')) AS actual_start
    FROM project_phases ph LEFT JOIN tasks t ON t.phase_id = ph.id
    WHERE ph.project_id = ? GROUP BY ph.id ORDER BY ph.sort_order, ph.id`, [nowIso(), projectId]);
}

// Creates a project with optional baseline tasks and first note. Call inside a transaction.
function createProject(body) {
  const fields = pick(body, PROJECT_FIELDS);
  checkCharter(fields, body.require_charter !== false);
  const baselineTasks = (body.baseline_tasks || []).map((s) => String(s).trim()).filter(Boolean);
  const note = String(body.initial_note || '').trim();
  const baseline = body.set_baseline !== false;
  // Team as lines of "Name, role" (or objects { name, role, capacity, contact }).
  const team = (Array.isArray(body.team) ? body.team : String(body.team || '').split(/\r?\n/)).map((m) => {
    if (m && typeof m === 'object') return pick(m, ['name', 'role', 'capacity', 'contact']);
    const [name, ...role] = String(m).split(/\s*,\s*|\s+[-–]\s+/);
    return { name, role: role.join(', ').trim() || null };
  }).filter((m) => String(m.name || '').trim());

  const p = insertRow('projects', fields);
  baselineTasks.forEach((title, i) => insertRow('tasks', { project_id: p.id, title, sort_order: i, is_baseline: baseline }));
  team.forEach((m, i) => insertRow('project_team', { ...m, name: String(m.name).trim(), project_id: p.id, sort_order: i }));
  if (note) insertRow('notes', { project_id: p.id, body: note });
  return baseline ? setBaseline(p.id) : p;
}

router.post('/projects', h((req, res) => {
  res.status(201).json(normProject(db.tx(() => createProject({ ...req.body, require_charter: true }))));
}));

router.get('/projects/:id', h((req, res) => {
  const project = db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!project) throw notFound('Project');
  const extras = charterExtras(project.id);
  res.json({
    ...normProject(project),
    charter: { ...extras, completeness: charter.completeness(project, extras) },
    tasks: tasks('WHERE t.project_id = ? ORDER BY t.sort_order, t.id', [project.id]),
    links: db.all('SELECT id, task_id, depends_on_id FROM task_links WHERE project_id = ?', [project.id]),
    costs: db.all('SELECT * FROM project_costs WHERE project_id = ? ORDER BY spent_on DESC, id DESC', [project.id]),
    spent: db.get('SELECT coalesce(sum(amount), 0) AS n FROM project_costs WHERE project_id = ?', [project.id]).n,
    escalated_from: db.get('SELECT id, ref, title FROM ideas WHERE project_id = ?', [project.id]) || null,
  });
}));

router.patch('/projects/:id', h((req, res) => {
  const fields = pick(req.body, PROJECT_FIELDS);
  checkCharter(fields, false);
  const row = fresh('projects', updateRow('projects', req.params.id, fields));
  if (!row) throw notFound('Project');
  res.json(normProject(row));
}));

router.delete('/projects/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Project');
  log.info(`Project ${req.params.id} deleted`);
  res.status(204).end();
}));

// Freezes the current plan: every existing task becomes a baseline task and
// a snapshot of the project + tasks is stored for later comparison.
function setBaseline(projectId) {
  const p = db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
  if (!p) throw notFound('Project');
  db.run('UPDATE tasks SET is_baseline = 1 WHERE project_id = ? AND is_baseline = 0', [projectId]);
  db.run('UPDATE project_phases SET baseline_due_at = due_at WHERE project_id = ?', [projectId]);
  const snapshotTasks = db.all(
    'SELECT id, parent_id, phase_id, title, status, priority, start_date, due_at FROM tasks WHERE project_id = ? ORDER BY sort_order, id',
    [projectId]);
  const snapshotPhases = db.all('SELECT id, name, start_date, due_at FROM project_phases WHERE project_id = ? ORDER BY sort_order, id', [projectId]);
  const snapshot = {
    name: p.name, description: p.description, priority: p.priority,
    start_date: p.start_date, due_at: p.due_at, tasks: snapshotTasks, phases: snapshotPhases,
  };
  db.run('UPDATE projects SET baseline_set_at = ?, baseline_due_at = due_at, baseline_snapshot = ? WHERE id = ?',
    [nowIso(), snapshot, projectId]);
  return db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
}

router.post('/projects/:id/baseline', h((req, res) => {
  res.json(normProject(db.tx(() => setBaseline(req.params.id))));
}));

// Notes + audit events for a project, newest first.
router.get('/projects/:id/timeline', h((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  const notes = db.all(`
    SELECT n.id, n.task_id, n.body, n.created_at, n.updated_at, t.title AS task_title
    FROM notes n LEFT JOIN tasks t ON t.id = n.task_id
    WHERE n.project_id = ? ORDER BY n.created_at DESC LIMIT ?`, [req.params.id, limit]);
  const events = db.all(`
    SELECT * FROM audit_log WHERE project_id = ? AND table_name NOT IN ('notes', 'meetings')
    ORDER BY changed_at DESC, id DESC LIMIT ?`, [req.params.id, limit]).map(normAudit);
  const meetings = meetingList('m.project_id = ?', [req.params.id]);
  const items = [
    ...notes.map((n) => ({ type: 'note', at: n.created_at, ...n })),
    ...meetings.filter((m) => m.held_at <= nowIso()).map((m) => ({ type: 'meeting', at: m.held_at, ...m })),
    ...events.map((e) => ({ type: 'event', at: e.changed_at, id: e.id, text: describeAudit(e) }))
      .filter((e) => e.text),
  ].sort((a, b) => b.at.localeCompare(a.at));
  res.json(items.slice(0, limit));
}));

// ------------------------------------------------------------------ phases

// A task's phase must be one of its own project's phases.
function checkPhase(phaseId, projectId) {
  if (phaseId === undefined || phaseId === null) return;
  const ph = db.get('SELECT project_id FROM project_phases WHERE id = ?', [phaseId]);
  if (!ph) throw notFound('Phase');
  if (Number(ph.project_id) !== Number(projectId)) throw new HttpError(400, 'That phase belongs to a different project');
}

function checkPhaseDates(current, fields) {
  const start = 'start_date' in fields ? fields.start_date : current?.start_date;
  const due = 'due_at' in fields ? fields.due_at : current?.due_at;
  if (start && due && start > dateKey(new Date(due))) throw new HttpError(400, 'The phase starts after its end date');
  if ('name' in fields && !String(fields.name ?? '').trim()) throw new HttpError(400, 'Phase name is required');
  if ('status' in fields && !['open', 'done'].includes(fields.status)) throw new HttpError(400, 'Invalid phase status');
}

router.get('/projects/:id/phases', h((req, res) => res.json(projectPhases(req.params.id))));

router.post('/projects/:id/phases', h((req, res) => {
  if (!db.get('SELECT 1 FROM projects WHERE id = ?', [req.params.id])) throw notFound('Project');
  const fields = pick(req.body, PHASE_FIELDS);
  checkPhaseDates(null, { name: fields.name ?? '', ...fields });
  fields.name = String(fields.name).trim();
  const sort = db.get('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM project_phases WHERE project_id = ?', [req.params.id]).n;
  const phase = db.tx(() => {
    const ph = insertRow('project_phases', { ...fields, project_id: Number(req.params.id), sort_order: sort });
    // Optionally put existing top-level tasks (with their subtasks) into the new phase.
    for (const id of Array.isArray(req.body.task_ids) ? req.body.task_ids : []) {
      const t = db.get('SELECT id, project_id, parent_id FROM tasks WHERE id = ?', [id]);
      if (!t || t.project_id !== ph.project_id || t.parent_id) continue;
      const ids = subtreeIds(t.id);
      db.run(`UPDATE tasks SET phase_id = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, [ph.id, ...ids]);
    }
    return ph;
  });
  res.status(201).json(projectPhases(req.params.id).find((x) => x.id === phase.id));
}));

router.patch('/phases/:id', h((req, res) => {
  const current = db.get('SELECT * FROM project_phases WHERE id = ?', [req.params.id]);
  if (!current) throw notFound('Phase');
  const fields = pick(req.body, PHASE_FIELDS);
  checkPhaseDates(current, fields);
  if (fields.name) fields.name = String(fields.name).trim();
  updateRow('project_phases', current.id, fields);
  res.json(projectPhases(current.project_id).find((x) => x.id === current.id));
}));

// New order for a project's phases: { ids: [phaseId, ...] }.
router.post('/projects/:id/phases/order', h((req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number);
  const mine = db.all('SELECT id FROM project_phases WHERE project_id = ?', [req.params.id]).map((r) => r.id);
  if (ids.length !== mine.length || !mine.every((id) => ids.includes(id))) throw new HttpError(400, 'Give every phase of the project, in the new order');
  db.tx(() => ids.forEach((id, i) => db.run('UPDATE project_phases SET sort_order = ? WHERE id = ? AND sort_order IS NOT ?', [i, id, i])));
  res.json(projectPhases(req.params.id));
}));

// Deleting a phase keeps its tasks (they just have no phase afterwards).
router.delete('/phases/:id', h((req, res) => {
  const ph = db.get('SELECT * FROM project_phases WHERE id = ?', [req.params.id]);
  if (!ph) throw notFound('Phase');
  db.tx(() => {
    db.run('UPDATE tasks SET phase_id = NULL WHERE phase_id = ?', [ph.id]);
    db.run('DELETE FROM project_phases WHERE id = ?', [ph.id]);
  });
  res.status(204).end();
}));

// ------------------------------------------------------------------ tasks

router.get('/tasks', h((req, res) => {
  const where = ["(p.id IS NULL OR p.status <> 'archived')"];
  const params = [];
  if (req.query.project_id) { params.push(req.query.project_id); where.push('t.project_id = ?'); }
  if (req.query.standalone === '1') where.push('t.project_id IS NULL');
  if (req.query.top_level === '1') where.push('t.parent_id IS NULL');
  if (req.query.open === '1') where.push("t.status <> 'done'");
  res.json(tasks(`WHERE ${where.join(' AND ')}
    ORDER BY t.priority DESC, t.due_at IS NULL, t.due_at, t.sort_order, t.id`, params));
}));

// Keeps waiting_since in step with waiting_on, and start <= due.
function applyTaskRules(current, fields) {
  if ('waiting_on' in fields) {
    if (!fields.waiting_on) fields.waiting_since = null;
    else if (!current || current.waiting_on !== fields.waiting_on) fields.waiting_since = nowIso();
  }
  const start = 'start_date' in fields ? fields.start_date : current?.start_date;
  const due = 'due_at' in fields ? fields.due_at : current?.due_at;
  if (start && due && start > dateKey(new Date(due))) throw new HttpError(400, 'The start date is after the due date');
}

// When a repeating task is completed, create its next occurrence (with fresh copies
// of its subtasks). Only once per task, however often it's ticked and unticked.
function spawnNextOccurrence(taskId) {
  const t = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!t || t.status !== 'done' || !t.recurrence || t.next_task_id) return null;
  const { due, shiftDays } = nextOccurrence(t.due_at, t.recurrence);
  const next = insertRow('tasks', {
    project_id: t.project_id, parent_id: t.parent_id, phase_id: t.phase_id, title: t.title, description: t.description,
    priority: t.priority, due_at: toDueIso(due), start_date: t.start_date ? shiftKey(t.start_date, shiftDays) : null,
    recurrence: t.recurrence, is_baseline: t.is_baseline, sort_order: t.sort_order,
  });
  for (const sub of db.all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order, id', [t.id])) {
    insertRow('tasks', {
      project_id: t.project_id, parent_id: next.id, phase_id: t.phase_id, title: sub.title, description: sub.description,
      priority: sub.priority, is_baseline: t.is_baseline, sort_order: sub.sort_order,
    });
  }
  db.run('UPDATE tasks SET next_task_id = ? WHERE id = ?', [next.id, t.id]);
  return normTask(fresh('tasks', next));
}

const nextSortOrder = (projectId) =>
  db.get('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM tasks WHERE project_id IS ?', [projectId ?? null]).n;

const subtreeIds = (id) => db.all(`WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL
  SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id) SELECT id FROM sub`, [id]).map((r) => r.id);

// Moves a task (with its subtasks, notes and reminders) into a project, or out to the
// standalone Tasks list (projectId null). Dependencies that would cross projects are dropped.
function moveTask(taskId, projectId) {
  const t = db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!t) throw notFound('Task');
  if (projectId && !db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
  if ((t.project_id ?? null) === (projectId ?? null)) return;
  const ids = subtreeIds(t.id);
  const inList = ids.map(() => '?').join(', ');
  db.run(`DELETE FROM task_links WHERE (task_id IN (${inList})) <> (depends_on_id IN (${inList}))`, [...ids, ...ids]);
  if (projectId) db.run(`UPDATE task_links SET project_id = ? WHERE task_id IN (${inList})`, [projectId, ...ids]);
  else db.run(`DELETE FROM task_links WHERE task_id IN (${inList})`, ids);
  // Work moved into a project is new scope compared with its baseline.
  db.run(`UPDATE tasks SET project_id = ?, is_baseline = 0, phase_id = NULL WHERE id IN (${inList})`, [projectId ?? null, ...ids]);
  db.run('UPDATE tasks SET parent_id = NULL, sort_order = ? WHERE id = ?', [nextSortOrder(projectId), t.id]);
  db.run(`UPDATE notes SET project_id = ? WHERE task_id IN (${inList})`, [projectId ?? null, ...ids]);
  db.run(`UPDATE meetings SET project_id = ? WHERE task_id IN (${inList})`, [projectId ?? null, ...ids]);
  db.run(`UPDATE attachments SET project_id = ? WHERE task_id IN (${inList})
    OR meeting_id IN (SELECT id FROM meetings WHERE task_id IN (${inList}))`, [projectId ?? null, ...ids, ...ids]);
  db.run(`UPDATE reminders SET project_id = ? WHERE task_id IN (${inList})`, [projectId ?? null, ...ids]);
}

// Names for the Owner field: the project's team first, then anyone who has owned a task.
router.get('/tasks/owner-names', h((req, res) => {
  const team = req.query.project_id
    ? db.all('SELECT name FROM project_team WHERE project_id = ? ORDER BY sort_order, id', [req.query.project_id]).map((r) => r.name) : [];
  res.json(dedupeNames([...team, ...recentOwners()]));
}));

const dedupeNames = (names) => {
  const seen = new Set();
  return names.filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()));
};
// Individual names from recent tasks' owner lists, most recent first.
// People get a department from the list named "Departments". departmentsList() is that
// list (or undefined); departmentOf() maps lower-cased names to their department.
const departmentsList = () => db.get("SELECT * FROM name_lists WHERE name = 'Departments' COLLATE NOCASE");
function departmentOf() {
  const map = new Map();
  for (const r of db.all('SELECT name, department FROM name_list_items WHERE department IS NOT NULL ORDER BY active DESC, sort_order')) {
    if (!map.has(r.name.toLowerCase())) map.set(r.name.toLowerCase(), r.department);
  }
  return (name) => map.get(String(name || '').trim().toLowerCase()) || null;
}
const cleanDepartment = (v) => String(v ?? '').replace(/\s+/g, ' ').trim() || null;

const recentOwners = () => dedupeNames(db.all(`SELECT owner FROM tasks WHERE owner IS NOT NULL
  ORDER BY updated_at DESC LIMIT 400`).flatMap((r) => splitOwners(r.owner))).slice(0, 60);

// Everything the owner / attendee pickers offer, in groups: the project's team, each
// list from Settings → People & departments, then other names used before.
// Each group: { label, names, details: { name: 'role / department / email' } }.
router.get('/owner-options', h((req, res) => {
  const groups = [];
  const deptOf = departmentOf();
  const group = (label, people) => {
    const seen = new Set();
    const list = people.filter((x) => x.name && !seen.has(x.name.toLowerCase()) && seen.add(x.name.toLowerCase()));
    groups.push({ label, names: list.map((x) => x.name), details: Object.fromEntries(list.filter((x) => x.detail).map((x) => [x.name, x.detail])),
      departments: Object.fromEntries(list.map((x) => [x.name, deptOf(x.name)]).filter(([, d]) => d)) });
  };
  if (req.query.project_id) {
    const p = db.get('SELECT leader, sponsor FROM projects WHERE id = ?', [req.query.project_id]);
    const team = db.all('SELECT name, role, contact FROM project_team WHERE project_id = ? ORDER BY sort_order, id', [req.query.project_id]);
    group('Project team', [{ name: p?.leader, detail: 'Project leader' },
      ...team.map((m) => ({ name: m.name, detail: [m.role, m.contact].filter(Boolean).join(' · ') })), { name: p?.sponsor, detail: 'Management sponsor' }]);
  }
  const depts = departmentsList();
  for (const l of db.all('SELECT * FROM name_lists ORDER BY sort_order, name')) {
    group(l.name, db.all('SELECT name, detail FROM name_list_items WHERE list_id = ? AND active = 1 ORDER BY sort_order, name', [l.id]));
    // The Departments group also says who is in each one (active people only).
    if (depts && l.id === depts.id) {
      const g = groups[groups.length - 1];
      g.members = {};
      for (const d of g.names) {
        const people = db.all(`SELECT DISTINCT name FROM name_list_items WHERE active = 1 AND list_id <> ? AND department = ?
          ORDER BY name COLLATE NOCASE`, [l.id, d]).map((r) => r.name);
        if (people.length) g.members[d] = people;
      }
    }
  }
  const listed = new Set(groups.flatMap((g) => g.names.map((n) => n.toLowerCase())));
  group('Used before', recentOwners().filter((n) => !listed.has(n.toLowerCase())).map((name) => ({ name })));
  res.json(groups.filter((g) => g.names.length));
}));

// Everyone on a project team, with the projects they're on (for the Contacts page).
router.get('/contacts/teams', h((req, res) => {
  const rows = db.all(`SELECT m.name, m.role, m.contact, p.id AS project_id, p.name AS project_name, p.status
    FROM project_team m JOIN projects p ON p.id = m.project_id WHERE p.status <> 'archived'
    ORDER BY m.name COLLATE NOCASE, p.name COLLATE NOCASE`);
  const people = new Map();
  const deptOf = departmentOf();
  for (const r of rows) {
    const key = r.name.trim().toLowerCase();
    const person = people.get(key) || { name: r.name.trim(), department: deptOf(r.name), roles: [], contact: null, projects: [] };
    if (r.role && !person.roles.includes(r.role)) person.roles.push(r.role);
    person.contact = person.contact || r.contact;
    person.projects.push({ id: r.project_id, name: r.project_name, status: r.status });
    people.set(key, person);
  }
  res.json([...people.values()]);
}));

// ---- Settings → People & departments ------------------------------------------------

router.get('/name-lists', h((req, res) => {
  const lists = db.all('SELECT * FROM name_lists ORDER BY sort_order, name');
  // How many open tasks name each entry as an owner (so it's clear what a rename/removal touches).
  const owners = db.all("SELECT owner FROM tasks WHERE owner IS NOT NULL AND status <> 'done'").map((r) => r.owner);
  const depts = departmentsList();
  const all = db.all('SELECT * FROM name_list_items ORDER BY sort_order, name');
  res.json(lists.map((l) => ({ ...l, fixed: isFixedList(l), departments: !!depts && l.id === depts.id, items: all.filter((i) => i.list_id === l.id).map((i) => {
    const item = { ...i, active: !!i.active, open_tasks: owners.filter((o) => ownsTask(o, i.name)).length };
    if (depts && l.id === depts.id) {
      // A department's open tasks: ones it owns itself, plus ones owned by anyone in it.
      const members = dedupeNames(all.filter((m) => m.list_id !== l.id && m.department && m.department.toLowerCase() === i.name.toLowerCase()).map((m) => m.name));
      item.members = members;
      item.dept_open_tasks = owners.filter((o) => ownsTask(o, i.name) || members.some((m) => ownsTask(o, m))).length;
    }
    return item;
  }) })));
}));

router.post('/name-lists', h((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'List name is required');
  if (db.get('SELECT 1 FROM name_lists WHERE name = ?', [name])) throw new HttpError(400, `There's already a list called "${name}"`);
  const sort = db.get('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM name_lists').n;
  res.status(201).json(insertRow('name_lists', { name, sort_order: sort }));
}));

// The two built-in lists, People and Departments, keep their names (people's departments
// come from the Departments list), so they can't be renamed or deleted. Lists you add can.
const FIXED_LISTS = ['people', 'departments'];
const isFixedList = (l) => !!l && FIXED_LISTS.includes(String(l.name).toLowerCase());
const lockedList = (id) => {
  const l = db.get('SELECT * FROM name_lists WHERE id = ?', [id]);
  if (isFixedList(l)) throw new HttpError(400, `The ${l.name} list is built in, so it can't be renamed or deleted`);
};

router.patch('/name-lists/:id', h((req, res) => {
  const f = {};
  if ('name' in req.body) {
    lockedList(req.params.id);
    f.name = String(req.body.name || '').trim();
    if (!f.name) throw new HttpError(400, 'List name is required');
    if (db.get('SELECT 1 FROM name_lists WHERE name = ? AND id <> ?', [f.name, req.params.id])) throw new HttpError(400, `There's already a list called "${f.name}"`);
    if (FIXED_LISTS.includes(f.name.toLowerCase())) throw new HttpError(400, `"${f.name}" is the name of a built-in list`);
  }
  if ('sort_order' in req.body) f.sort_order = Number(req.body.sort_order) || 0;
  const row = fresh('name_lists', updateRow('name_lists', req.params.id, f));
  if (!row) throw notFound('List');
  res.json(row);
}));

router.delete('/name-lists/:id', h((req, res) => {
  lockedList(req.params.id);
  if (!db.run('DELETE FROM name_lists WHERE id = ?', [req.params.id]).changes) throw notFound('List');
  res.status(204).end();
}));

// Add one entry ({ name, detail }) or several at once ({ names: "one per line" }).
router.post('/name-lists/:id/items', h((req, res) => {
  if (!db.get('SELECT 1 FROM name_lists WHERE id = ?', [req.params.id])) throw notFound('List');
  const names = req.body.names !== undefined ? String(req.body.names).split(/\r?\n/) : [req.body.name];
  const wanted = dedupeNames(names.map((n) => String(n ?? '').replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim()));
  if (!wanted.length) throw new HttpError(400, 'Name is required');
  const added = db.tx(() => {
    let sort = db.get('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM name_list_items WHERE list_id = ?', [req.params.id]).n;
    return wanted.filter((name) => !db.get('SELECT 1 FROM name_list_items WHERE list_id = ? AND name = ?', [req.params.id, name]))
      .map((name) => insertRow('name_list_items', { list_id: Number(req.params.id), name,
        detail: wanted.length === 1 ? (String(req.body.detail || '').trim() || null) : null,
        department: cleanDepartment(req.body.department), sort_order: sort++ }));
  });
  if (!added.length) throw new HttpError(400, wanted.length === 1 ? `"${wanted[0]}" is already in this list` : 'Those names are all in the list already');
  res.status(201).json({ added: added.length, skipped: wanted.length - added.length });
}));

// A contact's new name, carried everywhere the old one is used, so nothing loses its link:
// task and action owners, meeting attendees, project teams, leaders and sponsors.
// Returns how many tasks changed.
function renameEverywhere(from, to) {
  const same = (n) => String(n || '').trim().toLowerCase() === from.toLowerCase();
  const swap = (list) => normOwners(splitOwners(list).map((o) => (same(o) ? to : o)));
  let tasks = 0;
  for (const t of db.all('SELECT id, owner FROM tasks WHERE owner IS NOT NULL')) {
    if (!ownsTask(t.owner, from)) continue;
    db.run('UPDATE tasks SET owner = ? WHERE id = ?', [swap(t.owner), t.id]);
    tasks++;
  }
  for (const t of db.all('SELECT id, waiting_on FROM tasks WHERE waiting_on IS NOT NULL')) {
    if (ownsTask(t.waiting_on, from)) db.run('UPDATE tasks SET waiting_on = ? WHERE id = ?', [swap(t.waiting_on), t.id]);
  }
  for (const m of db.all('SELECT id, attendees FROM meetings WHERE attendees IS NOT NULL')) {
    if (ownsTask(m.attendees, from)) db.run('UPDATE meetings SET attendees = ? WHERE id = ?', [swap(m.attendees), m.id]);
  }
  for (const m of db.all('SELECT id, name FROM project_team')) if (same(m.name)) db.run('UPDATE project_team SET name = ? WHERE id = ?', [to, m.id]);
  for (const p of db.all('SELECT id, leader, sponsor FROM projects')) {
    if (same(p.leader)) db.run('UPDATE projects SET leader = ? WHERE id = ?', [to, p.id]);
    if (same(p.sponsor)) db.run('UPDATE projects SET sponsor = ? WHERE id = ?', [to, p.id]);
  }
  return tasks;
}

// Renaming an entry renames it everywhere it's used (see renameEverywhere).
router.patch('/name-list-items/:id', h((req, res) => {
  const item = db.get('SELECT * FROM name_list_items WHERE id = ?', [req.params.id]);
  if (!item) throw notFound('Entry');
  const f = {};
  if ('name' in req.body) {
    f.name = String(req.body.name || '').replace(/[,;]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!f.name) throw new HttpError(400, 'Name is required');
    if (db.get('SELECT 1 FROM name_list_items WHERE list_id = ? AND name = ? AND id <> ?', [item.list_id, f.name, item.id])) {
      throw new HttpError(400, `"${f.name}" is already in this list`);
    }
  }
  if ('detail' in req.body) f.detail = String(req.body.detail || '').trim() || null;
  if ('active' in req.body) f.active = req.body.active ? 1 : 0;
  if ('department' in req.body) f.department = cleanDepartment(req.body.department);
  let renamed = 0;
  let moved = 0;
  db.tx(() => {
    updateRow('name_list_items', item.id, f);
    // Renaming a department moves everyone in it to the new name.
    if (f.name && f.name !== item.name && item.list_id === departmentsList()?.id) {
      for (const m of db.all('SELECT id FROM name_list_items WHERE department = ? AND list_id <> ?', [item.name, item.list_id])) {
        updateRow('name_list_items', m.id, { department: f.name });
        moved++;
      }
    }
    if (f.name && f.name !== item.name) renamed = renameEverywhere(item.name, f.name);
  });
  res.json({ ...fresh('name_list_items', item), renamed_tasks: renamed, moved_people: moved });
}));

router.delete('/name-list-items/:id', h((req, res) => {
  const item = db.get('SELECT * FROM name_list_items WHERE id = ?', [req.params.id]);
  if (!item) throw notFound('Entry');
  if (item.list_id === departmentsList()?.id) {
    const people = db.get('SELECT count(*) AS n FROM name_list_items WHERE department = ? AND list_id <> ?', [item.name, item.list_id]).n;
    if (people) throw new HttpError(400, `${people} ${people === 1 ? 'person is' : 'people are'} in ${item.name} — give them another department first, or untick Active to stop offering it`);
  }
  db.run('DELETE FROM name_list_items WHERE id = ?', [item.id]);
  res.status(204).end();
}));

router.get('/tasks/waiting-names', h((req, res) => {
  res.json(db.all(`SELECT waiting_on AS name, max(coalesce(waiting_since, updated_at)) AS last FROM tasks
    WHERE waiting_on IS NOT NULL GROUP BY waiting_on COLLATE NOCASE ORDER BY last DESC LIMIT 50`).map((r) => r.name));
}));

router.post('/tasks', h((req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  applyTaskRules(null, fields);
  if (!fields.title || !String(fields.title).trim()) throw new HttpError(400, 'Task title is required');
  // No project = a standalone task in the Tasks list.
  let projectId = req.body.project_id || null;
  if (fields.parent_id) {
    const parent = db.get('SELECT project_id, phase_id FROM tasks WHERE id = ?', [fields.parent_id]);
    if (!parent) throw notFound('Parent task');
    projectId = parent.project_id;
    fields.phase_id = parent.phase_id; // subtasks follow their parent's phase
  }
  if (projectId && !db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
  checkPhase(fields.phase_id, projectId);
  if (fields.sort_order === undefined) fields.sort_order = nextSortOrder(projectId);
  const task = fresh('tasks', insertRow('tasks', { ...fields, project_id: projectId }));
  res.status(201).json(normTask(task));
}));

router.get('/tasks/:id', h((req, res) => {
  const [task] = tasks('WHERE t.id = ?', [req.params.id]);
  if (!task) throw notFound('Task');
  const history = db.all(
    "SELECT * FROM audit_log WHERE table_name = 'tasks' AND record_id = ? ORDER BY changed_at DESC, id DESC", [task.id])
    .map(normAudit);
  res.json({
    ...task,
    depends_on: db.all(`SELECT l.id AS link_id, t.id, t.title, t.status, t.due_at FROM task_links l
      JOIN tasks t ON t.id = l.depends_on_id WHERE l.task_id = ? ORDER BY t.sort_order, t.id`, [task.id]),
    blocking: db.all(`SELECT l.id AS link_id, t.id, t.title, t.status, t.start_date FROM task_links l
      JOIN tasks t ON t.id = l.task_id WHERE l.depends_on_id = ? ORDER BY t.sort_order, t.id`, [task.id]),
    subtasks: tasks('WHERE t.parent_id = ? ORDER BY t.sort_order, t.id', [task.id]),
    notes: db.all('SELECT * FROM notes WHERE task_id = ? ORDER BY created_at DESC', [task.id]),
    attachments: db.all('SELECT * FROM attachments WHERE task_id = ? ORDER BY created_at, id', [task.id]),
    meeting: task.meeting_id ? db.get('SELECT id, title, held_at FROM meetings WHERE id = ?', [task.meeting_id]) || null : null,
    meetings: meetingList('m.task_id = ?', [task.id]),
    reminders: db.all('SELECT * FROM reminders WHERE task_id = ? ORDER BY remind_at', [task.id]),
    history: history.map((e) => ({ at: e.changed_at, text: describeAudit(e) })).filter((e) => e.text),
  });
}));

router.patch('/tasks/:id', h((req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  let nextOcc = null;
  const task = db.tx(() => {
    const current = db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!current) throw notFound('Task');
    applyTaskRules(current, fields);
    if ('project_id' in req.body) moveTask(current.id, req.body.project_id || null);
    const projectId = db.get('SELECT project_id FROM tasks WHERE id = ?', [current.id]).project_id;
    if (fields.parent_id) fields.phase_id = db.get('SELECT phase_id FROM tasks WHERE id = ?', [fields.parent_id])?.phase_id ?? null;
    else if ('phase_id' in fields && current.parent_id && !('parent_id' in fields)) {
      throw new HttpError(400, 'Subtasks follow their parent task\'s phase; change the parent task instead');
    }
    checkPhase(fields.phase_id, projectId);
    const row = updateRow('tasks', req.params.id, fields);
    // The whole subtree moves with a task's phase.
    if ('phase_id' in fields) {
      const ids = subtreeIds(row.id).filter((x) => x !== row.id);
      if (ids.length) db.run(`UPDATE tasks SET phase_id = ? WHERE id IN (${ids.map(() => '?').join(', ')})`, [fields.phase_id, ...ids]);
    }
    // Optionally complete / reopen all subtasks along with the parent.
    if (req.body.cascade && fields.status) {
      db.run(`
        WITH RECURSIVE sub(id) AS (
          SELECT id FROM tasks WHERE parent_id = ?
          UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
        UPDATE tasks SET status = ? WHERE id IN (SELECT id FROM sub) AND status <> ?`,
      [row.id, fields.status, fields.status]);
    }
    if (fields.status === 'done') nextOcc = spawnNextOccurrence(row.id);
    return fresh('tasks', row);
  });
  res.json({ ...normTask(task), next_occurrence: nextOcc });
}));

// New order for some tasks of one list ({ ids } in the order wanted): subtasks of one
// task, or the top-level tasks of one project (or of the standalone Tasks list).
// The list may be filtered (completed hidden, one phase), so the given tasks take
// the places they already occupied among all their siblings; then all are renumbered.
router.post('/tasks/reorder', h((req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(Number);
  if (!ids.length || new Set(ids).size !== ids.length) throw new HttpError(400, 'Give each task to reorder once');
  const rows = ids.map((id) => db.get('SELECT id, project_id, parent_id FROM tasks WHERE id = ?', [id]));
  if (rows.some((r) => !r)) throw notFound('Task');
  const { project_id: projectId, parent_id: parentId } = rows[0];
  if (rows.some((r) => r.parent_id !== parentId || (!parentId && r.project_id !== projectId))) {
    throw new HttpError(400, 'Only tasks in the same list can be reordered together');
  }
  db.tx(() => {
    const order = (parentId
      ? db.all('SELECT id FROM tasks WHERE parent_id = ? ORDER BY sort_order, id', [parentId])
      : db.all('SELECT id FROM tasks WHERE parent_id IS NULL AND project_id IS ? ORDER BY sort_order, id', [projectId])).map((r) => r.id);
    const moved = new Set(ids);
    order.map((id, i) => (moved.has(id) ? i : -1)).filter((i) => i >= 0).forEach((slot, k) => { order[slot] = ids[k]; });
    order.forEach((id, i) => db.run('UPDATE tasks SET sort_order = ? WHERE id = ? AND sort_order IS NOT ?', [i, id, i]));
  });
  res.json({ ok: true });
}));

// Dependencies (for the Gantt chart): task :id can't start until depends_on_id is done.
router.post('/tasks/:id/dependencies', h((req, res) => {
  const link = db.tx(() => {
    const t = db.get('SELECT id, project_id FROM tasks WHERE id = ?', [req.params.id]);
    const dep = db.get('SELECT id, project_id FROM tasks WHERE id = ?', [req.body.depends_on_id]);
    if (!t || !dep) throw notFound('Task');
    if (t.id === dep.id) throw new HttpError(400, 'A task can\'t depend on itself');
    if (!t.project_id || !dep.project_id) throw new HttpError(400, 'Dependencies are for tasks in projects');
    if (t.project_id !== dep.project_id) throw new HttpError(400, 'Dependencies must be in the same project');
    // Refuse loops: walk everything `dep` already waits for.
    const seen = new Set();
    const queue = [dep.id];
    while (queue.length) {
      const id = queue.shift();
      if (id === t.id) throw new HttpError(400, 'That would create a loop of dependencies');
      if (seen.has(id)) continue;
      seen.add(id);
      for (const l of db.all('SELECT depends_on_id FROM task_links WHERE task_id = ?', [id])) queue.push(l.depends_on_id);
    }
    if (db.get('SELECT 1 FROM task_links WHERE task_id = ? AND depends_on_id = ?', [t.id, dep.id])) {
      throw new HttpError(400, 'That dependency already exists');
    }
    return insertRow('task_links', { project_id: t.project_id, task_id: t.id, depends_on_id: dep.id });
  });
  res.status(201).json(link);
}));

// Turns a standalone task into a project (the charter is required). Its subtasks become
// the project's tasks and its notes and reminders move across.
router.post('/tasks/:id/promote', h((req, res) => {
  const project = db.tx(() => {
    const t = db.get('SELECT * FROM tasks WHERE id = ?', [req.params.id]);
    if (!t) throw notFound('Task');
    if (t.project_id) throw new HttpError(400, 'Only standalone tasks can be promoted to a project');
    const p = createProject({
      priority: t.priority, due_at: t.due_at, start_date: t.start_date, ...req.body,
      name: req.body.name || t.title, set_baseline: false,
    });
    for (const child of db.all('SELECT id FROM tasks WHERE parent_id = ? ORDER BY sort_order, id', [t.id])) moveTask(child.id, p.id);
    db.run('UPDATE notes SET project_id = ?, task_id = NULL WHERE task_id = ?', [p.id, t.id]);
    db.run('UPDATE reminders SET project_id = ?, task_id = NULL WHERE task_id = ?', [p.id, t.id]);
    db.run('UPDATE meetings SET project_id = ?, task_id = NULL WHERE task_id = ?', [p.id, t.id]);
    insertRow('notes', { project_id: p.id,
      body: `Promoted from the task "${t.title}" (added ${new Date(t.created_at).toLocaleDateString(undefined, { dateStyle: 'medium' })}).` });
    db.run('DELETE FROM tasks WHERE id = ?', [t.id]);
    return req.body.set_baseline === false ? p : setBaseline(p.id);
  });
  res.status(201).json(normProject(project));
}));

router.delete('/task-links/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM task_links WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Dependency');
  res.status(204).end();
}));

router.delete('/tasks/:id', h((req, res) => {
  const changes = db.tx(() => {
    // Meetings on a standalone task go with it; on a project task they stay on the project.
    const ids = subtreeIds(Number(req.params.id));
    db.run(`DELETE FROM meetings WHERE project_id IS NULL AND task_id IN (${ids.map(() => '?').join(', ')})`, ids);
    return db.run('DELETE FROM tasks WHERE id = ?', [req.params.id]).changes;
  });
  if (!changes) throw notFound('Task');
  res.status(204).end();
}));

// ------------------------------------------------------------------ meetings

const MEETING_FIELDS = ['title', 'held_at', 'location', 'attendees', 'notes', 'duration_min'];
const MEETING_SELECT = `
  SELECT m.*, p.name AS project_name, t.title AS task_title,
    (SELECT count(*) FROM tasks a WHERE a.meeting_id = m.id) AS action_count,
    (SELECT count(*) FROM tasks a WHERE a.meeting_id = m.id AND a.status = 'done') AS actions_done
  FROM meetings m LEFT JOIN projects p ON p.id = m.project_id LEFT JOIN tasks t ON t.id = m.task_id`;
const meetingList = (where, params = [], order = 'm.held_at DESC, m.id DESC') =>
  db.all(`${MEETING_SELECT} WHERE ${where} ORDER BY ${order}`, params);

function getMeeting(id) {
  const m = db.get(`${MEETING_SELECT} WHERE m.id = ?`, [id]);
  if (!m) throw notFound('Meeting');
  return { ...m, actions: tasks('WHERE t.meeting_id = ? ORDER BY t.created_at, t.id', [m.id]),
    attachments: db.all('SELECT * FROM attachments WHERE meeting_id = ? ORDER BY created_at, id', [m.id]) };
}

router.get('/meetings', h((req, res) => {
  // For the calendar: meetings starting in [from, to) (plus the day before, which may run over).
  if (req.query.from && req.query.to) {
    const from = toIso(req.query.from, 'from');
    const to = toIso(req.query.to, 'to');
    const dayBefore = new Date(new Date(from).getTime() - 86400000).toISOString();
    return res.json(meetingList(`m.held_at >= ? AND m.held_at < ? AND (p.id IS NULL OR p.status <> 'archived')`, [dayBefore, to], 'm.held_at, m.id'));
  }
  if (req.query.project_id) return res.json(meetingList('m.project_id = ?', [req.query.project_id]));
  if (req.query.task_id) return res.json(meetingList('m.task_id = ?', [req.query.task_id]));
  res.json(meetingList('1', [], 'm.held_at DESC, m.id DESC LIMIT 200'));
}));

router.get('/meetings/:id', h((req, res) => res.json(getMeeting(req.params.id))));

// A meeting on a project ({ project_id }) or a task ({ task_id }).
router.post('/meetings', h((req, res) => {
  const fields = pick(req.body, MEETING_FIELDS);
  if (!String(fields.title || '').trim()) throw new HttpError(400, 'Meeting title is required');
  if (!fields.held_at) throw new HttpError(400, 'Meeting date and time are required');
  let projectId = req.body.project_id || null;
  const taskId = req.body.task_id || null;
  if (taskId) {
    const t = db.get('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
    if (!t) throw notFound('Task');
    projectId = t.project_id;
  } // neither: a meeting of its own (e.g. created on the calendar)
  if (projectId && !db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
  const m = insertRow('meetings', { ...fields, title: String(fields.title).trim(), project_id: projectId, task_id: taskId });
  res.status(201).json(getMeeting(m.id));
}));

router.patch('/meetings/:id', h((req, res) => {
  const fields = pick(req.body, MEETING_FIELDS);
  if ('title' in fields && !String(fields.title || '').trim()) throw new HttpError(400, 'Meeting title is required');
  if ('held_at' in fields && !fields.held_at) throw new HttpError(400, 'Meeting date and time are required');
  if (!updateRow('meetings', req.params.id, fields)) throw notFound('Meeting');
  res.json(getMeeting(req.params.id));
}));

// Deleting a meeting keeps the actions agreed at it (as ordinary tasks).
router.delete('/meetings/:id', h((req, res) => {
  if (!db.run('DELETE FROM meetings WHERE id = ?', [req.params.id]).changes) throw notFound('Meeting');
  res.status(204).end();
}));

// An agreed action: a task on the meeting's project, or a subtask of the meeting's task.
// The title understands the quick-add syntax (!high @fri *weekly).
router.post('/meetings/:id/actions', h((req, res) => {
  const m = db.get('SELECT * FROM meetings WHERE id = ?', [req.params.id]);
  if (!m) throw notFound('Meeting');
  const q = parseQuick(String(req.body.title || '').trim());
  if (!q.title) throw new HttpError(400, 'Action text is required');
  const extra = pick(req.body, ['owner', 'due_at']);
  const parent = m.task_id ? db.get('SELECT id, project_id, phase_id FROM tasks WHERE id = ?', [m.task_id]) : null;
  const projectId = parent ? parent.project_id : m.project_id;
  const when = new Date(m.held_at).toLocaleDateString(undefined, { dateStyle: 'medium' });
  const task = insertRow('tasks', {
    project_id: projectId, parent_id: parent?.id ?? null, phase_id: parent?.phase_id ?? null, meeting_id: m.id,
    title: q.title, priority: q.priority, recurrence: q.recurrence, owner: extra.owner ?? null,
    due_at: extra.due_at ?? toDueIso(q.due_at), description: `Agreed at the meeting "${m.title}" on ${when}.`,
    sort_order: nextSortOrder(projectId),
  });
  res.status(201).json(tasks('WHERE t.id = ?', [task.id])[0]);
}));

// ------------------------------------------------------------------ attachments

const ATTACH_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  avif: 'image/avif', pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', log: 'text/plain', mp4: 'video/mp4', mp3: 'audio/mpeg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', msg: 'application/vnd.ms-outlook', zip: 'application/zip' };
// Shown in the browser; everything else (including HTML/SVG, which could carry script) downloads.
const ATTACH_INLINE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'pdf', 'txt', 'csv', 'log', 'mp4', 'mp3']);
const attachExt = (name) => (String(name).match(/\.([a-z0-9]{1,8})$/i) || [])[1]?.toLowerCase() || '';

function saveAttachment(req, owner) {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'No file received');
  const name = path.basename(fileNameHeader(req, 'file')).replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'file';
  const safe = name.replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(-80) || 'file';
  const stored = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safe}`;
  fs.mkdirSync(config.attachDir, { recursive: true });
  fs.writeFileSync(path.join(config.attachDir, stored), req.body);
  try {
    return insertRow('attachments', { ...owner, name, stored, size: req.body.length, mime: ATTACH_MIME[attachExt(name)] || 'application/octet-stream' });
  } catch (err) { fs.rmSync(path.join(config.attachDir, stored), { force: true }); throw err; }
}

const uploadBody = express.raw({ type: () => true, limit: '100mb' });
router.post('/tasks/:id/attachments', uploadBody, h((req, res) => {
  const t = db.get('SELECT id, project_id FROM tasks WHERE id = ?', [req.params.id]);
  if (!t) throw notFound('Task');
  res.status(201).json(saveAttachment(req, { task_id: t.id, project_id: t.project_id }));
}));
router.post('/meetings/:id/attachments', uploadBody, h((req, res) => {
  const m = db.get('SELECT id, project_id FROM meetings WHERE id = ?', [req.params.id]);
  if (!m) throw notFound('Meeting');
  res.status(201).json(saveAttachment(req, { meeting_id: m.id, project_id: m.project_id }));
}));

router.get('/attachments/:id/file', h((req, res) => {
  const a = db.get('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (!a) throw notFound('Attachment');
  // The live folder, or the copy in the backups folder (e.g. after restoring a backup).
  const file = [path.join(config.attachDir, a.stored), path.join(backup.FILES_DIR, a.stored)].find((f) => fs.existsSync(f));
  if (!file || path.basename(a.stored) !== a.stored) throw notFound('The attachment’s file');
  const inline = ATTACH_INLINE.has(attachExt(a.name)) && req.query.download !== '1';
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Type', inline ? a.mime : (ATTACH_MIME[attachExt(a.name)] || 'application/octet-stream'));
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.sendFile(file);
}));

router.patch('/attachments/:id', h((req, res) => {
  const name = String(req.body.name || '').replace(/[\\/\u0000-\u001f]/g, '').trim().slice(0, 200);
  if (!name) throw new HttpError(400, 'Name is required');
  const row = fresh('attachments', updateRow('attachments', req.params.id, { name }));
  if (!row) throw notFound('Attachment');
  res.json(row);
}));

router.delete('/attachments/:id', h((req, res) => {
  const a = db.get('SELECT * FROM attachments WHERE id = ?', [req.params.id]);
  if (!a) throw notFound('Attachment');
  db.run('DELETE FROM attachments WHERE id = ?', [a.id]);
  // The file goes at the next backup, once it has been copied to the backups folder.
  res.status(204).end();
}));

// ------------------------------------------------------------------ notes

router.post('/notes', h((req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) throw new HttpError(400, 'Note text is required');
  let projectId = req.body.project_id || null;
  const taskId = req.body.task_id || null;
  // A note can start a new task: { new_task: { title: 'Call supplier !high @fri', project_id } }.
  const newTask = req.body.new_task && typeof req.body.new_task === 'object' ? req.body.new_task : null;
  if (newTask) {
    const q = parseQuick(String(newTask.title || '').trim());
    if (!q.title) throw new HttpError(400, 'The new task needs a title');
    projectId = newTask.project_id || null;
    if (projectId && !db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
    const result = db.tx(() => {
      const task = insertRow('tasks', { project_id: projectId, title: q.title, priority: q.priority, recurrence: q.recurrence,
        due_at: toDueIso(q.due_at), sort_order: nextSortOrder(projectId) });
      const { text, created } = tasksFromNote(body, projectId, task.id);
      const note = insertRow('notes', { project_id: projectId, task_id: task.id, body: text });
      return { ...note, created_tasks: created, task: normTask(fresh('tasks', task)) };
    });
    return res.status(201).json(result);
  }
  if (taskId) {
    const t = db.get('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
    if (!t) throw notFound('Task');
    projectId = t.project_id;
  }
  if (!projectId && !taskId) throw new HttpError(400, 'Choose a task, a new task or a project for the note');
  if (projectId && !db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
  const result = db.tx(() => {
    const { text, created } = tasksFromNote(body, projectId, taskId);
    return { ...insertRow('notes', { project_id: projectId, task_id: taskId, body: text }), created_tasks: created };
  });
  res.status(201).json(result);
}));

// "[ ] Chase finance !high @fri" lines in a note become tasks (subtasks when the
// note is on a task). The line is kept, marked "[→ task]" so it isn't re-created.
const CHECKLIST_LINE = /^(\s*(?:[-*•]\s*)?)\[\s?\]\s+(.+?)\s*$/;
function tasksFromNote(body, projectId, parentId) {
  const created = [];
  const today = new Date().toLocaleDateString(undefined, { dateStyle: 'medium' });
  const lines = body.split(/\r?\n/).map((line) => {
    const m = line.match(CHECKLIST_LINE);
    if (!m) return line;
    const q = parseQuick(m[2]);
    if (!q.title) return line;
    const t = insertRow('tasks', {
      project_id: projectId, parent_id: parentId, title: q.title, priority: q.priority, recurrence: q.recurrence,
      due_at: toDueIso(q.due_at), description: `Created from a note on ${today}.`, sort_order: nextSortOrder(projectId),
    });
    created.push(normTask(t));
    return `${m[1]}[→ task] ${m[2]}`;
  });
  return { text: lines.join('\n'), created };
}

router.patch('/notes/:id', h((req, res) => {
  const row = fresh('notes', updateRow('notes', req.params.id, pick(req.body, ['body'])));
  if (!row) throw notFound('Note');
  res.json(row);
}));

router.delete('/notes/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM notes WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Note');
  res.status(204).end();
}));

// ------------------------------------------------------------------ reminders

const REMINDER_SELECT = `
  SELECT r.*, t.title AS task_title, t.due_at AS task_due_at, t.status AS task_status,
         p.name AS project_name
  FROM reminders r
  LEFT JOIN tasks t ON t.id = r.task_id
  LEFT JOIN projects p ON p.id = r.project_id`;

router.get('/reminders', h((req, res) => {
  res.json(db.all(`${REMINDER_SELECT} WHERE r.status = 'pending' ORDER BY r.remind_at`));
}));

router.post('/reminders', h((req, res) => {
  const remindAt = toIso(req.body.remind_at, 'remind_at');
  if (!remindAt) throw new HttpError(400, 'remind_at is required');
  let projectId = req.body.project_id || null;
  const taskId = req.body.task_id || null;
  if (taskId) {
    const t = db.get('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
    if (!t) throw notFound('Task');
    projectId = t.project_id;
  }
  res.status(201).json(insertRow('reminders', {
    project_id: projectId, task_id: taskId, remind_at: remindAt, message: req.body.message || null,
  }));
}));

// Body: { action: 'dismiss' } or { action: 'snooze', minutes: 10 }
router.patch('/reminders/:id', h((req, res) => {
  let row;
  if (req.body.action === 'dismiss') {
    row = updateRow('reminders', req.params.id, { status: 'dismissed' });
  } else if (req.body.action === 'snooze') {
    const minutes = Math.max(1, Number(req.body.minutes) || 10);
    row = db.get(`UPDATE reminders SET remind_at = ?, snooze_count = snooze_count + 1, status = 'pending'
                  WHERE id = ? RETURNING *`, [nowIso(minutes * 60000), req.params.id]);
  } else {
    row = updateRow('reminders', req.params.id, pick(req.body, ['remind_at', 'message']));
  }
  if (!row) throw notFound('Reminder');
  res.json(fresh('reminders', row));
}));

router.delete('/reminders/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM reminders WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Reminder');
  res.status(204).end();
}));

// Polled by the browser: reminders that are due now, plus task due-date alerts.
router.get('/alerts', h((req, res) => {
  const now = nowIso();
  res.json({
    now,
    reminders: db.all(`${REMINDER_SELECT} WHERE r.status = 'pending' AND r.remind_at <= ? ORDER BY r.remind_at`, [now]),
    due_tasks: tasks(`WHERE t.status <> 'done' AND (p.id IS NULL OR p.status IN ('active', 'on_hold'))
      AND t.due_at IS NOT NULL AND t.due_at <= ? ORDER BY t.due_at`, [nowIso(24 * 3600 * 1000)]),
  });
}));

// ------------------------------------------------------------------ dashboard

router.get('/dashboard', h((req, res) => {
  // Day boundaries in the PC's local time zone.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayStart = (n) => new Date(today.getTime() + n * 86400000).toISOString();
  const now = nowIso();
  const base = "WHERE t.status <> 'done' AND (p.id IS NULL OR p.status IN ('active', 'on_hold'))";
  res.json({
    overdue: tasks(`${base} AND t.due_at < ? ORDER BY t.due_at`, [now]),
    today: tasks(`${base} AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at`, [now, dayStart(1)]),
    week: tasks(`${base} AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at`, [dayStart(1), dayStart(8)]),
    high_priority: tasks(`${base} AND t.priority >= 3 ORDER BY t.priority DESC, t.due_at IS NULL, t.due_at`),
    blocked: tasks(`${base} AND t.status = 'blocked' ORDER BY t.priority DESC, t.due_at IS NULL, t.due_at`),
    waiting: tasks(`${base} AND t.waiting_on IS NOT NULL ORDER BY t.waiting_on COLLATE NOCASE, t.waiting_since`),
    ideas: db.get(`SELECT count(*) AS open, coalesce(sum(cost), 0) AS cost FROM ideas
      WHERE status IN ('new', 'reviewing', 'approved')`),
    meetings: meetingList(`m.held_at >= ? AND m.held_at < ? AND (p.id IS NULL OR p.status <> 'archived')`,
      [dayStart(0), dayStart(8)], 'm.held_at, m.id'),
    recent_notes: db.all(`SELECT n.*, p.name AS project_name, t.title AS task_title FROM notes n
      LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id
      ORDER BY n.created_at DESC LIMIT 15`),
    reminders: db.all(`${REMINDER_SELECT} WHERE r.status = 'pending' ORDER BY r.remind_at LIMIT 20`),
  });
}));

// ------------------------------------------------------------------ ideation

const IDEA_FIELDS = ['title', 'description', 'submitted_by', 'area_id', 'priority', 'due_at', 'cost', 'status', 'impact', 'effort', 'proposed_solution', 'resolution', 'benefit'];
const IDEA_SELECT = `
  SELECT i.*, a.name AS area_name, p.name AS project_name,
         (SELECT count(*) FROM idea_notes n WHERE n.idea_id = i.id) AS note_count,
         (SELECT max(created_at) FROM idea_notes n WHERE n.idea_id = i.id) AS last_note_at
  FROM ideas i LEFT JOIN areas a ON a.id = i.area_id LEFT JOIN projects p ON p.id = i.project_id`;
const OPEN_IDEA = "i.status IN ('new', 'reviewing', 'approved')";

// The submission date (created_at) can be set back: a date keeps the time of day it had (now
// for a new idea); not in the future.
function submittedAt(v, current) {
  const s = String(v ?? '').trim();
  if (!s) throw new HttpError(400, 'The submission date can\'t be blank');
  let at;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = current ? new Date(current) : new Date();
    const [y, m, d] = s.split('-').map(Number);
    at = new Date(y, m - 1, d, t.getHours(), t.getMinutes(), t.getSeconds());
  } else at = new Date(s);
  if (Number.isNaN(at.getTime())) throw new HttpError(400, 'Invalid submission date');
  if (at > new Date(Date.now() + 60000)) throw new HttpError(400, 'The submission date can\'t be in the future');
  return at.toISOString();
}
function ideaFields(body, current = null) {
  const f = pick(body, IDEA_FIELDS);
  if (body.submitted_at !== undefined) f.created_at = submittedAt(body.submitted_at, current);
  if (f.status === 'escalated') throw new HttpError(400, 'Use "Escalate to project" to escalate an idea');
  if (f.title !== undefined && !String(f.title || '').trim()) throw new HttpError(400, 'Idea name is required');
  return f;
}

router.get('/ideas', h((req, res) => {
  const where = [];
  const params = [];
  const status = req.query.status || 'open';
  if (status === 'open') where.push(OPEN_IDEA);
  else if (status !== 'all') { where.push('i.status = ?'); params.push(status); }
  if (req.query.area_id) { where.push('i.area_id = ?'); params.push(req.query.area_id); }
  if (req.query.q) {
    const q = `%${String(req.query.q).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.proposed_solution LIKE ? ESCAPE '\\' OR i.ref LIKE ? ESCAPE '\\' OR i.submitted_by LIKE ? ESCAPE '\\')");
    params.push(q, q, q, q, q);
  }
  res.json(db.all(`${IDEA_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY i.id DESC`, params));
}));

// Distinct submitters, for the "Submitted by" suggestions.
router.get('/ideas/submitters', h((req, res) => {
  res.json(db.all(`SELECT submitted_by AS name, max(created_at) AS last FROM ideas
    WHERE coalesce(trim(submitted_by), '') <> '' GROUP BY submitted_by COLLATE NOCASE ORDER BY last DESC`).map((r) => r.name));
}));

router.post('/ideas', h((req, res) => {
  const fields = ideaFields(req.body);
  if (!fields.title) throw new HttpError(400, 'Idea name is required');
  if (req.body.submitted_at !== undefined && !String(req.body.submitted_at).trim()) delete fields.created_at;
  const idea = fresh('ideas', insertRow('ideas', fields));
  res.status(201).json(db.get(`${IDEA_SELECT} WHERE i.id = ?`, [idea.id]));
}));

router.get('/ideas/:id', h((req, res) => {
  const idea = db.get(`${IDEA_SELECT} WHERE i.id = ?`, [req.params.id]);
  if (!idea) throw notFound('Idea');
  const history = db.all(
    "SELECT * FROM audit_log WHERE table_name = 'ideas' AND record_id = ? ORDER BY changed_at DESC, id DESC", [idea.id])
    .map(normAudit);
  res.json({
    ...idea,
    notes: db.all('SELECT * FROM idea_notes WHERE idea_id = ? ORDER BY created_at DESC, id DESC', [idea.id]),
    history: history.map((e) => ({ at: e.changed_at, text: describeAudit(e) })).filter((e) => e.text),
  });
}));

router.patch('/ideas/:id', h((req, res) => {
  const current = db.get('SELECT status, created_at FROM ideas WHERE id = ?', [req.params.id]);
  if (!current) throw notFound('Idea');
  const fields = ideaFields(req.body, current.created_at);
  if (current.status === 'escalated' && fields.status) throw new HttpError(400, 'This idea has already been escalated to a project');
  updateRow('ideas', req.params.id, fields);
  res.json(db.get(`${IDEA_SELECT} WHERE i.id = ?`, [req.params.id]));
}));

router.delete('/ideas/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM ideas WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Idea');
  res.status(204).end();
}));

router.post('/ideas/:id/notes', h((req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) throw new HttpError(400, 'Note text is required');
  if (!db.get('SELECT 1 FROM ideas WHERE id = ?', [req.params.id])) throw notFound('Idea');
  res.status(201).json(insertRow('idea_notes', { idea_id: req.params.id, body }));
}));

router.delete('/idea-notes/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM idea_notes WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Note');
  res.status(204).end();
}));

// Turns an idea into a full project: copies its details and notes, and links the two.
router.post('/ideas/:id/escalate', h((req, res) => {
  const project = db.tx(() => {
    const idea = db.get(`${IDEA_SELECT} WHERE i.id = ?`, [req.params.id]);
    if (!idea) throw notFound('Idea');
    if (idea.status === 'escalated') throw new HttpError(400, `${idea.ref} has already been escalated`);
    const currency = getSettings().currency;
    const summary = [
      `Escalated from ${idea.ref} "${idea.title}".`,
      idea.submitted_by && `Submitted by: ${idea.submitted_by}`,
      idea.proposed_solution && `Proposed solution: ${idea.proposed_solution}`,
      idea.benefit && `Benefit: ${idea.benefit}`,
      idea.area_name && `Area: ${idea.area_name}`,
      idea.cost !== null && `Estimated cost: ${currency}${idea.cost.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `Raised: ${new Date(idea.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
    ].filter(Boolean).join('\n');
    const p = createProject({
      ...Object.fromEntries(CHARTER_TEXT.map((k) => [k, req.body[k]])),
      problem: req.body.problem !== undefined ? req.body.problem : idea.description,
      name: req.body.name || idea.title,
      description: req.body.description !== undefined ? req.body.description : idea.description,
      priority: req.body.priority || idea.priority,
      due_at: req.body.due_at !== undefined ? req.body.due_at : idea.due_at,
      budget: req.body.budget !== undefined ? req.body.budget : idea.cost,
      start_date: req.body.start_date,
      baseline_tasks: req.body.baseline_tasks,
      set_baseline: req.body.set_baseline,
    });
    // Notes keep their original time stamps so the project history reads in order.
    db.run('INSERT INTO notes (project_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)',
      [p.id, summary, idea.created_at, idea.created_at]);
    if (req.body.copy_notes !== false) {
      for (const n of db.all('SELECT * FROM idea_notes WHERE idea_id = ? ORDER BY created_at, id', [idea.id])) {
        db.run('INSERT INTO notes (project_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)',
          [p.id, `[${idea.ref}] ${n.body}`, n.created_at, n.created_at]);
      }
    }
    db.run("UPDATE ideas SET status = 'escalated', project_id = ? WHERE id = ?", [p.id, idea.id]);
    return p;
  });
  log.info(`Idea ${req.params.id} escalated to project ${project.id}`);
  res.status(201).json(normProject(project));
}));

// ------------------------------------------------------------------ weekly KPIs

const kpi = require('./kpi');
const zlibSync = require('zlib');
const kpiMeta = (r) => ({ id: r.id, week: r.week, year: r.year, month: r.month, source_name: r.source_name, source_modified: r.source_modified,
  loaded_at: r.updated_at, exported_at: r.exported_at, exported_to: r.exported_to, origin: r.origin === 'ci' ? 'ci' : 'excel' });
// The last workbook loaded is kept as the template for A3s the CI Manager builds itself.
const KPI_TEMPLATE = path.join(config.dataDir, 'kpi', 'template.xlsm');

function storeWeek(buf, sourceName, sourceModified) {
  const set = getSettings();
  let w;
  try {
    w = kpi.loadWeek(buf, { a3Sheet: set.kpi_a3_sheet, dbSheet: set.kpi_db_sheet, weekCell: set.kpi_week_cell });
  } catch (err) { throw new HttpError(400, err.message); }
  const row = {
    week: w.week, year: w.year, month: w.month, source_name: sourceName || null, source_modified: sourceModified || null,
    model: zlibSync.gzipSync(JSON.stringify({ views: w.views, values: w.values, sheets: w.sheets, errors: w.errors })).toString('base64'),
    pkg: w.pkg.toString('base64'), updated_at: nowIso(),
  };
  const old = db.get('SELECT id FROM kpi_snapshots WHERE week = ?', [w.week]);
  const saved = old ? fresh('kpi_snapshots', updateRow('kpi_snapshots', old.id, { ...row, origin: 'excel', exported_at: null, exported_to: null })) : insertRow('kpi_snapshots', { ...row, origin: 'excel' });
  try { fs.mkdirSync(path.dirname(KPI_TEMPLATE), { recursive: true }); fs.writeFileSync(KPI_TEMPLATE, buf); setSetting('kpi_template_week', w.week); } catch (err) { log.warn('Could not keep the workbook as the A3 template', err.message); }
  log.info(`KPI week ${w.week} ${old ? 'reloaded' : 'loaded'}`, { from: sourceName });
  return { ...kpiMeta(saved), replaced: !!old, errors: w.errors };
}

router.get('/kpi/snapshots', h((req, res) => {
  res.json(db.all('SELECT * FROM kpi_snapshots ORDER BY year DESC, week DESC').map(kpiMeta));
}));

router.get('/kpi/snapshots/:id', h((req, res) => {
  const r = db.get('SELECT * FROM kpi_snapshots WHERE id = ?', [req.params.id]);
  if (!r) throw notFound('Week');
  const edits = kpiEdits(r.week);
  // a week with no typed text of its own can start from the last earlier week that has some
  const textFrom = Object.values(edits).some((e) => e.text !== null) ? null
    : db.get("SELECT week FROM kpi_edits WHERE text IS NOT NULL AND week < ? ORDER BY week DESC LIMIT 1", [r.week])?.week || null;
  const notes = db.get('SELECT text, updated_at FROM kpi_notes WHERE week = ?', [r.week]);
  const model = JSON.parse(zlibSync.gunzipSync(Buffer.from(r.model, 'base64')).toString('utf8'));
  if (model.views?.a3) model.views.a3 = kpi.withAddedRows(model.views.a3, addedRows(r.week));
  res.json({ ...kpiMeta(r), ...model, edits, text_from: textFrom,
    notes: notes ? { text: notes.text, updated_at: notes.updated_at } : null });
}));

// ---- changes made by hand on a week's A3 (typed text, KPI colours) ----
const KPI_COLORS = { green: '00B050', yellow: 'FFC000', orange: 'FFC000', red: 'FF0000' };
// ➕ Rows added to lists on a week's A3, in the order added.
const addedRows = (week) => db.all('SELECT src_row, row, col_left, col_right FROM kpi_rows_added WHERE week = ? ORDER BY id', [week]);
const snapshotA3 = (week) => {
  const r = db.get('SELECT model FROM kpi_snapshots WHERE week = ?', [week]);
  const a3 = r ? JSON.parse(zlibSync.gunzipSync(Buffer.from(r.model, 'base64')).toString('utf8')).views?.a3 : null;
  return a3 ? kpi.withAddedRows(a3, addedRows(week)) : null;
};
const kpiEdits = (week) => Object.fromEntries(db.all('SELECT ref, text, color, size FROM kpi_edits WHERE week = ? ORDER BY ref', [week]).map((e) => [e.ref.toUpperCase(), { text: e.text, color: e.color, ...(e.size ? { size: e.size } : {}) }]));
function setKpiEdit(week, ref, f) {
  const old = db.get('SELECT * FROM kpi_edits WHERE week = ? AND ref = ?', [week, ref]);
  // the workbook's text back: no size of its own either
  if ('text' in f && f.text === null && !('size' in f)) f = { ...f, size: null };
  const next = { text: old?.text ?? null, color: old?.color ?? null, size: old?.size ?? null, ...f };
  if (next.text === null && next.color === null && next.size === null) { if (old) db.run('DELETE FROM kpi_edits WHERE id = ?', [old.id]); return; }
  if (old) updateRow('kpi_edits', old.id, f); else insertRow('kpi_edits', { week, ref, ...next });
}
const editWeek = (raw) => {
  const week = String(raw).trim().toUpperCase();
  if (!kpiData.WEEK_RE.test(week)) throw new HttpError(400, 'Not a week code');
  if (!db.get('SELECT id FROM kpi_snapshots WHERE week = ?', [week])) throw notFound('Week');
  return week;
};
// { ref, text } changes a typed box (null puts the workbook's text back); { ref, color }
// sets a KPI's colour: green, orange or red (null: as its conditional format gives).
router.put('/kpi/edits/:week', h((req, res) => {
  const week = editWeek(req.params.week);
  const ref = String(req.body.ref || '').trim().toUpperCase();
  if (!/^[A-Z]{1,3}[1-9]\d{0,5}$/.test(ref)) throw new HttpError(400, 'Not a cell reference');
  const f = {};
  if ('text' in req.body) {
    if (req.body.text !== null && typeof req.body.text !== 'string') throw new HttpError(400, 'Text must be text');
    if (req.body.text && req.body.text.length > 5000) throw new HttpError(400, 'That text is too long (5,000 characters at most)');
    f.text = req.body.text === null ? null : req.body.text.replace(/\r\n?/g, '\n');
  }
  if ('color' in req.body) {
    const c = req.body.color === null ? null : KPI_COLORS[String(req.body.color).toLowerCase()] || (Object.values(KPI_COLORS).includes(String(req.body.color).toUpperCase()) ? String(req.body.color).toUpperCase() : undefined);
    if (c === undefined) throw new HttpError(400, 'Colour must be green, yellow or red');
    f.color = c;
  }
  // the size the text is shrunk to so it fits its box (worked out by the page, which measures it)
  if ('size' in req.body) {
    const sz = req.body.size === null || req.body.size === '' ? null : Number(req.body.size);
    if (sz !== null && !(sz >= 4 && sz <= 100)) throw new HttpError(400, 'Font size must be between 4 and 100 pt');
    f.size = sz === null ? null : Math.round(sz * 2) / 2;
  }
  if (!Object.keys(f).length) throw new HttpError(400, 'Nothing to change');
  setKpiEdit(week, ref, f);
  res.json(kpiEdits(week));
}));
// A week's notes (empty text removes them).
router.put('/kpi/notes/:week', h((req, res) => {
  const week = String(req.params.week).trim().toUpperCase();
  if (!kpiData.WEEK_RE.test(week)) throw new HttpError(400, 'Not a week code');
  const text = typeof req.body.text === 'string' ? req.body.text.replace(/\r\n?/g, '\n') : '';
  if (text.length > 20000) throw new HttpError(400, 'Notes are limited to 20,000 characters');
  const old = db.get('SELECT id FROM kpi_notes WHERE week = ?', [week]);
  if (!text.trim()) { if (old) db.run('DELETE FROM kpi_notes WHERE id = ?', [old.id]); return res.json(null); }
  const row = old ? fresh('kpi_notes', updateRow('kpi_notes', old.id, { text })) : fresh('kpi_notes', insertRow('kpi_notes', { week, text }));
  res.json({ text: row.text, updated_at: row.updated_at });
}));

// Puts the whole week back as it was worked out.
router.delete('/kpi/edits/:week', h((req, res) => {
  const week = editWeek(req.params.week);
  for (const e of db.all('SELECT id FROM kpi_edits WHERE week = ?', [week])) db.run('DELETE FROM kpi_edits WHERE id = ?', [e.id]);
  res.json({});
}));
// ➕ Adds a row under the list the box (ref) is in, laid out as its last row — when the row under it is free.
router.post('/kpi/rows/:week', h((req, res) => {
  const week = editWeek(req.params.week);
  const a3 = snapshotA3(week);
  if (!a3?.edit) throw new HttpError(400, 'Load this week again to edit it');
  const t = kpi.addRowTarget(a3, req.body.ref);
  if (t.error) throw new HttpError(400, t.error);
  insertRow('kpi_rows_added', { week, ...t });
  res.status(201).json({ ...t, ref: `${kpi.colLettersOf(t.col_left)}${t.row}` });
}));
// Removes an added row (the row and its first column), and anything typed in it.
router.delete('/kpi/rows/:week/:row/:left', h((req, res) => {
  const week = editWeek(req.params.week);
  const a = db.get('SELECT * FROM kpi_rows_added WHERE week = ? AND row = ? AND col_left = ?', [week, Number(req.params.row), Number(req.params.left)]);
  if (!a) throw notFound('Added row');
  for (let c = a.col_left; c <= a.col_right; c++) db.run('DELETE FROM kpi_edits WHERE week = ? AND ref = ?', [week, `${kpi.colLettersOf(c)}${a.row}`]);
  db.run('DELETE FROM kpi_rows_added WHERE id = ?', [a.id]);
  res.json({ edits: kpiEdits(week) });
}));

// Starts a week's typed text from another week's (boxes this week hasn't changed yet).
router.post('/kpi/edits/:week/copy', h((req, res) => {
  const week = editWeek(req.params.week);
  const from = String(req.body.from || '').trim().toUpperCase();
  const mine = kpiEdits(week);
  // boxes the week writes up for itself (the complaints) aren't carried over from another week
  const snapRow = db.get('SELECT model FROM kpi_snapshots WHERE week = ?', [week]);
  let own = [];
  try { own = snapRow ? JSON.parse(zlibSync.gunzipSync(Buffer.from(snapRow.model, 'base64')).toString('utf8')).writeups || [] : []; } catch { own = []; }
  // the rows added to lists that week come along (where this week has room for them)
  for (const a of addedRows(from)) {
    if (db.get('SELECT id FROM kpi_rows_added WHERE week = ? AND row = ? AND col_left = ?', [week, a.row, a.col_left])) continue;
    const view = snapshotA3(week);
    const t = view ? kpi.addRowTarget(view, `${kpi.colLettersOf(a.col_left)}${a.src_row}`) : { error: true };
    if (!t.error && t.row === a.row) insertRow('kpi_rows_added', { week, ...t });
  }
  let n = 0;
  for (const e of db.all('SELECT ref, text, size FROM kpi_edits WHERE week = ? AND text IS NOT NULL', [from])) {
    const ref = e.ref.toUpperCase();
    if (own.includes(ref)) continue;
    if (mine[ref]?.text !== null && mine[ref]?.text !== undefined) continue;
    setKpiEdit(week, ref, { text: e.text, size: e.size ?? null }); n++;
  }
  res.json({ copied: n, edits: kpiEdits(week) });
}));

router.delete('/kpi/snapshots/:id', h((req, res) => {
  if (!db.run('DELETE FROM kpi_snapshots WHERE id = ?', [req.params.id]).changes) throw notFound('Week');
  res.status(204).end();
}));

// Load the week the workbook is showing: an uploaded copy…
router.post('/kpi/load', express.raw({ type: '*/*', limit: '200mb' }), h((req, res) => {
  if (!req.body?.length) throw new HttpError(400, 'Choose the workbook to load');
  const name = fileNameHeader(req, 'workbook.xlsm');
  if (!/\.xls[xm]$/i.test(name)) throw new HttpError(400, 'Choose an Excel workbook (.xlsx or .xlsm)');
  res.status(201).json(storeWeek(req.body, name, req.get('X-File-Modified') || null));
}));

// …or straight from where it's saved (e.g. on the S: drive).
router.post('/kpi/load-path', h((req, res) => {
  const file = String(req.body.path || getSettings().kpi_workbook_path || '').trim().replace(/^"|"$/g, '');
  if (!file) throw new HttpError(400, 'Set where the workbook is saved first');
  if (!/\.xls[xm]$/i.test(file)) throw new HttpError(400, 'That isn\'t an Excel workbook (.xlsx or .xlsm)');
  let buf; let stat;
  try { stat = fs.statSync(file); buf = fs.readFileSync(file); } catch (err) {
    throw new HttpError(400, err.code === 'ENOENT' ? `Can't find ${file}` : err.code === 'EBUSY' || err.code === 'EPERM' ? `${file} is locked — close it in Excel, or save and try again` : `Can't open ${file}: ${err.message}`);
  }
  res.status(201).json(storeWeek(buf, path.basename(file), stat.mtime.toISOString()));
}));

// ---- KPIs worked out from the source files ------------------------------------------------

const kpiData = require('./kpidata');
// ♻ scrap from consumption or machine rejections: automatic only takes consumption while its export is linked
kpiData.useScrapPref(() => { const s = getSettings(); const p = s.kpi_scrap_from || 'auto'; return p === 'auto' && !String(s.kpi_src_consumption || '').trim() ? 'remakes' : p; });
const splitWeekends = () => getSettings().kpi_split_weekends === '1';

// Excel's figures for each week, from the newest loaded week that has the Database values.
function excelVolumes() {
  const r = db.get("SELECT id, week, model, updated_at FROM kpi_snapshots WHERE COALESCE(origin, 'excel') = 'excel' ORDER BY updated_at DESC LIMIT 1");
  if (!r) return null;
  const model = JSON.parse(zlibSync.gunzipSync(Buffer.from(r.model, 'base64')).toString('utf8'));
  const v = model.values || null;
  if (!v) return { week: r.week, id: r.id, weeks: null };
  const weeks = {};
  for (let row = 2; row <= 1000; row++) {
    const code = v[`B${row}`];
    if (typeof code !== 'string' || !/^W\d{4}(_\d)?$/.test(code) || row < 40) continue;
    weeks[code] = Object.fromEntries(Object.entries(kpiData.DATABASE_COLUMNS).map(([key, col]) => [key, typeof v[`${col}${row}`] === 'number' ? v[`${col}${row}`] : null]));
  }
  return { week: r.week, id: r.id, loaded_at: r.updated_at, weeks };
}

router.get('/kpi/calc', h((req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const vol = kpiData.weeklyVolumes(year);
  res.json({ year, ...vol, sources: kpiData.sourcesStatus(), forecasts: forecastStatus(), excel: excelVolumes(), split_weekends: splitWeekends() });
}));

// Reads the source files that changed (all of them with force). Sources without a file of
// their own come from the CI workbook's import sheets.
router.post('/kpi/calc/import', h((req, res) => {
  const set = getSettings();
  const results = kpiData.importSources({
    paths: { perso: set.kpi_src_perso, shipped: set.kpi_src_shipped, remakes: set.kpi_src_remakes, consumption: set.kpi_src_consumption, otd: set.kpi_src_otd, salesforce: set.kpi_src_salesforce },
    workbook: set.kpi_workbook_path || null, force: !!req.body.force, splitWeekends: splitWeekends(),
  });
  log.info('KPI sources imported', results.map((r) => `${r.source}: ${r.status}${r.rows !== undefined ? ` (${r.rows})` : ''}`).join(', '));
  res.json(results);
}));

// A week's typed-in figures. protime: the Sun–Fri "present" counts (hours are worked out from them).
router.put('/kpi/manual/:week', h((req, res) => {
  const week = String(req.params.week).trim().toUpperCase();
  if (!kpiData.WEEK_RE.test(week)) throw new HttpError(400, 'Not a week code (e.g. W2639 or W2640_1)');
  const num = (v, label, int) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${label} must be a number of 0 or more`);
    return int ? Math.round(n) : n;
  };
  const f = {};
  if ('protime' in req.body) {
    const days = Array.isArray(req.body.protime) ? req.body.protime.slice(0, 6).map((v, i) => num(v, `Protime ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'][i]}`)) : [];
    f.protime = days.some((v) => v !== null) ? JSON.stringify(days) : null;
    if (f.protime) f.hours = kpiData.hoursFromProtime(days);
  }
  if ('hours' in req.body && !f.protime) f.hours = num(req.body.hours, 'Working hours');
  if ('contract' in req.body) f.contract = num(req.body.contract, 'Contract');
  if ('temps' in req.body) f.temps = num(req.body.temps, 'Temps');
  for (const k of ['cc_critical', 'cc_major', 'cc_minor']) if (k in req.body) f[k] = num(req.body[k], 'Complaints', true);
  const old = db.get('SELECT * FROM kpi_manual WHERE week = ?', [week]);
  const row = old ? fresh('kpi_manual', updateRow('kpi_manual', old.id, f)) : insertRow('kpi_manual', { week, ...f });
  res.json(row);
}));

// ✎ Adjusting a figure worked out from the sources, for one week: { value, reason } (value in the
// Database table's own units: kU for volumes, units for scrap, a fraction for the % KPIs). The
// figures worked out from it follow; the computed value is kept alongside. DELETE puts it back.
const overrideTarget = (req) => {
  const week = String(req.params.week || '').trim().toUpperCase();
  if (!kpiData.WEEK_RE.test(week)) throw new HttpError(400, 'Not a week code');
  const col = String(req.params.col || '');
  if (!kpiData.ADJUSTABLE.includes(col)) throw new HttpError(400, `${col} can't be adjusted here${kpiData.MANUAL_FIELDS.includes(col) ? ' — it\'s typed in with ✎ on the week' : ''}`);
  const year = 2000 + Number(week.slice(1, 3));
  if (!kpiData.weeksOf(year).some((w) => w.week === week)) throw new HttpError(400, `${week} isn't a reporting week${kpiData.weeksOf(year).some((w) => w.week === `${week}_1`) ? ` — it's split: ${week}_1 / ${week}_2` : ''}`);
  return { week, col, year };
};
router.put('/kpi/overrides/:week/:col', h((req, res) => {
  const { week, col, year } = overrideTarget(req);
  const value = Number(String(req.body.value ?? '').replace(',', '.').trim());
  if (String(req.body.value ?? '').trim() === '' || !Number.isFinite(value)) throw new HttpError(400, 'The adjusted figure must be a number');
  const reason = String(req.body.reason || '').trim();
  if (!reason) throw new HttpError(400, 'Say why it\'s adjusted — it shows with the figure');
  if (reason.length > 500) throw new HttpError(400, 'The reason is limited to 500 characters');
  const f = { value, reason, by_name: collab.whoOf(req) };
  const old = db.get('SELECT id FROM kpi_overrides WHERE week = ? AND col = ?', [week, col]);
  if (old) updateRow('kpi_overrides', old.id, f); else insertRow('kpi_overrides', { week, col, ...f });
  res.json(kpiData.weeklyVolumes(year).weeks.find((w) => w.week === week) || null);
}));
router.delete('/kpi/overrides/:week/:col', h((req, res) => {
  const { week, col, year } = overrideTarget(req);
  if (!db.run('DELETE FROM kpi_overrides WHERE week = ? AND col = ?', [week, col]).changes) throw notFound('Adjustment');
  res.json(kpiData.weeklyVolumes(year).weeks.find((w) => w.week === week) || null);
}));

// Fills weeks' typed-in figures from Excel's Database sheet (the loaded week), where
// nothing's been entered here yet — for carrying the year so far over.
router.post('/kpi/manual/from-excel', h((req, res) => {
  const xl = excelVolumes();
  if (!xl?.weeks) throw new HttpError(400, 'Load a week from the workbook first (A3 tab)');
  // only up to the week Excel was reporting: later weeks' zeros are just empty formulas
  const year = kpi.weekParts(xl.week)?.year;
  const order = year ? kpiData.weeksOf(year).map((w) => w.week) : [];
  const upTo = order.indexOf(String(xl.week).toUpperCase());
  let weeks = 0; let fields = 0;
  db.tx(() => {
    for (const [week, vals] of Object.entries(xl.weeks)) {
      if (upTo >= 0 && (order.indexOf(week) < 0 || order.indexOf(week) > upTo)) continue;
      const old = db.get('SELECT * FROM kpi_manual WHERE week = ?', [week]);
      const f = {};
      for (const k of kpiData.MANUAL_FIELDS) if (vals[k] !== null && vals[k] !== undefined && (old?.[k] === null || old?.[k] === undefined)) f[k] = vals[k];
      if (!Object.keys(f).length) continue;
      if (old) updateRow('kpi_manual', old.id, f); else insertRow('kpi_manual', { week, ...f });
      weeks++; fields += Object.keys(f).length;
    }
  });
  res.json({ weeks, fields });
}));

// The customer forecast files, as set (they're read when an A3 is built).
const cleanPath = (p) => String(p || '').trim().replace(/^"|"$/g, '');
function forecastStatus() {
  const set = getSettings();
  return Object.entries(kpiData.FORECASTS).map(([key, spec]) => {
    const file = cleanPath(set[`kpi_fc_${key}`]);
    let stat = null; try { stat = file ? fs.statSync(file) : null; } catch { /* not there */ }
    return { key, label: spec.label, default_file: spec.file, sheet: spec.sheet, workbook_sheet: spec.workbook, path: file || null, found: !!stat, modified: stat ? stat.mtime.toISOString() : null };
  });
}
function forecastFiles() {
  const set = getSettings();
  return Object.entries(kpiData.FORECASTS).map(([key, spec]) => {
    const file = cleanPath(set[`kpi_fc_${key}`]);
    if (!file) return { spec };
    try { return { spec, file: path.basename(file), modified: fs.statSync(file).mtime.toISOString(), buf: fs.readFileSync(file) }; } catch (err) {
      return { spec, file: path.basename(file), error: err.code === 'ENOENT' ? `can't find ${file}` : err.message };
    }
  });
}

// ▶ Prepare this week: where each step stands for a week (by default the last one finished).
router.get('/kpi/prepare', h((req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const thisYear = new Date().getFullYear();
  const list = [...(new Date().getMonth() === 0 ? kpiData.weeksOf(thisYear - 1).slice(-6) : []), ...kpiData.weeksOf(thisYear)]
    .map((w) => ({ ...w, end: kpiData.weekEnd(w.week) }));
  const done = list.filter((w) => w.end && w.end < today);
  const fallback = done[done.length - 1]?.week || list[0]?.week;
  let week = String(req.query.week || '').trim().toUpperCase() || fallback;
  if (!kpiData.WEEK_RE.test(week)) week = fallback;
  const year = 2000 + Number(week.slice(1, 3));
  const vol = kpiData.weeklyVolumes(year);
  const figures = vol.weeks.find((w) => w.week === week) || null;
  const sources = kpiData.sourcesStatus();
  const lastRead = sources.map((x) => x.imported_at).filter(Boolean).sort().pop() || null;
  const manual = db.get('SELECT * FROM kpi_manual WHERE week = ?', [week]);
  const r = db.get('SELECT * FROM kpi_snapshots WHERE week = ?', [week]);
  let snap = null;
  if (r) {
    const model = JSON.parse(zlibSync.gunzipSync(Buffer.from(r.model, 'base64')).toString('utf8'));
    const edits = kpiEdits(week);
    const lastEdit = db.get('SELECT MAX(updated_at) AS t FROM kpi_edits WHERE week = ?', [week])?.t || null;
    const textEdited = Object.values(edits).filter((e) => e.text !== null && !/^[▲▼▬]$/.test(e.text)).length;
    const changed = [lastEdit, r.updated_at].filter(Boolean).sort().pop();
    snap = {
      ...kpiMeta(r), flags: model.flags || [], errors: model.errors || [], template_week: model.template_week || null,
      // built before the latest figures were read or typed in
      stale: r.origin === 'ci' && [lastRead, manual?.updated_at, db.get("SELECT MAX(changed_at) AS t FROM audit_log WHERE table_name = 'kpi_overrides' AND upper(json_extract(coalesce(new_data, old_data), '$.week')) = ?", [week])?.t].some((t) => t && t > r.updated_at),
      text_edited: textEdited, edits: Object.keys(edits).length,
      text_from: textEdited ? null : db.get('SELECT week FROM kpi_edits WHERE text IS NOT NULL AND week < ? ORDER BY week DESC LIMIT 1', [week])?.week || null,
      saved_current: !!r.exported_at && r.exported_at >= changed,
    };
  }
  const target = kpi.exportTarget(getSettings(), week);
  res.json({
    week, today, default_week: fallback, weeks: list.filter((w) => !w.end || w.end <= today || w.week === week).slice(-12).reverse(),
    figures, manual: manual ? { ...manual, protime: parseJson(manual.protime), hours: manual.protime ? kpiData.hoursFromProtime(parseJson(manual.protime)) ?? manual.hours : manual.hours } : null,
    sources, forecasts: forecastStatus(), last_read: lastRead,
    otd: { uncounted: vol.otd_uncounted.length, checks: vol.otd_checks.filter((c) => c.typed_week === week).length },
    snap, template: hasTemplate(), export_path: target?.path || null,
  });
}));

// The reporting weeks of a year, with the A3 each has (loaded from Excel or built here).
// The workbook a week is built from: the last one loaded, or (loaded before templates were
// kept) the one at the saved workbook path, which is then kept as the template.
const workbookPath = () => String(getSettings().kpi_workbook_path || '').trim().replace(/^"|"$/g, '');
const hasTemplate = () => fs.existsSync(KPI_TEMPLATE) || (!!workbookPath() && fs.existsSync(workbookPath()));
function templateWorkbook() {
  if (fs.existsSync(KPI_TEMPLATE)) return fs.readFileSync(KPI_TEMPLATE);
  const file = workbookPath();
  if (!file || !fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  try { fs.mkdirSync(path.dirname(KPI_TEMPLATE), { recursive: true }); fs.writeFileSync(KPI_TEMPLATE, buf); } catch (err) { log.warn('Could not keep the workbook as the A3 template', err.message); }
  return buf;
}

router.get('/kpi/weeks', h((req, res) => {
  const tw = String(getSetting('kpi_template_week') || '').match(/^W(\d\d)/i);
  const year = Number(req.query.year) || (tw ? 2000 + Number(tw[1]) : null)
    || db.get('SELECT year FROM kpi_snapshots WHERE year IS NOT NULL ORDER BY updated_at DESC LIMIT 1')?.year || new Date().getFullYear();
  const have = new Map(db.all('SELECT * FROM kpi_snapshots WHERE year = ?', [year]).map((r) => [r.week.toUpperCase(), kpiMeta(r)]));
  res.json({ year, template_week: getSetting('kpi_template_week') || null, template: hasTemplate(),
    weeks: kpiData.weeksOf(year).map((w) => ({ ...w, a3: have.get(w.week) || null })) });
}));

// The CI Manager's own A3 for a week: the workbook's formulas re-run on the figures
// worked out from the source files (see kpi.buildWeek). A week loaded from Excel is only
// replaced when asked (replace: true).
router.post('/kpi/build', h((req, res) => {
  const week = String(req.body.week || '').trim().toUpperCase();
  if (!kpiData.WEEK_RE.test(week)) throw new HttpError(400, 'Not a week code');
  const template = templateWorkbook();
  if (!template) throw new HttpError(400, 'Load the workbook once (📥 Load this week) — its A3 and Database sheets are the template for the weeks the CI Manager builds');
  const old = db.get('SELECT * FROM kpi_snapshots WHERE week = ?', [week]);
  if (old && (old.origin || 'excel') === 'excel' && !req.body.replace) throw new HttpError(409, `${week} was loaded from Excel — confirm to replace it with the CI Manager's own figures`);
  const year = kpi.weekParts(week).year;
  const set = getSettings();
  let w;
  try {
    w = kpi.buildWeek(template, week, {
      weeks: kpiData.weeklyVolumes(year).weeks, topScrap: kpiData.topScrap, shippedFor: kpiData.shippedFor, weekEnd: kpiData.weekEnd, columns: kpiData.DATABASE_COLUMNS,
      forecasts: forecastFiles(), complaints: kpiData.complaintsOf,
    }, { a3Sheet: set.kpi_a3_sheet, dbSheet: set.kpi_db_sheet, weekCell: set.kpi_week_cell });
  } catch (err) { throw new HttpError(400, err.message); }
  const row = {
    week, year: w.year, month: w.month, source_name: 'CI Manager', source_modified: null, origin: 'ci', updated_at: nowIso(), exported_at: null, exported_to: null,
    model: zlibSync.gzipSync(JSON.stringify({ views: w.views, values: w.values, sheets: w.sheets, errors: w.errors, flags: w.flags, template_week: w.template_week, writeups: w.writeups })).toString('base64'),
    pkg: w.pkg.toString('base64'),
  };
  const saved = old ? fresh('kpi_snapshots', updateRow('kpi_snapshots', old.id, row)) : insertRow('kpi_snapshots', row);
  if (w.template_week && !getSetting('kpi_template_week')) setSetting('kpi_template_week', w.template_week);
  log.info(`A3 for ${week} built from the source figures`);
  res.status(201).json({ ...kpiMeta(saved), flags: w.flags });
}));

// 🔎 The detail behind one figure of the Database table (?week=W2639&col=perso_ps).
router.get('/kpi/calc/detail', h((req, res) => {
  if (!kpiData.WEEK_RE.test(String(req.query.week || ''))) throw new HttpError(400, 'Which week?');
  if (!/^[a-z_]+$/.test(String(req.query.col || ''))) throw new HttpError(400, 'Which figure?');
  res.json(kpiData.figureDetail(req.query.week, req.query.col));
}));
router.get('/kpi/calc/otd', h((req, res) => {
  const week = String(req.query.week || '').trim().toUpperCase();
  if (!kpiData.WEEK_RE.test(week)) throw new HttpError(400, 'Not a week code');
  res.json(kpiData.otdRows(week));
}));

router.post('/kpi/calc/weekends', h((req, res) => {
  const split = !!req.body.split;
  setSetting('kpi_split_weekends', split ? '1' : '0');
  kpiData.rewriteWeeks(split);
  res.json({ split_weekends: split });
}));

// Where the A3s would be saved, for a few kinds of week (the latest, a split one, a single-digit one).
router.get('/kpi/export-preview', h((req, res) => {
  const set = getSettings();
  const last = db.get('SELECT week FROM kpi_snapshots ORDER BY year DESC, week DESC LIMIT 1')?.week;
  const yy = last ? last.slice(1, 3) : String(new Date().getFullYear()).slice(2);
  const split = kpiData.weeksOf(2000 + Number(yy)).find((w) => /_1$/.test(w.week) && w.week.slice(3, 5) !== '01')?.week;
  const weeks = [...new Set([last, `W${yy}04`, split].filter(Boolean))];
  res.json(weeks.map((week) => ({ week, path: kpi.exportTarget(set, week)?.path || null })));
}));

// The disconnected A3: chart pictures come from the page (PNG, base64). With save,
// it's also written to the export folder for the week.
router.post('/kpi/snapshots/:id/export', h((req, res) => {
  const r = db.get('SELECT * FROM kpi_snapshots WHERE id = ?', [req.params.id]);
  if (!r) throw notFound('Week');
  const images = {};
  for (const [index, data] of Object.entries(req.body.charts || {})) {
    const m = String(data || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (m) images[index] = Buffer.from(m[1], 'base64');
  }
  const edits = kpiEdits(r.week);
  let pkg = kpi.addRowsToPackage(Buffer.from(r.pkg, 'base64'), addedRows(r.week));
  if (Object.keys(edits).length) {
    const model = JSON.parse(zlibSync.gunzipSync(Buffer.from(r.model, 'base64')).toString('utf8'));
    pkg = kpi.applyEdits(pkg, edits, model.views?.a3?.edit || {});
  }
  const file = kpi.exportA3(pkg, images);
  const set = getSettings();
  const target = kpi.exportTarget(set, r.week);
  const name = target?.name || kpi.exportTarget({ ...set, kpi_export_dir: '.' }, r.week).name;
  let savedTo = null;
  if (req.body.save) {
    if (!target) throw new HttpError(400, 'Set the folder the A3 is saved to first');
    const { dir } = target;
    try {
      fs.mkdirSync(dir, { recursive: true });
      savedTo = path.join(dir, name);
      fs.writeFileSync(savedTo, file);
    } catch (err) {
      throw new HttpError(400, err.code === 'EBUSY' || err.code === 'EPERM' ? `${path.join(dir, name)} is open in Excel — close it and try again` : `Couldn't save to ${dir}: ${err.message}`);
    }
    updateRow('kpi_snapshots', r.id, { exported_at: nowIso(), exported_to: savedTo });
    log.info(`A3 for ${r.week} saved`, { to: savedTo });
  }
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  if (savedTo) res.set('X-Saved-To', encodeURIComponent(savedTo));
  res.send(file);
}));

// ------------------------------------------------------------------ 🏭 production planning

const planning = require('./planning');
const PLAN_UPLOAD = path.join(config.dataDir, 'plan', 'open-workorders.xlsx');
const OTTO_UPLOAD = path.join(config.dataDir, 'plan', 'otto.xlsx');
const DISP_UPLOAD = path.join(config.dataDir, 'plan', 'dispatch.xlsx');
const planHistory = require('./planhistory');
// Matching (the other half of production): its export, open jobs in plan-date order, linked to the
// perso jobs by work order. Finished and test jobs are counted but not listed.
// Max age (days) of what's shown: older is likely an error (0 = show everything).
const planMaxAge = (set) => { const v = String(set.plan_max_age ?? '').trim(); return v === '' ? 30 : Math.max(0, Number(v) || 0); };
const nowLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const localYmd = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
// Overdue work (past its deadline now), what's hidden as too old, and the catch-up estimate.
function backlogOf(jobs, hidden, record, capacity, maxAge) {
  const now = nowLocal();
  const over = jobs.filter((j) => j.deadline && j.deadline < now);
  return {
    max_age: maxAge, hidden_jobs: hidden.length, hidden_qty: hidden.reduce((t, j) => t + j.qty, 0),
    overdue_jobs: over.length, overdue_qty: over.reduce((t, j) => t + j.qty, 0), oldest_due: over.map((j) => j.due).filter(Boolean).sort()[0] || null,
    catch_up: planning.catchUp({ overdue: over.reduce((t, j) => t + j.qty, 0), ...record, days: 7, workDays: capacity.days }),
  };
}
function ottoOf(set, persoJobs, capacity) {
  const o = planning.readSource({ file: cleanPath(set.plan_otto_src) || null, uploaded: OTTO_UPLOAD, parser: planning.parseOtto });
  recordOtto(o);
  const source = { status: o.status, file: o.file || null, name: o.name || null, uploaded: !!o.uploaded, modified: o.modified || null, error: o.error || null, skipped: o.skipped || [] };
  const machines = db.all('SELECT * FROM plan_otto_machines ORDER BY sort_order, id');
  const speeds = db.all('SELECT * FROM plan_otto_speeds ORDER BY customer');
  if (o.status !== 'ok') return { source, machines, speeds, customers: [], running: [], queue: [], done: 0, tests: 0, load: [], projected: false, backlog: null };
  const maxAge = planMaxAge(set);
  const openAll = o.jobs.filter((j) => !j.done && !j.test);
  const hidden = openAll.filter((j) => planning.tooOld(j.due, maxAge));
  const open = openAll.filter((j) => !planning.tooOld(j.due, maxAge)).map((j) => ({ ...j }));
  // the shipper and cut-off from the perso work orders (open, else from the plan history)
  const wos = [...new Set(open.map((j) => String(j.wo || '').toUpperCase()).filter(Boolean))];
  const past = [];
  for (let i = 0; i < wos.length; i += 400) {
    const part = wos.slice(i, i + 400);
    for (const r of db.all(`SELECT wo, shipper, deadline FROM plan_history_jobs WHERE upper(wo) IN (${part.map(() => '?').join(',')})`, part)) {
      const t = /T(\d{2}):(\d{2})/.exec(r.deadline || '');
      const cutoff = t ? Number(t[1]) * 60 + Number(t[2]) : null;
      past.push({ wo: r.wo, shipper: r.shipper, cutoff: cutoff !== null && cutoff < 23 * 60 + 59 ? cutoff : null });
    }
  }
  planning.shipFromPerso(open, persoJobs, past);
  planning.linkOtto(persoJobs, open);
  const running = planning.orderOtto(open.filter((j) => j.running)); const queue = planning.orderOtto(open.filter((j) => !j.running));
  const load = planning.projectOtto(running, queue, machines, speeds, capacity, new Date());
  // customers for the speeds table: those in the open Matching jobs, and any with a speed set before
  const cust = new Map();
  for (const j of open) if (j.customer) { const c = cust.get(j.customer) || { customer: j.customer, name: j.customer_name, items: 0, jobs: 0 }; c.items += j.qty; c.jobs++; cust.set(j.customer, c); }
  for (const r of speeds) if (!cust.has(r.customer.toUpperCase())) cust.set(r.customer.toUpperCase(), { customer: r.customer.toUpperCase(), name: null, items: 0, jobs: 0 });
  const customers = [...cust.values()].map((c) => ({ ...c, speed: speeds.find((r) => r.customer.toUpperCase() === c.customer)?.speed ?? null })).sort((a, b) => b.items - a.items || a.customer.localeCompare(b.customer));
  // the pace: finished jobs (by End Date) and all work due (by Plan Date) in the export
  const real = o.jobs.filter((j) => !j.test);
  const backlog = backlogOf(open, hidden, { done: real.filter((j) => j.done && j.end_date).map((j) => ({ date: j.end_date, qty: j.qty })),
    due: real.filter((j) => j.due).map((j) => ({ date: j.due, qty: j.qty })) }, capacity, maxAge);
  return { source, machines, speeds, customers, running, queue, load: load || [], projected: !!load, backlog,
    done: o.jobs.filter((j) => j.done && !j.test).length, tests: o.jobs.filter((j) => j.test).length };
}
// 🚚 Dispatch: the open dispatch jobs (those due long ago hidden, as elsewhere), each linked to its work
// order's perso jobs and Matching jobs — where it is in the chain — in due order, then priority.
const DISP_PRIO = (p) => (/urgent/i.test(p || '') ? 0 : /high/i.test(p || '') ? 1 : /low/i.test(p || '') ? 3 : 2);
function dispOf(set, persoJobs, ottoOpen) {
  const d = planning.readSource({ file: cleanPath(set.plan_disp_src) || null, uploaded: DISP_UPLOAD, parser: planning.parseDisp });
  recordDisp(d);
  const source = { status: d.status, file: d.file || null, name: d.name || null, uploaded: !!d.uploaded, modified: d.modified || null, error: d.error || null, skipped: d.skipped || [] };
  if (d.status !== 'ok') return { source, jobs: [], done: 0, hidden: 0, hidden_qty: 0, max_age: planMaxAge(set) };
  const maxAge = planMaxAge(set);
  const openAll = d.jobs.filter((j) => !j.done);
  const hidden = openAll.filter((j) => planning.tooOld(j.due, maxAge));
  const open = openAll.filter((j) => !planning.tooOld(j.due, maxAge)).map((j) => ({ ...j }));
  // Matching: the open jobs (with their projected finish) and the finished ones still in its export
  const o = planning.readSource({ file: cleanPath(set.plan_otto_src) || null, uploaded: OTTO_UPLOAD, parser: planning.parseOtto });
  const ottoDone = o.status === 'ok' ? o.jobs.filter((j) => j.done && !j.test) : [];
  planning.linkDisp(open, persoJobs, [...ottoOpen, ...ottoDone]);
  attachDelays(open);
  open.sort((a, b) => ((a.due || '9') !== (b.due || '9') ? ((a.due || '9') < (b.due || '9') ? -1 : 1) : DISP_PRIO(a.prio) - DISP_PRIO(b.prio) || a.name.localeCompare(b.name)));
  lastDisp = { at: new Date().toISOString(), jobs: open };
  return { source, jobs: open, done: d.jobs.filter((j) => j.done).length, hidden: hidden.length, hidden_qty: hidden.reduce((t, j) => t + j.qty, 0), max_age: maxAge };
}
// ⏱ Dispatch delays: each job's new expected date — its own (set on the job) or its customer's and original
// due date's together: delay { new_date, reason, from: 'job' | 'group', group_date, group_reason }.
let lastDisp = null; // the open dispatch jobs as last worked out (for the delay report)
function attachDelays(jobs) {
  const groups = new Map(db.all('SELECT * FROM plan_disp_delays').map((r) => [`${String(r.customer).toUpperCase()}|${r.due}`, r]));
  const own = new Map(db.all('SELECT * FROM plan_disp_delay_jobs').map((r) => [String(r.key).toUpperCase(), r]));
  for (const j of jobs) {
    const g = groups.get(`${String(j.customer || '').toUpperCase()}|${j.due}`); const o = own.get(String(j.key).toUpperCase());
    j.delay = g || o ? { new_date: o?.new_date || g?.new_date || null, reason: (o?.new_date || o?.reason ? o?.reason : null) || g?.reason || null, from: o?.new_date ? 'job' : g?.new_date ? 'group' : null,
      group_date: g?.new_date || null, group_reason: g?.reason || null, job_date: o?.new_date || null, job_reason: o?.reason || null } : null;
  }
  const n = new Date(); const today = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  for (const j of jobs) j.delayed = isDelayed(j, today);
  return jobs;
}
function recordDisp(d) {
  if (d.status !== 'ok' || d.uploaded) return;
  try { const r = planHistory.ingestDisp(d.jobs, d.modified, d.file); if (r) log.info('Planning: Dispatch export recorded', r); } catch (err) { log.warn('Planning: Dispatch history not recorded', err.message); }
}
// Each new version of the linked export goes into the plan history (an uploaded copy doesn't).
function recordPlan(src) {
  if (src.status !== 'ok' || src.uploaded) return;
  try { const r = planHistory.ingest(src.lines, src.modified, src.file); if (r) log.info('Planning: export recorded', r); } catch (err) { log.warn('Planning: history not recorded', err.message); }
}
// …and each new version of the Matching export into its own (📆 D+ due out, when Matching jobs were done).
function recordOtto(o) {
  if (o.status !== 'ok' || o.uploaded) return;
  try { const r = planHistory.ingestOtto(o.jobs, o.modified, o.file); if (r) log.info('Planning: Matching export recorded', r); } catch (err) { log.warn('Planning: Matching history not recorded', err.message); }
}
// Hourly exports are caught even with Planning closed, and the files Planning reads are read in
// the background (at start-up and whenever one is saved again), so opening the tab finds them
// ready instead of reading them from the network then. Checking is cheap: a file is only read
// again when it has changed.
function checkPlanExport() {
  const set = getSettings();
  const file = cleanPath(set.plan_src);
  try {
    if (file) recordPlan(planning.readSource({ file }));
    if (cleanPath(set.plan_db)) planning.readCards({ file: cleanPath(set.plan_db), table: set.plan_db_table || 'Cards' });
    if (cleanPath(set.plan_otto_src)) recordOtto(planning.readSource({ file: cleanPath(set.plan_otto_src), parser: planning.parseOtto }));
    if (cleanPath(set.plan_disp_src)) recordDisp(planning.readSource({ file: cleanPath(set.plan_disp_src), parser: planning.parseDisp }));
  } catch (err) { log.warn('Planning: reading ahead', err.message); }
}
setTimeout(checkPlanExport, 3000).unref();
setInterval(checkPlanExport, 2 * 60 * 1000).unref();
const planTime = (s, fallback) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : fallback; };
// The open work orders, as jobs in order (mode fifo | bau), with the capacity projection.
router.get('/plan', h((req, res) => {
  const set = getSettings();
  const src = planning.readSource({ file: cleanPath(set.plan_src) || null, uploaded: PLAN_UPLOAD });
  recordPlan(src);
  const capacity = { rate: Number(set.plan_rate) || null, lines: Number(set.plan_lines) || 1, start: planTime(set.plan_day_start, 360), end: planTime(set.plan_day_end, 1320),
    days: String(set.plan_days || '1,2,3,4,5').split(',').map(Number).filter((d) => d >= 0 && d <= 6),
    buffer: Math.max(0, Number(set.plan_buffer) || 0), changeover: Math.max(0, Number(set.plan_changeover) || 0) };
  const source = { status: src.status, file: src.file || null, name: src.name || null, uploaded: !!src.uploaded, modified: src.modified || null, read_at: src.read_at || null, error: src.error || null,
    lines: src.lines?.length || 0, skipped: src.skipped || [] };
  const db_ = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  const cardsDb = { status: db_.status, file: db_.file || null, name: db_.name || null, modified: db_.modified || null, table: db_.table || null, count: db_.count || 0, error: db_.error || null, columns: db_.columns || null };
  const rules = db.all('SELECT * FROM plan_speeds ORDER BY type, material, sides');
  let sharedSetup = null; try { sharedSetup = JSON.parse(metaGet('shared_setup_info') || 'null'); } catch { /* none */ }
  // working time for the next two weeks (the Gantt's shading; available hours a day)
  const now = new Date();
  const windows = planning.workingWindows(now, new Date(now.getTime() + 14 * 86400000), capacity).map((w) => ({ start: w.start.toISOString(), end: w.end.toISOString() }));
  const available = planning.minutesByDay(now, new Date(now.getTime() + 14 * 86400000), capacity);
  if (src.status !== 'ok') { const otto0 = ottoOf(set, [], capacity); return res.json({ shared_setup: sharedSetup, windows, available, now: now.toISOString(), otto: otto0, disp: dispOf(set, [], [...otto0.running, ...otto0.queue]), machines: db.all('SELECT * FROM plan_machines ORDER BY sort_order, id'), machine_load: [], capacity_by_type: [], product_types: [], source, cards_db: cardsDb, rules, combos: [], capacity, mode: (['bau', 'score', 'mitigation'].includes(req.query.mode) ? req.query.mode : 'fifo'), running: [], queue: [], slots: [] }); }
  const mode = (['bau', 'score', 'mitigation'].includes(req.query.mode) ? req.query.mode : 'fifo');
  const oeeRows = db.all('SELECT customer, oee FROM plan_oee ORDER BY customer');
  const oeeDefault = Number(set.plan_oee_default) > 0 && Number(set.plan_oee_default) <= 100 ? Number(set.plan_oee_default) / 100 : null;
  const maxAge = planMaxAge(set);
  const hiddenJobs = planning.jobsOf(src.lines.filter((l) => planning.tooOld(l.due, maxAge)));
  // 🔬 learned run times (Setup › Run times): each card line timed from the history of that card
  const learnOn = set.plan_learned_times === '1';
  const model = learnOn ? planLearn.modelFor({ cards: db_.status === 'ok' ? db_.cards : null, cardsKey: `${db_.file}|${db_.modified}|${db_.count}` }) : null;
  const kindKey = (c) => [c.type, c.material, c.sides].map((v) => String(v ?? '').trim().toLowerCase()).join('|');
  const learned = model ? (l, withRule) => planLearn.predict(model, { article: l.article, qty: l.qty, customer: l.customer, kindKey: l.card ? kindKey(l.card) : null }, { withRule }) : null;
  const lines = planning.withSpeeds(src.lines.filter((l) => !planning.tooOld(l.due, maxAge)).map((l) => ({ ...l })), db_.status === 'ok' ? db_.cards : null, rules, capacity.rate,
    { by: new Map(oeeRows.map((r) => [r.customer.toUpperCase(), r.oee])), fallback: oeeDefault }, learned);
  // customers for the OEE table: those in the open work orders (name from the card database) and any set before
  const custNames = new Map();
  if (db_.status === 'ok') for (const c of db_.cards.values()) if (c.trigram && c.customer && !custNames.has(c.trigram.toUpperCase())) custNames.set(c.trigram.toUpperCase(), c.customer);
  const custCards = new Map();
  for (const l of lines) if (l.customer) custCards.set(l.customer.toUpperCase(), (custCards.get(l.customer.toUpperCase()) || 0) + l.qty);
  const oeeList = [...new Set([...custCards.keys(), ...oeeRows.map((r) => r.customer.toUpperCase())])].map((c) => ({
    customer: c, name: custNames.get(c) || null, cards: custCards.get(c) || 0, oee: oeeRows.find((r) => r.customer.toUpperCase() === c)?.oee ?? null,
  })).sort((a, b) => b.cards - a.cards || a.customer.localeCompare(b.customer));
  const unknown = db_.status === 'ok' ? [...new Set(lines.filter((l) => !l.card).map((l) => l.article))] : [];
  const jobs = planning.jobsOf(lines);
  const modifiers = modifiersOf(set);
  const scored = planning.scoreJobs(jobs, { now: new Date(), deadline: modifiers.deadline, rules: modifiers.rules, shifts: modifiers.shifts, shiftStarts: modifiers.shift_starts, off: modifiers.off,
    tagOf: (ax) => modifiers.tagBy.get(planning.axKey(ax)) || null });
  modifiers.current_shift = scored.shift;
  const running = planning.order(jobs.filter((j) => j.running), mode === 'score' ? 'score' : 'fifo');
  // pins for jobs no longer in the export are cleared
  const keys = new Set(jobs.map((j) => j.key));
  const pinRows = db.all('SELECT * FROM plan_pins ORDER BY id');
  for (const pr of pinRows) if (!keys.has(pr.key)) db.run('DELETE FROM plan_pins WHERE id = ?', [pr.id]);
  let queue = planning.order(jobs.filter((j) => !j.running), mode === 'mitigation' ? 'fifo' : mode, pinRows.filter((pr) => keys.has(pr.key)).map((pr) => pr.key));
  const machines = db.all('SELECT * FROM plan_machines ORDER BY sort_order, id');
  // 🛟 mitigation: what can still be on time first, with the plan deciding what can't
  const mitiDays = Math.max(0, Number(set.plan_miti_days ?? 5) || 0);
  const mitigation = { days: mitiDays, horizon: mitiDays ? planning.workingDaysAhead(new Date(), mitiDays, capacity.days) : null };
  if (mode === 'mitigation') {
    const useM = machines.some((m) => m.active);
    const at = new Date();
    queue = planning.mitigate(running, queue, { now: at, horizon: mitigation.horizon,
      stepper: (r, q) => (useM ? planning.machineStepper(r, q, machines, capacity, at) : planning.lineStepper(r, q, capacity, at)) });
  }
  // with machines: each card line planned on a machine that runs its type; else spread over the lines running
  const machineLoad = machines.some((m) => m.active) ? planning.projectMachines(running, queue, machines, capacity, new Date()) : false;
  const projected = machineLoad ? true : planning.project(running, queue, capacity, new Date());
  const types = [...new Set(db_.status === 'ok' ? [...db_.cards.values()].map((c) => c.type).filter(Boolean) : [])].sort();
  const otto = ottoOf(set, [...running, ...queue], capacity);
  const disp = dispOf(set, [...running, ...queue], [...otto.running, ...otto.queue]);
  // the pace from the plan history: jobs done (when they left the export) and all jobs due
  const since = new Date(Date.now() - 10 * 86400000);
  const histFirst = db.get('SELECT MIN(file_modified) AS f FROM plan_history_reads')?.f || null;
  // the pace: from the timing report (cards persoed, and the jobs due, by day) — the same on every PC; until
  // there is one, from this PC's own plan history
  const pace = planHistory.persoPace(localYmd(since), [...running, ...queue]);
  const backlog = backlogOf([...running, ...queue], hiddenJobs, pace.any ? { done: pace.done, due: pace.due, from: pace.from } : {
    done: planHistory.donePerDay(since.toISOString(), localYmd),
    due: db.all('SELECT due, qty FROM plan_history_jobs WHERE due >= ?', [localYmd(since)]).map((r) => ({ date: r.due, qty: r.qty })),
    from: histFirst }, capacity, maxAge);
  backlog.pace_from = pace.any ? 'runs' : 'history';
  delete modifiers.tagBy;
  const pdataStatus = (() => { const f = cleanPath(set.kpi_perso_data) || null; if (!f) return null; let st; try { st = require('./persodata').stamp(); } catch { st = {}; }
    return { status: fs.existsSync(f) ? 'ok' : 'missing', rows: st.n || 0, first: st.first || null, last: st.last || null }; })();
  res.json({ pdata: pdataStatus, shared_setup: sharedSetup, mitigation, modifiers, backlog, otto, disp, oee: oeeList, oee_default: oeeDefault, windows, available, machines, machine_load: machineLoad || [], capacity_by_type: planning.capacityByType(lines, machines, capacity), product_types: types,
    source, cards_db: cardsDb, rules, combos: planning.combos(lines, rules), unknown_articles: unknown, no_speed: lines.filter((l) => l.speed === null || l.speed_from === 'average').length,
    learned_times: { on: learnOn, runs: model?.runs || 0, setup: model ? Math.round(model.setup * 10) / 10 : null, lines: lines.length,
      card: lines.filter((l) => l.speed_from === 'learned:card').length, kind: lines.filter((l) => l.speed_from === 'learned:kind').length, all: lines.filter((l) => l.speed_from === 'learned:all').length }, averaged: lines.some((l) => l.speed_from === 'average'),
    capacity, mode, projected, now: new Date().toISOString(), running, queue, slots: planning.loadByDeadline([...running, ...queue]) });
}));
// The machines and the product types each runs ("DOD, Laser"; blank = any).
const machineFields = (b) => {
  const f = {};
  if ('name' in b) { f.name = String(b.name || '').trim(); if (!f.name) throw new HttpError(400, 'Give the machine a name'); }
  if ('types' in b) f.types = String(b.types || '').split(/[,;]/).map((t) => t.trim()).filter(Boolean).join(', ') || null;
  if ('active' in b) f.active = b.active ? 1 : 0;
  return f;
};
router.post('/plan/machines', h((req, res) => {
  const f = machineFields({ name: req.body.name, types: req.body.types, active: req.body.active ?? true });
  const order = (db.get('SELECT MAX(sort_order) AS m FROM plan_machines')?.m ?? -1) + 1;
  res.status(201).json(fresh('plan_machines', insertRow('plan_machines', { ...f, sort_order: order })));
}));
router.patch('/plan/machines/:id', h((req, res) => {
  const old = db.get('SELECT * FROM plan_machines WHERE id = ?', [req.params.id]);
  if (!old) throw notFound('Machine');
  res.json(fresh('plan_machines', updateRow('plan_machines', old.id, machineFields(req.body))));
}));
router.delete('/plan/machines/:id', h((req, res) => {
  if (!db.run('DELETE FROM plan_machines WHERE id = ?', [req.params.id]).changes) throw notFound('Machine');
  res.status(204).end();
}));

// ⚖ Priority modifiers: the rule lists, the shift table, card tags, which modules are off, and the
// deadline module's numbers.
const hm = (s, fallback) => { const m = String(s ?? '').match(/^(\d{1,2}):(\d{2})$/); return m ? Number(m[1]) * 60 + Number(m[2]) : fallback; };
const modNum = (v, d) => (String(v ?? '').trim() === '' || Number.isNaN(Number(v)) ? d : Number(v));
function modifiersOf(set) {
  const tags = db.all('SELECT * FROM plan_card_tags ORDER BY tag, ax');
  const rules = db.all('SELECT * FROM plan_modifiers ORDER BY list, customer, tag, type, id');
  const D = planning.DEADLINE_DEFAULTS;
  return {
    rules, shifts: db.all('SELECT * FROM plan_mod_shifts ORDER BY customer'), tags, tagBy: new Map(tags.map((t) => [planning.axKey(t.ax), t.tag])),
    lists: [...new Set(['Matching', 'Dispatch', 'Manual', ...rules.map((r) => r.list)])],
    off: String(set.plan_mod_off || '').split(',').map((x) => x.trim()).filter(Boolean),
    shift_starts: { night: hm(set.plan_shift_night, 21 * 60 + 45), morning: hm(set.plan_shift_morning, 5 * 60 + 45), afternoon: hm(set.plan_shift_afternoon, 13 * 60 + 45) },
    deadline: { base: modNum(set.plan_dl_base, D.base), per_day: modNum(set.plan_dl_per_day, D.per_day), max_extra: modNum(set.plan_dl_max, D.max_extra), lead: modNum(set.plan_dl_lead, D.lead) },
  };
}
const modText = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
const modFields = (b) => {
  const f = {};
  if ('list' in b) { f.list = String(b.list || '').trim(); if (!f.list) throw new HttpError(400, 'Name the list'); }
  if ('customer' in b) f.customer = modText(b.customer)?.toUpperCase() || null;
  for (const k of ['tag', 'type', 'note', 'authoriser']) if (k in b) f[k] = modText(b[k]);
  if ('tag' in b && f.tag) f.tag = f.tag.toUpperCase();
  if ('until' in b) { f.until = modText(b.until); if (f.until && !/^\d{4}-\d{2}-\d{2}$/.test(f.until)) throw new HttpError(400, 'Until must be a date'); }
  if ('value' in b) { f.value = Number(String(b.value ?? '').replace(',', '.')); if (String(b.value ?? '').trim() === '' || Number.isNaN(f.value)) throw new HttpError(400, 'The modifier must be a number'); }
  return f;
};
router.post('/plan/modifiers', h((req, res) => {
  const f = modFields({ list: req.body.list, customer: req.body.customer, tag: req.body.tag, type: req.body.type, value: req.body.value, note: req.body.note, authoriser: req.body.authoriser, until: req.body.until });
  res.status(201).json(fresh('plan_modifiers', insertRow('plan_modifiers', f)));
}));
router.patch('/plan/modifiers/:id', h((req, res) => {
  const old = db.get('SELECT * FROM plan_modifiers WHERE id = ?', [req.params.id]);
  if (!old) throw notFound('Modifier');
  res.json(fresh('plan_modifiers', updateRow('plan_modifiers', old.id, modFields(req.body))));
}));
router.delete('/plan/modifiers/:id', h((req, res) => {
  if (!db.run('DELETE FROM plan_modifiers WHERE id = ?', [req.params.id]).changes) throw notFound('Modifier');
  res.status(204).end();
}));
// The shift values for a customer ({ night, morning, afternoon }; all blank removes the row).
router.put('/plan/mod-shifts/:customer', h((req, res) => {
  const customer = String(req.params.customer || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(customer)) throw new HttpError(400, 'Not a customer code');
  const old = db.get('SELECT * FROM plan_mod_shifts WHERE customer = ?', [customer]);
  const f = {};
  for (const k of planning.SHIFTS) {
    const raw = k in req.body ? String(req.body[k] ?? '').replace(',', '.').trim() : old?.[k] ?? '';
    const v = raw === '' || raw === null ? null : Number(raw);
    if (v !== null && Number.isNaN(v)) throw new HttpError(400, 'The modifier must be a number');
    f[k] = v;
  }
  if (planning.SHIFTS.every((k) => !f[k])) { if (old) db.run('DELETE FROM plan_mod_shifts WHERE id = ?', [old.id]); return res.json(null); }
  res.json(old ? fresh('plan_mod_shifts', updateRow('plan_mod_shifts', old.id, f)) : fresh('plan_mod_shifts', insertRow('plan_mod_shifts', { customer, ...f })));
}));
// Card tags: one ({ ax, tag }; blank tag removes it) or pasted lines "AX<tab>Tag" ({ text }).
function setTag(ax, tag) {
  ax = String(ax ?? '').trim(); tag = String(tag ?? '').trim().toUpperCase();
  if (!ax) return 0;
  const old = db.get('SELECT * FROM plan_card_tags WHERE ax = ?', [ax]);
  if (!tag) { if (old) db.run('DELETE FROM plan_card_tags WHERE id = ?', [old.id]); return 0; }
  if (old) { if (old.tag !== tag) updateRow('plan_card_tags', old.id, { tag }); } else insertRow('plan_card_tags', { ax, tag });
  return 1;
}
router.post('/plan/card-tags', h((req, res) => {
  if (typeof req.body.text === 'string') {
    let n = 0;
    db.tx(() => { for (const line of req.body.text.split(/\r?\n/)) { const [ax, tag] = line.split(/\t|;|,/).map((x) => x?.trim()); if (ax && tag && !/^ax/i.test(ax)) n += setTag(ax, tag); } });
    return res.json({ saved: n });
  }
  res.json({ saved: setTag(req.body.ax, req.body.tag) });
}));
// Brings the modifier pages over from the Production Planning workbook: ShiftLookup, ManualLookup,
// MatchingLookup and DispatchLookup, and the Cards sheet's AX / Tag list. The lists it brings
// replace those of the same name.
router.post('/plan/modifiers/import', express.raw({ type: '*/*', limit: '50mb' }), h((req, res) => {
  if (!req.body?.length) throw new HttpError(400, 'Choose the Production Planning workbook');
  const { readBook } = require('./xlsxread');
  let book;
  try { book = readBook(req.body); } catch (err) { throw new HttpError(400, `Can't read it: ${err.message}`); }
  const rowsOf = (name) => {
    const info = book.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!info) return null;
    const sh = book.sheet(info.name); const grid = [];
    for (const c of sh.cells.values()) { (grid[c.row] = grid[c.row] || [])[c.col] = c.v; }
    return grid;
  };
  const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
  const got = { lists: {}, shifts: 0, tags: 0 };
  db.tx(() => {
    for (const [sheet, list] of [['MatchingLookup', 'Matching'], ['DispatchLookup', 'Dispatch'], ['ManualLookup', 'Manual']]) {
      const g = rowsOf(sheet); if (!g) continue;
      const head = (g[1] || []).map((x) => String(x ?? '').trim().toLowerCase());
      const col = (n) => head.indexOf(n);
      db.run('DELETE FROM plan_modifiers WHERE list = ?', [list]);
      let n = 0;
      for (let r = 2; r < g.length; r++) {
        const row = g[r] || []; const v = num(row[col('modifier')]);
        if (!row[col('customer')] || !v) continue; // a customer with no modifier set adds nothing
        insertRow('plan_modifiers', { list, customer: String(row[col('customer')]).trim().toUpperCase(), tag: modText(row[col('tag')])?.toUpperCase() || null, value: v,
          note: modText(row[col(list === 'Manual' ? 'reason' : 'additional steps')]), authoriser: col('authoriser') >= 0 ? modText(row[col('authoriser')]) : null });
        n++;
      }
      got.lists[list] = n;
    }
    const sg = rowsOf('ShiftLookup');
    if (sg) {
      const head = (sg[1] || []).map((x) => String(x ?? '').trim().toLowerCase());
      for (let r = 2; r < sg.length; r++) {
        const row = sg[r] || []; const customer = String(row[head.indexOf('customer')] ?? '').trim().toUpperCase();
        if (!customer) continue;
        const f = Object.fromEntries(planning.SHIFTS.map((k) => [k, num(row[head.indexOf(k)]) || null]));
        const old = db.get('SELECT id FROM plan_mod_shifts WHERE customer = ?', [customer]);
        if (planning.SHIFTS.every((k) => !f[k])) { if (old) db.run('DELETE FROM plan_mod_shifts WHERE id = ?', [old.id]); continue; }
        if (old) updateRow('plan_mod_shifts', old.id, f); else insertRow('plan_mod_shifts', { customer, ...f });
        got.shifts++;
      }
    }
    const cg = rowsOf('Cards');
    if (cg) { // the AX / Tag list beside the card table
      const head = (cg[1] || []).map((x) => String(x ?? '').trim().toLowerCase());
      const ax = head.lastIndexOf('ax'); const tag = head.lastIndexOf('tag');
      if (ax >= 0 && tag >= 0) for (let r = 2; r < cg.length; r++) { const row = cg[r] || []; if (row[ax] !== null && row[ax] !== undefined && row[tag]) got.tags += setTag(planning.axKey(row[ax]), row[tag]); }
    }
  });
  if (!Object.keys(got.lists).length && !got.shifts && !got.tags) throw new HttpError(400, 'No modifier pages found (MatchingLookup, DispatchLookup, ManualLookup, ShiftLookup)');
  res.json(got);
}));

// 📄 Generate plan: the operator sheets as a PDF. The page sends what to draw; the PDF is kept a
// few minutes so the browser can open it by address (and save it with a proper name).
const { renderPlanPdf } = require('./plansheet');
const planPdfs = new Map(); // id → { buf, name, at }
router.post('/plan/sheet', express.json({ limit: '10mb' }), h(async (req, res) => {
  const m = req.body || {};
  if (!Array.isArray(m.pages)) throw new HttpError(400, 'Nothing to draw');
  const buf = await renderPlanPdf(m);
  const now = Date.now();
  for (const [k, v] of planPdfs) if (now - v.at > 15 * 60000) planPdfs.delete(k);
  while (planPdfs.size >= 30) planPdfs.delete(planPdfs.keys().next().value);
  const id = `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const d = new Date();
  const name = `${String(m.file_label || 'Plan').replace(/[^\w .-]/g, '').trim() || 'Plan'} ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.pdf`;
  planPdfs.set(id, { buf, name, at: now });
  res.status(201).json({ url: `/api/plan/sheet/${id}/${encodeURIComponent(name)}`, name, bytes: buf.length });
}));
router.get('/plan/sheet/:id/:name?', h((req, res) => {
  const f = planPdfs.get(req.params.id);
  if (!f) throw new HttpError(404, 'That plan has expired — generate it again');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="${f.name}"`);
  res.send(f.buf);
}));

// 📦 The planning setup on its own — to move it to a planner on a server (or back): the plan_*
// settings and the machines, speeds, OEE, Matching machines and speeds, modifiers, shift values, card
// tags and pins. With ?history=1 also the history built up from the exports (each export read and
// each job seen, for the pace and on-time figures) and the ⏱ Production runs — merged on import.
const SETUP_TABLES = ['plan_machines', 'plan_speeds', 'plan_oee', 'plan_otto_machines', 'plan_otto_speeds', 'plan_modifiers', 'plan_mod_shifts', 'plan_card_tags', 'plan_pins'];
router.get('/plan/setup', h((req, res) => {
  const settings = Object.fromEntries(db.all("SELECT key, value FROM settings WHERE key LIKE 'plan\\_%' ESCAPE '\\'").map((r) => [r.key, r.value]));
  const tables = Object.fromEntries(SETUP_TABLES.map((t) => [t, db.all(`SELECT * FROM ${t} ORDER BY id`).map(({ id, created_at, updated_at, ...rest }) => rest)]));
  const withHistory = req.query.history === '1';
  const history = withHistory ? {
    reads: db.all('SELECT file_modified, file, read_at, jobs, cards, running, done FROM plan_history_reads ORDER BY id'),
    jobs: db.all('SELECT * FROM plan_history_jobs ORDER BY id').map(({ id, ...rest }) => rest),
    lines: db.all('SELECT key, wo, article, qty FROM plan_history_lines ORDER BY id'),
    otto_reads: db.all('SELECT file_modified, file, read_at, jobs FROM plan_otto_reads ORDER BY id'),
    otto_jobs: db.all('SELECT * FROM plan_otto_jobs ORDER BY id').map(({ id, ...rest }) => rest),
    disp_reads: db.all('SELECT file_modified, file, read_at, jobs FROM plan_disp_reads ORDER BY id'),
    disp_jobs: db.all('SELECT * FROM plan_disp_jobs ORDER BY id').map(({ id, ...rest }) => rest),
    prod_runs: db.all('SELECT * FROM prod_runs ORDER BY id').map(({ id, ...rest }) => rest),
  } : undefined;
  res.set('Content-Disposition', `attachment; filename="planning-setup${withHistory ? '-with-history' : ''}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ kind: 'ci-planning-setup', version: 1, exported_at: new Date().toISOString(), settings, tables, ...(history ? { history } : {}) });
}));
function importSetup(b) {
  if (b?.kind !== 'ci-planning-setup' || !b.tables) throw new HttpError(400, 'Not a planning setup file');
  const got = {};
  db.tx(() => {
    for (const t of SETUP_TABLES) {
      if (!Array.isArray(b.tables[t])) continue;
      const cols = new Set(db.all(`PRAGMA table_info(${t})`).map((c) => c.name));
      db.run(`DELETE FROM ${t}`);
      for (const row of b.tables[t]) insertRow(t, Object.fromEntries(Object.entries(row).filter(([k]) => cols.has(k) && !['id', 'created_at', 'updated_at'].includes(k))));
      got[t] = b.tables[t].length;
    }
    for (const [k, v] of Object.entries(b.settings || {})) if (/^plan_[a-z0-9_]+$/.test(k) && k in SETTING_DEFAULTS) db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v === null ? null : String(v)]);
  });
  return { tables: got, settings: Object.keys(b.settings || {}).filter((k) => /^plan_/.test(k)).length };
}
router.post('/plan/setup', express.json({ limit: '400mb' }), h((req, res) => {
  const b = req.body || {};
  const r = importSetup(b);
  res.json({ ok: true, ...r, history: b.history ? mergeHistory(b.history) : null });
}));

// 📦 Handed out on the network: the newest planning-setup*.json next to CIManager-Setup.bat
// (config.sharedDir), applied by itself when a new one appears — its history merged (only ever
// adds), its setup only on an install that has no planning setup yet (never over one in use).
function sharedSetupFile(pattern = /^planning-setup.*\.json$/i) {
  try {
    const dir = config.sharedDir;
    if (!dir || !fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => pattern.test(f))
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { file: path.join(dir, f), mtime: st.mtimeMs, size: st.size }; })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0] || null;
  } catch { return null; }
}
function applySharedSetup() {
  const f = sharedSetupFile();
  if (!f) return null;
  const sig = `${path.basename(f.file)}|${f.mtime}|${f.size}`;
  if (metaGet('shared_setup_applied') === sig) return null;
  const b = JSON.parse(fs.readFileSync(f.file, 'utf8').replace(/^\uFEFF/, ''));
  if (b?.kind !== 'ci-planning-setup') throw new Error('not a planning setup file');
  const empty = !db.get('SELECT 1 FROM plan_machines UNION ALL SELECT 1 FROM plan_speeds UNION ALL SELECT 1 FROM plan_otto_machines LIMIT 1');
  const setup = empty && b.tables ? importSetup(b) : null;
  const history = b.history ? mergeHistory(b.history) : null;
  metaSet('shared_setup_applied', sig);
  metaSet('shared_setup_info', JSON.stringify({ file: f.file, at: new Date().toISOString(), setup: !!setup, kept_own: !empty, history }));
  return { file: f.file, setup, kept_own: !empty, history };
}
// 📦 Team pack: what everyone on the team shares, handed out the same way — the contacts lists
// (People with their roles, Departments and any lists added) and the project categories and
// policy deployment lists. Applying it only ever adds: missing lists, names and entries; a
// person's details or department filled in only where they're blank here.
const TEAM_PATTERN = /^cimanager-team.*\.json$/i;
router.get('/team-pack', h((req, res) => {
  const lists = db.all('SELECT * FROM name_lists ORDER BY sort_order, id');
  const pack = {
    kind: 'ci-team-pack', version: 1, exported_at: new Date().toISOString(),
    contacts: lists.map((l) => ({ name: l.name, sort_order: l.sort_order,
      items: db.all('SELECT name, detail, department, active, sort_order FROM name_list_items WHERE list_id = ? ORDER BY sort_order, id', [l.id]).map((i) => ({ ...i, active: !!i.active })) })),
    lookups: db.all('SELECT list, name, active, sort_order FROM lookups ORDER BY list, sort_order, id').map((l) => ({ ...l, active: !!l.active })),
  };
  res.set('Content-Disposition', `attachment; filename="cimanager-team-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(pack);
}));
function mergeTeamPack(b) {
  if (b?.kind !== 'ci-team-pack') throw new HttpError(400, 'Not a CI Manager team pack');
  const out = { lists: 0, names: 0, filled: 0, lookups: 0 };
  db.tx(() => {
    for (const l of Array.isArray(b.contacts) ? b.contacts : []) {
      const name = String(l?.name || '').trim(); if (!name) continue;
      let list = db.get('SELECT * FROM name_lists WHERE name = ?', [name]);
      if (!list) { db.run('INSERT INTO name_lists (name, sort_order) VALUES (?, ?)', [name, Number(l.sort_order) || 0]); list = db.get('SELECT * FROM name_lists WHERE name = ?', [name]); out.lists++; }
      for (const i of Array.isArray(l.items) ? l.items : []) {
        const n = String(i?.name || '').trim(); if (!n) continue;
        const mine = db.get('SELECT * FROM name_list_items WHERE list_id = ? AND name = ?', [list.id, n]);
        if (!mine) {
          db.run('INSERT INTO name_list_items (list_id, name, detail, department, active, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
            [list.id, n, i.detail || null, i.department || null, i.active === false ? 0 : 1, Number(i.sort_order) || 0]);
          out.names++;
        } else if ((!mine.detail && i.detail) || (!mine.department && i.department)) {
          db.run('UPDATE name_list_items SET detail = coalesce(detail, ?), department = coalesce(department, ?) WHERE id = ?', [i.detail || null, i.department || null, mine.id]);
          out.filled++;
        }
      }
    }
    for (const l of Array.isArray(b.lookups) ? b.lookups : []) {
      const name = String(l?.name || '').trim();
      if (!name || !LOOKUP_LISTS.includes(l.list) || db.get('SELECT 1 FROM lookups WHERE list = ? AND name = ?', [l.list, name])) continue;
      db.run('INSERT INTO lookups (list, name, active, sort_order) VALUES (?, ?, ?, ?)', [l.list, name, l.active === false ? 0 : 1, Number(l.sort_order) || 0]);
      out.lookups++;
    }
  });
  return out;
}
router.post('/team-pack', express.json({ limit: '20mb' }), h((req, res) => res.json(mergeTeamPack(req.body))));
function applySharedTeam() {
  const f = sharedSetupFile(TEAM_PATTERN);
  if (!f) return null;
  const sig = `${path.basename(f.file)}|${f.mtime}|${f.size}`;
  if (metaGet('shared_team_applied') === sig) return null;
  const added = mergeTeamPack(JSON.parse(fs.readFileSync(f.file, 'utf8').replace(/^\uFEFF/, '')));
  metaSet('shared_team_applied', sig);
  metaSet('shared_team_info', JSON.stringify({ file: f.file, at: new Date().toISOString(), added }));
  return { file: f.file, added };
}
router.get('/team-pack/status', h((req, res) => {
  let info = null; try { info = JSON.parse(metaGet('shared_team_info') || 'null'); } catch { /* none */ }
  res.json({ dir: config.sharedDir, applied: info });
}));
const applySharedTeamSafe = () => { try { return applySharedTeam(); } catch (err) { return { error: err.message }; } };
setInterval(() => { const r = applySharedTeamSafe(); if (r?.file) log.info(`Team pack ${r.file} applied`, r.added); }, 30 * 60 * 1000).unref();

const applySharedSetupSafe = () => { try { return applySharedSetup(); } catch (err) { return { error: err.message }; } };
setInterval(() => { const r = applySharedSetupSafe(); if (r?.file) log.info(`Planning: shared setup ${r.file} applied`, r); }, 30 * 60 * 1000).unref();
router.get('/plan/setup/shared', h((req, res) => {
  let info = null; try { info = JSON.parse(metaGet('shared_setup_info') || 'null'); } catch { /* none */ }
  res.json({ dir: config.sharedDir, file: sharedSetupFile()?.file || null, applied: info });
}));

// History from another install, merged into this one's (nothing here is lost):
// - exports read: added where not here yet (same saved time = same export); they're filed under this
//   install's own export path, so the next read isn't taken for a different file being linked;
// - jobs: added where not here yet; where both have one, the one seen more recently wins (the
//   earliest first sighting kept);
// - Production runs: added where not here yet.
function mergeHistory(h) {
  const out = { reads: 0, jobs: 0, jobs_updated: 0, prod_runs: 0 };
  const ownFile = cleanPath(getSettings().plan_src) || null;
  db.tx(() => {
    // the newest export read must be the last one (by id): the next export is compared with it
    for (const r of Array.isArray(h.reads) ? h.reads : []) {
      if (!r?.file_modified || db.get('SELECT 1 FROM plan_history_reads WHERE file_modified = ?', [r.file_modified])) continue;
      db.run('INSERT INTO plan_history_reads (file_modified, file, read_at, jobs, cards, running, done) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [r.file_modified, ownFile || r.file || null, r.read_at || new Date().toISOString(), r.jobs || 0, r.cards || 0, r.running || 0, r.done || 0]);
      out.reads++;
    }
    const last = db.get('SELECT * FROM plan_history_reads ORDER BY file_modified DESC LIMIT 1');
    if (last && last.id !== db.get('SELECT max(id) AS m FROM plan_history_reads').m) {
      // move the latest export read to the end, filed under this install's export
      db.run('DELETE FROM plan_history_reads WHERE id = ?', [last.id]);
      db.run('INSERT INTO plan_history_reads (file_modified, file, read_at, jobs, cards, running, done) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [last.file_modified, ownFile || last.file, last.read_at, last.jobs, last.cards, last.running, last.done]);
    }
    const cols = ['key', 'wo', 'per', 'customer', 'qty', 'due', 'deadline', 'prio', 'shipper', 'first_seen', 'last_seen', 'started_at', 'done_at', 'late_minutes'];
    for (const j of Array.isArray(h.jobs) ? h.jobs : []) {
      if (!j?.key || !j.wo || !j.first_seen || !j.last_seen) continue;
      const mine = db.get('SELECT * FROM plan_history_jobs WHERE key = ?', [j.key]);
      if (!mine) { db.run(`INSERT INTO plan_history_jobs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => j[c] ?? null)); out.jobs++; continue; }
      const first = j.first_seen < mine.first_seen ? j.first_seen : mine.first_seen;
      if (j.last_seen > mine.last_seen) {
        db.run(`UPDATE plan_history_jobs SET ${cols.slice(1).map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.slice(1).map((c) => (c === 'first_seen' ? first : j[c] ?? null)), mine.id]);
        out.jobs_updated++;
      } else if (first !== mine.first_seen) db.run('UPDATE plan_history_jobs SET first_seen = ? WHERE id = ?', [first, mine.id]);
    }
    for (const l of Array.isArray(h.lines) ? h.lines : []) if (l?.key && l.wo && l.article) db.run('INSERT OR IGNORE INTO plan_history_lines (key, wo, article, qty) VALUES (?, ?, ?, ?)', [l.key, l.wo, l.article, Number(l.qty) || 0]);
    for (const r of Array.isArray(h.otto_reads) ? h.otto_reads : []) if (r?.file_modified) db.run('INSERT OR IGNORE INTO plan_otto_reads (file_modified, file, read_at, jobs) VALUES (?, ?, ?, ?)', [r.file_modified, r.file || null, r.read_at || new Date().toISOString(), r.jobs || 0]);
    const ocols = ['key', 'wo', 'customer', 'qty', 'due', 'deadline', 'prio', 'machine', 'first_seen', 'last_seen', 'done_at', 'late_minutes'];
    for (const j of Array.isArray(h.otto_jobs) ? h.otto_jobs : []) if (j?.key && j.first_seen && j.last_seen) db.run(`INSERT OR IGNORE INTO plan_otto_jobs (${ocols.join(', ')}) VALUES (${ocols.map(() => '?').join(', ')})`, ocols.map((c) => j[c] ?? null));
    for (const r of Array.isArray(h.disp_reads) ? h.disp_reads : []) if (r?.file_modified) db.run('INSERT OR IGNORE INTO plan_disp_reads (file_modified, file, read_at, jobs) VALUES (?, ?, ?, ?)', [r.file_modified, r.file || null, r.read_at || new Date().toISOString(), r.jobs || 0]);
    for (const j of Array.isArray(h.disp_jobs) ? h.disp_jobs : []) if (j?.key && j.first_seen && j.last_seen) db.run(`INSERT OR IGNORE INTO plan_disp_jobs (${ocols.join(', ')}) VALUES (${ocols.map(() => '?').join(', ')})`, ocols.map((c) => j[c] ?? null));
    const pcols = ['source', 'job', 'machine', 'station', 'start_at', 'end_at', 'qty', 'job_qty', 'remake', 'mode', 'product', 'item', 'item_name', 'customer', 'trigram', 'due', 'imported', 'file', 'read_at'];
    // runs only for the days this PC has none of (its own report reads are the record for theirs)
    const haveDay = new Set(db.all("SELECT DISTINCT source || '|' || substr(start_at, 1, 10) AS k FROM prod_runs").map((x) => x.k));
    for (const r of Array.isArray(h.prod_runs) ? h.prod_runs : []) {
      if (!r?.source || !r.job || !r.start_at || !prod.counted(r.job)) continue;
      if (haveDay.has(`${r.source}|${String(r.start_at).slice(0, 10)}`)) continue;
      const ch = db.run(`INSERT INTO prod_runs (${pcols.join(', ')}) VALUES (${pcols.map(() => '?').join(', ')})`, pcols.map((c) => (c === 'machine' ? r.machine ?? '' : c === 'remake' ? (r.remake ? 1 : 0) : c === 'read_at' ? r.read_at || new Date().toISOString() : r[c] ?? null)));
      if (ch?.changes) out.prod_runs++;
    }
  });
  return out;
}

// Matching machines: name, items per hour, how the export's Machine column names it (optional).
const ottoMachineFields = (b) => {
  const f = {};
  if ('name' in b) { f.name = String(b.name || '').trim(); if (!f.name) throw new HttpError(400, 'Give the machine a name'); }
  if ('match' in b) f.match = String(b.match || '').trim() || null;
  if ('speed' in b) {
    const raw = String(b.speed ?? '').replace(',', '.').trim();
    f.speed = raw ? Number(raw) : null;
    if (f.speed !== null && !(f.speed > 0)) throw new HttpError(400, 'Speed must be a number of items per hour above 0');
  }
  if ('active' in b) f.active = b.active ? 1 : 0;
  return f;
};
router.post('/plan/otto/machines', h((req, res) => {
  const f = ottoMachineFields({ name: req.body.name, match: req.body.match, speed: req.body.speed, active: req.body.active ?? true });
  const order = (db.get('SELECT MAX(sort_order) AS m FROM plan_otto_machines')?.m ?? -1) + 1;
  res.status(201).json(fresh('plan_otto_machines', insertRow('plan_otto_machines', { ...f, sort_order: order })));
}));
router.patch('/plan/otto/machines/:id', h((req, res) => {
  const old = db.get('SELECT * FROM plan_otto_machines WHERE id = ?', [req.params.id]);
  if (!old) throw notFound('Machine');
  res.json(fresh('plan_otto_machines', updateRow('plan_otto_machines', old.id, ottoMachineFields(req.body))));
}));
router.delete('/plan/otto/machines/:id', h((req, res) => {
  if (!db.run('DELETE FROM plan_otto_machines WHERE id = ?', [req.params.id]).changes) throw notFound('Machine');
  res.status(204).end();
}));
// Matching items per hour for a customer (trigram); blank removes it (the machine's speed is used).
router.put('/plan/otto/speeds/:customer', h((req, res) => {
  const customer = String(req.params.customer || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(customer)) throw new HttpError(400, 'Not a customer code');
  const raw = String(req.body.speed ?? '').replace(',', '.').trim();
  const old = db.get('SELECT id FROM plan_otto_speeds WHERE customer = ?', [customer]);
  if (!raw) { if (old) db.run('DELETE FROM plan_otto_speeds WHERE id = ?', [old.id]); return res.json(null); }
  const speed = Number(raw);
  if (!(speed > 0)) throw new HttpError(400, 'Speed must be a number of items per hour above 0');
  res.json(old ? fresh('plan_otto_speeds', updateRow('plan_otto_speeds', old.id, { speed })) : fresh('plan_otto_speeds', insertRow('plan_otto_speeds', { customer, speed })));
}));

// Production speeds by kind of card (type × material × print sides; blank = any).
const speedFields = (b) => {
  const t = (v) => (v === null || v === undefined ? null : String(v).trim() || null);
  const speed = Number(String(b.speed ?? '').replace(',', '.'));
  if (!(speed > 0)) throw new HttpError(400, 'Speed must be a number of cards per hour above 0');
  return { type: t(b.type), material: t(b.material), sides: t(b.sides), speed, machine: t(b.machine) };
};
router.post('/plan/speeds', h((req, res) => {
  const f = speedFields(req.body);
  const old = db.get('SELECT id FROM plan_speeds WHERE type IS ? AND material IS ? AND sides IS ?', [f.type, f.material, f.sides]);
  res.status(old ? 200 : 201).json(fresh('plan_speeds', old ? updateRow('plan_speeds', old.id, f) : insertRow('plan_speeds', f)));
}));
router.patch('/plan/speeds/:id', h((req, res) => {
  const old = db.get('SELECT * FROM plan_speeds WHERE id = ?', [req.params.id]);
  if (!old) throw notFound('Speed');
  res.json(fresh('plan_speeds', updateRow('plan_speeds', old.id, speedFields({ ...old, ...req.body }))));
}));
router.delete('/plan/speeds/:id', h((req, res) => {
  if (!db.run('DELETE FROM plan_speeds WHERE id = ?', [req.params.id]).changes) throw notFound('Speed');
  res.status(204).end();
}));

// Estimated OEE for a customer (trigram), in % (blank removes it: the default is used).
router.put('/plan/oee/:customer', h((req, res) => {
  const customer = String(req.params.customer || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,6}$/.test(customer)) throw new HttpError(400, 'Not a customer code');
  const raw = String(req.body.oee ?? '').replace('%', '').replace(',', '.').trim();
  const old = db.get('SELECT id FROM plan_oee WHERE customer = ?', [customer]);
  if (!raw) { if (old) db.run('DELETE FROM plan_oee WHERE id = ?', [old.id]); return res.json(null); }
  const pct = Number(raw);
  if (!(pct > 0 && pct <= 100)) throw new HttpError(400, 'OEE must be a percentage above 0 and up to 100');
  const row = old ? fresh('plan_oee', updateRow('plan_oee', old.id, { oee: pct / 100 })) : fresh('plan_oee', insertRow('plan_oee', { customer, oee: pct / 100 }));
  res.json(row);
}));

// 📌 Pinning a job puts it at the front of the queue (in pin order) until it's unpinned or done.
router.post('/plan/pins', h((req, res) => {
  const key = String(req.body.key || '').trim();
  if (!/^\S+\/\S*$/.test(key)) throw new HttpError(400, 'Not a job (work order / job)');
  if (!db.get('SELECT id FROM plan_pins WHERE key = ?', [key])) insertRow('plan_pins', { key });
  res.status(201).json({ ok: true });
}));
router.delete('/plan/pins', h((req, res) => {
  db.run('DELETE FROM plan_pins WHERE key = ?', [String(req.query.key || '')]);
  res.status(204).end();
}));

// What's been done: completions per day (on time or late), the week, the latest jobs done.
// 🔬 Learned from the production runs: speeds, OEE, accuracy, patterns and findings (see planlearn.js).
function learnNow(daysQ, toQ) {
  const set = getSettings();
  const dbc = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  const cards = dbc.status === 'ok' ? dbc.cards : null;
  const custNames = new Map();
  if (cards) for (const c of cards.values()) if (c.trigram && c.customer && !custNames.has(c.trigram.toUpperCase())) custNames.set(c.trigram.toUpperCase(), c.customer);
  const hm = (v, d) => planTime(v, d);
  const oeeDefault = Number(set.plan_oee_default) > 0 && Number(set.plan_oee_default) <= 100 ? Number(set.plan_oee_default) / 100 : null;
  return { ...planLearn.learn({
    days: [30, 60, 90, 180, 365].includes(Number(daysQ)) ? Number(daysQ) : 90,
    // the window ends now, or at the end of a day asked for (?to=YYYY-MM-DD)
    now: /^\d{4}-\d{2}-\d{2}$/.test(String(toQ || '')) ? new Date(`${toQ}T23:59:59`) : new Date(),
    cards, custNames, rules: db.all('SELECT * FROM plan_speeds'), rate: Number(set.plan_rate) || null,
    oee: { by: new Map(db.all('SELECT customer, oee FROM plan_oee').map((r) => [r.customer.toUpperCase(), r.oee])), fallback: oeeDefault },
    shiftStarts: { night: hm(set.plan_shift_night, 21 * 60 + 45), morning: hm(set.plan_shift_morning, 5 * 60 + 45), afternoon: hm(set.plan_shift_afternoon, 13 * 60 + 45) },
    ottoSpeeds: new Map(db.all('SELECT customer, speed FROM plan_otto_speeds').map((r) => [r.customer.toUpperCase(), r.speed])),
    ottoMachines: db.all('SELECT name, speed FROM plan_otto_machines WHERE active = 1'),
  }), learned_on: set.plan_learned_times === '1', cards_status: dbc.status, oee_default: oeeDefault ? Math.round(oeeDefault * 100) : null };
}
router.get('/plan/learn', h((req, res) => res.json(learnNow(req.query.days, req.query.to))));
// 🔍 Planning search: a work order or card looked up in the exports, the plan history, the runs and the card database.
function findCtx(withModel = false) {
  const set = getSettings();
  const src = planning.readSource({ file: cleanPath(set.plan_src) || null, uploaded: PLAN_UPLOAD });
  const o = planning.readSource({ file: cleanPath(set.plan_otto_src) || null, uploaded: OTTO_UPLOAD, parser: planning.parseOtto });
  const dbc = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  const cards = dbc.status === 'ok' ? dbc.cards : null;
  const dsp = planning.readSource({ file: cleanPath(set.plan_disp_src) || null, uploaded: DISP_UPLOAD, parser: planning.parseDisp });
  return { lines: src.status === 'ok' ? src.lines : [], otto: o.status === 'ok' ? o.jobs : [], disp: dsp.status === 'ok' ? dsp.jobs : [], cards,
    ...(withModel ? { model: planLearn.modelFor({ cards, cardsKey: `${dbc.file}|${dbc.modified}|${dbc.count}` }), predict: planLearn.predict } : {}) };
}
router.get('/plan/find', h((req, res) => res.json(planFind.suggest(String(req.query.q || '').slice(0, 60), findCtx()))));
router.get('/plan/find/wo/:wo', h((req, res) => res.json(planFind.workorder(req.params.wo, findCtx()))));
router.get('/plan/find/item/:ax', h((req, res) => res.json(planFind.item(req.params.ax, findCtx(true)))));
// 🔎 Explode: one of its tables opened up over any dates, grouped by anything, with each row's share.
router.get('/plan/learn/explode', h((req, res) => {
  const set = getSettings();
  const dbc = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  const cards = dbc.status === 'ok' ? dbc.cards : null;
  const custNames = new Map();
  if (cards) for (const c of cards.values()) if (c.trigram && c.customer && !custNames.has(c.trigram.toUpperCase())) custNames.set(c.trigram.toUpperCase(), c.customer);
  let filter = {};
  try { const f = JSON.parse(String(req.query.filter || '{}')); if (f && typeof f === 'object' && !Array.isArray(f)) filter = f; } catch { /* none */ }
  res.json(planLearn.explode({ from: req.query.from, to: req.query.to, by: req.query.by, source: req.query.source, compare: req.query.compare === '1', filter, cards, custNames,
    shiftStarts: { night: planTime(set.plan_shift_night, 21 * 60 + 45), morning: planTime(set.plan_shift_morning, 5 * 60 + 45), afternoon: planTime(set.plan_shift_afternoon, 13 * 60 + 45) } }));
}));
// The same as a workbook, to share or work on further.
router.get('/plan/learn.xlsx', h((req, res) => {
  const L = learnNow(req.query.days, req.query.to);
  const c = (header, width = 12, type) => ({ header, width, ...(type ? { type } : {}) });
  const pace = (title, rows) => ({ name: title, columns: [c(title.replace(/^By /, '').replace(/^./, (x) => x.toUpperCase()), 22), c('Name', 24), c('Runs', 8), c('Cards', 11), c('Hours', 9), c('Cards/h', 9), c('Pace %', 9)],
    rows: rows.map((r) => [r.label, r.name || '', r.runs, r.cards, r.hours, r.per_hour, r.pace]) });
  const sheets = [
    { name: 'Findings', columns: [c('Kind', 10), c('Finding', 120)], rows: [
      ['Window', `${L.days} days: ${L.runs.used} runs, ${L.runs.cards} cards over ${L.runs.days} days (${L.runs.anomalies} anomalies left out)`],
      ['Accuracy', `Planned within 25%: ${L.accuracy.now?.within ?? '—'}% now, ${L.accuracy.learned?.within ?? '—'}% with learned speeds + OEE, ${L.accuracy.items?.within ?? '—'}% card by card`],
      ...L.findings.map((f) => [f.kind, f.text])] },
    { name: 'Speeds', columns: [c('Type', 16), c('Material', 14), c('Print sides', 11), c('Runs', 8), c('Cards', 11), c('Learned cards/h', 14), c('From', 9), c('To', 9), c('Planned now', 12), c('Planned from', 22), c('Change %', 10), c('Confidence', 11)],
      rows: L.speeds.map((x) => [x.type, x.material, x.sides, x.runs, x.cards, x.speed, x.p25, x.p75, x.current, x.current_from, x.change, x.confidence]) },
    { name: 'OEE', columns: [c('Customer', 10), c('Name', 26), c('Runs', 8), c('Cards', 11), c('Measured %', 11), c('Suggested %', 11), c('Planned now %', 13), c('Confidence', 11)],
      rows: L.oee.map((x) => [x.customer, x.name, x.runs, x.cards, x.oee, x.suggested, x.current, x.confidence]) },
    pace('By shift', L.patterns.shift), pace('By job size', L.patterns.size), pace('By machine', L.patterns.machine), pace('By weekday', L.patterns.weekday),
    pace('By customer', L.patterns.customer), pace('By week', L.patterns.week),
    { name: 'Cards off their kind', columns: [c('Card AX', 14), c('Name', 26), c('Customer', 10), c('Type', 14), c('Material', 12), c('Print sides', 10), c('Runs', 8), c('Cards', 11), c('Its cards/h', 11), c('Kind cards/h', 11), c('Relative %', 10)],
      rows: L.cards.map((x) => [x.item, x.name, x.customer, x.type, x.material, x.sides, x.runs, x.cards, x.speed, x.kind_speed, Math.round(x.ratio * 100)]) },
    { name: 'Jobs over', columns: [c('Job', 18), c('Customer', 10), c('Started', 18), c('Runs', 8), c('Cards', 11), c('Machines', 16), c('Usual min', 10), c('Took min', 10), c('Over min', 10)],
      rows: L.overruns.map((x) => [x.job, x.customer, x.first.replace('T', ' '), x.runs, x.cards, x.machines, x.expected, x.actual, x.over]) },
    { name: 'Remakes', columns: [c('Customer', 10), c('Name', 26), c('Cards', 11), c('Remade', 10), c('Share %', 9)], rows: L.remakes.map((x) => [x.customer, x.name, x.cards, x.remade, x.pct]) },
    { name: 'Late', columns: [c('By', 10), c('Customer / shipper', 22), c('Jobs', 8), c('Late', 8), c('Share %', 9), c('Average late min', 15)],
      rows: [...L.lateness.customer.map((x) => ['customer', x.label, x.jobs, x.late, x.late_pct, x.avg_late]), ...L.lateness.shipper.map((x) => ['shipper', x.label, x.jobs, x.late, x.late_pct, x.avg_late])] },
    { name: 'Matching speeds', columns: [c('Customer', 10), c('Name', 26), c('Runs', 8), c('Items', 11), c('Learned items/h', 14), c('Planned now', 12), c('Change %', 10), c('Confidence', 11)],
      rows: L.matching.customers.map((x) => [x.customer, x.name, x.runs, x.items, x.speed, x.current ?? x.machine_avg, x.change, x.confidence]) },
  ];
  const file = `Planning learned ${new Date().toISOString().slice(0, 10)} (${L.days} days).xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.send(buildXlsx(sheets));
}));
router.get('/plan/history', h((req, res) => {
  res.json(planHistory.summary({ days: Math.min(60, Math.max(7, Number(req.query.days) || 14)), half: String(req.query.half || 'perso') }));
}));

// A copy of the export, to try it out before linking the file itself.
router.post('/plan/upload', express.raw({ type: '*/*', limit: '50mb' }), h((req, res) => {
  const half = ['otto', 'disp'].includes(req.query.half) ? req.query.half : 'perso';
  if (!req.body?.length) throw new HttpError(400, { otto: 'Choose the Matching export', disp: 'Choose the Dispatch export', perso: 'Choose the open work orders export' }[half]);
  try { ({ otto: planning.parseOtto, disp: planning.parseDisp, perso: planning.parse }[half])(req.body); } catch (err) { throw new HttpError(400, err.message); }
  const to = { otto: OTTO_UPLOAD, disp: DISP_UPLOAD, perso: PLAN_UPLOAD }[half];
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, req.body);
  res.status(201).json({ ok: true });
}));

// ------------------------------------------------------------------ settings & areas

const SETTING_DEFAULTS = {
  currency: '£', report_last_sent: '',
  // Weekly KPIs: where the CI workbook is, its sheets, and where the A3 copy is saved
  // ({year} {yy} {wk} {week} are filled in from the reporting week).
  kpi_workbook_path: '', kpi_a3_sheet: 'A3 Weekly Report', kpi_db_sheet: 'Database', kpi_week_cell: 'B2',
  kpi_export_dir: '', kpi_export_sub: 'WK{wk}', kpi_export_name: 'A3 {year} WK{wk}.xlsx',
  // The source files the KPIs are worked out from (blank: use the workbook's import sheets),
  // and whether weekend days in a week split across two months count in their month's part.
  kpi_src_perso: '', kpi_src_shipped: '', kpi_src_remakes: '', kpi_src_consumption: '', kpi_scrap_from: 'auto', kpi_src_otd: '', kpi_src_salesforce: '', kpi_split_weekends: '0',
  // The customer forecast files (blank: the workbook's copy of them).
  kpi_fc_benelux: '', kpi_fc_amex: '',
  // ⏱ The daily timing reports (each job's start and end on its machine), perso and Matching.
  kpi_time_perso: '', kpi_time_otto: '', cpm_shifts: '3', cpm_hours: '6', cpm_holidays: '', cpm_oee_default: '0.35', cpm_machines: '{}', kpi_perso_data: '', kpi_pdata_remakes: '1', kpi_pdata_live: '0', kpi_pdata_m: '1',
  // 🏭 Planning: the open work orders export, and the capacity the plan is projected with
  // (cards per hour per line × lines, working hours and days 0 = Sun … 6 = Sat).
  plan_src: '', planner_url: '', plan_db: '', plan_db_table: 'Cards', plan_rate: '', plan_lines: '1', plan_buffer: '0', plan_changeover: '0', plan_learned_times: '0', plan_oee_default: '', plan_otto_src: '', plan_disp_src: '', plan_max_age: '30', plan_miti_days: '5', plan_mod_off: '', plan_shift_night: '21:45', plan_shift_morning: '05:45', plan_shift_afternoon: '13:45', plan_dl_base: '100', plan_dl_per_day: '20', plan_dl_max: '100', plan_dl_lead: '10', plan_day_start: '06:00', plan_day_end: '22:00', plan_days: '1,2,3,4,5',
};
function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const r of db.all('SELECT key, value FROM settings')) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out;
}

router.get('/settings', h((req, res) => res.json(getSettings())));

router.patch('/settings', h((req, res) => {
  db.tx(() => {
    for (const key of Object.keys(SETTING_DEFAULTS)) {
      if (req.body[key] === undefined) continue;
      db.run(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, String(req.body[key]).trim()]);
    }
  });
  res.json(getSettings());
}));

// ---- ⏱ Production actuals: the daily timing reports, kept as they roll over --------------------
const prodFile = (source) => cleanPath(getSettings()[`kpi_time_${source}`]) || null;
const prodSource = (v) => (v === 'otto' ? 'otto' : 'perso');
// Read every 10 minutes (and at start-up) so no day is missed even with the page closed.
const pdataFile = () => cleanPath(getSettings().kpi_perso_data) || null;
function readProdReports() {
  const pd = require('./persodata').readLinked(pdataFile());
  if (pd.status === 'read') log.info(`DailyPersoData: read ${pd.rows} rows`); else if (pd.status === 'error') log.warn(`DailyPersoData: ${pd.error}`);
  for (const source of Object.keys(prod.SOURCES)) {
    const r = prod.readLinked(source, prodFile(source));
    if (r.status === 'read') log.info(`Production ${source}: read ${r.rows} runs (${r.added} new)`);
    else if (r.status === 'error') log.warn(`Production ${source}: ${r.error}`);
  }
}
setTimeout(() => { try { prod.purgeUncounted(); } catch (err) { log.warn('Production: tidying', err.message); } readProdReports(); }, 4000).unref();
setInterval(readProdReports, 10 * 60 * 1000).unref();

// The runs from a day (from=YYYY-MM-DD, days=1..31): Gantt, load, totals and anomalies.
// 📐 CPM — capacity planning (Prod Management): forecasts against actuals, flex, capacity and scenarios (cpm.js).
const cpm = require('./cpm');
function cpmCards() { const set = getSettings(); const c = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' }); return c.status === 'ok' ? c.cards : null; }
function cpmRefresh() {
  const set = getSettings();
  const files = Object.keys(kpiData.FORECASTS).map((key) => { const file = cleanPath(set[`kpi_fc_${key}`]); if (!file) return { key };
    try { const st = fs.statSync(file); return { key, file, modified: st.mtime.toISOString(), buf: fs.readFileSync(file) }; } catch (err) { return { key, file, error: err.message }; } });
  let read = null; try { read = cpm.refreshForecasts(files); } catch (err) { log.warn('CPM forecasts', err.message); }
  return { files: files.map(({ buf, ...f }) => f), read };
}
const cpmOwner = (req) => (req.account ? String(req.account.id) : 'local');
const cpmScenario = (req, id) => {
  if (!id) return null;
  const sc = db.get('SELECT * FROM cpm_scenarios WHERE id = ?', [id]);
  if (!sc || (sc.owner !== cpmOwner(req) && !sc.shared)) throw new HttpError(404, 'No such scenario');
  return { ...sc, changes: JSON.parse(sc.changes || '[]'), shared: !!sc.shared, mine: sc.owner === cpmOwner(req) };
};
const CPM_SETTINGS = ['cpm_shifts', 'cpm_hours', 'cpm_holidays', 'cpm_oee_default', 'cpm_machines'];
router.get('/cpm/overview', h((req, res) => {
  const files = cpmRefresh();
  const year = Number(req.query.year) || new Date().getFullYear();
  const period = req.query.period === 'week' ? 'week' : 'month';
  const useFlex = req.query.flex !== '0'; const cards = cpmCards();
  const base = cpm.compute({ year, period, useFlex, cards });
  const scenarios = String(req.query.scenarios || '').split(',').filter(Boolean).slice(0, 2).map((id) => cpmScenario(req, Number(id)));
  res.json({ ...base, files: files.files, cards: !!cards, settings: Object.fromEntries(CPM_SETTINGS.map((k) => [k, getSettings()[k]])),
    scenarios: scenarios.map((sc) => ({ id: sc.id, name: sc.name, ...cpm.compute({ year, period, useFlex, cards, changes: sc.changes }) })) });
}));
router.put('/cpm/settings', h((req, res) => {
  for (const k of CPM_SETTINGS) if (req.body[k] !== undefined) db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, String(req.body[k]).trim()]);
  res.json(Object.fromEntries(CPM_SETTINGS.map((k) => [k, getSettings()[k]])));
}));
router.get('/cpm/customers', h((req, res) => {
  cpmRefresh(); const cards = cpmCards();
  const learned = cpm.learnedSplit(cards); const prodOee = new Map(db.all('SELECT customer, oee FROM plan_oee').map((r) => [String(r.customer).toUpperCase(), r.oee]));
  const year = new Date().getFullYear(); const fc = cpm.forecastOf(year);
  const fcTot = new Map(); for (const [k, x] of fc.by) { const tri = k.split('|')[0]; fcTot.set(tri, (fcTot.get(tri) || 0) + (x.total || Object.values(x.tech).reduce((a, b) => a + b, 0))); }
  const list = cpm.customers().map((c) => ({ ...c, learned: learned.get(c.trigram) || null, prod_oee: prodOee.get(c.trigram) ?? null, forecast_year: fcTot.get(c.trigram) || 0 }));
  // customers persoed or forecast but not set up yet
  const known = new Set(list.map((c) => c.trigram));
  const seen = [...new Set([...learned.keys(), ...fcTot.keys()])].filter((t) => !known.has(t) && !/^[~*]/.test(t)).map((t) => ({ trigram: t, learned: learned.get(t) || null, forecast_year: fcTot.get(t) || 0 }));
  res.json({ customers: list, not_set_up: seen, unmapped: fc.unmapped, forecast_as_of: fc.as_of, techs: cpm.TECHS, oee_default: cpm.oeeFallback(), oee_default_from: Number(getSettings().plan_oee_default) > 0 ? 'production' : 'cpm' });
}));
router.put('/cpm/customers/:trigram', h((req, res) => {
  const tri = String(req.params.trigram || '').trim().toUpperCase(); if (!/^[A-Z0-9]{2,6}$/.test(tri)) throw new HttpError(400, 'Not a customer code');
  const b = req.body || {}; const num = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [cpm.normTech(k), Number(v)]).filter(([k, v]) => k && v > 0)) : null);
  const f = { name: b.name !== undefined ? String(b.name || '').trim() || null : undefined, fc_names: b.fc_names !== undefined ? (Array.isArray(b.fc_names) ? b.fc_names : String(b.fc_names || '').split('|')).map((x) => String(x).trim()).filter(Boolean).join('|') || null : undefined,
    split: b.split !== undefined ? (Object.keys(num(b.split) || {}).length ? JSON.stringify(num(b.split)) : null) : undefined, oee: b.oee !== undefined ? (Object.keys(num(b.oee) || {}).length ? JSON.stringify(num(b.oee)) : null) : undefined,
    active: b.active !== undefined ? (b.active ? 1 : 0) : undefined };
  const fields = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
  const old = db.get('SELECT id FROM cpm_customers WHERE trigram = ?', [tri]);
  if (old) updateRow('cpm_customers', old.id, fields); else insertRow('cpm_customers', { trigram: tri, ...fields });
  if (fields.fc_names !== undefined || fields.name !== undefined) cpm.remapForecasts();
  res.json(cpm.customers().find((c) => c.trigram === tri));
}));
router.delete('/cpm/customers/:trigram', h((req, res) => { db.run('DELETE FROM cpm_customers WHERE trigram = ?', [String(req.params.trigram).toUpperCase()]); cpm.remapForecasts(); res.status(204).end(); }));
// the CPM workbook's Config sheet: customers, splits, OEE (forecast names: the customer's name in it)
router.post('/cpm/customers/import', express.raw({ type: '*/*', limit: '60mb' }), h((req, res) => {
  let cfg; try { cfg = cpm.parseConfig(req.body); } catch (err) { throw new HttpError(400, err.message); }
  const byTri = new Map(); for (const c of cfg.customers) { const x = byTri.get(c.trigram); if (!x) byTri.set(c.trigram, { ...c, names: [c.name] }); else x.names.push(c.name); }
  db.tx(() => { for (const c of byTri.values()) {
    const old = db.get('SELECT * FROM cpm_customers WHERE trigram = ?', [c.trigram]);
    const names = [...new Set([...String(old?.fc_names || '').split('|').filter(Boolean), ...c.names])].join('|');
    const f = { name: old?.name || c.names[0], fc_names: names, split: Object.keys(c.split).length ? JSON.stringify(c.split) : old?.split ?? null, oee: Object.keys(c.oee).length ? JSON.stringify(c.oee) : old?.oee ?? null };
    if (old) updateRow('cpm_customers', old.id, f); else insertRow('cpm_customers', { trigram: c.trigram, ...f });
  } });
  cpm.remapForecasts();
  res.json({ sheet: cfg.sheet, customers: byTri.size });
}));
router.get('/cpm/flex', h((req, res) => { cpmRefresh(); const f = cpm.flex({ cards: cpmCards() }); res.json({ customers: f.customers, overall: f.overall, pairs: f.pairs, history: cpm.historyCoverage() }); }));
router.post('/cpm/history', express.raw({ type: '*/*', limit: '60mb' }), h((req, res) => {
  const name = String(req.get('X-File-Name') || 'upload.xlsx');
  let rows; try { rows = cpm.parseHistory(req.body, { kind: ['forecast', 'actual'].includes(req.query.kind) ? req.query.kind : null, year: Number(req.query.year) || null }); } catch (err) { throw new HttpError(400, `${name}: ${err.message}`); }
  if (!rows.length) throw new HttpError(400, `${name}: no months found — a row of months (JAN … DEC) with customers down the side, and the year and FORECAST / ACTUAL above them (or chosen when uploading)`);
  res.status(201).json({ file: name, ...cpm.storeHistory(rows, name) });
}));
router.delete('/cpm/history', h((req, res) => { const y = Number(req.query.year); const k = String(req.query.kind || ''); db.run('DELETE FROM cpm_history WHERE year = ? AND kind = ?', [y, k]); res.status(204).end(); }));
router.get('/cpm/scenarios', h((req, res) => {
  res.json(db.all('SELECT * FROM cpm_scenarios WHERE owner = ? OR shared = 1 ORDER BY owner = ? DESC, updated_at DESC', [cpmOwner(req), cpmOwner(req)])
    .map((sc) => ({ ...sc, changes: JSON.parse(sc.changes || '[]'), shared: !!sc.shared, mine: sc.owner === cpmOwner(req) })));
}));
const cpmChanges = (c) => (Array.isArray(c) ? c : []).filter((x) => x && typeof x === 'object' && /^(speed|add_machine|remove_machine|capabilities|shifts|oee|volume|new_customer)$/.test(x.type)).slice(0, 60);
router.post('/cpm/scenarios', h((req, res) => {
  const b = req.body || {}; const name = String(b.name || '').trim(); if (!name) throw new HttpError(400, 'Give the scenario a name');
  const row = insertRow('cpm_scenarios', { owner: cpmOwner(req), owner_name: req.account?.person || null, name, notes: b.notes || null, changes: JSON.stringify(cpmChanges(b.changes)), shared: b.shared ? 1 : 0 });
  res.status(201).json(cpmScenario(req, row.id));
}));
router.put('/cpm/scenarios/:id', h((req, res) => {
  const sc = cpmScenario(req, Number(req.params.id)); if (!sc.mine) throw new HttpError(403, 'Only its owner can change a scenario — copy it to make your own');
  const b = req.body || {}; const f = {};
  if (b.name !== undefined) { f.name = String(b.name).trim(); if (!f.name) throw new HttpError(400, 'Give the scenario a name'); }
  if (b.notes !== undefined) f.notes = b.notes || null; if (b.changes !== undefined) f.changes = JSON.stringify(cpmChanges(b.changes)); if (b.shared !== undefined) f.shared = b.shared ? 1 : 0;
  updateRow('cpm_scenarios', sc.id, f); res.json(cpmScenario(req, sc.id));
}));
router.delete('/cpm/scenarios/:id', h((req, res) => { const sc = cpmScenario(req, Number(req.params.id)); if (!sc.mine) throw new HttpError(403, 'Only its owner can delete a scenario'); db.run('DELETE FROM cpm_scenarios WHERE id = ?', [sc.id]); res.status(204).end(); }));

// 📆 D+ (due out): how much notice work orders come with, from the plan histories (dplus.js).
router.get('/plan/dplus', h((req, res) => {
  const set = getSettings();
  const dbc = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  const custNames = new Map();
  if (dbc.status === 'ok') for (const c of dbc.cards.values()) if (c.trigram && c.customer && !custNames.has(c.trigram.toUpperCase())) custNames.set(c.trigram.toUpperCase(), c.customer);
  const workDays = new Set(String(set.plan_days || '1,2,3,4,5').split(',').map(Number).filter((d) => d >= 0 && d <= 6));
  res.json(require('./dplus').profile({ from: req.query.from, to: req.query.to, bucket: req.query.bucket || null, source: req.query.source, workDays, custNames }));
}));
router.get('/prod', h((req, res) => {
  const source = prodSource(req.query.source);
  prod.readLinked(source, prodFile(source));
  // no day asked for: the latest day with runs (else today)
  const latest = db.get(`SELECT max(start_at) AS d FROM prod_runs WHERE source = ? AND ${prod.KEEP}`, [source])?.d;
  const m = String(req.query.from || '').match(/^(\d{4})-(\d{2})-(\d{2})$/) || String(latest || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  const now = new Date();
  const from = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.min(31, Math.max(1, Number(req.query.days) || 1));
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  const set = getSettings();
  const v = prod.view(source, from, to, { sensitivity: String(req.query.sensitivity || 'normal'), withAnomalies: req.query.anomalies === '1' });
  // customer names from Planning's card database, where the report has none
  const cards = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  if (cards.status === 'ok') {
    const names = new Map();
    for (const c of cards.cards.values()) if (c.trigram && c.customer && !names.has(c.trigram.toUpperCase())) names.set(c.trigram.toUpperCase(), c.customer);
    for (const r of v.runs) if (!r.customer && r.trigram) r.customer = names.get(r.trigram) || null;
  }
  res.json({ ...v,
    days, linked: { perso: !!prodFile('perso'), otto: !!prodFile('otto') }, file: prodFile(source),
    work: { start: set.plan_day_start, end: set.plan_day_end, days: String(set.plan_days || '1,2,3,4,5').split(',').map(Number) } });
}));
// 🕰 The open work orders hidden from Production for being due long ago (Setup: "Hide anything due more
// than … days ago"), to investigate: each with what's known about it — when it first appeared in the
// export, whether it ran (the ⏱ timing runs) and how much, its Matching jobs — and a hint: ran in full
// (likely done but not closed), partly run, or never run. Perso by work order and card line; Matching jobs.
// ⏱ Dispatch delays: a new expected date (and reason) for a customer's work orders due out on one day,
// or for one dispatch job (it wins over its group's). An empty date and reason clears it.
const okDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const delayFields = (b) => {
  const nd = String(b.new_date ?? '').trim(); if (nd && !okDay(nd)) throw new HttpError(400, 'The new date should be a date');
  return { new_date: nd || null, reason: String(b.reason ?? '').trim().slice(0, 300) || null };
};
router.put('/plan/disp/delay', h((req, res) => {
  const customer = String(req.body.customer || '').trim().toUpperCase(); const due = String(req.body.due || '');
  if (!customer || !okDay(due)) throw new HttpError(400, 'Choose a customer and original due date');
  const f = delayFields(req.body);
  const old = db.get('SELECT id FROM plan_disp_delays WHERE customer = ? AND due = ?', [customer, due]);
  if (!f.new_date && !f.reason) { if (old) db.run('DELETE FROM plan_disp_delays WHERE id = ?', [old.id]); return res.json(null); }
  res.json(old ? fresh('plan_disp_delays', updateRow('plan_disp_delays', old.id, f)) : fresh('plan_disp_delays', insertRow('plan_disp_delays', { customer, due, ...f })));
}));
// several groups at once: { groups: [{ customer, due }], new_date, reason }
router.put('/plan/disp/delays', h((req, res) => {
  const f = delayFields(req.body); const list = Array.isArray(req.body.groups) ? req.body.groups : [];
  if (!list.length) throw new HttpError(400, 'Choose the groups to change');
  db.tx(() => { for (const g of list) {
    const customer = String(g.customer || '').trim().toUpperCase(); const due = String(g.due || ''); if (!customer || !okDay(due)) continue;
    const old = db.get('SELECT id FROM plan_disp_delays WHERE customer = ? AND due = ?', [customer, due]);
    if (!f.new_date && !f.reason) { if (old) db.run('DELETE FROM plan_disp_delays WHERE id = ?', [old.id]); continue; }
    if (old) updateRow('plan_disp_delays', old.id, f); else insertRow('plan_disp_delays', { customer, due, ...f });
  } });
  res.json({ changed: list.length });
}));
router.put('/plan/disp/delay/job', h((req, res) => {
  const key = String(req.body.key || '').trim(); if (!key) throw new HttpError(400, 'Choose a dispatch job');
  const f = delayFields(req.body);
  const old = db.get('SELECT id FROM plan_disp_delay_jobs WHERE key = ?', [key]);
  if (!f.new_date && !f.reason) { if (old) db.run('DELETE FROM plan_disp_delay_jobs WHERE id = ?', [old.id]); return res.json(null); }
  const due = okDay(req.body.due) ? req.body.due : null; const customer = String(req.body.customer || '').trim().toUpperCase() || null;
  res.json(old ? fresh('plan_disp_delay_jobs', updateRow('plan_disp_delay_jobs', old.id, f)) : fresh('plan_disp_delay_jobs', insertRow('plan_disp_delay_jobs', { key, customer, due, ...f })));
}));
// The delay plan as a workbook to send on: by customer and original due date, and work order by work order.
router.get('/plan/disp/delays.xlsx', h((req, res) => {
  const set = getSettings();
  const now = new Date(); const ymdL = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymdL(now);
  const jobs = attachDelays((lastDisp?.jobs || dispOf(set, [], []).jobs).map((j) => ({ ...j })));
  // ?customers=ADX,KBC: only theirs (none: all customers)
  const only = new Set(String(req.query.customers || '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
  const delayed = jobs.filter((j) => isDelayed(j, today) && (!only.size || only.has(String(j.customer || '').toUpperCase())));
  const STAGE = { perso: 'Waiting on perso', matching: 'Waiting on Matching', ready: 'Ready to dispatch' };
  const groups = new Map();
  for (const j of delayed) { const k = `${j.customer}|${j.due}`; (groups.get(k) || groups.set(k, []).get(k)).push(j); }
  const c = (header, width = 12, type) => ({ header, width, ...(type ? { type } : {}) });
  // sent on to customer service as it is: what they need, the dates as dates
  const gRows = [...groups.values()].sort((a, b) => String(a[0].customer).localeCompare(String(b[0].customer)) || String(a[0].due).localeCompare(String(b[0].due))).map((l) => {
    // its work orders' dates differ (some have their own): the group is out by the latest of them
    const dates = l.map((j) => j.delay?.new_date || null); const g = l[0].delay;
    return [l[0].customer || '', l[0].due || null, l.length, l.reduce((t, j) => t + (j.qty || 0), 0), dates.every(Boolean) ? dates.sort().pop() : null,
      g?.group_reason || '', Object.entries(STAGE).map(([k, v]) => [v, l.filter((j) => j.stage === k).length]).filter(([, n]) => n).map(([v, n]) => `${n} ${v.toLowerCase()}`).join(', ')]; });
  const jRows = delayed.sort((a, b) => String(a.customer).localeCompare(String(b.customer)) || String(a.due).localeCompare(String(b.due)) || a.name.localeCompare(b.name)).map((j) => [
    j.name, j.customer || '', j.qty, j.due || null, j.delay?.new_date || null, j.delay?.reason || '']);
  const sheets = [
    { name: 'Delays', columns: [c('Customer', 10), c('Original due out', 13, 'date'), c('Work orders', 11, 'number'), c('Cards', 9, 'number'), c('New expected date', 14, 'date'), c('Reason', 40), c('Where they are', 40)], rows: gRows },
    { name: 'Work orders', columns: [c('Name', 24), c('Customer', 10), c('Cards', 8, 'number'), c('Original due out', 13, 'date'), c('New expected date', 14, 'date'), c('Reason', 40)], rows: jRows },
  ];
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="dispatch-delays-${only.size && only.size <= 3 ? `${[...only].sort().join('-').replace(/[^A-Z0-9-]/g, '')}-` : ''}${today}.xlsx"`);
  res.send(buildXlsx(sheets));
}));
// ⬆ The delays list kept so far in Excel (Name, Trigram, Due Date, Expected due date — other columns, its Comments
// too, are ignored): only the new expected dates are filled in; reasons already set are kept. A customer and due date
// whose rows all agree get the date as a group; otherwise each work order gets its own. A row whose expected date is
// its due date (or has none) has nothing to bring in.
// ?apply=1 saves it; without, it only says what it would do.
const DELAY_IMPORT = { name: ['name', 'wo', 'work order'], customer: ['trigram', 'customer'], due: ['due date', 'due out', 'due', 'original due date'],
  new_date: ['expected due date', 'expected date', 'new date', 'new expected date', 'expected'] };
router.post('/plan/disp/delays/import', express.raw({ type: '*/*', limit: '30mb' }), h((req, res) => {
  if (!req.body?.length) throw new HttpError(400, 'Choose the delays workbook');
  let book; try { book = require('./xlsxread').readBook(req.body); } catch { throw new HttpError(400, 'That isn\'t an Excel workbook (.xlsx)'); }
  const L = (n) => { let t = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) t = String.fromCharCode(65 + ((n - 1) % 26)) + t; return t; };
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  let sh = null; let headRow = 0; let col = null;
  for (const info of book.sheets) {
    const x = book.sheet(info.name);
    for (let r = 1; r <= Math.min(x.maxRow, 20) && !headRow; r++) {
      const found = {};
      for (const c of [...x.cells.values()].filter((y) => y.row === r)) for (const [k, names] of Object.entries(DELAY_IMPORT)) if (!found[k] && names.includes(norm(c.v))) found[k] = c.col;
      if (found.name && found.new_date) { sh = x; headRow = r; col = found; }
    }
    if (sh) break;
  }
  if (!sh) throw new HttpError(400, 'Can\'t find the Name and Expected due date columns');
  const day = (v) => { const d = planning.parseDay(v); return d ? `${d.y}-${String(d.m + 1).padStart(2, '0')}-${String(d.d).padStart(2, '0')}` : null; };
  const openJobs = new Map((lastDisp?.jobs || []).map((j) => [String(j.key).toUpperCase(), j]));
  const rows = []; let skipped = 0; let read = 0;
  for (let r = headRow + 1; r <= sh.maxRow; r++) {
    const g = (k) => (col[k] ? sh.cells.get(`${L(col[k])}${r}`)?.v ?? null : null);
    const name = String(g('name') ?? '').trim().toUpperCase();
    if (!name) continue;
    read++;
    const open = openJobs.get(name);
    const customer = (String(g('customer') ?? '').trim() || open?.customer || name.slice(1, 4)).toUpperCase();
    const due = day(g('due')) || open?.due || null;
    const expected = day(g('new_date'));
    const newDate = expected && expected !== due ? expected : null;
    if (!newDate) { skipped++; continue; }
    rows.push({ key: name, customer, due, new_date: newDate, open: !!open });
  }
  // a customer and due date whose rows all agree: one group date
  const byGroup = new Map();
  for (const x of rows) if (x.due) { const k = `${x.customer}|${x.due}`; (byGroup.get(k) || byGroup.set(k, []).get(k)).push(x); }
  const groups = []; const jobs = [];
  for (const [k, l] of byGroup) {
    if (l.every((x) => x.new_date === l[0].new_date)) { const [customer, due] = k.split('|'); groups.push({ customer, due, new_date: l[0].new_date, keys: l.map((x) => x.key) }); } else jobs.push(...l);
  }
  jobs.push(...rows.filter((x) => !x.due));
  const summary = { read, rows: rows.length, skipped, groups: groups.length, group_rows: groups.reduce((t, g) => t + g.keys.length, 0), jobs: jobs.length, open: rows.filter((x) => x.open).length, sheet: sh.name };
  if (String(req.query.apply) !== '1') return res.json({ ...summary, applied: false });
  db.tx(() => {
    for (const g of groups) {
      const old = db.get('SELECT id FROM plan_disp_delays WHERE customer = ? AND due = ?', [g.customer, g.due]);
      if (old) updateRow('plan_disp_delays', old.id, { new_date: g.new_date }); else insertRow('plan_disp_delays', { customer: g.customer, due: g.due, new_date: g.new_date });
      // they follow their group's date (a reason of their own stays)
      for (const k of g.keys) { db.run('UPDATE plan_disp_delay_jobs SET new_date = NULL WHERE key = ?', [k]); db.run('DELETE FROM plan_disp_delay_jobs WHERE key = ? AND reason IS NULL', [k]); }
    }
    for (const x of jobs) {
      const old = db.get('SELECT id FROM plan_disp_delay_jobs WHERE key = ?', [x.key]);
      if (old) updateRow('plan_disp_delay_jobs', old.id, { new_date: x.new_date, customer: x.customer, due: x.due });
      else insertRow('plan_disp_delay_jobs', { key: x.key, customer: x.customer, due: x.due, new_date: x.new_date });
    }
  });
  res.json({ ...summary, applied: true });
}));

// Delayed: actively overdue — its due-out day has passed and it's still open (one due today can still go today).
function isDelayed(j, today) {
  return !!j.due && j.due < today;
}

router.get('/plan/hidden.xlsx', h((req, res) => {
  const set = getSettings();
  const maxAge = Number(req.query.days) > 0 ? Number(req.query.days) : planMaxAge(set);
  const now = new Date();
  const ymdL = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const daysAgo = (due) => (due ? Math.floor((now - new Date(`${due}T12:00:00`)) / 86400000) : null);
  const src = planning.readSource({ file: cleanPath(set.plan_src) || null, uploaded: PLAN_UPLOAD });
  const o = planning.readSource({ file: cleanPath(set.plan_otto_src) || null, uploaded: OTTO_UPLOAD, parser: planning.parseOtto });
  const dbc = planning.readCards({ file: cleanPath(set.plan_db) || null, table: set.plan_db_table || 'Cards' });
  const cards = dbc.status === 'ok' ? dbc.cards : null;
  const custName = new Map(); if (cards) for (const c of cards.values()) if (c.trigram && c.customer && !custName.has(c.trigram.toUpperCase())) custName.set(c.trigram.toUpperCase(), c.customer);
  const lines = src.status === 'ok' ? src.lines.filter((l) => planning.tooOld(l.due, maxAge)) : [];
  const jobs = planning.jobsOf(lines).sort((a, b) => String(a.due).localeCompare(String(b.due)) || String(a.key).localeCompare(String(b.key)));
  const ottoAll = o.status === 'ok' ? o.jobs.filter((j) => !j.test) : [];
  const like = (wo) => `${String(wo).toUpperCase().replace(/[\\%_]/g, (x) => `\\${x}`)}%`;
  const runsOf = (wo) => db.get(`SELECT count(*) AS n, coalesce(sum(CASE WHEN remake = 0 THEN qty END), 0) AS cards, max(coalesce(end_at, start_at)) AS last, group_concat(DISTINCT machine) AS machines
    FROM prod_runs WHERE source = 'perso' AND upper(job) LIKE ? ESCAPE '\\'`, [like(wo)]);
  const woRuns = new Map(); const hist = new Map();
  for (const wo of new Set(jobs.map((j) => j.wo))) {
    woRuns.set(wo, runsOf(wo));
    hist.set(wo, db.get('SELECT min(first_seen) AS first, max(started_at) AS started FROM plan_history_jobs WHERE upper(wo) = ?', [String(wo).toUpperCase()]));
  }
  const woQty = new Map(); for (const j of jobs) woQty.set(j.wo, (woQty.get(j.wo) || 0) + j.qty);
  const hint = (wo, status) => { const r = woRuns.get(wo); const q = woQty.get(wo) || 0;
    if (!r?.n && /progress/i.test(status || '')) return 'In Progress in the export, but no runs recorded — check where it is';
    if (!r?.n) return 'Never ran — check it is still wanted, or the work order is wrong';
    if (r.cards >= q) return 'Ran in full — likely done but not closed in the system';
    return `Partly run (${r.cards} of ${q} cards) — check what is left`; };
  const ottoOf = (wo) => ottoAll.filter((x) => String(x.wo).toUpperCase() === String(wo).toUpperCase());
  const c = (header, width = 12, type) => ({ header, width, ...(type ? { type } : {}) });
  const inv = [c('Cause', 30), c('Action', 30), c('Owner', 16), c('Closed', 11, 'date')];
  const persoRows = jobs.map((j) => { const r = woRuns.get(j.wo); const h = hist.get(j.wo) || {}; const ox = ottoOf(j.wo);
    return [j.wo, j.per, j.customer || '', custName.get(String(j.customer || '').toUpperCase()) || '', j.qty, j.articles.length, j.due, daysAgo(j.due), j.status || '', j.prio || '', j.group || '', j.shipper || '', j.cutoff_raw || '',
      h.first || null, r.n, r.cards, r.last || null, r.machines || '', ox.length ? ox.map((x) => `${x.name}: ${x.done ? 'done' : x.status || 'open'}`).join('; ') : '', hint(j.wo, j.status), '', '', '', '']; });
  const lineRows = lines.slice().sort((a, b) => String(a.due).localeCompare(String(b.due)) || String(a.wo).localeCompare(String(b.wo))).map((l) => {
    const card = cards ? cards.get(planning.axKey(l.article)) : null;
    const ran = db.get(`SELECT count(*) AS n, coalesce(sum(CASE WHEN remake = 0 THEN qty END), 0) AS cards FROM prod_runs WHERE source = 'perso' AND upper(job) LIKE ? ESCAPE '\\' AND item IS NOT NULL AND (item = ? OR ltrim(item, '0') = ?)`, [like(l.wo), String(l.article).trim(), planning.axKey(l.article)]);
    return [l.wo, l.per, l.article, card?.name || '', [card?.type, card?.material, card?.sides].filter(Boolean).join(' · ') || (card ? '' : 'not in the card database'), l.qty, l.due, daysAgo(l.due), l.status || '', ran.n, ran.cards]; });
  const ottoHidden = ottoAll.filter((j) => !j.done && planning.tooOld(j.due, maxAge)).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const ottoRows = ottoHidden.map((j) => { const r = db.get(`SELECT count(*) AS n, coalesce(sum(qty), 0) AS items, max(coalesce(end_at, start_at)) AS last FROM prod_runs WHERE source = 'otto' AND upper(job) LIKE ? ESCAPE '\\'`, [like(j.name)]);
    const persoOpen = src.status === 'ok' && src.lines.some((l) => String(l.wo).toUpperCase() === String(j.wo).toUpperCase());
    return [j.name, j.wo, j.customer || '', j.customer_name || '', j.qty, j.due, daysAgo(j.due), j.status || '', j.machine || '', persoOpen ? 'yes' : 'no', r.n, r.items, r.last || null,
      r.n && r.items >= j.qty ? 'Ran in full — likely done but not closed' : r.n ? `Partly run (${r.items} of ${j.qty} items)` : persoOpen ? 'Never ran — perso still open' : 'Never ran — perso done', '', '', '', '']; });
  const dsp = planning.readSource({ file: cleanPath(set.plan_disp_src) || null, uploaded: DISP_UPLOAD, parser: planning.parseDisp });
  const dispHidden = dsp.status === 'ok' ? dsp.jobs.filter((j) => !j.done && planning.tooOld(j.due, maxAge)).sort((a, b) => String(a.due).localeCompare(String(b.due))) : [];
  const dispRows = dispHidden.map((j) => { const persoOpen = src.status === 'ok' && src.lines.some((l) => String(l.wo).toUpperCase() === j.wo); const ox = ottoOf(j.wo);
    const matchingOpen = ox.some((x) => !x.done);
    return [j.name, j.wo, j.customer || '', j.customer_name || '', j.qty, j.due, daysAgo(j.due), j.status || '', j.prio || '', j.group || '', persoOpen ? 'yes' : 'no',
      ox.length ? ox.map((x) => `${x.name}: ${x.done ? 'done' : x.status || 'open'}`).join('; ') : '',
      persoOpen ? 'Perso still open — check the perso work order first' : matchingOpen ? 'Waiting on Matching — check the Matching job' : 'Perso and Matching done — likely dispatched but not closed', '', '', '', '']; });
  const sheets = [
    { name: 'Read me', columns: [c('', 24), c('', 110)], rows: [
      ['What', `Open work orders hidden from Production because they were due more than ${maxAge} days ago (Production › ⚙ Setup › Hide anything due more than … days ago). They aren't shown or counted in the plan, the backlog or the tiles.`],
      ['Perso', `${new Set(jobs.map((j) => j.wo)).size} work orders, ${jobs.length} jobs, ${lines.length} card lines, ${jobs.reduce((t, j) => t + j.qty, 0)} cards — see "Hidden perso" (one row per job) and "Hidden perso lines" (one per card).`],
      ['Matching', `${ottoHidden.length} Matching jobs — see "Hidden Matching".`],
      ['Dispatch', `${dispHidden.length} dispatch jobs — see "Hidden Dispatch".`],
      ['Ran?', 'From the ⏱ timing runs kept by the CI Manager: "Ran in full" usually means the work is done but the work order was never closed; "Never ran" that it is still waiting, no longer wanted, or wrong.'],
      ['Investigation', 'Fill in Cause, Action, Owner and Closed as each is resolved.'],
      ['Made', `${ymdL(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`]] },
    { name: 'Hidden perso', columns: [c('Work order', 16), c('Job', 7), c('Customer', 9), c('Customer name', 20), c('Cards', 8, 'number'), c('Card lines', 9, 'number'), c('Due', 11, 'date'), c('Days ago', 8, 'number'),
      c('Status', 18), c('Priority', 8), c('Group', 14), c('Shipper', 22), c('Cut-off', 8), c('First seen in export', 17, 'datetime'), c('Runs', 6, 'number'), c('Cards run', 9, 'number'), c('Last run', 17, 'datetime'),
      c('Machines', 14), c('Matching', 30), c('Hint', 48), ...inv], rows: persoRows },
    { name: 'Hidden perso lines', columns: [c('Work order', 16), c('Job', 7), c('Card (AX)', 12), c('Card name', 24), c('Kind', 26), c('Cards', 8, 'number'), c('Due', 11, 'date'), c('Days ago', 8, 'number'), c('Status', 18), c('Runs', 6, 'number'), c('Cards run', 9, 'number')], rows: lineRows },
    { name: 'Hidden Matching', columns: [c('Name', 24), c('Work order', 16), c('Customer', 9), c('Customer name', 20), c('Items', 8, 'number'), c('Plan date', 11, 'date'), c('Days ago', 8, 'number'), c('Status', 18), c('Machine', 14),
      c('Perso still open', 10), c('Runs', 6, 'number'), c('Items run', 9, 'number'), c('Last run', 17, 'datetime'), c('Hint', 40), ...inv], rows: ottoRows },,
    { name: 'Hidden Dispatch', columns: [c('Name', 24), c('Work order', 16), c('Customer', 9), c('Customer name', 20), c('Qty', 8, 'number'), c('Due out', 11, 'date'), c('Days ago', 8, 'number'), c('Status', 22), c('Priority', 8), c('Group', 22),
      c('Perso still open', 10), c('Matching', 30), c('Hint', 44), ...inv], rows: dispRows }
  ];
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="hidden-work-orders-${ymdL(now)}.xlsx"`);
  res.send(buildXlsx(sheets));
}));

// ⚠ The timing runs judged anomalies (far too quick or slow for their machine and size, no end,
// impossible) over a period, in one workbook to investigate: by work order and run by run, with columns
// for the investigation. (The work orders hidden for their age: /plan/hidden.xlsx.)
router.get('/prod/anomalies.xlsx', h((req, res) => {
  const set = getSettings();
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const now = new Date();
  const to = ok(req.query.to) ? new Date(`${req.query.to}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
  to.setDate(to.getDate() + 1);
  const from = ok(req.query.from) ? new Date(`${req.query.from}T00:00:00`) : new Date(to.getTime() - 90 * 86400000);
  const sens = ['strict', 'normal', 'loose'].includes(req.query.sensitivity) ? req.query.sensitivity : 'normal';
  const ymdL = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const SIDE = { perso: 'Perso', otto: 'Matching' };
  const KIND = { slow: 'Far too slow', quick: 'Far too quick', open: 'No end time', invalid: 'Impossible' };
  // the runs set aside, both sides
  const runs = [];
  for (const source of ['perso', 'otto']) {
    const v = prod.view(source, from, to, { sensitivity: sens });
    for (const r of v.runs) if (r.anomaly) runs.push({ ...r, side: source, wo: planning.woOfName(r.job) });
  }
  runs.sort((a, b) => (a.wo < b.wo ? -1 : a.wo > b.wo ? 1 : a.start_at < b.start_at ? -1 : 1));
  // where each work order stands now
  const src = planning.readSource({ file: cleanPath(set.plan_src) || null, uploaded: PLAN_UPLOAD });
  const openWos = new Set(src.status === 'ok' ? src.lines.map((l) => String(l.wo).toUpperCase()) : []);
  const statusOf = (wo) => { if (openWos.has(wo)) return 'Open'; const h = db.get('SELECT max(done_at) AS d, count(*) AS n FROM plan_history_jobs WHERE upper(wo) = ?', [wo]); return h.n ? (h.d ? `Done ${String(h.d).slice(0, 10)}` : 'Open') : 'Not seen in the export'; };
  const off = (r) => (r.usual?.minutes > 0 && r.minutes > 0 ? Math.round((Math.max(r.minutes, r.usual.minutes) / Math.min(r.minutes, r.usual.minutes)) * 10) / 10 : null);
  const byWo = new Map();
  for (const r of runs) { const k = `${r.side}|${r.wo}`; (byWo.get(k) || byWo.set(k, []).get(k)).push(r); }
  const woRows = [...byWo.values()].map((l) => {
    const worst = l.reduce((a, b) => ((off(b) || 0) > (off(a) || 0) ? b : a));
    return [l[0].wo, SIDE[l[0].side], l[0].trigram || l[0].customer || '', l.length, [...new Set(l.map((r) => KIND[r.anomaly.kind] || r.anomaly.kind))].join(', '),
      l.reduce((t, r) => t + (r.qty || 0), 0), Math.round(l.reduce((t, r) => t + (r.minutes > 0 ? r.minutes : 0), 0)), Math.round(l.reduce((t, r) => t + (r.usual?.minutes || 0), 0)),
      worst.anomaly.text, [...new Set(l.map((r) => r.machine))].join(', '), l[0].start_at, l[l.length - 1].end_at || l[l.length - 1].start_at, statusOf(String(l[0].wo).toUpperCase()), '', '', '', ''];
  }).sort((a, b) => b[3] - a[3] || String(a[0]).localeCompare(String(b[0])));
  const runRows = runs.map((r) => [r.wo, SIDE[r.side], r.job, r.machine, r.station || '', r.start_at, r.end_at || '', r.minutes > 0 ? Math.round(r.minutes) : null, r.qty,
    r.usual ? Math.round(r.usual.minutes) : null, off(r), KIND[r.anomaly.kind] || r.anomaly.kind, r.anomaly.text, r.item || '', r.item_name || '', r.trigram || r.customer || '', r.remake ? 'yes' : '']);
  const c = (header, width = 12, type) => ({ header, width, ...(type ? { type } : {}) });
  const inv = [c('Cause', 30), c('Action', 30), c('Owner', 16), c('Closed', 11, 'date')];
  const sheets = [
    { name: 'Read me', columns: [c('', 26), c('', 100)], rows: [
      ['What', 'Everything the CI Manager sets aside, to investigate'],
      ['Timing anomalies', `Runs from the daily timing reports between ${ymdL(from)} and ${ymdL(new Date(to.getTime() - 86400000))} that can't be right for their machine and size (strictness: ${sens}). They are left out of Timing, Learned and the planning figures.`],
      ['', `${runRows.length} run${runRows.length === 1 ? '' : 's'} in ${woRows.length} work order${woRows.length === 1 ? '' : 's'}: see "Anomalies by WO" (one row each, with columns for the investigation) and "Anomalous runs" (every run).`],
      ['Old open work orders', 'The open work orders hidden from Production for their age have their own export: the ⬇ Export them to Excel button on the hidden line in the Perso or Matching backlog.'],
      ['Made', new Date().toISOString().replace('T', ' ').slice(0, 16)]] },
    { name: 'Anomalies by WO', columns: [c('Work order', 16), c('Side', 9), c('Customer', 10), c('Runs', 6, 'number'), c('Kinds', 22), c('Cards', 9, 'number'), c('Minutes took', 11, 'number'), c('Usual minutes', 11, 'number'),
      c('Worst', 60), c('Machines', 16), c('First run', 17, 'datetime'), c('Last run', 17, 'datetime'), c('In the export now', 18), ...inv], rows: woRows },
    { name: 'Anomalous runs', columns: [c('Work order', 16), c('Side', 9), c('Job', 22), c('Machine', 10), c('Station', 10), c('Started', 17, 'datetime'), c('Ended', 17, 'datetime'), c('Minutes', 9, 'number'),
      c('Cards', 9, 'number'), c('Usual minutes', 11, 'number'), c('× off', 7, 'number'), c('Kind', 14), c('Why', 60), c('Card (AX)', 12), c('Card name', 22), c('Customer', 10), c('Remake', 8)], rows: runRows },
  ];
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="anomalies-${ymdL(from)}-to-${ymdL(new Date(to.getTime() - 86400000))}.xlsx"`);
  res.send(buildXlsx(sheets));
}));
// Read the linked report now (even if it looks unchanged).
router.post('/prod/read', h((req, res) => {
  if (req.body?.source === 'pdata') {
    const r = require('./persodata').readLinked(pdataFile(), { force: true });
    if (r.status === 'none') throw new HttpError(400, 'Set where the DailyPersoData report is saved first');
    return res.json(r);
  }
  const source = prodSource(req.body?.source);
  const r = prod.readLinked(source, prodFile(source), { force: true });
  if (r.status === 'none') throw new HttpError(400, `Set where the ${prod.SOURCES[source]} timing report is saved first`);
  res.json(r);
}));
// Older reports, loaded by hand to fill in the history.
router.post('/prod/upload', express.raw({ type: '*/*', limit: '100mb' }), h((req, res) => {
  const source = prodSource(req.query.source);
  if (!req.body?.length) throw new HttpError(400, 'Choose a timing report');
  const name = fileNameHeader(req, 'report.xlsx');
  if (!/\.xls[xm]$/i.test(name)) throw new HttpError(400, 'Choose an Excel file (.xlsx)');
  let parsed;
  try { parsed = prod.parse(req.body); } catch (err) { throw new HttpError(400, `${name}: ${err.message}`); }
  res.status(201).json({ source, file: name, rows: parsed.rows.length, skipped: parsed.skipped, ...prod.coverage(parsed.rows), ...prod.store(source, parsed.rows, name) });
}));

// ---- shared defaults: the file paths that are the same for everyone on the network
// (the CI workbook, the KPI sources and forecasts, the A3 folder, the planning exports), handed
// out in one file — exported on KPIs › Sources, put next to CIManager-Setup.bat on the share and
// read by every install when it starts (DEFAULTS_FILE). A value is filled in only where it's blank,
// still the built-in default, or still what the last shared file said: anything someone set
// for themselves is left alone.
const SHARED_KEYS = Object.keys(SETTING_DEFAULTS).filter((k) => k.startsWith('kpi_')
  || ['plan_src', 'plan_otto_src', 'plan_disp_src', 'plan_db', 'plan_db_table', 'planner_url',
    // …and the planning settings every figure depends on, so every PC works them out alike
    'plan_days', 'plan_day_start', 'plan_day_end', 'plan_max_age', 'plan_buffer', 'plan_changeover'].includes(k));
const metaGet = (key) => db.get('SELECT value FROM settings WHERE key = ?', [key])?.value;
const metaSet = (key, value) => db.run(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);

function sharedValues(doc) {
  const values = doc && typeof doc === 'object' && doc.settings && typeof doc.settings === 'object' ? doc.settings : null;
  if (!values) throw new HttpError(400, 'Not a CI Manager shared defaults file');
  return Object.fromEntries(SHARED_KEYS.filter((k) => typeof values[k] === 'string').map((k) => [k, values[k].trim()]));
}

function applyShared(values, from) {
  const cur = getSettings();
  let prev = {};
  try { prev = JSON.parse(metaGet('shared_defaults_values') || '{}'); } catch { /* none yet */ }
  const changed = []; const kept = [];
  db.tx(() => {
    for (const [k, v] of Object.entries(values)) {
      if (cur[k] === v) continue;
      if (cur[k] === '' || cur[k] === SETTING_DEFAULTS[k] || (k in prev && cur[k] === prev[k])) {
        metaSet(k, v); changed.push(k);
      } else kept.push(k);
    }
    metaSet('shared_defaults_values', JSON.stringify(values));
    metaSet('shared_defaults_from', from);
    metaSet('shared_defaults_at', new Date().toISOString());
  });
  return { changed, kept };
}

function readSharedFile(file) {
  return sharedValues(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')));
}

router.get('/settings/shared', h((req, res) => {
  let values = {};
  try { values = JSON.parse(metaGet('shared_defaults_values') || '{}'); } catch { /* none */ }
  const cur = getSettings();
  res.json({ file: config.defaultsFile, file_found: !!config.defaultsFile && fs.existsSync(config.defaultsFile),
    from: metaGet('shared_defaults_from') || null, at: metaGet('shared_defaults_at') || null, keys: SHARED_KEYS,
    own: Object.keys(values).filter((k) => cur[k] !== values[k]) });
}));

// The paths set here, as a file for everyone else.
router.get('/settings/shared/export', h((req, res) => {
  const cur = getSettings();
  const settings = Object.fromEntries(SHARED_KEYS.filter((k) => cur[k] !== '' && cur[k] !== SETTING_DEFAULTS[k]).map((k) => [k, cur[k]]));
  res.set('Content-Disposition', 'attachment; filename="cimanager-defaults.json"');
  res.type('application/json').send(JSON.stringify({ app: 'CI Manager', kind: 'shared-defaults', exported_at: new Date().toISOString(), settings }, null, 2));
}));

// Apply a file picked in the browser ({ doc, name }), or the shared file again ({}).
router.post('/settings/shared/apply', express.json({ limit: '1mb' }), h((req, res) => {
  let values; let from;
  if (req.body?.doc) { values = sharedValues(req.body.doc); from = String(req.body.name || 'a file'); } else {
    if (!config.defaultsFile) throw new HttpError(400, 'No shared defaults file is set up (DEFAULTS_FILE)');
    if (!fs.existsSync(config.defaultsFile)) throw new HttpError(400, `Can't reach ${config.defaultsFile}`);
    try { values = readSharedFile(config.defaultsFile); } catch (err) { throw err instanceof HttpError ? err : new HttpError(400, `Couldn't read ${config.defaultsFile}: ${err.message}`); }
    from = config.defaultsFile;
  }
  res.json({ ...applyShared(values, from), settings: getSettings() });
}));

router.get('/areas', h((req, res) => {
  res.json(db.all(`SELECT a.*, (SELECT count(*) FROM ideas i WHERE i.area_id = a.id) AS idea_count
    FROM areas a ORDER BY a.sort_order, a.name COLLATE NOCASE`).map((a) => ({ ...a, active: !!a.active })));
}));

router.post('/areas', h((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) throw new HttpError(400, 'Area name is required');
  if (db.get('SELECT 1 FROM areas WHERE name = ?', [name])) throw new HttpError(400, `"${name}" already exists`);
  res.status(201).json(insertRow('areas', { name }));
}));

router.patch('/areas/:id', h((req, res) => {
  const f = pick(req.body, ['name', 'active', 'sort_order']);
  if (f.name !== undefined) {
    f.name = String(f.name || '').trim();
    if (!f.name) throw new HttpError(400, 'Area name is required');
    if (db.get('SELECT 1 FROM areas WHERE name = ? AND id <> ?', [f.name, req.params.id])) throw new HttpError(400, `"${f.name}" already exists`);
  }
  const row = updateRow('areas', req.params.id, f);
  if (!row) throw notFound('Area');
  res.json(fresh('areas', row));
}));

router.delete('/areas/:id', h((req, res) => {
  const used = db.get('SELECT count(*) AS n FROM ideas WHERE area_id = ?', [req.params.id]).n;
  if (used) throw new HttpError(400, `This area is used by ${used} idea(s). Untick "Active" to hide it from the list instead.`);
  const { changes } = db.run('DELETE FROM areas WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Area');
  res.status(204).end();
}));

// ------------------------------------------------------------------ charter: team, KPIs, lists

const TEAM_FIELDS = ['name', 'role', 'capacity', 'contact', 'sort_order'];
const KPI_FIELDS = ['name', 'unit', 'baseline', 'target', 'current', 'sort_order'];
for (const [path_, table, fieldsList, what] of [['team', 'project_team', TEAM_FIELDS, 'Team member'], ['kpis', 'project_kpis', KPI_FIELDS, 'KPI']]) {
  router.post(`/projects/:id/${path_}`, h((req, res) => {
    if (!db.get('SELECT 1 FROM projects WHERE id = ?', [req.params.id])) throw notFound('Project');
    const f = pick(req.body, fieldsList);
    if (!String(f.name || '').trim()) throw new HttpError(400, `${what} name is required`);
    if (f.sort_order === undefined) {
      f.sort_order = db.get(`SELECT coalesce(max(sort_order), -1) + 1 AS n FROM ${table} WHERE project_id = ?`, [req.params.id]).n;
    }
    res.status(201).json(insertRow(table, { ...f, project_id: Number(req.params.id) }));
  }));
  router.patch(`/${path_}/:id`, h((req, res) => {
    const f = pick(req.body, fieldsList);
    if ('name' in f && !String(f.name || '').trim()) throw new HttpError(400, `${what} name is required`);
    const row = fresh(table, updateRow(table, req.params.id, f));
    if (!row) throw notFound(what);
    res.json(row);
  }));
  router.delete(`/${path_}/:id`, h((req, res) => {
    if (!db.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]).changes) throw notFound(what);
    res.status(204).end();
  }));
}

const LOOKUP_LISTS = ['category', 'policy_deployment'];
router.get('/lookups', h((req, res) => {
  const rows = db.all(`SELECT l.*, (SELECT count(*) FROM projects p WHERE
      (l.list = 'category' AND p.category = l.name) OR (l.list = 'policy_deployment' AND p.policy_deployment = l.name)) AS used
    FROM lookups l ORDER BY l.sort_order, l.name COLLATE NOCASE`).map((r) => ({ ...r, active: !!r.active }));
  res.json(Object.fromEntries(LOOKUP_LISTS.map((l) => [l, rows.filter((r) => r.list === l)])));
}));
router.post('/lookups', h((req, res) => {
  const name = String(req.body.name || '').trim();
  if (!LOOKUP_LISTS.includes(req.body.list)) throw new HttpError(400, 'Unknown list');
  if (!name) throw new HttpError(400, 'Name is required');
  if (db.get('SELECT 1 FROM lookups WHERE list = ? AND name = ?', [req.body.list, name])) throw new HttpError(400, `"${name}" already exists`);
  res.status(201).json(insertRow('lookups', { list: req.body.list, name }));
}));
router.patch('/lookups/:id', h((req, res) => {
  const cur = db.get('SELECT * FROM lookups WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound('List item');
  const f = pick(req.body, ['name', 'active', 'sort_order']);
  if ('name' in f) {
    f.name = String(f.name || '').trim();
    if (!f.name) throw new HttpError(400, 'Name is required');
  }
  const row = db.tx(() => {
    const r = updateRow('lookups', cur.id, f);
    // Renaming an item updates the projects that use it.
    if (f.name && f.name !== cur.name) db.run(`UPDATE projects SET ${cur.list} = ? WHERE ${cur.list} = ?`, [f.name, cur.name]);
    return r;
  });
  res.json(fresh('lookups', row));
}));
router.delete('/lookups/:id', h((req, res) => {
  if (!db.run('DELETE FROM lookups WHERE id = ?', [req.params.id]).changes) throw notFound('List item');
  res.status(204).end();
}));

// ---- charter Excel template: upload once, map fields to cells, fill per project

// Uploads send their file name URI-encoded (headers can't carry e.g. "é" as is).
const fileNameHeader = (req, fallback) => {
  const raw = String(req.get('X-File-Name') || '');
  try { return decodeURIComponent(raw) || fallback; } catch { return raw || fallback; }
};
const TEMPLATE_FILE = path.join(config.dataDir, 'charter-template.xlsx');
const setSetting = (key, value) => db.run(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
const getSetting = (key) => db.get('SELECT value FROM settings WHERE key = ?', [key])?.value ?? null;

function templateInfo() {
  const exists = fs.existsSync(TEMPLATE_FILE);
  const info = { uploaded: exists, file_name: getSetting('charter_template_name'), fields: charter.FIELD_LIST,
    mapping: parseJson(getSetting('charter_map')) || {} };
  if (exists) {
    try {
      const t = charter.readTemplate(fs.readFileSync(TEMPLATE_FILE));
      info.sheets = t.sheets.filter((sh) => !sh.hidden).map((sh) => sh.name);
      info.output_sheets = charter.outputSheets(t, info.mapping);
      info.dropped_sheets = t.sheets.map((sh) => sh.name).filter((n) => !info.output_sheets.includes(n));
      info.timelines = t.sheets.filter((sh) => !sh.hidden).flatMap((sh) => charter.detectTimelines(sh)).map((g) => ({
        title: g.title, kind: g.kind, sheet: g.sheet, first_row: g.rows[0], last_row: g.rows.at(-1), rows: g.rows.length,
        months: g.months.length, has_owner: !!g.owner_col, has_planned: !!g.planned_col, has_status: !!g.status_col,
      }));
      info.uploaded_at = fs.statSync(TEMPLATE_FILE).mtime.toISOString();
    } catch (err) { info.error = err.message; }
  }
  return info;
}

router.get('/charter-template', h((req, res) => res.json(templateInfo())));

router.post('/charter-template', express.raw({ type: '*/*', limit: '15mb' }), h((req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || !buf.length) throw new HttpError(400, 'No file received');
  let detected;
  let template;
  try {
    template = charter.readTemplate(buf);
    detected = charter.detectMapping(template);
  } catch (err) {
    throw new HttpError(400, `That doesn't look like an Excel .xlsx file (${err.message})`);
  }
  // Offer the template's own dropdown choices (e.g. Category) as the app's pick-list.
  for (const list of ['category', 'policy_deployment']) {
    charter.validationList(template, detected[list]).forEach((name) => {
      db.run('INSERT OR IGNORE INTO lookups (list, name) VALUES (?, ?)', [list, name]);
    });
  }
  fs.mkdirSync(path.dirname(TEMPLATE_FILE), { recursive: true });
  fs.writeFileSync(TEMPLATE_FILE, buf);
  setSetting('charter_template_name', fileNameHeader(req, 'template.xlsx').slice(0, 200));
  setSetting('charter_map', JSON.stringify(detected));
  log.info('Charter template uploaded', { fields_found: Object.keys(detected).length });
  res.status(201).json(templateInfo());
}));

router.patch('/charter-template', h((req, res) => {
  if (!fs.existsSync(TEMPLATE_FILE)) throw notFound('Template');
  const t = charter.readTemplate(fs.readFileSync(TEMPLATE_FILE));
  const mapping = {};
  for (const [key, m] of Object.entries(req.body.mapping || {})) {
    if (!charter.FIELDS[key] || !m || !m.cell) continue;
    const cell = String(m.cell).trim().toUpperCase();
    if (!/^[A-Z]{1,3}[1-9]\d*$/.test(cell)) throw new HttpError(400, `"${m.cell}" isn't a cell reference (e.g. B4)`);
    if (!t.sheets.some((sh) => sh.name === m.sheet)) throw new HttpError(400, `No sheet called "${m.sheet}"`);
    mapping[key] = { sheet: m.sheet, cell, mode: m.mode === 'append' ? 'append' : 'replace' };
  }
  setSetting('charter_map', JSON.stringify(mapping));
  res.json(templateInfo());
}));

router.post('/charter-template/detect', h((req, res) => {
  if (!fs.existsSync(TEMPLATE_FILE)) throw notFound('Template');
  setSetting('charter_map', JSON.stringify(charter.detectMapping(charter.readTemplate(fs.readFileSync(TEMPLATE_FILE)))));
  res.json(templateInfo());
}));

router.delete('/charter-template', h((req, res) => {
  fs.rmSync(TEMPLATE_FILE, { force: true });
  db.run("DELETE FROM settings WHERE key IN ('charter_template_name', 'charter_map')");
  res.status(204).end();
}));

router.get('/projects/:id/charter.xlsx', h((req, res) => {
  const p = db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!p) throw notFound('Project');
  const values = charter.values(p, charterExtras(p.id), getSettings().currency);
  const mapping = parseJson(getSetting('charter_map')) || {};
  const buf = fs.existsSync(TEMPLATE_FILE)
    ? charter.fillTemplate(fs.readFileSync(TEMPLATE_FILE), mapping, values)
    : charter.plainWorkbook(values);
  const file = `Charter - ${(p.project_code ? `${p.project_code} ` : '') + p.name}`.replace(/[^\w -]+/g, '').trim().slice(0, 80);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}.xlsx"; filename*=UTF-8''${encodeURIComponent(`${file}.xlsx`)}`);
  res.send(buf);
}));

// ------------------------------------------------------------------ project costs

router.post('/projects/:id/costs', h((req, res) => {
  if (!db.get('SELECT 1 FROM projects WHERE id = ?', [req.params.id])) throw notFound('Project');
  const f = pick(req.body, ['description', 'amount', 'spent_on']);
  if (!f.description || !String(f.description).trim()) throw new HttpError(400, 'Description is required');
  if (f.amount === null || f.amount === undefined) throw new HttpError(400, 'Amount is required');
  res.status(201).json(insertRow('project_costs', { ...f, spent_on: f.spent_on || dateKey(new Date()), project_id: Number(req.params.id) }));
}));

router.patch('/costs/:id', h((req, res) => {
  const row = fresh('project_costs', updateRow('project_costs', req.params.id, pick(req.body, ['description', 'amount', 'spent_on'])));
  if (!row) throw notFound('Cost');
  res.json(row);
}));

router.delete('/costs/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM project_costs WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Cost');
  res.status(204).end();
}));

// ------------------------------------------------------------------ 📅 Reschedules

// A task's, project's, phase's, idea's or meeting's earlier dates: { kind, field, current, moves: [...] }.
router.get('/reschedules/:kind/:id', h((req, res) => {
  const k = reschedule.KINDS[req.params.kind];
  if (!k) throw notFound('Kind');
  const row = db.get(`SELECT ${k.field} AS v FROM ${k.table} WHERE id = ?`, [Number(req.params.id)]);
  if (!row) throw notFound('Record');
  res.json({ kind: req.params.kind, field: k.field, current: row.v, moves: reschedule.historyOf(req.params.kind, req.params.id) });
}));

// ------------------------------------------------------------------ 📥 My work

// What the signed-in person is named on: open tasks they own (one of the names in Owner), active
// projects they lead, sponsor or are on the team of, and what's newly theirs since they last looked
// (from the activity log: a task given to them, a project they were made leader, sponsor or a team
// member of — by someone else).
const named = (owners, person) => splitOwners(owners).some((n) => n.toLowerCase() === String(person).toLowerCase());
router.get('/me/work', h((req, res) => {
  const a = req.account;
  if (!a) return res.json({ account: null });
  const person = a.person;
  const tasks = db.all(`SELECT t.id, t.title, t.status, t.priority, t.due_at, t.owner, t.project_id, p.name AS project_name FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id WHERE t.owner IS NOT NULL AND t.status <> 'done' AND (p.id IS NULL OR p.status IN ('active', 'on_hold'))`)
    .filter((t) => named(t.owner, person))
    .sort((x, y) => (x.due_at || '9999').localeCompare(y.due_at || '9999') || y.priority - x.priority);
  const team = new Map(db.all('SELECT project_id, role FROM project_team WHERE name = ? COLLATE NOCASE', [person]).map((r) => [r.project_id, r.role]));
  const projects = db.all("SELECT id, name, status, priority, due_at, leader, sponsor FROM projects WHERE status IN ('active', 'on_hold') ORDER BY due_at IS NULL, due_at")
    .map((p) => ({ ...p, roles: [named(p.leader, person) && 'Leader', named(p.sponsor, person) && 'Sponsor', team.has(p.id) && (team.get(p.id) || 'Team member')].filter(Boolean) }))
    .filter((p) => p.roles.length);
  // newly theirs
  const since = a.inbox_seen_at || a.created_at;
  const parse = (x) => { try { return x ? JSON.parse(x) : {}; } catch { return {}; } };
  const fresh = new Map();
  for (const r of db.all("SELECT * FROM audit_log WHERE table_name IN ('tasks', 'projects', 'project_team') AND changed_at > ? ORDER BY id", [since])) {
    if (r.changed_by && r.changed_by.toLowerCase() === person.toLowerCase()) continue;
    const o = parse(r.old_data); const n = parse(r.new_data);
    if (r.action === 'DELETE') continue;
    if (r.table_name === 'tasks' && named(n.owner, person) && !named(o.owner, person)) fresh.set(`task:${n.id}`, { kind: 'task', id: n.id, title: n.title, by: r.changed_by, at: r.changed_at });
    if (r.table_name === 'projects') {
      for (const [f, role] of [['leader', 'leader'], ['sponsor', 'sponsor']]) if (named(n[f], person) && !named(o[f], person)) fresh.set(`project:${n.id}`, { kind: 'project', id: n.id, title: n.name, role, by: r.changed_by, at: r.changed_at });
    }
    if (r.table_name === 'project_team' && String(n.name || '').toLowerCase() === person.toLowerCase() && String(o.name || '').toLowerCase() !== person.toLowerCase()) {
      const p = db.get('SELECT name FROM projects WHERE id = ?', [n.project_id]);
      if (p) fresh.set(`project:${n.project_id}`, { kind: 'project', id: n.project_id, title: p.name, role: n.role || 'team member', by: r.changed_by, at: r.changed_at });
    }
  }
  // only what's still open
  const openTasks = new Set(tasks.map((t) => t.id)); const openProjects = new Set(projects.map((p) => p.id));
  const news = [...fresh.values()].filter((x) => (x.kind === 'task' ? openTasks.has(x.id) : openProjects.has(x.id))).sort((x, y) => y.at.localeCompare(x.at));
  res.json({ account: { person, username: a.username }, tasks, projects, new: news, seen_at: since });
}));
router.post('/me/work/seen', h((req, res) => {
  if (!req.account) throw new HttpError(401, 'Sign in first');
  db.run('UPDATE accounts SET inbox_seen_at = ? WHERE id = ?', [nowIso(), req.account.id]);
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ 🕘 a record's history

// Every change to one record, newest first: when, who, and each field's value before and after
// (from the audit log), so anything overwritten can be seen and put back.
const HISTORY_TABLES = { projects: 'projects', tasks: 'tasks', ideas: 'ideas', meetings: 'meetings', phases: 'project_phases', notes: 'notes', costs: 'project_costs' };
const HISTORY_SKIP = new Set(['id', 'created_at', 'updated_at', 'completed_at', 'dismissed_at', 'sort_order', 'project_code', 'ref']);
router.get('/history/:kind/:id', h((req, res) => {
  const table = HISTORY_TABLES[req.params.kind];
  if (!table) throw notFound('History');
  const rows = db.all('SELECT * FROM audit_log WHERE table_name = ? AND record_id = ? ORDER BY id DESC LIMIT 300', [table, Number(req.params.id)]);
  const parse = (x) => { try { return x ? JSON.parse(x) : {}; } catch { return {}; } };
  res.json(rows.map((r) => {
    const o = parse(r.old_data); const n = parse(r.new_data);
    const fields = [...new Set([...Object.keys(o), ...Object.keys(n)])].filter((f) => !HISTORY_SKIP.has(f) && JSON.stringify(o[f] ?? null) !== JSON.stringify(n[f] ?? null))
      .map((f) => ({ field: f, old: o[f] ?? null, new: n[f] ?? null }));
    return { id: r.id, at: r.changed_at, by: r.changed_by, action: r.action, fields };
  }).filter((r) => r.action !== 'UPDATE' || r.fields.length));
}));

// ------------------------------------------------------------------ open a file path

// Shows a file or folder from a note in Windows File Explorer. Files are only ever
// selected in their folder (/select), never opened or run.
router.post('/open-path', h((req, res) => {
  const p = String(req.body.path || '').trim();
  if (!p || p.includes('"') || !path.win32.isAbsolute(p)) throw new HttpError(400, 'Not a full file or folder path');
  if (process.platform !== 'win32') return res.json({ opened: false, reason: 'File Explorer is only available on Windows' });
  let stat;
  try { stat = fs.statSync(p); } catch { throw new HttpError(404, `Can't find ${p} (is the drive or network share available?)`); }
  if (stat.isDirectory()) execFile('explorer.exe', [p], () => {});
  else spawn('explorer.exe', [`/select,"${p}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
  res.json({ opened: true });
}));

// ------------------------------------------------------------------ Excel export

const XL = {
  projects: [
    { header: 'Project', width: 32 }, { header: 'Status', width: 11 }, { header: 'Priority', width: 9 },
    { header: 'Start', type: 'date', width: 11 }, { header: 'Due', type: 'date', width: 11 },
    { header: 'Baseline due', type: 'date', width: 12 }, { header: 'Tasks', type: 'number', width: 7 },
    { header: 'Done', type: 'number', width: 7 }, { header: 'Overdue', type: 'number', width: 8 },
    { header: 'Budget', type: 'money', width: 11 }, { header: 'Spent', type: 'money', width: 11 },
    { header: 'Created', type: 'datetime', width: 16 }, { header: 'Completed', type: 'datetime', width: 16 },
    { header: 'Description', type: 'wrap', width: 50 },
    { header: 'Project ID', width: 12 }, { header: 'Sponsor', width: 18 }, { header: 'Leader', width: 18 },
    { header: 'Policy deployment', width: 18 }, { header: 'Category', width: 16 }, { header: 'Gross margin effect', width: 18 },
    { header: 'Problem definition', type: 'wrap', width: 50 }, { header: 'Goals', type: 'wrap', width: 50 },
    { header: 'In scope', type: 'wrap', width: 40 }, { header: 'Out of scope', type: 'wrap', width: 40 },
    { header: 'Quantified benefits', type: 'wrap', width: 40 }, { header: 'Other benefits', type: 'wrap', width: 40 },
    { header: 'Charter complete', width: 10 },
  ],
  tasks: [
    { header: 'Project', width: 26 }, { header: 'Phase', width: 20 }, { header: 'Task', width: 40 }, { header: 'Subtask of', width: 26 },
    { header: 'Owner', width: 16 }, { header: 'Status', width: 11 }, { header: 'Priority', width: 9 }, { header: 'Start', type: 'date', width: 11 },
    { header: 'Due', type: 'date', width: 11 }, { header: 'Waiting on', width: 16 },
    { header: 'Waiting since', type: 'date', width: 12 }, { header: 'Repeats', width: 11 },
    { header: 'In baseline', width: 10 }, { header: 'Created', type: 'datetime', width: 16 },
    { header: 'Completed', type: 'datetime', width: 16 }, { header: 'Description', type: 'wrap', width: 50 },
  ],
  team: [
    { header: 'Project', width: 26 }, { header: 'Name', width: 22 }, { header: 'Role', width: 22 },
    { header: 'Department', width: 18 }, { header: 'Capacity', width: 16 }, { header: 'Contact', width: 28 },
    { header: 'Open tasks', type: 'number', width: 10 }, { header: 'Overdue', type: 'number', width: 8 },
  ],
  meetings: [
    { header: 'When', type: 'datetime', width: 16 }, { header: 'Project', width: 26 }, { header: 'Task', width: 26 },
    { header: 'Meeting', width: 30 }, { header: 'Location', width: 16 }, { header: 'Attendees', type: 'wrap', width: 30 },
    { header: 'Notes', type: 'wrap', width: 70 }, { header: 'Actions agreed', type: 'wrap', width: 60 },
  ],
  phases: [
    { header: 'Project', width: 26 }, { header: '#', type: 'number', width: 5 }, { header: 'Phase', width: 30 },
    { header: 'Status', width: 10 }, { header: 'Start', type: 'date', width: 11 }, { header: 'End', type: 'date', width: 11 },
    { header: 'Baseline end', type: 'date', width: 12 }, { header: 'Tasks', type: 'number', width: 7 },
    { header: 'Done', type: 'number', width: 7 }, { header: 'Overdue', type: 'number', width: 8 },
    { header: 'Completed', type: 'datetime', width: 16 }, { header: 'Description', type: 'wrap', width: 50 },
  ],
  ideas: [
    { header: 'Ref', width: 11 }, { header: 'Idea', width: 36 }, { header: 'Area', width: 14 },
    { header: 'Submitted by', width: 16 }, { header: 'Priority', width: 9 }, { header: 'Impact', type: 'number', width: 8 },
    { header: 'Effort', type: 'number', width: 8 }, { header: 'Value score', type: 'number', width: 11 },
    { header: 'Due', type: 'date', width: 11 }, { header: 'Cost', type: 'money', width: 11 },
    { header: 'Status', width: 14 }, { header: 'Project', width: 26 }, { header: 'Raised', type: 'datetime', width: 16 },
    { header: 'Updated', type: 'datetime', width: 16 }, { header: 'Description', type: 'wrap', width: 50 },
    { header: 'Proposed solution', type: 'wrap', width: 40 }, { header: 'Resolution', type: 'wrap', width: 40 }, { header: 'Benefit', type: 'wrap', width: 40 },
  ],
  notes: [
    { header: 'Date', type: 'datetime', width: 16 }, { header: 'Project / idea', width: 30 },
    { header: 'Task', width: 30 }, { header: 'Note', type: 'wrap', width: 80 },
  ],
  costs: [
    { header: 'Project', width: 30 }, { header: 'Date', type: 'date', width: 11 },
    { header: 'Description', width: 40 }, { header: 'Amount', type: 'money', width: 12 },
  ],
};
const label = (map, v) => map[v] || v || '';

function exportSheets(scope, id) {
  const sheets = [];
  const projWhere = scope === 'project' ? 'WHERE p.id = ?' : '';
  const projParams = scope === 'project' ? [id] : [];
  if (scope !== 'ideas') {
    const projects = db.all(`SELECT p.*,
        (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
        (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
        (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status <> 'done' AND t.due_at < ?) AS overdue_count,
        (SELECT coalesce(sum(amount), 0) FROM project_costs c WHERE c.project_id = p.id) AS spent
      FROM projects p ${projWhere} ORDER BY p.status = 'archived', p.name COLLATE NOCASE`, [nowIso(), ...projParams]);
    if (scope === 'project' && !projects.length) throw notFound('Project');
    sheets.push({ name: 'Projects', columns: XL.projects, rows: projects.map((p) => [
      p.name, label(STATUS_LABEL, p.status), PRIORITY_LABEL[p.priority], p.start_date, p.due_at, p.baseline_due_at,
      p.task_count, p.done_count, p.overdue_count, p.budget, p.spent, p.created_at, p.completed_at, p.description,
      p.project_code, p.sponsor, p.leader, p.policy_deployment, p.category, p.gm_effect, p.problem, p.goals,
      p.in_scope, p.out_scope, p.benefits_quantified, p.benefits_other,
      `${charter.completeness(p, charterExtras(p.id)).pct}%`]) });
    const tRows = db.all(`SELECT t.*, p.name AS project_name, par.title AS parent_title, ph.name AS phase_name FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN tasks par ON par.id = t.parent_id
      LEFT JOIN project_phases ph ON ph.id = t.phase_id
      ${projWhere} ORDER BY p.name IS NULL, p.name COLLATE NOCASE, t.sort_order, t.id`, projParams);
    sheets.push({ name: 'Tasks', columns: XL.tasks, rows: tRows.map((t) => [
      t.project_name || '(standalone task)', t.phase_name, t.title, t.parent_title, t.owner, label(STATUS_LABEL, t.status), PRIORITY_LABEL[t.priority], t.start_date,
      t.due_at, t.waiting_on, t.waiting_since, label(REPEAT_LABEL, t.recurrence), t.is_baseline ? 'Yes' : 'No',
      t.created_at, t.completed_at, t.description]) });
    const phases = projects.flatMap((p) => projectPhases(p.id).map((ph, i) => [p.name, i + 1, ph.name, label(STATUS_LABEL, ph.status),
      ph.start_date, ph.due_at, ph.baseline_due_at, ph.task_count, ph.done_count, ph.overdue_count, ph.completed_at, ph.description]));
    if (phases.length) sheets.push({ name: 'Phases', columns: XL.phases, rows: phases });
    const now = nowIso();
    const deptOf = departmentOf();
    const team = projects.flatMap((p) => {
      const open = db.all("SELECT owner, due_at FROM tasks WHERE project_id = ? AND status <> 'done' AND owner IS NOT NULL", [p.id]);
      return db.all('SELECT * FROM project_team WHERE project_id = ? ORDER BY sort_order, id', [p.id]).map((m) => {
        const mine = open.filter((t) => ownsTask(t.owner, m.name));
        return [p.name, m.name, m.role, deptOf(m.name), m.capacity, m.contact, mine.length, mine.filter((t) => t.due_at && t.due_at < now).length];
      });
    });
    if (team.length) sheets.push({ name: 'Team', columns: XL.team, rows: team });
    const meetings = scope === 'project' ? meetingList('m.project_id = ?', [id], 'm.held_at')
      : meetingList('1', [], 'm.held_at');
    if (meetings.length) {
      sheets.push({ name: 'Meetings', columns: XL.meetings, rows: meetings.map((m) => [
        m.held_at, m.project_name || '(standalone task)', m.task_title, m.title, m.location, m.attendees, htmlToText(m.notes),
        tasks('WHERE t.meeting_id = ? ORDER BY t.created_at, t.id', [m.id]).map((a) => `${a.status === 'done' ? '✓' : '☐'} ${a.title}`
          + `${a.owner ? ` [${a.owner}]` : ''}${a.due_at ? ` — due ${new Date(a.due_at).toLocaleDateString('en-GB')}` : ''}`).join('\n'),
      ]) });
    }
  }
  if (scope !== 'project') {
    const ideas = db.all(`${IDEA_SELECT} ORDER BY i.id`);
    sheets.push({ name: 'Ideas', columns: XL.ideas, rows: ideas.map((i) => [
      i.ref, i.title, i.area_name, i.submitted_by, PRIORITY_LABEL[i.priority], i.impact, i.effort,
      i.impact && i.effort ? i.impact * (6 - i.effort) : null, i.due_at, i.cost, label(STATUS_LABEL, i.status),
      i.project_name, i.created_at, i.updated_at, i.description, i.proposed_solution, i.resolution, i.benefit]) });
  }
  const notes = [];
  if (scope !== 'ideas') {
    notes.push(...db.all(`SELECT n.created_at, coalesce(p.name, '(standalone task)') AS owner, t.title AS task, n.body FROM notes n
      LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id ${projWhere}`, projParams));
  }
  if (scope !== 'project') {
    notes.push(...db.all(`SELECT n.created_at, i.ref || ' ' || i.title AS owner, NULL AS task, n.body
      FROM idea_notes n JOIN ideas i ON i.id = n.idea_id`));
  }
  notes.sort((a, b) => b.created_at.localeCompare(a.created_at));
  sheets.push({ name: 'Notes', columns: XL.notes, rows: notes.map((n) => [n.created_at, n.owner, n.task, n.body]) });
  if (scope !== 'ideas') {
    const costs = db.all(`SELECT c.*, p.name AS project_name FROM project_costs c JOIN projects p ON p.id = c.project_id
      ${projWhere} ORDER BY p.name COLLATE NOCASE, c.spent_on`, projParams);
    sheets.push({ name: 'Costs', columns: XL.costs, rows: costs.map((c) => [c.project_name, c.spent_on, c.description, c.amount]) });
  }
  return sheets;
}

router.get('/export.xlsx', h((req, res) => {
  const scope = ['project', 'ideas'].includes(req.query.scope) ? req.query.scope : 'all';
  const sheets = exportSheets(scope, req.query.id);
  let name = scope === 'ideas' ? 'Ideas' : 'All';
  if (scope === 'project') {
    const p = db.get('SELECT name FROM projects WHERE id = ?', [req.query.id]);
    name = p.name.replace(/[^\w -]+/g, '').trim().slice(0, 40) || 'Project';
  }
  const file = `CI Manager - ${name} - ${dateKey(new Date())}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.send(buildXlsx(sheets));
}));

// ------------------------------------------------------------------ status report

// Everything that happened between two dates (inclusive, local), per project.
router.get('/report', h((req, res) => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const today = dateKey(new Date());
  const to = day.test(req.query.to || '') ? req.query.to : today;
  const fromDefault = new Date(); fromDefault.setDate(fromDefault.getDate() - 6);
  const from = day.test(req.query.from || '') ? req.query.from : dateKey(fromDefault);
  if (from > to) throw new HttpError(400, 'The start of the period is after the end');
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const start = new Date(fy, fm - 1, fd).toISOString();
  const end = new Date(ty, tm - 1, td, 23, 59, 59, 999).toISOString();
  const now = nowIso();
  const soon = new Date(ty, tm - 1, td + 14, 23, 59, 59, 999).toISOString();

  const projectFilter = req.query.project_id ? 'AND p.id = ?' : '';
  const pp = req.query.project_id ? [req.query.project_id] : [];
  const projects = db.all(`SELECT p.*,
      (SELECT count(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
      (SELECT count(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_count,
      (SELECT coalesce(sum(amount), 0) FROM project_costs c WHERE c.project_id = p.id) AS spent
    FROM projects p
    WHERE (p.status IN ('active', 'on_hold')
       OR EXISTS (SELECT 1 FROM audit_log a WHERE a.project_id = p.id AND a.changed_at BETWEEN ? AND ?)) ${projectFilter}
    ORDER BY p.status = 'completed', p.priority DESC, p.due_at IS NULL, p.due_at`, [start, end, ...pp]);

  const out = projects.map((p) => {
    const open = "t.project_id = ? AND t.status <> 'done'";
    const events = db.all(`SELECT * FROM audit_log WHERE project_id = ? AND changed_at BETWEEN ? AND ?
      AND table_name IN ('tasks', 'projects', 'project_phases') AND action = 'UPDATE' ORDER BY changed_at, id`, [p.id, start, end]).map(normAudit);
    // Net due-date change per task/project over the period.
    const moves = new Map();
    for (const e of events) {
      if (e.old_data?.due_at === e.new_data?.due_at) continue;
      const key = `${e.table_name}:${e.record_id}`;
      const what = { projects: 'Project due date', project_phases: `Phase "${e.new_data.name}" end date` }[e.table_name] || e.new_data.title;
      const m = moves.get(key) || { what, from: e.old_data.due_at };
      m.to = e.new_data.due_at;
      m.at = e.changed_at;
      moves.set(key, m);
    }
    const started = new Map();
    for (const e of events) {
      if (e.table_name === 'tasks' && e.new_data?.status === 'in_progress' && e.old_data?.status !== 'in_progress') {
        started.set(e.record_id, { title: e.new_data.title, at: e.changed_at });
      }
    }
    return {
      id: p.id, name: p.name, status: p.status, priority: p.priority, due_at: p.due_at,
      baseline_due_at: p.baseline_due_at, baseline_set_at: p.baseline_set_at,
      task_count: p.task_count, done_count: p.done_count, budget: p.budget, spent: p.spent,
      phases: projectPhases(p.id).map((ph) => ({ id: ph.id, name: ph.name, status: ph.status, due_at: ph.due_at,
        baseline_due_at: ph.baseline_due_at, completed_at: ph.completed_at, task_count: ph.task_count, done_count: ph.done_count })),
      completed: tasks('WHERE t.project_id = ? AND t.completed_at BETWEEN ? AND ? ORDER BY t.completed_at', [p.id, start, end]),
      added: tasks('WHERE t.project_id = ? AND t.created_at BETWEEN ? AND ? ORDER BY t.created_at', [p.id, start, end]),
      started: [...started.values()],
      due_changes: [...moves.values()].filter((m) => m.from !== m.to),
      notes: db.all(`SELECT n.*, t.title AS task_title FROM notes n LEFT JOIN tasks t ON t.id = n.task_id
        WHERE n.project_id = ? AND n.created_at BETWEEN ? AND ? ORDER BY n.created_at`, [p.id, start, end]),
      meetings: meetingList('m.project_id = ? AND m.held_at BETWEEN ? AND ?', [p.id, start, end], 'm.held_at')
        .map((m) => ({ id: m.id, title: m.title, held_at: m.held_at, task_title: m.task_title, action_count: m.action_count, actions_done: m.actions_done })),
      spent_in_period: db.get(`SELECT coalesce(sum(amount), 0) AS n FROM project_costs
        WHERE project_id = ? AND spent_on BETWEEN ? AND ?`, [p.id, from, to]).n,
      blocked: tasks(`WHERE ${open} AND t.status = 'blocked' ORDER BY t.due_at IS NULL, t.due_at`, [p.id]),
      overdue: tasks(`WHERE ${open} AND t.due_at < ? ORDER BY t.due_at`, [p.id, now]),
      waiting: tasks(`WHERE ${open} AND t.waiting_on IS NOT NULL ORDER BY t.waiting_since`, [p.id]),
      upcoming: tasks(`WHERE ${open} AND t.due_at >= ? AND t.due_at <= ? ORDER BY t.due_at`, [p.id, now, soon]),
    };
  });

  // Standalone tasks, reported alongside the projects.
  let standalone = null;
  if (!req.query.project_id) {
    const sw = "t.project_id IS NULL AND t.status <> 'done'";
    standalone = {
      completed: tasks('WHERE t.project_id IS NULL AND t.completed_at BETWEEN ? AND ? ORDER BY t.completed_at', [start, end]),
      added: tasks('WHERE t.project_id IS NULL AND t.created_at BETWEEN ? AND ? ORDER BY t.created_at', [start, end]),
      notes: db.all(`SELECT n.*, t.title AS task_title FROM notes n JOIN tasks t ON t.id = n.task_id
        WHERE n.project_id IS NULL AND n.created_at BETWEEN ? AND ? ORDER BY n.created_at`, [start, end]),
      blocked: tasks(`WHERE ${sw} AND t.status = 'blocked' ORDER BY t.due_at IS NULL, t.due_at`),
      overdue: tasks(`WHERE ${sw} AND t.due_at < ? ORDER BY t.due_at`, [now]),
      waiting: tasks(`WHERE ${sw} AND t.waiting_on IS NOT NULL ORDER BY t.waiting_since`),
      upcoming: tasks(`WHERE ${sw} AND t.due_at >= ? AND t.due_at <= ? ORDER BY t.due_at`, [now, soon]),
    };
  }
  const ideaEvents = req.query.project_id ? [] : db.all(`SELECT * FROM audit_log WHERE table_name = 'ideas'
    AND action = 'UPDATE' AND changed_at BETWEEN ? AND ? ORDER BY changed_at, id`, [start, end]).map(normAudit)
    .filter((e) => e.old_data?.status !== e.new_data?.status)
    .map((e) => ({ ref: e.new_data.ref, title: e.new_data.title, from: e.old_data.status, to: e.new_data.status, at: e.changed_at }));
  res.json({
    from, to, generated_at: now, currency: getSettings().currency,
    projects: out,
    standalone,
    ideas: req.query.project_id ? null : {
      raised: db.all(`${IDEA_SELECT} WHERE i.created_at BETWEEN ? AND ? ORDER BY i.id`, [start, end]),
      status_changes: ideaEvents,
    },
  });
}));

// ------------------------------------------------------------------ audit log

router.get('/audit', h((req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const rows = req.query.project_id
    ? db.all('SELECT * FROM audit_log WHERE project_id = ? ORDER BY changed_at DESC, id DESC LIMIT ?', [req.query.project_id, limit])
    : db.all('SELECT * FROM audit_log ORDER BY changed_at DESC, id DESC LIMIT ?', [limit]);
  res.json(rows.map(normAudit).map((r) => ({ ...r, summary: describeAudit(r) || `${r.action} ${r.table_name} #${r.record_id}` })));
}));

// ------------------------------------------------------------------ backups

router.get('/info', h((req, res) => res.json({
  data_dir: config.dataDir, db_file: config.dbFile, backup_dir: config.backup.dir, log_dir: config.logDir,
})));
router.get('/backups', h((req, res) => res.json(backup.listBackups())));
router.post('/backups', h((req, res) => res.status(201).json(backup.runBackup('manual (UI)'))));

// Restore from an uploaded backup file (?check=1 only reads it and reports what's in it).
const loadBackup = (fn) => {
  try { return fn(); } catch (err) { if (err instanceof BadBackup) throw new HttpError(400, err.message); throw err; }
};
const restoreReply = (req, res, data, label) => {
  if (req.query.check === '1') return res.json({ created: data.created, counts: data.counts });
  res.json(restoreData(data, `restore from ${label}`));
};
router.post('/backups/restore', express.raw({ type: '*/*', limit: '500mb' }), h((req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'No file received');
  const name = path.basename(fileNameHeader(req, 'upload'));
  restoreReply(req, res, loadBackup(() => readBackup(req.body, name)), name);
}));
// Restore one of the backups listed on the Backups page.
router.post('/backups/:kind/:file/restore', h((req, res) => {
  const b = backup.listBackups().find((x) => x.kind === req.params.kind && x.file === req.params.file);
  if (!b) throw notFound('Backup');
  restoreReply(req, res, loadBackup(() => readBackup(b.path)), b.file);
}));

// ------------------------------------------------------------------ library (Obsidian vault)

const md = require('./markdown');
const LIB_DIR = path.join(config.dataDir, 'library');

let libFilesCache = null; // relative paths of the attachments in LIB_DIR
function libraryFiles() {
  if (libFilesCache) return libFilesCache;
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r); else out.push(r);
    }
  };
  walk(LIB_DIR, '');
  libFilesCache = out;
  return out;
}

const folderOf = (p) => (p && p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const joinRel = (from, t) => path.posix.normalize(path.posix.join(folderOf(from), t));

// Finds notes and attachments the way Obsidian does: by name anywhere in the vault
// (nearest folder first), by path from the vault root, or relative to the note.
function libraryResolver() {
  const docs = db.all('SELECT id, path, title, aliases FROM library_docs ORDER BY length(path), path');
  const byKey = new Map();
  const add = (k, d) => { const key = k.toLowerCase(); if (!byKey.has(key)) byKey.set(key, []); byKey.get(key).push(d); };
  for (const d of docs) {
    add(d.path.replace(/\.md$/i, ''), d);
    add(d.title, d);
    for (const a of String(d.aliases || '').split('\n').filter(Boolean)) add(a, d);
  }
  const resolveDoc = (target, from = '') => {
    const t = String(target || '').replace(/\\/g, '/').replace(/\.md$/i, '').replace(/^\.?\//, '').trim();
    if (!t) return null;
    const key = t.toLowerCase();
    let list = !t.startsWith('../') && byKey.get(key);
    if (!list && from) list = byKey.get(joinRel(from, t).toLowerCase());
    if (!list && key.includes('/')) list = docs.filter((d) => d.path.toLowerCase().replace(/\.md$/, '').endsWith(`/${key}`));
    if (!list || !list.length) return null;
    return list.find((d) => folderOf(d.path) === folderOf(from)) || list[0];
  };
  const files = libraryFiles();
  const byPath = new Map(files.map((f) => [f.toLowerCase(), f]));
  const byName = new Map();
  for (const f of files) { const n = f.split('/').pop().toLowerCase(); if (!byName.has(n)) byName.set(n, f); }
  const resolveFile = (target, from = '') => {
    const t = String(target || '').replace(/\\/g, '/').replace(/^\.?\//, '').trim();
    if (!t) return null;
    const rel = byPath.get(t.toLowerCase()) || byPath.get(joinRel(from, t).toLowerCase()) || byName.get(t.split('/').pop().toLowerCase());
    return rel ? { url: `/api/library/file?p=${encodeURIComponent(rel)}`, name: rel.split('/').pop(), path: rel } : null;
  };
  const bodies = new Map();
  const loadDoc = (id) => {
    if (!bodies.has(id)) bodies.set(id, db.get('SELECT body FROM library_docs WHERE id = ?', [id])?.body || '');
    return bodies.get(id);
  };
  return { docs, resolveDoc, resolveFile, loadDoc };
}

// Ids of the notes a piece of text links to ([[wikilinks]], ![[embeds]], [x](Note.md)).
const LINKS_IN_TEXT = /!?\[\[([^\]\n]+?)\]\]|\]\(\s*<?([^)>\n]+?\.md(?:#[^)>\n]*)?)>?\s*\)/g;
function linkedDocIds(text, r, from = '') {
  const ids = new Set();
  for (const m of String(text || '').matchAll(LINKS_IN_TEXT)) {
    let t = m[1] ? m[1].replace(/\\\|/g, '|').split('|')[0] : m[2];
    try { if (!m[1]) t = decodeURIComponent(t); } catch { /* keep */ }
    const d = r.resolveDoc(t.split('#')[0], from);
    if (d) ids.add(d.id);
  }
  return ids;
}

function librarySearch(term, limit = 50) {
  const q = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const low = term.toLowerCase();
  return db.all(`SELECT id, path, title, folder, tags, body FROM library_docs
      WHERE title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'
      ORDER BY (title LIKE ? ESCAPE '\\') DESC, title COLLATE NOCASE`, [q, q, q, q, q])
    .map((d) => {
      const text = md.toPlainText(d.body);
      const at = text.toLowerCase().indexOf(low);
      const inName = [d.title, d.path, d.tags].some((v) => String(v || '').toLowerCase().includes(low));
      if (at < 0 && !inName) return null;
      const snippet = at < 0 ? text.slice(0, 160) : `${at > 60 ? '…' : ''}${text.slice(Math.max(0, at - 60), at + 120)}${at + 120 < text.length ? '…' : ''}`;
      return { id: d.id, path: d.path, title: d.title, folder: d.folder, tags: d.tags, snippet };
    }).filter(Boolean).slice(0, limit);
}

// Notes and folders removed from the library stay out of later imports (until included again).
// Column widths set by dragging in a note's tables: { path: { tableNo: { cols, widths } } }.
// Kept by path, so they survive re-importing the vault; ignored if the table's columns change.
const libWidths = () => parseJson(getSetting('library_widths')) || {};
const setLibWidths = (all) => setSetting('library_widths', JSON.stringify(all));

const libExcluded = () => parseJson(getSetting('library_excluded')) || [];
const setLibExcluded = (list) => setSetting('library_excluded', JSON.stringify([...new Set(list)].sort()));
// Entries are a note path ("Folder/Note.md") or a folder ("Folder/").
const isLibExcluded = (p, list = libExcluded()) => list.some((x) => (x.endsWith('/') ? `${p}`.toLowerCase().startsWith(x.toLowerCase()) : p.toLowerCase() === x.toLowerCase()));

router.get('/library', h((req, res) => {
  res.json({
    docs: db.all('SELECT id, path, title, folder, tags, updated_at FROM library_docs ORDER BY path COLLATE NOCASE'),
    files: libraryFiles().length,
    imported_at: getSetting('library_imported_at'),
    source: getSetting('library_source'),
    excluded: libExcluded(),
  });
}));

// Remove one note (it stays in the vault; later imports leave it out).
router.delete('/library/docs/:id', h((req, res) => {
  const doc = db.get('SELECT id, path FROM library_docs WHERE id = ?', [req.params.id]);
  if (!doc) throw notFound('Note');
  db.tx(() => {
    db.run('DELETE FROM library_docs WHERE id = ?', [doc.id]);
    setLibExcluded([...libExcluded(), doc.path]);
    const widths = libWidths();
    if (widths[doc.path]) { delete widths[doc.path]; setLibWidths(widths); }
  });
  log.info('Library note removed', doc.path);
  res.status(204).end();
}));

// Remove a folder: its notes, sub-folders and the attachments stored in it.
router.delete('/library/folder', h((req, res) => {
  const folder = cleanLibraryPath(req.query.path);
  if (!folder) throw new HttpError(400, 'Which folder?');
  const removed = db.tx(() => {
    const n = db.run("DELETE FROM library_docs WHERE folder = ? COLLATE NOCASE OR folder LIKE ? ESCAPE '\\'",
      [folder, `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`]).changes;
    setLibExcluded([...libExcluded().filter((x) => !x.toLowerCase().startsWith(`${folder.toLowerCase()}/`)), `${folder}/`]);
    return n;
  });
  fs.rmSync(path.join(LIB_DIR, ...folder.split('/')), { recursive: true, force: true });
  libFilesCache = null;
  log.info('Library folder removed', { folder, notes: removed });
  res.json({ removed });
}));

// Let a removed note or folder come back with the next import.
router.post('/library/excluded/remove', h((req, res) => {
  setLibExcluded(libExcluded().filter((x) => x !== req.body.path));
  res.json({ excluded: libExcluded() });
}));

router.get('/library/search', h((req, res) => res.json(librarySearch(String(req.query.q || '').trim()))));

// [[Name#Heading]] from a task or project description -> the note it means.
router.get('/library/resolve', h((req, res) => {
  const [target, heading = ''] = String(req.query.t || '').split('#');
  const doc = libraryResolver().resolveDoc(target.split('|')[0]);
  if (!doc) throw notFound(`“${target}” in the library`);
  res.json({ id: doc.id, title: doc.title, slug: heading ? md.slugify(heading) : null });
}));

router.get('/library/docs/:id', h((req, res) => {
  const doc = db.get('SELECT * FROM library_docs WHERE id = ?', [req.params.id]);
  if (!doc) throw notFound('Note');
  const r = libraryResolver();
  const out = md.renderMarkdown(doc.body, { ...r, path: doc.path, seen: new Set([doc.id]) });
  const backlinks = db.all('SELECT id, path, title, folder, body FROM library_docs WHERE id <> ? ORDER BY title COLLATE NOCASE', [doc.id])
    .filter((d) => linkedDocIds(d.body, r, d.path).has(doc.id)).map(({ id, title, folder }) => ({ id, title, folder }));
  const linkedTasks = db.all(`SELECT t.id, t.title, t.status, t.project_id, t.description, p.name AS project_name FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id WHERE t.description LIKE '%[[%' ORDER BY t.status = 'done', t.id DESC`)
    .filter((t) => linkedDocIds(t.description, r).has(doc.id)).map(({ description, ...t }) => t);
  const linkedProjects = db.all("SELECT id, name, description FROM projects WHERE description LIKE '%[[%'")
    .filter((p) => linkedDocIds(p.description, r).has(doc.id)).map(({ id, name }) => ({ id, name }));
  res.json({ ...doc, html: out.html, headings: out.headings, props: out.props, backlinks, col_widths: libWidths()[doc.path] || {},
    linked_tasks: linkedTasks, linked_projects: linkedProjects });
}));

// Save (widths: [px, …]) or reset (widths: null) the column widths of one table in a note.
router.patch('/library/docs/:id/widths', h((req, res) => {
  const doc = db.get('SELECT path FROM library_docs WHERE id = ?', [req.params.id]);
  if (!doc) throw notFound('Note');
  const table = Number(req.body.table);
  if (!Number.isInteger(table) || table < 0 || table > 500) throw new HttpError(400, 'Which table?');
  const all = libWidths();
  const mine = all[doc.path] || {};
  if (req.body.widths == null) delete mine[table];
  else {
    const widths = Array.isArray(req.body.widths) ? req.body.widths.map((w) => Math.round(Number(w))) : [];
    if (!widths.length || widths.length > 100 || widths.some((w) => !Number.isFinite(w) || w < 20 || w > 4000)) throw new HttpError(400, 'Column widths must be 20–4000 px');
    mine[table] = { cols: widths.length, widths };
  }
  if (Object.keys(mine).length) all[doc.path] = mine; else delete all[doc.path];
  setLibWidths(all);
  res.json(mine);
}));

// Attachments (images, PDFs…) of the imported vault.
router.get('/library/file', h((req, res) => {
  const rel = cleanLibraryPath(req.query.p);
  const full = rel && path.join(LIB_DIR, ...rel.split('/'));
  if (!full || !full.startsWith(LIB_DIR + path.sep) || !fs.existsSync(full) || !md.ATTACHMENT_EXT.includes(md.extOf(rel))) throw notFound('File');
  if (md.extOf(rel) === 'svg') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.set('Cache-Control', 'no-cache');
  res.sendFile(full);
}));

// A vault-relative path, or null if it's unsafe or hidden (.obsidian, .trash, ../…).
function cleanLibraryPath(p) {
  const parts = String(p || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((x) => x === '..' || x.startsWith('.') || /[<>:"|?*\u0000-\u001f]/.test(x))) return null;
  return parts.join('/');
}

// Import: begin -> send files in batches -> finish (the library is only replaced at the
// end, so a cancelled or failed import leaves the current one as it was).
const libImports = new Map();
router.post('/library/import', h((req, res) => {
  for (const [id, imp] of libImports) { // forget abandoned imports
    if (Date.now() - imp.touched > 2 * 3600 * 1000) { fs.rmSync(imp.dir, { recursive: true, force: true }); libImports.delete(id); }
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(config.dataDir, `library-import-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  libImports.set(id, { dir, docs: new Map(), files: 0, skipped: 0, left_out: 0, excluded: libExcluded(), touched: Date.now(),
    source: String(req.body.source || '').slice(0, 200) || null });
  res.status(201).json({ id });
}));

router.post('/library/import/:id/files', h((req, res) => {
  const imp = libImports.get(req.params.id);
  if (!imp) throw notFound('Import');
  imp.touched = Date.now();
  for (const f of Array.isArray(req.body.files) ? req.body.files : []) {
    const rel = cleanLibraryPath(f.path);
    const ext = rel && md.extOf(rel);
    if (rel && imp.excluded.length && isLibExcluded(rel, imp.excluded)) { imp.left_out++; continue; }
    if (rel && ext === 'md' && typeof f.text === 'string') { imp.docs.set(rel, f.text.replace(/\r\n?/g, '\n')); continue; }
    if (!rel || !md.ATTACHMENT_EXT.includes(ext) || typeof f.base64 !== 'string') { imp.skipped++; continue; }
    const full = path.join(imp.dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(f.base64, 'base64'));
    imp.files++;
  }
  res.json({ notes: imp.docs.size, files: imp.files, skipped: imp.skipped });
}));

router.post('/library/import/:id/finish', h((req, res) => {
  const imp = libImports.get(req.params.id);
  if (!imp) throw notFound('Import');
  if (!imp.docs.size && !imp.left_out) throw new HttpError(400, 'No notes (.md files) were found in that folder');
  const now = nowIso();
  const result = db.tx(() => {
    const existing = new Map(db.all('SELECT id, path, body FROM library_docs').map((d) => [d.path, d]));
    const counts = { notes: imp.docs.size, added: 0, updated: 0, unchanged: 0, removed: 0, files: imp.files, skipped: imp.skipped, left_out: imp.left_out };
    for (const [p, body] of imp.docs) {
      const meta = md.docMeta(body);
      const row = { title: p.split('/').pop().replace(/\.md$/i, ''), folder: folderOf(p), tags: meta.tags.join(', ') || null,
        aliases: meta.aliases.join('\n') || null };
      const ex = existing.get(p);
      if (!ex) {
        db.run(`INSERT INTO library_docs (path, title, folder, body, tags, aliases, imported_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [p, row.title, row.folder, body, row.tags, row.aliases, now, now, now]);
        counts.added++;
      } else {
        const changed = ex.body !== body;
        db.run(`UPDATE library_docs SET title = ?, folder = ?, body = ?, tags = ?, aliases = ?, imported_at = ?
          ${changed ? ', updated_at = ?' : ''} WHERE id = ?`,
        [row.title, row.folder, body, row.tags, row.aliases, now, ...(changed ? [now] : []), ex.id]);
        counts[changed ? 'updated' : 'unchanged']++;
        existing.delete(p);
      }
    }
    for (const ex of existing.values()) db.run('DELETE FROM library_docs WHERE id = ?', [ex.id]);
    counts.removed = existing.size;
    setSetting('library_imported_at', now);
    if (imp.source) setSetting('library_source', imp.source);
    return counts;
  });
  // Swap in the new attachments folder.
  const old = `${LIB_DIR}.old-${req.params.id}`;
  if (fs.existsSync(LIB_DIR)) fs.renameSync(LIB_DIR, old);
  fs.renameSync(imp.dir, LIB_DIR);
  fs.rmSync(old, { recursive: true, force: true });
  libFilesCache = null;
  libImports.delete(req.params.id);
  log.info('Library imported from the Obsidian vault', { source: imp.source, ...result });
  res.json(result);
}));

router.delete('/library', h((req, res) => {
  db.run('DELETE FROM library_docs');
  fs.rmSync(LIB_DIR, { recursive: true, force: true });
  libFilesCache = null;
  db.run("DELETE FROM settings WHERE key IN ('library_imported_at', 'library_source', 'library_excluded', 'library_widths')");
  log.info('Library removed');
  res.status(204).end();
}));

// ------------------------------------------------------------------ search

router.get('/search', h((req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json({ projects: [], tasks: [], notes: [], ideas: [], meetings: [], library: [], production: [], contacts: [], reporting: [] });
  const q = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const like = (col) => `${col} LIKE ? ESCAPE '\\'`;
  res.json({
    projects: !accounts.canUse(req, 'projects') ? [] : db.all(`SELECT id, name, status FROM projects WHERE ${like('name')} OR ${like('description')} LIMIT 20`, [q, q]),
    tasks: tasks(`WHERE ${like('t.title')} OR ${like('t.description')} LIMIT 30`, [q, q]),
    notes: db.all(`SELECT n.*, p.name AS project_name, t.title AS task_title FROM notes n
      LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id
      WHERE ${like('n.body')} ORDER BY n.created_at DESC LIMIT 30`, [q]),
    ideas: !accounts.canUse(req, 'ideas') ? [] : db.all(`${IDEA_SELECT} WHERE ${like('i.title')} OR ${like('i.description')} OR ${like('i.ref')}
      OR i.id IN (SELECT idea_id FROM idea_notes WHERE ${like('body')}) ORDER BY i.id DESC LIMIT 30`, [q, q, q, q]),
    library: librarySearch(term, 20),
    // 🏭 Production: work orders and cards (the open exports, the plan history, the runs, the card database)
    production: !accounts.canUse(req, 'planning') || term.length < 2 ? [] : (() => { try { return planFind.suggest(term.slice(0, 60), findCtx()); } catch { return []; } })(),
    // 📇 Contacts: the people and departments in the lists
    contacts: !accounts.canUse(req, 'contacts') ? [] : db.all(`SELECT i.name, i.detail, i.department, l.name AS list FROM name_list_items i JOIN name_lists l ON l.id = i.list_id
      WHERE ${like('i.name')} OR ${like('i.department')} OR ${like('i.detail')} ORDER BY i.name LIMIT 20`, [q, q, q]),
    // 📊 Reporting: what was typed on the Weekly Ops Report (its boxes and the week's notes)
    reporting: !accounts.canUse(req, 'kpi') ? [] : [
      ...db.all(`SELECT week, ref, text, (SELECT max(s.id) FROM kpi_snapshots s WHERE s.week = e.week) AS snap FROM kpi_edits e WHERE ${like('text')} ORDER BY week DESC LIMIT 20`, [q]),
      ...db.all(`SELECT week, NULL AS ref, text, (SELECT max(s.id) FROM kpi_snapshots s WHERE s.week = n.week) AS snap FROM kpi_notes n WHERE ${like('text')} ORDER BY week DESC LIMIT 10`, [q])],
    // Notes are HTML, so match on their text (a search for "b" shouldn't hit every <b>).
    meetings: meetingList(`${like('m.title')} OR ${like('m.attendees')} OR ${like('m.location')} OR m.notes IS NOT NULL`, [q, q, q], 'm.held_at DESC')
      .filter((m) => [m.title, m.attendees, m.location, htmlToText(m.notes)].some((v) => String(v || '').toLowerCase().includes(term.toLowerCase())))
      .slice(0, 30).map((m) => ({ ...m, notes_text: htmlToText(m.notes) })),
  });
}));

// ------------------------------------------------------------------ helpers

const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
  active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived',
  open: 'Open', new: 'New', reviewing: 'Under review', approved: 'Approved', rejected: 'Rejected',
  implemented: 'Implemented', escalated: 'Escalated to project' };
const PRIORITY_LABEL = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const FIELD_LABEL = { title: 'title', name: 'name', description: 'description', status: 'status',
  priority: 'priority', due_at: 'due date', start_date: 'start date', parent_id: 'parent task',
  remind_at: 'reminder time', message: 'message', body: 'text',
  submitted_by: 'submitted by', area_id: 'area', cost: 'cost', value: 'value', active: 'active',
  waiting_on: 'waiting on', proposed_solution: 'proposed solution', resolution: 'resolution', benefit: 'benefit', created_at: 'submission date', recurrence: 'repeats', budget: 'budget', impact: 'impact', effort: 'effort',
  amount: 'amount', spent_on: 'date', project_code: 'project ID', sponsor: 'sponsor', leader: 'project leader',
  policy_deployment: 'policy deployment', category: 'category', gm_effect: 'gross margin effect',
  problem: 'problem definition', goals: 'goals', in_scope: 'in scope', out_scope: 'out of scope',
  benefits_quantified: 'quantified benefits', benefits_other: 'other benefits', role: 'role', capacity: 'capacity',
  contact: 'contact', held_at: 'date/time', location: 'location', attendees: 'attendees', notes: 'notes',
  unit: 'unit', baseline: 'baseline', target: 'target', current: 'current value', owner: 'owner', phase_id: 'phase' };
const LONG_TEXT = ['notes', 'description', 'body', 'problem', 'goals', 'in_scope', 'out_scope', 'benefits_quantified', 'benefits_other'];
const REPEAT_LABEL = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', fortnightly: 'Every 2 weeks',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

function fmtValue(field, v) {
  if (v === null || v === undefined || v === '') return '(none)';
  if (field === 'status') return STATUS_LABEL[v] || v;
  if (field === 'priority') return PRIORITY_LABEL[v] || v;
  if (field === 'area_id') return db.get('SELECT name FROM areas WHERE id = ?', [v])?.name || `#${v}`;
  if (field === 'active') return v ? 'yes' : 'no';
  if (field === 'recurrence') return REPEAT_LABEL[v] || v;
  if (field === 'phase_id') return db.get('SELECT name FROM project_phases WHERE id = ?', [v])?.name || `phase #${v}`;
  if (field in MONEY_FIELDS) return `${getSettings().currency}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (field === 'created_at') return new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (field === 'due_at') return new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (field === 'start_date' || field === 'spent_on') return new Date(`${v}T12:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (field === 'held_at') return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  if (field === 'remind_at') return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// Turns an audit_log row into a human sentence (or null for noise).
function describeAudit(e) {
  const d = e.new_data || e.old_data || {};
  const label = { projects: 'Project', tasks: d.parent_id ? 'Subtask' : 'Task', notes: 'Note', reminders: 'Reminder',
    ideas: `Idea${d.ref ? ` ${d.ref}` : ''}`, idea_notes: 'Idea note', areas: 'Area', settings: 'Setting',
    project_costs: 'Cost', task_links: 'Dependency', project_team: 'Team member', project_kpis: 'KPI',
    lookups: 'List item', project_phases: 'Phase', meetings: 'Meeting', attachments: 'Attachment' }[e.table_name] || e.table_name;
  if (e.table_name === 'project_phases' && e.action === 'UPDATE' && e.old_data?.status !== e.new_data?.status) {
    return `Phase "${d.name}" ${e.new_data.status === 'done' ? 'completed ✓' : 'reopened'}`;
  }
  if (e.table_name === 'kpi_overrides') {
    const n = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 4 }));
    if (e.action === 'DELETE') return `KPI ${d.week} ${d.col}: adjustment removed (was ${n(d.value)}) — the worked-out figure is back`;
    return `KPI ${d.week} ${d.col} adjusted by hand: ${e.action === 'UPDATE' ? `${n(e.old_data?.value)} → ` : ''}${n(d.value)} — ${d.reason}`;
  }
  if (e.table_name === 'task_links') {
    const title = (id) => db.get('SELECT title FROM tasks WHERE id = ?', [id])?.title || `task #${id}`;
    const verb = e.action === 'DELETE' ? 'removed' : 'added';
    return `Dependency ${verb}: "${title(d.task_id)}" waits for "${title(d.depends_on_id)}"`;
  }
  if (e.table_name === 'project_costs' && e.action !== 'UPDATE') {
    return `Cost ${e.action === 'INSERT' ? 'added' : 'deleted'}: ${fmtValue('amount', d.amount)} ${d.description ? `"${d.description}"` : ''}`.trim();
  }
  const name = d.title || d.name || d.key || d.description || (d.body && fmtValue('body', d.body)) || '';
  const named = name ? ` "${name}"` : '';
  if (e.action === 'INSERT') {
    if (e.table_name === 'reminders') return `Reminder set for ${fmtValue('remind_at', d.remind_at)}`;
    return `${label} created${named}`;
  }
  if (e.action === 'DELETE') return `${label} deleted${named}`;
  if (e.table_name === 'reminders') {
    if (e.old_data?.snooze_count !== e.new_data?.snooze_count) return `Reminder snoozed until ${fmtValue('remind_at', e.new_data.remind_at)}`;
    if (e.new_data?.status === 'dismissed' && e.old_data?.status !== 'dismissed') return 'Reminder dismissed';
  }
  const changes = [];
  for (const [field, text] of Object.entries(FIELD_LABEL)) {
    const a = e.old_data?.[field];
    const b = e.new_data?.[field];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      if (field === 'project_code' && !a) continue; // assigned automatically on creation
      if (LONG_TEXT.includes(field)) changes.push(`${text} edited`);
      else changes.push(`${text}: ${fmtValue(field, a)} → ${fmtValue(field, b)}`);
    }
  }
  if (e.table_name === 'projects' && e.old_data?.baseline_set_at !== e.new_data?.baseline_set_at) {
    changes.push('baseline set');
  }
  if (e.table_name === 'ideas' && e.new_data?.status === 'escalated' && e.old_data?.status !== 'escalated') {
    const p = db.get('SELECT name FROM projects WHERE id = ?', [e.new_data.project_id]);
    return `${label}${named} escalated to project${p ? ` "${p.name}"` : ''}`;
  }
  if (e.table_name === 'tasks' && !e.old_data?.is_baseline && e.new_data?.is_baseline) {
    changes.push('added to baseline');
  }
  if (!changes.length) return null;
  return `${label}${named}: ${changes.join('; ')}`;
}

// ------------------------------------------------------------------ errors

router.use((err, req, res, _next) => {
  const status = err.status || (/constraint failed|datatype mismatch/i.test(err.message) ? 400 : 500);
  if (status >= 500) log.error(`${req.method} ${req.originalUrl} failed`, err.stack || err.message);
  res.status(status).json({ error: err.message });
});

module.exports = router;
// On start-up: a planning setup handed out on the network (see applySharedSetup).
module.exports.applySharedSetup = applySharedSetupSafe;
module.exports.applySharedTeam = applySharedTeamSafe;
// On start-up: read the shared defaults file, if there is one and it can be reached.
module.exports.applySharedDefaults = () => {
  const file = config.defaultsFile;
  if (!file) return null;
  if (!fs.existsSync(file)) return { file, error: 'not found (not on the network?)' };
  try { return { file, ...applyShared(readSharedFile(file), file) }; } catch (err) { return { file, error: err.message }; }
};
