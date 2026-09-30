const express = require('express');
const db = require('./db');
const backup = require('./backup');
const log = require('./logger');
const config = require('./config');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { parseQuick, nextOccurrence, shiftKey, dateKey } = require('./dates');
const { buildXlsx } = require('./xlsx');
const { RECURRENCES } = require('./schema');

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

// Picks only allowed keys from a body, turning '' into null and normalising values.
function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body[k] === undefined) continue;
    let v = body[k] === '' ? null : body[k];
    if (k === 'due_at') v = toDueIso(v);
    if (k === 'remind_at') v = toIso(v, k);
    if (k in DATE_FIELDS && v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `Invalid ${DATE_FIELDS[k]}`);
    if (k in MONEY_FIELDS) v = parseMoney(v, MONEY_FIELDS[k]);
    if ((k === 'impact' || k === 'effort') && v !== null) {
      v = Number(v);
      if (!Number.isInteger(v) || v < 1 || v > 5) throw new HttpError(400, `${k} must be 1 to 5`);
    }
    if (k === 'recurrence' && v !== null && !RECURRENCES.includes(v)) throw new HttpError(400, 'Invalid repeat setting');
    if (k === 'waiting_on') v = v === null ? null : (String(v).trim() || null);
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
const normProject = (p) => p && { ...p, baseline_snapshot: parseJson(p.baseline_snapshot) };
const normTask = (t) => t && { ...t, is_baseline: !!t.is_baseline };
const normAudit = (e) => ({ ...e, old_data: parseJson(e.old_data), new_data: parseJson(e.new_data) });

const PROJECT_FIELDS = ['name', 'description', 'status', 'priority', 'start_date', 'due_at', 'budget'];
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'due_at', 'sort_order', 'parent_id',
  'start_date', 'waiting_on', 'recurrence'];

const TASK_SELECT = `
  SELECT t.*, p.name AS project_name,
         (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
         (SELECT count(*) FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtask_done,
         (SELECT count(*) FROM notes n WHERE n.task_id = t.id) AS note_count,
         (SELECT min(r.remind_at) FROM reminders r WHERE r.task_id = t.id AND r.status = 'pending') AS next_reminder
  FROM tasks t JOIN projects p ON p.id = t.project_id`;
const tasks = (where, params = []) => db.all(`${TASK_SELECT} ${where}`, params).map(normTask);

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
           (SELECT coalesce(sum(amount), 0) FROM project_costs c WHERE c.project_id = p.id) AS spent
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    ${includeArchived ? '' : "WHERE p.status <> 'archived'"}
    GROUP BY p.id
    ORDER BY (p.status = 'active') DESC, p.priority DESC, p.due_at IS NULL, p.due_at, p.name COLLATE NOCASE`,
  [nowIso()]);
  res.json(rows.map(normProject));
}));

// Creates a project with optional baseline tasks and first note. Call inside a transaction.
function createProject(body) {
  const fields = pick(body, PROJECT_FIELDS);
  if (!fields.name || !String(fields.name).trim()) throw new HttpError(400, 'Project name is required');
  const baselineTasks = (body.baseline_tasks || []).map((s) => String(s).trim()).filter(Boolean);
  const note = String(body.initial_note || '').trim();
  const baseline = body.set_baseline !== false;

  const p = insertRow('projects', fields);
  baselineTasks.forEach((title, i) => insertRow('tasks', { project_id: p.id, title, sort_order: i, is_baseline: baseline }));
  if (note) insertRow('notes', { project_id: p.id, body: note });
  return baseline ? setBaseline(p.id) : p;
}

router.post('/projects', h((req, res) => {
  res.status(201).json(normProject(db.tx(() => createProject(req.body))));
}));

router.get('/projects/:id', h((req, res) => {
  const project = db.get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
  if (!project) throw notFound('Project');
  res.json({
    ...normProject(project),
    tasks: tasks('WHERE t.project_id = ? ORDER BY t.sort_order, t.id', [project.id]),
    links: db.all('SELECT id, task_id, depends_on_id FROM task_links WHERE project_id = ?', [project.id]),
    costs: db.all('SELECT * FROM project_costs WHERE project_id = ? ORDER BY spent_on DESC, id DESC', [project.id]),
    spent: db.get('SELECT coalesce(sum(amount), 0) AS n FROM project_costs WHERE project_id = ?', [project.id]).n,
    escalated_from: db.get('SELECT id, ref, title FROM ideas WHERE project_id = ?', [project.id]) || null,
  });
}));

router.patch('/projects/:id', h((req, res) => {
  const row = fresh('projects', updateRow('projects', req.params.id, pick(req.body, PROJECT_FIELDS)));
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
  const snapshotTasks = db.all(
    'SELECT id, parent_id, title, status, priority, start_date, due_at FROM tasks WHERE project_id = ? ORDER BY sort_order, id',
    [projectId]);
  const snapshot = {
    name: p.name, description: p.description, priority: p.priority,
    start_date: p.start_date, due_at: p.due_at, tasks: snapshotTasks,
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
    SELECT * FROM audit_log WHERE project_id = ? AND table_name <> 'notes'
    ORDER BY changed_at DESC, id DESC LIMIT ?`, [req.params.id, limit]).map(normAudit);
  const items = [
    ...notes.map((n) => ({ type: 'note', at: n.created_at, ...n })),
    ...events.map((e) => ({ type: 'event', at: e.changed_at, id: e.id, text: describeAudit(e) }))
      .filter((e) => e.text),
  ].sort((a, b) => b.at.localeCompare(a.at));
  res.json(items.slice(0, limit));
}));

