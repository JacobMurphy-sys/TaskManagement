const express = require('express');
const db = require('./db');
const backup = require('./backup');
const log = require('./logger');
const config = require('./config');

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

// Picks only allowed keys from a body, turning '' into null and normalising dates.
function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body[k] === undefined) continue;
    let v = body[k] === '' ? null : body[k];
    if (k === 'due_at') v = toDueIso(v);
    if (k === 'remind_at') v = toIso(v, k);
    if (k === 'start_date' && v !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, 'Invalid start_date');
    out[k] = v;
  }
  return out;
}

function insertRow(table, fields) {
  const keys = Object.keys(fields);
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

const PROJECT_FIELDS = ['name', 'description', 'status', 'priority', 'start_date', 'due_at'];
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'due_at', 'sort_order', 'parent_id'];

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
           (SELECT max(changed_at) FROM audit_log a WHERE a.project_id = p.id) AS last_activity_at
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
    'SELECT id, parent_id, title, status, priority, due_at FROM tasks WHERE project_id = ? ORDER BY sort_order, id',
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

router.post('/tasks', h((req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  if (!fields.title || !String(fields.title).trim()) throw new HttpError(400, 'Task title is required');
  let projectId = req.body.project_id;
  if (fields.parent_id) {
    const parent = db.get('SELECT project_id FROM tasks WHERE id = ?', [fields.parent_id]);
    if (!parent) throw notFound('Parent task');
    projectId = parent.project_id;
  }
  if (!projectId) throw new HttpError(400, 'project_id is required');
  if (!db.get('SELECT 1 FROM projects WHERE id = ?', [projectId])) throw notFound('Project');
  if (fields.sort_order === undefined) {
    fields.sort_order = db.get('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM tasks WHERE project_id = ?', [projectId]).n;
  }
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
    subtasks: tasks('WHERE t.parent_id = ? ORDER BY t.sort_order, t.id', [task.id]),
    notes: db.all('SELECT * FROM notes WHERE task_id = ? ORDER BY created_at DESC', [task.id]),
    reminders: db.all('SELECT * FROM reminders WHERE task_id = ? ORDER BY remind_at', [task.id]),
    history: history.map((e) => ({ at: e.changed_at, text: describeAudit(e) })).filter((e) => e.text),
  });
}));

router.patch('/tasks/:id', h((req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  const task = db.tx(() => {
    const row = updateRow('tasks', req.params.id, fields);
    if (!row) throw notFound('Task');
    // Optionally complete / reopen all subtasks along with the parent.
    if (req.body.cascade && fields.status) {
      db.run(`
        WITH RECURSIVE sub(id) AS (
          SELECT id FROM tasks WHERE parent_id = ?
          UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
        UPDATE tasks SET status = ? WHERE id IN (SELECT id FROM sub) AND status <> ?`,
      [row.id, fields.status, fields.status]);
    }
    return fresh('tasks', row);
  });
  res.json(normTask(task));
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
  res.status(201).json(insertRow('notes', { project_id: projectId, task_id: taskId, body }));
}));

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
    ideas: db.get(`SELECT count(*) AS open, coalesce(sum(cost), 0) AS cost FROM ideas
      WHERE status IN ('new', 'reviewing', 'approved')`),
    recent_notes: db.all(`SELECT n.*, p.name AS project_name, t.title AS task_title FROM notes n
      JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id
      ORDER BY n.created_at DESC LIMIT 15`),
    reminders: db.all(`${REMINDER_SELECT} WHERE r.status = 'pending' ORDER BY r.remind_at LIMIT 20`),
  });
}));

// ------------------------------------------------------------------ ideation

const IDEA_FIELDS = ['title', 'description', 'submitted_by', 'area_id', 'priority', 'due_at', 'cost', 'status'];
const IDEA_SELECT = `
  SELECT i.*, a.name AS area_name, p.name AS project_name,
         (SELECT count(*) FROM idea_notes n WHERE n.idea_id = i.id) AS note_count,
         (SELECT max(created_at) FROM idea_notes n WHERE n.idea_id = i.id) AS last_note_at
  FROM ideas i LEFT JOIN areas a ON a.id = i.area_id LEFT JOIN projects p ON p.id = i.project_id`;
const OPEN_IDEA = "i.status IN ('new', 'reviewing', 'approved')";

function ideaFields(body) {
  const f = pick(body, IDEA_FIELDS);
  if (f.cost !== undefined && f.cost !== null) {
    const n = Number(String(f.cost).replace(/[^0-9.-]/g, ''));
    if (String(f.cost).trim() === '' || Number.isNaN(n) || n < 0) throw new HttpError(400, 'Cost must be a positive number');
    f.cost = Math.round(n * 100) / 100;
  }
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

const SETTING_DEFAULTS = { currency: '£' };
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
  submitted_by: 'submitted by', area_id: 'area', cost: 'cost', value: 'value', active: 'active' };

function fmtValue(field, v) {
  if (v === null || v === undefined || v === '') return '(none)';
  if (field === 'status') return STATUS_LABEL[v] || v;
  if (field === 'priority') return PRIORITY_LABEL[v] || v;
  if (field === 'area_id') return db.get('SELECT name FROM areas WHERE id = ?', [v])?.name || `#${v}`;
  if (field === 'active') return v ? 'yes' : 'no';
  if (field === 'due_at') return new Date(v).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (field === 'remind_at') return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// Turns an audit_log row into a human sentence (or null for noise).
function describeAudit(e) {
  const d = e.new_data || e.old_data || {};
  const label = { projects: 'Project', tasks: d.parent_id ? 'Subtask' : 'Task', notes: 'Note', reminders: 'Reminder',
    ideas: `Idea${d.ref ? ` ${d.ref}` : ''}`, idea_notes: 'Idea note', areas: 'Area', settings: 'Setting' }[e.table_name] || e.table_name;
  const name = d.title || d.name || d.key || (d.body && fmtValue('body', d.body)) || '';
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
