const express = require('express');
const db = require('./db');
const backup = require('./backup');
const log = require('./logger');

const router = express.Router();

// Wraps async handlers so errors reach the error middleware.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const notFound = (what) => new HttpError(404, `${what} not found`);

// Picks only allowed keys from a body, turning '' into null.
function pick(body, keys) {
  const out = {};
  for (const k of keys) {
    if (body[k] !== undefined) out[k] = body[k] === '' ? null : body[k];
  }
  return out;
}

// Builds "UPDATE table SET a=$1, b=$2 WHERE id=$n RETURNING *".
async function updateRow(client, table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return (await client.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0];
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const { rows } = await client.query(
    `UPDATE ${table} SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
    [...keys.map((k) => fields[k]), id],
  );
  return rows[0];
}

const PROJECT_FIELDS = ['name', 'description', 'status', 'priority', 'start_date', 'due_at'];
const TASK_FIELDS = ['title', 'description', 'status', 'priority', 'due_at', 'sort_order', 'parent_id'];

const TASK_SELECT = `
  SELECT t.*, p.name AS project_name,
         (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id) AS subtask_count,
         (SELECT count(*)::int FROM tasks s WHERE s.parent_id = t.id AND s.status = 'done') AS subtask_done,
         (SELECT count(*)::int FROM notes n WHERE n.task_id = t.id) AS note_count,
         (SELECT min(r.remind_at) FROM reminders r WHERE r.task_id = t.id AND r.status = 'pending') AS next_reminder
  FROM tasks t JOIN projects p ON p.id = t.project_id`;

// ------------------------------------------------------------------ projects

router.get('/projects', h(async (req, res) => {
  const includeArchived = req.query.all === '1';
  const { rows } = await db.query(`
    SELECT p.*,
           count(t.id)::int                                       AS task_count,
           count(t.id) FILTER (WHERE t.status = 'done')::int      AS done_count,
           count(t.id) FILTER (WHERE t.status <> 'done' AND t.due_at < now())::int AS overdue_count,
           (SELECT max(created_at) FROM notes n WHERE n.project_id = p.id) AS last_note_at
    FROM projects p LEFT JOIN tasks t ON t.project_id = p.id
    ${includeArchived ? '' : "WHERE p.status <> 'archived'"}
    GROUP BY p.id
    ORDER BY (p.status = 'active') DESC, p.priority DESC, p.due_at NULLS LAST, p.name`);
  res.json(rows);
}));

router.post('/projects', h(async (req, res) => {
  const fields = pick(req.body, PROJECT_FIELDS);
  if (!fields.name || !String(fields.name).trim()) throw new HttpError(400, 'Project name is required');
  const baselineTasks = (req.body.baseline_tasks || []).map((s) => String(s).trim()).filter(Boolean);

  const project = await db.tx(async (c) => {
    const keys = Object.keys(fields);
    const { rows } = await c.query(
      `INSERT INTO projects (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      keys.map((k) => fields[k]),
    );
    const p = rows[0];
    for (const [i, title] of baselineTasks.entries()) {
      await c.query('INSERT INTO tasks (project_id, title, sort_order) VALUES ($1, $2, $3)', [p.id, title, i]);
    }
    if (req.body.initial_note && String(req.body.initial_note).trim()) {
      await c.query('INSERT INTO notes (project_id, body) VALUES ($1, $2)', [p.id, String(req.body.initial_note).trim()]);
    }
    if (req.body.set_baseline !== false) await setBaseline(c, p.id);
    return p;
  });
  res.status(201).json(project);
}));

router.get('/projects/:id', h(async (req, res) => {
  const { rows: [project] } = await db.query('SELECT * FROM projects WHERE id = $1', [req.params.id]);
  if (!project) throw notFound('Project');
  const { rows: tasks } = await db.query(`${TASK_SELECT} WHERE t.project_id = $1 ORDER BY t.sort_order, t.id`, [project.id]);
  res.json({ ...project, tasks });
}));

router.patch('/projects/:id', h(async (req, res) => {
  const row = await updateRow(db, 'projects', req.params.id, pick(req.body, PROJECT_FIELDS));
  if (!row) throw notFound('Project');
  res.json(row);
}));

router.delete('/projects/:id', h(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Project');
  log.info(`Project ${req.params.id} deleted`);
  res.status(204).end();
}));

// Freezes the current plan: every existing task becomes a baseline task and
// a snapshot of the project + tasks is stored for later comparison.
async function setBaseline(client, projectId) {
  const { rows: [p] } = await client.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!p) throw notFound('Project');
  await client.query('UPDATE tasks SET is_baseline = true WHERE project_id = $1', [projectId]);
  const { rows: tasks } = await client.query(
    'SELECT id, parent_id, title, status, priority, due_at FROM tasks WHERE project_id = $1 ORDER BY sort_order, id',
    [projectId],
  );
  const snapshot = {
    name: p.name, description: p.description, priority: p.priority,
    start_date: p.start_date, due_at: p.due_at, tasks,
  };
  const { rows: [updated] } = await client.query(
    `UPDATE projects SET baseline_set_at = now(), baseline_due_at = due_at, baseline_snapshot = $2
     WHERE id = $1 RETURNING *`,
    [projectId, snapshot],
  );
  return updated;
}

