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
  res.json(lists.map((l) => ({ ...l, departments: !!depts && l.id === depts.id, items: all.filter((i) => i.list_id === l.id).map((i) => {
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

// The Departments list is what people's departments point at, so it can't be renamed or deleted.
const lockedList = (id) => {
  if (Number(id) === departmentsList()?.id) throw new HttpError(400, 'The Departments list can\'t be renamed or deleted — people\'s departments come from it');
};

router.patch('/name-lists/:id', h((req, res) => {
  const f = {};
  if ('name' in req.body) {
    lockedList(req.params.id);
    f.name = String(req.body.name || '').trim();
    if (!f.name) throw new HttpError(400, 'List name is required');
    if (db.get('SELECT 1 FROM name_lists WHERE name = ? AND id <> ?', [f.name, req.params.id])) throw new HttpError(400, `There's already a list called "${f.name}"`);
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
      i.project_name, i.created_at, i.updated_at, i.description]) });
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
  res.json({ ...doc, html: out.html, headings: out.headings, props: out.props, backlinks,
    linked_tasks: linkedTasks, linked_projects: linkedProjects });
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
  db.run("DELETE FROM settings WHERE key IN ('library_imported_at', 'library_source', 'library_excluded')");
  log.info('Library removed');
  res.status(204).end();
}));

// ------------------------------------------------------------------ search

router.get('/search', h((req, res) => {
  const term = String(req.query.q || '').trim();
  if (!term) return res.json({ projects: [], tasks: [], notes: [], ideas: [], meetings: [], library: [] });
  const q = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const like = (col) => `${col} LIKE ? ESCAPE '\\'`;
  res.json({
    projects: db.all(`SELECT id, name, status FROM projects WHERE ${like('name')} OR ${like('description')} LIMIT 20`, [q, q]),
    tasks: tasks(`WHERE ${like('t.title')} OR ${like('t.description')} LIMIT 30`, [q, q]),
    notes: db.all(`SELECT n.*, p.name AS project_name, t.title AS task_title FROM notes n
      LEFT JOIN projects p ON p.id = n.project_id LEFT JOIN tasks t ON t.id = n.task_id
      WHERE ${like('n.body')} ORDER BY n.created_at DESC LIMIT 30`, [q]),
    ideas: db.all(`${IDEA_SELECT} WHERE ${like('i.title')} OR ${like('i.description')} OR ${like('i.ref')}
      OR i.id IN (SELECT idea_id FROM idea_notes WHERE ${like('body')}) ORDER BY i.id DESC LIMIT 30`, [q, q, q, q]),
    library: librarySearch(term, 20),
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
  waiting_on: 'waiting on', recurrence: 'repeats', budget: 'budget', impact: 'impact', effort: 'effort',
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