// ------------------------------------------------------------------ tasks

router.get('/tasks', h((req, res) => {
  const where = ["p.status <> 'archived'"];
  const params = [];
  if (req.query.project_id) { params.push(req.query.project_id); where.push('t.project_id = ?'); }
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
    project_id: t.project_id, parent_id: t.parent_id, title: t.title, description: t.description,
    priority: t.priority, due_at: toDueIso(due), start_date: t.start_date ? shiftKey(t.start_date, shiftDays) : null,
    recurrence: t.recurrence, is_baseline: t.is_baseline, sort_order: t.sort_order,
  });
  for (const sub of db.all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order, id', [t.id])) {
    insertRow('tasks', {
      project_id: t.project_id, parent_id: next.id, title: sub.title, description: sub.description,
      priority: sub.priority, is_baseline: t.is_baseline, sort_order: sub.sort_order,
    });
  }
  db.run('UPDATE tasks SET next_task_id = ? WHERE id = ?', [next.id, t.id]);
  return normTask(fresh('tasks', next));
}

const nextSortOrder = (projectId) =>
  db.get('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM tasks WHERE project_id = ?', [projectId]).n;

router.get('/tasks/waiting-names', h((req, res) => {
  res.json(db.all(`SELECT waiting_on AS name, max(coalesce(waiting_since, updated_at)) AS last FROM tasks
    WHERE waiting_on IS NOT NULL GROUP BY waiting_on COLLATE NOCASE ORDER BY last DESC LIMIT 50`).map((r) => r.name));
}));