router.post('/projects/:id/baseline', h(async (req, res) => {
  res.json(await db.tx((c) => setBaseline(c, req.params.id)));
}));

// Notes + audit events for a project, newest first.
router.get('/projects/:id/timeline', h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 300, 2000);
  const { rows: notes } = await db.query(`
    SELECT n.id, n.task_id, n.body, n.created_at, n.updated_at, t.title AS task_title
    FROM notes n LEFT JOIN tasks t ON t.id = n.task_id
    WHERE n.project_id = $1 ORDER BY n.created_at DESC LIMIT $2`, [req.params.id, limit]);
  const { rows: events } = await db.query(`
    SELECT * FROM audit_log WHERE project_id = $1 AND table_name <> 'notes'
    ORDER BY changed_at DESC LIMIT $2`, [req.params.id, limit]);
  const items = [
    ...notes.map((n) => ({ type: 'note', at: n.created_at, ...n })),
    ...events.map((e) => ({ type: 'event', at: e.changed_at, id: e.id, text: describeAudit(e) }))
      .filter((e) => e.text),
  ].sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json(items.slice(0, limit));
}));

// ------------------------------------------------------------------ tasks

router.get('/tasks', h(async (req, res) => {
  const where = ["p.status NOT IN ('archived')"];
  const params = [];
  if (req.query.project_id) { params.push(req.query.project_id); where.push(`t.project_id = $${params.length}`); }
  if (req.query.top_level === '1') where.push('t.parent_id IS NULL');
  if (req.query.open === '1') where.push("t.status <> 'done'");
  const { rows } = await db.query(
    `${TASK_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY t.priority DESC, t.due_at NULLS LAST, t.sort_order, t.id`, params);
  res.json(rows);
}));