router.post('/tasks', h((req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  applyTaskRules(null, fields);
  if (!fields.title || !String(fields.title).trim()) throw new HttpError(400, 'Task title is required');
  let projectId = req.body.project_id;
  if (fields.parent_id) {
    const parent = db.get('SELECT project_id FROM tasks WHERE id = ?', [fields.parent_id]);
    if (!parent) throw notFound('Parent task');
    projectId = parent.project_id;
  }
  if (!projectId) throw new HttpError(400, 'project_id is required');
  if (!db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
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
    const row = updateRow('tasks', req.params.id, fields);
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

// Dependencies (for the Gantt chart): task :id can't start until depends_on_id is done.
router.post('/tasks/:id/dependencies', h((req, res) => {
  const link = db.tx(() => {
    const t = db.get('SELECT id, project_id FROM tasks WHERE id = ?', [req.params.id]);
    const dep = db.get('SELECT id, project_id FROM tasks WHERE id = ?', [req.body.depends_on_id]);
    if (!t || !dep) throw notFound('Task');
    if (t.id === dep.id) throw new HttpError(400, 'A task can\'t depend on itself');
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

router.delete('/task-links/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM task_links WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Dependency');
  res.status(204).end();
}));

router.delete('/tasks/:id', h((req, res) => {
  const { changes } = db.run('DELETE FROM tasks WHERE id = ?', [req.params.id]);
  if (!changes) throw notFound('Task');
  res.status(204).end();
}));

// ------------------------------------------------------------------ notes

router.post('/notes', h((req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) throw new HttpError(400, 'Note text is required');
  let projectId = req.body.project_id;
  const taskId = req.body.task_id || null;
  if (taskId) {
    const t = db.get('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
    if (!t) throw notFound('Task');
    projectId = t.project_id;
  }
  if (!projectId) throw new HttpError(400, 'project_id is required');
  if (!db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
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
    due_tasks: tasks(`WHERE t.status <> 'done' AND p.status IN ('active', 'on_hold')
      AND t.due_at IS NOT NULL AND t.due_at <= ? ORDER BY t.due_at`, [nowIso(24 * 3600 * 1000)]),
  });
}));

// ------------------------------------------------------------------ dashboard

router.get('/dashboard', h((req, res) => {
  // Day boundaries in the PC's local time zone.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dayStart = (n) => new Date(today.getTime() + n * 86400000).toISOString();
  const now = nowIso();
  const base = "WHERE t.status <> 'done' AND p.status IN ('active', 'on_hold')";
  res.json({
    overdue: tasks(`${base} AND t.due_at < ? ORDER BY t.due_at`, [now]),
    today: tasks(`${base} AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at`, [now, dayStart(1)]),
    week: tasks(`${base} AND t.due_at >= ? AND t.due_at < ? ORDER BY t.due_at`, [dayStart(1), dayStart(8)]),
    high_priority: tasks(`${base} AND t.priority >= 3 ORDER BY t.priority DESC, t.due_at IS NULL, t.due_at`),
    blocked: tasks(`${base} AND t.status = 'blocked' ORDER BY t.priority DESC, t.due_at IS NULL, t.due_at`),
    waiting: tasks(`${base} AND t.waiting_on IS NOT NULL ORDER BY t.waiting_on COLLATE NOCASE, t.waiting_since`),
    ideas: db.get(`SELECT count(*) AS open, coalesce(sum(cost), 0) AS cost FROM ideas
      WHERE status IN ('new', 'reviewing', 'approved')`),
    recent_notes: db.all(`SELECT n.*, p.name AS project_name, t.title AS task_title FROM notes n
      JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id
      ORDER BY n.created_at DESC LIMIT 15`),
    reminders: db.all(`${REMINDER_SELECT} WHERE r.status = 'pending' ORDER BY r.remind_at LIMIT 20`),
  });
}));

// ------------------------------------------------------------------ ideation

const IDEA_FIELDS = ['title', 'description', 'submitted_by', 'area_id', 'priority', 'due_at', 'cost', 'status', 'impact', 'effort'];
const IDEA_SELECT = `
  SELECT i.*, a.name AS area_name, p.name AS project_name,
         (SELECT count(*) FROM idea_notes n WHERE n.idea_id = i.id) AS note_count,
         (SELECT max(created_at) FROM idea_notes n WHERE n.idea_id = i.id) AS last_note_at
  FROM ideas i LEFT JOIN areas a ON a.id = i.area_id LEFT JOIN projects p ON p.id = i.project_id`;
const OPEN_IDEA = "i.status IN ('new', 'reviewing', 'approved')";

function ideaFields(body) {
  const f = pick(body, IDEA_FIELDS);
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
    where.push("(i.title LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\' OR i.ref LIKE ? ESCAPE '\\' OR i.submitted_by LIKE ? ESCAPE '\\')");
    params.push(q, q, q, q);
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
  const current = db.get('SELECT status FROM ideas WHERE id = ?', [req.params.id]);
  if (!current) throw notFound('Idea');
  const fields = ideaFields(req.body);
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
      idea.area_name && `Area: ${idea.area_name}`,
      idea.cost !== null && `Estimated cost: ${currency}${idea.cost.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      `Raised: ${new Date(idea.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`,
    ].filter(Boolean).join('\n');
    const p = createProject({
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

// ------------------------------------------------------------------ settings & areas

const SETTING_DEFAULTS = { currency: '£', report_last_sent: '' };
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
  ],
  tasks: [
    { header: 'Project', width: 26 }, { header: 'Task', width: 40 }, { header: 'Subtask of', width: 26 },
    { header: 'Status', width: 11 }, { header: 'Priority', width: 9 }, { header: 'Start', type: 'date', width: 11 },
    { header: 'Due', type: 'date', width: 11 }, { header: 'Waiting on', width: 16 },
    { header: 'Waiting since', type: 'date', width: 12 }, { header: 'Repeats', width: 11 },
    { header: 'In baseline', width: 10 }, { header: 'Created', type: 'datetime', width: 16 },
    { header: 'Completed', type: 'datetime', width: 16 }, { header: 'Description', type: 'wrap', width: 50 },
  ],
  ideas: [
    { header: 'Ref', width: 11 }, { header: 'Idea', width: 36 }, { header: 'Area', width: 14 },
    { header: 'Submitted by', width: 16 }, { header: 'Priority', width: 9 }, { header: 'Impact', type: 'number', width: 8 },
    { header: 'Effort', type: 'number', width: 8 }, { header: 'Value score', type: 'number', width: 11 },
    { header: 'Due', type: 'date', width: 11 }, { header: 'Cost', type: 'money', width: 11 },
    { header: 'Status', width: 14 }, { header: 'Project', width: 26 }, { header: 'Raised', type: 'datetime', width: 16 },
    { header: 'Updated', type: 'datetime', width: 16 }, { header: 'Description', type: 'wrap', width: 50 },
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
      p.task_count, p.done_count, p.overdue_count, p.budget, p.spent, p.created_at, p.completed_at, p.description]) });
    const tRows = db.all(`SELECT t.*, p.name AS project_name, par.title AS parent_title FROM tasks t
      JOIN projects p ON p.id = t.project_id LEFT JOIN tasks par ON par.id = t.parent_id
      ${projWhere} ORDER BY p.name COLLATE NOCASE, t.sort_order, t.id`, projParams);
    sheets.push({ name: 'Tasks', columns: XL.tasks, rows: tRows.map((t) => [
      t.project_name, t.title, t.parent_title, label(STATUS_LABEL, t.status), PRIORITY_LABEL[t.priority], t.start_date,
      t.due_at, t.waiting_on, t.waiting_since, label(REPEAT_LABEL, t.recurrence), t.is_baseline ? 'Yes' : 'No',
      t.created_at, t.completed_at, t.description]) });
  }
  if (scope !== 'project') {
    const ideas = db.all(`${IDEA_SELECT} ORDER BY i.id`);
    sheets.push({ name: 'Ideas', columns: XL.ideas, rows: ideas.map((i) => [
      i.ref, i.title, i.area_name, i.submitted_by, PRIORITY_LABEL[i.priority], i.impact, i.effort,
      i.impact && i.effort ? i.impact * (6 - i.effort) : null, i.due_at, i.cost, label(STATUS_LABEL, i.status),
      i.project_name, i.created_at, i.updated_at, i.description]) });
  }
  const notes = [];
  if (scope !== 'ideas') {
    notes.push(...db.all(`SELECT n.created_at, p.name AS owner, t.title AS task, n.body FROM notes n
      JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id ${projWhere}`, projParams));
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
  const file = `TaskManager - ${name} - ${dateKey(new Date())}.xlsx`;
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
      AND table_name IN ('tasks', 'projects') AND action = 'UPDATE' ORDER BY changed_at, id`, [p.id, start, end]).map(normAudit);
    // Net due-date change per task/project over the period.
    const moves = new Map();
    for (const e of events) {
      if (e.old_data?.due_at === e.new_data?.due_at) continue;
      const key = `${e.table_name}:${e.record_id}`;
      const m = moves.get(key) || { what: e.table_name === 'projects' ? 'Project due date' : e.new_data.title, from: e.old_data.due_at };
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
      completed: tasks('WHERE t.project_id = ? AND t.completed_at BETWEEN ? AND ? ORDER BY t.completed_at', [p.id, start, end]),
      added: tasks('WHERE t.project_id = ? AND t.created_at BETWEEN ? AND ? ORDER BY t.created_at', [p.id, start, end]),
      started: [...started.values()],
      due_changes: [...moves.values()].filter((m) => m.from !== m.to),
      notes: db.all(`SELECT n.*, t.title AS task_title FROM notes n LEFT JOIN tasks t ON t.id = n.task_id
        WHERE n.project_id = ? AND n.created_at BETWEEN ? AND ? ORDER BY n.created_at`, [p.id, start, end]),
      spent_in_period: db.get(`SELECT coalesce(sum(amount), 0) AS n FROM project_costs
        WHERE project_id = ? AND spent_on BETWEEN ? AND ?`, [p.id, from, to]).n,
      blocked: tasks(`WHERE ${open} AND t.status = 'blocked' ORDER BY t.due_at IS NULL, t.due_at`, [p.id]),
      overdue: tasks(`WHERE ${open} AND t.due_at < ? ORDER BY t.due_at`, [p.id, now]),
      waiting: tasks(`WHERE ${open} AND t.waiting_on IS NOT NULL ORDER BY t.waiting_since`, [p.id]),
      upcoming: tasks(`WHERE ${open} AND t.due_at >= ? AND t.due_at <= ? ORDER BY t.due_at`, [p.id, now, soon]),
    };
  });

  const ideaEvents = req.query.project_id ? [] : db.all(`SELECT * FROM audit_log WHERE table_name = 'ideas'
    AND action = 'UPDATE' AND changed_at BETWEEN ? AND ? ORDER BY changed_at, id`, [start, end]).map(normAudit)
    .filter((e) => e.old_data?.status !== e.new_data?.status)
    .map((e) => ({ ref: e.new_data.ref, title: e.new_data.title, from: e.old_data.status, to: e.new_data.status, at: e.changed_at }));
  res.json({
    from, to, generated_at: now, currency: getSettings().currency,
    projects: out,
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

// ------------------------------------------------------------------ search

router.get('/search', h((req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json({ projects: [], tasks: [], notes: [], ideas: [] });
  const q = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const like = (col) => `${col} LIKE ? ESCAPE '\\'`;
  res.json({
    projects: db.all(`SELECT id, name, status FROM projects WHERE ${like('name')} OR ${like('description')} LIMIT 20`, [q, q]),
    tasks: tasks(`WHERE ${like('t.title')} OR ${like('t.description')} LIMIT 30`, [q, q]),
    notes: db.all(`SELECT n.*, p.name AS project_name FROM notes n JOIN projects p ON p.id = n.project_id
      WHERE ${like('n.body')} ORDER BY n.created_at DESC LIMIT 30`, [q]),
    ideas: db.all(`${IDEA_SELECT} WHERE ${like('i.title')} OR ${like('i.description')} OR ${like('i.ref')}
      OR i.id IN (SELECT idea_id FROM idea_notes WHERE ${like('body')}) ORDER BY i.id DESC LIMIT 30`, [q, q, q, q]),
  });
}));

// ------------------------------------------------------------------ helpers

const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
  active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived',
  new: 'New', reviewing: 'Under review', approved: 'Approved', rejected: 'Rejected',
  implemented: 'Implemented', escalated: 'Escalated to project' };
const PRIORITY_LABEL = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const FIELD_LABEL = { title: 'title', name: 'name', description: 'description', status: 'status',
  priority: 'priority', due_at: 'due date', start_date: 'start date', parent_id: 'parent task',
  remind_at: 'reminder time', message: 'message', body: 'text',
  submitted_by: 'submitted by', area_id: 'area', cost: 'cost', value: 'value', active: 'active',
  waiting_on: 'waiting on', recurrence: 'repeats', budget: 'budget', impact: 'impact', effort: 'effort',
  amount: 'amount', spent_on: 'date' };
const REPEAT_LABEL = { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', fortnightly: 'Every 2 weeks',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };

function fmtValue(field, v) {
  if (v === null || v === undefined || v === '') return '(none)';
  if (field === 'status') return STATUS_LABEL[v] || v;
  if (field === 'priority') return PRIORITY_LABEL[v] || v;
  if (field === 'area_id') return db.get('SELECT name FROM areas WHERE id = ?', [v])?.name || `#${v}`;
  if (field === 'active') return v ? 'yes' : 'no';
  if (field === 'recurrence') return REPEAT_LABEL[v] || v;
  if (field in MONEY_FIELDS) return `${getSettings().currency}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (field === 'due_at') return new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (field === 'start_date' || field === 'spent_on') return new Date(`${v}T12:00`).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (field === 'remind_at') return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// Turns an audit_log row into a human sentence (or null for noise).
function describeAudit(e) {
  const d = e.new_data || e.old_data || {};
  const label = { projects: 'Project', tasks: d.parent_id ? 'Subtask' : 'Task', notes: 'Note', reminders: 'Reminder',
    ideas: `Idea${d.ref ? ` ${d.ref}` : ''}`, idea_notes: 'Idea note', areas: 'Area', settings: 'Setting',
    project_costs: 'Cost', task_links: 'Dependency' }[e.table_name] || e.table_name;
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
      if (field === 'description' || field === 'body') changes.push(`${text} edited`);
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