router.post('/tasks', h(async (req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  if (!fields.title || !String(fields.title).trim()) throw new HttpError(400, 'Task title is required');
  let projectId = req.body.project_id;
  if (fields.parent_id) {
    const { rows: [parent] } = await db.query('SELECT project_id FROM tasks WHERE id = $1', [fields.parent_id]);
    if (!parent) throw notFound('Parent task');
    projectId = parent.project_id;
  }
  if (!projectId) throw new HttpError(400, 'project_id is required');
  if (fields.sort_order === undefined) {
    const { rows: [m] } = await db.query('SELECT coalesce(max(sort_order), -1) + 1 AS n FROM tasks WHERE project_id = $1', [projectId]);
    fields.sort_order = m.n;
  }
  fields.project_id = projectId;
  const keys = Object.keys(fields);
  const { rows: [task] } = await db.query(
    `INSERT INTO tasks (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    keys.map((k) => fields[k]),
  );
  res.status(201).json(task);
}));

router.get('/tasks/:id', h(async (req, res) => {
  const { rows: [task] } = await db.query(`${TASK_SELECT} WHERE t.id = $1`, [req.params.id]);
  if (!task) throw notFound('Task');
  const { rows: subtasks } = await db.query(`${TASK_SELECT} WHERE t.parent_id = $1 ORDER BY t.sort_order, t.id`, [task.id]);
  const { rows: notes } = await db.query('SELECT * FROM notes WHERE task_id = $1 ORDER BY created_at DESC', [task.id]);
  const { rows: reminders } = await db.query('SELECT * FROM reminders WHERE task_id = $1 ORDER BY remind_at', [task.id]);
  const { rows: history } = await db.query(
    "SELECT * FROM audit_log WHERE table_name = 'tasks' AND record_id = $1 ORDER BY changed_at DESC", [task.id]);
  res.json({ ...task, subtasks, notes, reminders,
    history: history.map((e) => ({ at: e.changed_at, text: describeAudit(e) })).filter((e) => e.text) });
}));

router.patch('/tasks/:id', h(async (req, res) => {
  const fields = pick(req.body, TASK_FIELDS);
  const task = await db.tx(async (c) => {
    const row = await updateRow(c, 'tasks', req.params.id, fields);
    if (!row) throw notFound('Task');
    // Optionally complete / reopen all subtasks along with the parent.
    if (req.body.cascade && fields.status) {
      await c.query(`
        WITH RECURSIVE sub AS (
          SELECT id FROM tasks WHERE parent_id = $1
          UNION ALL SELECT t.id FROM tasks t JOIN sub ON t.parent_id = sub.id)
        UPDATE tasks SET status = $2 WHERE id IN (SELECT id FROM sub) AND status <> $2`,
      [row.id, fields.status]);
    }
    return row;
  });
  res.json(task);
}));

router.delete('/tasks/:id', h(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Task');
  res.status(204).end();
}));

// ------------------------------------------------------------------ notes

router.post('/notes', h(async (req, res) => {
  const body = String(req.body.body || '').trim();
  if (!body) throw new HttpError(400, 'Note text is required');
  let projectId = req.body.project_id;
  const taskId = req.body.task_id || null;
  if (taskId) {
    const { rows: [t] } = await db.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    if (!t) throw notFound('Task');
    projectId = t.project_id;
  }
  if (!projectId) throw new HttpError(400, 'project_id is required');
  const { rows: [note] } = await db.query(
    'INSERT INTO notes (project_id, task_id, body) VALUES ($1, $2, $3) RETURNING *', [projectId, taskId, body]);
  res.status(201).json(note);
}));

router.patch('/notes/:id', h(async (req, res) => {
  const row = await updateRow(db, 'notes', req.params.id, pick(req.body, ['body']));
  if (!row) throw notFound('Note');
  res.json(row);
}));

router.delete('/notes/:id', h(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM notes WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Note');
  res.status(204).end();
}));

// ------------------------------------------------------------------ reminders

const REMINDER_SELECT = `
  SELECT r.*, t.title AS task_title, t.due_at AS task_due_at, t.status AS task_status,
         p.name AS project_name
  FROM reminders r
  LEFT JOIN tasks t ON t.id = r.task_id
  LEFT JOIN projects p ON p.id = r.project_id`;

router.get('/reminders', h(async (req, res) => {
  const { rows } = await db.query(
    `${REMINDER_SELECT} WHERE r.status = 'pending' ORDER BY r.remind_at`);
  res.json(rows);
}));

router.post('/reminders', h(async (req, res) => {
  if (!req.body.remind_at) throw new HttpError(400, 'remind_at is required');
  let projectId = req.body.project_id || null;
  const taskId = req.body.task_id || null;
  if (taskId) {
    const { rows: [t] } = await db.query('SELECT project_id FROM tasks WHERE id = $1', [taskId]);
    if (!t) throw notFound('Task');
    projectId = t.project_id;
  }
  const { rows: [r] } = await db.query(
    'INSERT INTO reminders (project_id, task_id, remind_at, message) VALUES ($1, $2, $3, $4) RETURNING *',
    [projectId, taskId, req.body.remind_at, req.body.message || null]);
  res.status(201).json(r);
}));

// Body: { action: 'dismiss' } or { action: 'snooze', minutes: 10 }
router.patch('/reminders/:id', h(async (req, res) => {
  let row;
  if (req.body.action === 'dismiss') {
    row = await updateRow(db, 'reminders', req.params.id, { status: 'dismissed' });
  } else if (req.body.action === 'snooze') {
    const minutes = Math.max(1, Number(req.body.minutes) || 10);
    ({ rows: [row] } = await db.query(
      `UPDATE reminders SET remind_at = now() + make_interval(mins => $2), snooze_count = snooze_count + 1,
              status = 'pending'
       WHERE id = $1 RETURNING *`, [req.params.id, minutes]));
  } else {
    row = await updateRow(db, 'reminders', req.params.id, pick(req.body, ['remind_at', 'message']));
  }
  if (!row) throw notFound('Reminder');
  res.json(row);
}));

router.delete('/reminders/:id', h(async (req, res) => {
  const { rowCount } = await db.query('DELETE FROM reminders WHERE id = $1', [req.params.id]);
  if (!rowCount) throw notFound('Reminder');
  res.status(204).end();
}));

// Polled by the browser: reminders that are due now, plus task due-date alerts.
router.get('/alerts', h(async (req, res) => {
  const { rows: reminders } = await db.query(
    `${REMINDER_SELECT} WHERE r.status = 'pending' AND r.remind_at <= now() ORDER BY r.remind_at`);
  const { rows: tasks } = await db.query(
    `${TASK_SELECT} WHERE t.status <> 'done' AND p.status IN ('active', 'on_hold')
       AND t.due_at IS NOT NULL AND t.due_at <= now() + interval '24 hours'
     ORDER BY t.due_at`);
  res.json({ now: new Date().toISOString(), reminders, due_tasks: tasks });
}));

// ------------------------------------------------------------------ dashboard

router.get('/dashboard', h(async (req, res) => {
  const base = `${TASK_SELECT} WHERE t.status <> 'done' AND p.status IN ('active', 'on_hold')`;
  const [overdue, today, week, high, recentNotes, reminders] = await Promise.all([
    db.query(`${base} AND t.due_at < now() ORDER BY t.due_at`),
    db.query(`${base} AND t.due_at >= now() AND t.due_at < date_trunc('day', now()) + interval '1 day' ORDER BY t.due_at`),
    db.query(`${base} AND t.due_at >= date_trunc('day', now()) + interval '1 day'
              AND t.due_at < date_trunc('day', now()) + interval '8 days' ORDER BY t.due_at`),
    db.query(`${base} AND t.priority >= 3 ORDER BY t.priority DESC, t.due_at NULLS LAST`),
    db.query(`SELECT n.*, p.name AS project_name, t.title AS task_title FROM notes n
              JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id
              ORDER BY n.created_at DESC LIMIT 15`),
    db.query(`${REMINDER_SELECT} WHERE r.status = 'pending' ORDER BY r.remind_at LIMIT 20`),
  ]);
  res.json({
    overdue: overdue.rows, today: today.rows, week: week.rows, high_priority: high.rows,
    recent_notes: recentNotes.rows, reminders: reminders.rows,
  });
}));

// ------------------------------------------------------------------ audit log

router.get('/audit', h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 5000);
  const params = [limit];
  let where = '';
  if (req.query.project_id) { params.push(req.query.project_id); where = 'WHERE project_id = $2'; }
  const { rows } = await db.query(`SELECT * FROM audit_log ${where} ORDER BY changed_at DESC LIMIT $1`, params);
  res.json(rows.map((r) => ({ ...r, summary: describeAudit(r) || `${r.action} ${r.table_name} #${r.record_id}` })));
}));

// ------------------------------------------------------------------ backups

router.get('/backups', h(async (req, res) => res.json(backup.listBackups())));
router.post('/backups', h(async (req, res) => res.status(201).json(await backup.runBackup('manual (UI)'))));

// ------------------------------------------------------------------ search

router.get('/search', h(async (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  if (q === '%%') return res.json({ projects: [], tasks: [], notes: [] });
  const [projects, tasks, notes] = await Promise.all([
    db.query('SELECT id, name, status FROM projects WHERE name ILIKE $1 OR description ILIKE $1 LIMIT 20', [q]),
    db.query(`${TASK_SELECT} WHERE t.title ILIKE $1 OR t.description ILIKE $1 LIMIT 30`, [q]),
    db.query(`SELECT n.*, p.name AS project_name FROM notes n JOIN projects p ON p.id = n.project_id
              WHERE n.body ILIKE $1 ORDER BY n.created_at DESC LIMIT 30`, [q]),
  ]);
  res.json({ projects: projects.rows, tasks: tasks.rows, notes: notes.rows });
}));

// ------------------------------------------------------------------ helpers

const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
  active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived' };
const PRIORITY_LABEL = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const FIELD_LABEL = { title: 'title', name: 'name', description: 'description', status: 'status',
  priority: 'priority', due_at: 'due date', start_date: 'start date', parent_id: 'parent task',
  remind_at: 'reminder time', message: 'message', body: 'text' };

function fmtValue(field, v) {
  if (v === null || v === undefined || v === '') return '(none)';
  if (field === 'status') return STATUS_LABEL[v] || v;
  if (field === 'priority') return PRIORITY_LABEL[v] || v;
  if (field === 'due_at' || field === 'remind_at') return new Date(v).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const s = String(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// Turns an audit_log row into a human sentence (or null for noise).
function describeAudit(e) {
  const d = e.new_data || e.old_data || {};
  const label = { projects: 'Project', tasks: d.parent_id ? 'Subtask' : 'Task', notes: 'Note', reminders: 'Reminder' }[e.table_name] || e.table_name;
  const name = d.title || d.name || (d.body && fmtValue('body', d.body)) || '';
  const named = name ? ` "${name}"` : '';
  if (e.action === 'INSERT') {
    if (e.table_name === 'reminders') return `Reminder set for ${fmtValue('remind_at', d.remind_at)}`;
    return `${label} created${named}`;
  }
  if (e.action === 'DELETE') return `${label} deleted${named}`;
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
  if (e.table_name === 'reminders' && e.old_data?.snooze_count !== e.new_data?.snooze_count) {
    return `Reminder snoozed until ${fmtValue('remind_at', e.new_data.remind_at)}`;
  }
  if (!changes.length) return null;
  if (e.table_name === 'reminders' && e.new_data?.status === 'dismissed') return 'Reminder dismissed';
  return `${label}${named}: ${changes.join('; ')}`;
}

// ------------------------------------------------------------------ errors

router.use((err, req, res, _next) => {
  const status = err.status || (err.code === '22P02' || err.code === '23514' || err.code === '22007' || err.code === '22008' ? 400 : 500);
  if (status >= 500) log.error(`${req.method} ${req.originalUrl} failed`, err.stack || err.message);
  res.status(status).json({ error: err.message });
});

module.exports = router;
