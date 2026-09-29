'use strict';

// ======================================================================
// Helpers
// ======================================================================

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
const STATUS = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };
const PSTATUS = { active: 'Active', on_hold: 'On hold', completed: 'Completed', archived: 'Archived' };

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

async function request(method, url, body) {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}
const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b || {}),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 2500);
}

// ---- dates -----------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');

function fmtDateTime(iso, opts = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, { weekday: opts.weekday === false ? undefined : 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return `${date}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtRelative(iso) {
  const diff = new Date(iso) - Date.now();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  let s;
  if (m < 1) s = 'now';
  else if (m < 60) s = `${m}m`;
  else if (m < 60 * 24) s = `${Math.round(m / 60)}h`;
  else s = `${Math.round(m / 1440)}d`;
  if (s === 'now') return 'now';
  return diff < 0 ? `${s} ago` : `in ${s}`;
}
// <input type="datetime-local"> <-> ISO
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

function at(daysFromToday, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  d.setHours(hour, minute, 0, 0);
  return d;
}
function nextWorkdayAt9() {
  const d = at(1, 9);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}

// Quick-add syntax:  "Call supplier !high @tomorrow"
//   priority: !low !med !high !crit (or !1..!4)
//   due:      @today @tomorrow @mon..@sun @2026-10-03 @2026-10-03T14:30  (default time 17:00)
function parseQuick(text) {
  let priority; let due;
  const prioMap = { low: 1, l: 1, 1: 1, med: 2, medium: 2, m: 2, 2: 2, high: 3, h: 3, 3: 3, crit: 4, critical: 4, c: 4, 4: 4 };
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const title = text.replace(/(^|\s)!(\w+)/g, (m, sp, w) => {
    const p = prioMap[w.toLowerCase()];
    if (!p) return m;
    priority = p; return sp;
  }).replace(/(^|\s)@([\w:-]+)/g, (m, sp, w) => {
    const lw = w.toLowerCase();
    let d;
    if (lw === 'today') d = at(0, 17);
    else if (lw === 'tomorrow' || lw === 'tmr') d = at(1, 17);
    else if (days.includes(lw.slice(0, 3)) && /^[a-z]+$/.test(lw)) {
      const target = days.indexOf(lw.slice(0, 3));
      let add = (target - new Date().getDay() + 7) % 7;
      if (add === 0) add = 7;
      d = at(add, 17);
    } else if (/^\d{4}-\d{2}-\d{2}(t\d{2}:\d{2})?$/.test(lw)) {
      d = new Date(lw.length === 10 ? `${w}T17:00` : w);
    }
    if (!d || Number.isNaN(d.getTime())) return m;
    due = d.toISOString(); return sp;
  }).replace(/\s+/g, ' ').trim();
  return { title, priority, due_at: due };
}

// ---- small renderers ---------------------------------------------------

const prioPill = (p) => `<span class="pill prio-${p}" title="Priority">${PRIORITY[p]}</span>`;

function dueChip(t) {
  if (!t.due_at) return '';
  const due = new Date(t.due_at);
  let cls = '';
  if (t.status !== 'done') {
    if (due < new Date()) cls = 'overdue';
    else if (due - Date.now() < 24 * 3600 * 1000) cls = 'soon';
  }
  return `<span class="chip ${cls}" title="Due ${esc(fmtDateTime(t.due_at))}">📅 ${esc(fmtDateTime(t.due_at, { weekday: false }))}${cls ? ` (${fmtRelative(t.due_at)})` : ''}</span>`;
}
function statusChip(s) {
  return s === 'in_progress' || s === 'blocked' ? `<span class="pill status-${s}">${STATUS[s]}</span>` : '';
}
const options = (map, selected) => Object.entries(map)
  .map(([v, l]) => `<option value="${v}" ${String(v) === String(selected) ? 'selected' : ''}>${esc(l)}</option>`).join('');

// ======================================================================
// State, routing & sidebar
// ======================================================================

const state = { projects: [], view: null, project: null };
const main = () => $('#main');

async function loadProjects() {
  state.projects = await api.get(`/projects${$('#show-archived').checked ? '?all=1' : ''}`);
  renderSidebar();
}

function renderSidebar() {
  const current = state.view === 'project' ? String(state.projectId) : null;
  $('#project-list').innerHTML = state.projects.map((p) => {
    const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
    return `<li><a href="#/project/${p.id}" class="${String(p.id) === current ? 'active' : ''}">
      <div class="pname"><span>${esc(p.name)}</span>
        ${p.overdue_count ? `<span class="chip overdue" title="Overdue tasks">⚠ ${p.overdue_count}</span>` : ''}
        ${p.status !== 'active' ? `<span class="small muted">${PSTATUS[p.status]}</span>` : ''}
      </div>
      <div class="progress" title="${p.done_count}/${p.task_count} tasks done"><div style="width:${pct}%"></div></div>
    </a></li>`;
  }).join('') || '<li class="empty small">No projects yet</li>';
  $$('#sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.view));
}

async function route() {
  document.body.classList.remove('sidebar-open');
  const [view = 'dashboard', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  state.view = view;
  state.projectId = view === 'project' ? rest[0] : null;
  renderSidebar();
  try {
    if (view === 'project') await renderProject(rest[0]);
    else if (view === 'kanban') await renderKanban();
    else if (view === 'log') await renderLog();
    else if (view === 'backups') await renderBackups();
    else if (view === 'search') await renderSearch(decodeURIComponent(rest.join('/')));
    else { state.view = 'dashboard'; renderSidebar(); await renderDashboard(); }
  } catch (err) {
    main().innerHTML = `<div class="card"><h2>Something went wrong</h2><p class="pre">${esc(err.message)}</p></div>`;
  }
}

// Re-renders the current view (keeping scroll) and the sidebar.
async function refresh() {
  const scroll = main().scrollTop;
  await Promise.all([loadProjects(), route()]);
  main().scrollTop = scroll;
  pollAlerts();
}

// ======================================================================
// Dashboard
// ======================================================================

function miniTask(t) {
  return `<li class="${t.status === 'done' ? 'done' : ''}">
    <input type="checkbox" data-action="toggle-task" data-id="${t.id}" data-subs="${t.subtask_count - t.subtask_done}" ${t.status === 'done' ? 'checked' : ''}>
    <span class="t" data-action="open-task" data-id="${t.id}">${esc(t.title)}</span>
    <a class="small" href="#/project/${t.project_id}">${esc(t.project_name)}</a>
    ${prioPill(t.priority)} ${dueChip(t)}
  </li>`;
}

async function renderDashboard() {
  const d = await api.get('/dashboard');
  const section = (title, items, render, empty) => `<div class="card"><h2>${title} <span class="muted small">${items.length}</span></h2>
    ${items.length ? `<ul class="mini">${items.map(render).join('')}</ul>` : `<div class="empty">${empty}</div>`}</div>`;
  main().innerHTML = `
    <div class="row" style="margin-bottom:14px"><h1 style="margin:0">Dashboard</h1><div class="spacer"></div>
      <span class="muted">${esc(fmtDate(new Date()))}</span></div>
    <div class="grid dash">
      ${section('⚠ Overdue', d.overdue, miniTask, 'Nothing overdue 🎉')}
      ${section('📅 Due today', d.today, miniTask, 'Nothing else due today')}
      ${section('🗓 Next 7 days', d.week, miniTask, 'Nothing due this week')}
      ${section('🔥 High priority', d.high_priority, miniTask, 'No open high-priority tasks')}
      ${section('🔔 Upcoming reminders', d.reminders, (r) => `<li>
          <span class="t" ${r.task_id ? `data-action="open-task" data-id="${r.task_id}"` : ''}>${esc(r.message || r.task_title || 'Reminder')}</span>
          ${r.project_name ? `<a class="small" href="#/project/${r.project_id}">${esc(r.project_name)}</a>` : ''}
          <span class="chip">⏰ ${esc(fmtDateTime(r.remind_at, { weekday: false }))} (${fmtRelative(r.remind_at)})</span>
          <button class="icon" data-action="delete-reminder" data-id="${r.id}" title="Delete reminder">✕</button>
        </li>`, 'No reminders set')}
      ${section('📝 Latest notes', d.recent_notes, (n) => `<li style="display:block">
          <div class="small muted">${esc(fmtDateTime(n.created_at))} · <a href="#/project/${n.project_id}">${esc(n.project_name)}</a>${n.task_title ? ` · ${esc(n.task_title)}` : ''}</div>
          <div class="pre">${esc(n.body)}</div></li>`, 'No notes yet')}
    </div>`;
}

// ======================================================================
// Project view
// ======================================================================

function buildTree(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, { ...t, children: [] }]));
  const roots = [];
  for (const t of byId.values()) {
    if (t.parent_id && byId.has(t.parent_id)) byId.get(t.parent_id).children.push(t);
    else roots.push(t);
  }
  const sort = (list) => {
    list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    list.forEach((t) => sort(t.children));
    return list;
  };
  return sort(roots);
}

function taskRow(t, p, hideDone) {
  const done = t.status === 'done';
  const added = p.baseline_set_at && !t.is_baseline;
  const kids = hideDone ? t.children.filter((c) => c.status !== 'done') : t.children;
  const open = t.children.filter((c) => c.status !== 'done').length;
  return `<li class="task ${done ? 'done' : ''}">
    <div class="task-line">
      <input type="checkbox" data-action="toggle-task" data-id="${t.id}" data-subs="${open}" ${done ? 'checked' : ''} title="${done ? `Completed ${esc(fmtDateTime(t.completed_at))}` : 'Mark done'}">
      <span class="task-title" data-action="open-task" data-id="${t.id}">${esc(t.title)}</span>
      ${statusChip(t.status)} ${t.priority !== 2 ? prioPill(t.priority) : ''} ${dueChip(t)}
      ${added ? `<span class="badge added" title="Added ${esc(fmtDateTime(t.created_at))}, after the baseline">+ added</span>` : ''}
      ${t.children.length ? `<span class="small muted" title="Subtasks done">☑ ${t.children.length - open}/${t.children.length}</span>` : ''}
      ${t.next_reminder ? `<span class="small" title="Reminder ${esc(fmtDateTime(t.next_reminder))}">🔔</span>` : ''}
      ${t.note_count ? `<span class="small muted" title="Notes">📝 ${t.note_count}</span>` : ''}
      <span class="row-actions">
        <button class="icon" data-action="add-subtask" data-id="${t.id}" title="Add subtask">＋ sub</button>
        <button class="icon" data-action="remind-task" data-id="${t.id}" title="Set a reminder">🔔</button>
      </span>
    </div>
    <div class="add-sub-slot" data-slot="${t.id}"></div>
    ${kids.length ? `<ul class="subtasks">${kids.map((c) => taskRow(c, p, hideDone)).join('')}</ul>` : ''}
  </li>`;
}

function baselineBox(p) {
  if (!p.baseline_set_at) {
    return `<div class="baseline-box"><span>No baseline set. A baseline freezes the original plan so later additions are tracked.</span>
      <button data-action="set-baseline">Set baseline now</button></div>`;
  }
  const snap = p.baseline_snapshot || {};
  const baseIds = new Set((snap.tasks || []).map((t) => t.id));
  const currentIds = new Set(p.tasks.map((t) => t.id));
  const added = p.tasks.filter((t) => !t.is_baseline).length;
  const removed = [...baseIds].filter((id) => !currentIds.has(id)).length;
  let slip = '';
  if (p.baseline_due_at && p.due_at && p.baseline_due_at !== p.due_at) {
    const days = Math.round((new Date(p.due_at) - new Date(p.baseline_due_at)) / 86400000);
    slip = ` <span class="chip ${days > 0 ? 'overdue' : ''}">(${days > 0 ? '+' : ''}${days} day${Math.abs(days) === 1 ? '' : 's'} vs baseline)</span>`;
  }
  return `<div class="baseline-box">
    <span><span class="badge baseline">Baseline</span> set <b>${esc(fmtDateTime(p.baseline_set_at))}</b></span>
    <span>Baseline tasks: <b>${baseIds.size}</b></span>
    <span>Added since: <b>${added}</b></span>
    ${removed ? `<span>Removed since: <b>${removed}</b></span>` : ''}
    <span>Baseline due: <b>${p.baseline_due_at ? esc(fmtDate(p.baseline_due_at)) : '—'}</b>${slip}</span>
    <button class="link" data-action="set-baseline" title="Re-baseline: all current tasks become the new baseline">Re-baseline</button>
  </div>`;
}

function timelineItem(i) {
  if (i.type === 'note') {
    return `<li class="note"><div class="when">🕘 ${esc(fmtDateTime(i.created_at))}
        ${i.task_title ? `<span class="badge baseline" data-action="open-task" data-id="${i.task_id}" style="cursor:pointer">${esc(i.task_title)}</span>` : ''}
        <span class="spacer"></span><button class="icon" data-action="delete-note" data-id="${i.id}" title="Delete note">✕</button></div>
      <div class="note-body pre">${esc(i.body)}</div></li>`;
  }
  return `<li class="event"><span title="${esc(fmtDateTime(i.at))}">${esc(fmtDateTime(i.at, { weekday: false }))}</span> — ${esc(i.text)}</li>`;
}

async function renderProject(id) {
  const [p, timeline] = await Promise.all([api.get(`/projects/${id}`), api.get(`/projects/${id}/timeline`)]);
  state.project = p;
  const hideDone = store.get('hideDone', false);
  const notesOnly = store.get('notesOnly', false);
  const tree = buildTree(p.tasks);
  const shown = hideDone ? tree.filter((t) => t.status !== 'done') : tree;
  const done = p.tasks.filter((t) => t.status === 'done').length;
  const items = notesOnly ? timeline.filter((i) => i.type === 'note') : timeline;

  main().innerHTML = `
    <div class="project-head">
      <div class="title">
        <h1>${esc(p.name)}</h1>
        ${p.description ? `<div class="pre muted">${esc(p.description)}</div>` : ''}
        <div class="small muted" style="margin-top:4px">Created ${esc(fmtDateTime(p.created_at))} · Updated ${esc(fmtDateTime(p.updated_at))}
          ${p.completed_at ? ` · Completed ${esc(fmtDateTime(p.completed_at))}` : ''}</div>
      </div>
      <div class="meta">
        <select data-action="project-field" data-field="status" title="Status">${options(PSTATUS, p.status)}</select>
        <select data-action="project-field" data-field="priority" title="Priority">${options(PRIORITY, p.priority)}</select>
        ${p.due_at ? dueChip({ ...p, status: p.status === 'completed' ? 'done' : '' }) : ''}
        <button data-action="edit-project">✎ Edit</button>
        <button data-action="remind-project" title="Project reminder">🔔</button>
      </div>
    </div>
    ${baselineBox(p)}
    <div class="quick-note">
      <textarea id="note-input" placeholder="Add a note to this project… (Enter to save, Shift+Enter for a new line)"></textarea>
      <select id="note-task" title="Attach note to a task (optional)">
        <option value="">Whole project</option>
        ${p.tasks.filter((t) => t.status !== 'done').map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}
      </select>
      <button class="primary" data-action="save-note">Add note</button>
    </div>
    <div class="grid two">
      <div class="card">
        <div class="list-tools">
          <h2 style="margin:0">Tasks <span class="muted small">${done}/${p.tasks.length} done</span></h2>
          <label class="small muted row"><input type="checkbox" data-action="toggle-hide-done" ${hideDone ? 'checked' : ''}> Hide completed</label>
        </div>
        ${shown.length ? `<ul class="tasks">${shown.map((t) => taskRow(t, p, hideDone)).join('')}</ul>` : '<div class="empty">No tasks yet — add one below.</div>'}
        <div class="add-task">
          <input type="text" id="add-task-input" placeholder="Add a task… (Enter)   e.g. Send report !high @fri" autocomplete="off">
          <div class="small muted" style="margin-top:4px">Shortcuts: <code>!low</code> <code>!high</code> <code>!crit</code> · <code>@today</code> <code>@tomorrow</code> <code>@mon</code> <code>@2026-10-31</code></div>
        </div>
      </div>
      <div class="card">
        <div class="list-tools">
          <h2 style="margin:0">Timeline</h2>
          <label class="small muted row"><input type="checkbox" data-action="toggle-notes-only" ${notesOnly ? 'checked' : ''}> Notes only</label>
        </div>
        ${items.length ? `<ul class="timeline">${items.map(timelineItem).join('')}</ul>` : '<div class="empty">Nothing yet.</div>'}
      </div>
    </div>`;

  $('#note-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveProjectNote(); }
  });
  $('#add-task-input').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = parseQuick(e.target.value);
    if (!q.title) return;
    await api.post('/tasks', { project_id: p.id, ...q });
    await refresh();
    $('#add-task-input')?.focus();
  });
}

async function saveProjectNote() {
  const input = $('#note-input');
  const body = input.value.trim();
  if (!body) return;
  await api.post('/notes', { project_id: state.project.id, task_id: $('#note-task').value || null, body });
  input.value = '';
  toast('Note added');
  await refresh();
  $('#note-input')?.focus();
}

// ======================================================================
// Kanban
// ======================================================================

async function renderKanban() {
  const pid = store.get('kanbanProject', '');
  const withSubs = store.get('kanbanSubs', false);
  const qs = new URLSearchParams();
  if (pid) qs.set('project_id', pid);
  if (!withSubs) qs.set('top_level', '1');
  const tasks = await api.get(`/tasks?${qs}`);
  const cols = Object.keys(STATUS);
  const doneLimit = 30;
  const byStatus = Object.fromEntries(cols.map((s) => [s, tasks.filter((t) => t.status === s)]));
  byStatus.done.sort((a, b) => new Date(b.completed_at) - new Date(a.completed_at));
  const activeProjects = state.projects.filter((p) => p.status !== 'archived');

  const card = (t) => `<div class="kcard p${t.priority} ${t.status === 'done' ? 'done' : ''}" draggable="true" data-id="${t.id}">
      <div class="small muted">${pid ? '' : esc(t.project_name)}${t.parent_id ? ' · subtask' : ''}</div>
      <div class="ktitle"><input type="checkbox" data-action="toggle-task" data-id="${t.id}" data-subs="${t.subtask_count - t.subtask_done}" ${t.status === 'done' ? 'checked' : ''}>
        <span data-action="open-task" data-id="${t.id}" style="cursor:pointer">${esc(t.title)}</span></div>
      <div class="kmeta">${prioPill(t.priority)} ${dueChip(t)}
        ${t.subtask_count ? `<span class="small muted">☑ ${t.subtask_done}/${t.subtask_count}</span>` : ''}
        ${t.next_reminder ? '<span class="small">🔔</span>' : ''}${t.note_count ? `<span class="small muted">📝 ${t.note_count}</span>` : ''}</div>
      ${t.subtask_count ? `<div class="progress"><div style="width:${Math.round((t.subtask_done / t.subtask_count) * 100)}%"></div></div>` : ''}
    </div>`;

  main().innerHTML = `
    <div class="kanban-tools">
      <h1 style="margin:0">Kanban</h1><div class="spacer"></div>
      <select id="kanban-project"><option value="">All projects</option>
        ${activeProjects.map((p) => `<option value="${p.id}" ${String(p.id) === String(pid) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <label class="small muted row"><input type="checkbox" id="kanban-subs" ${withSubs ? 'checked' : ''}> Include subtasks</label>
    </div>
    <div class="kanban">
      ${cols.map((s) => {
        const list = s === 'done' ? byStatus.done.slice(0, doneLimit) : byStatus[s];
        return `<div class="column" data-status="${s}">
          <h3>${STATUS[s]} <span class="muted small">${byStatus[s].length}</span></h3>
          ${list.map(card).join('')}
          ${s === 'done' && byStatus.done.length > doneLimit ? `<div class="small muted">Showing latest ${doneLimit} completed</div>` : ''}
          ${s === 'todo' ? `<input type="text" id="kanban-add" placeholder="+ Add task${pid ? '' : ' (pick a project above)'}…" ${pid ? '' : 'disabled'}>` : ''}
        </div>`;
      }).join('')}
    </div>`;

  $('#kanban-project').addEventListener('change', (e) => { store.set('kanbanProject', e.target.value); renderKanban(); });
  $('#kanban-subs').addEventListener('change', (e) => { store.set('kanbanSubs', e.target.checked); renderKanban(); });
  $('#kanban-add')?.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = parseQuick(e.target.value);
    if (!q.title) return;
    await api.post('/tasks', { project_id: pid, ...q });
    await refresh();
    $('#kanban-add')?.focus();
  });

  // Drag & drop between columns changes status.
  $$('.kcard').forEach((c) => {
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  $$('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      const t = tasks.find((x) => String(x.id) === id);
      if (!t || t.status === col.dataset.status) return;
      await setTaskStatus(t.id, col.dataset.status, t.subtask_count - t.subtask_done);
    });
  });
}

// ======================================================================
// Activity log, backups, search
// ======================================================================

async function renderLog() {
  const pid = store.get('logProject', '');
  const rows = await api.get(`/audit?limit=500${pid ? `&project_id=${pid}` : ''}`);
  const names = Object.fromEntries(state.projects.map((p) => [p.id, p.name]));
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">Activity log</h1><div class="spacer"></div>
      <select id="log-project"><option value="">All projects</option>
        ${state.projects.map((p) => `<option value="${p.id}" ${String(p.id) === String(pid) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <p class="muted small">Every insert, change and delete is recorded by the database itself — including edits made in pgAdmin, DBeaver or Access. Showing the latest 500.</p>
    <div class="card" style="overflow-x:auto"><table class="log">
      <thead><tr><th>When</th><th>Project</th><th>What</th><th>DB user</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="nowrap">${esc(fmtDateTime(r.changed_at))}</td>
        <td>${r.project_id ? (names[r.project_id] ? `<a href="#/project/${r.project_id}">${esc(names[r.project_id])}</a>` : `#${r.project_id}`) : ''}</td>
        <td>${esc(r.summary)}</td><td class="muted">${esc(r.db_user)}</td></tr>`).join('')}</tbody>
    </table>${rows.length ? '' : '<div class="empty">No activity yet.</div>'}</div>`;
  $('#log-project').addEventListener('change', (e) => { store.set('logProject', e.target.value); renderLog(); });
}

async function renderBackups() {
  const list = await api.get('/backups');
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">Backups</h1><div class="spacer"></div>
      <button class="primary" data-action="backup-now">💾 Back up now</button></div>
    <div class="card stack">
      <p>Backups run automatically (at start-up and on the interval set in <code>.env</code>). Each backup is a
        <b>JSON export</b> of every table, plus a native <b>pg_dump</b> file when <code>pg_dump</code> is available.</p>
      <p class="small muted">Restore a JSON backup with <code>npm run restore -- backups/json/&lt;file&gt;.json</code>
        (a safety backup of the current data is taken first). A <code>.dump</code> file can be restored from pgAdmin (Restore…) or with <code>pg_restore</code>.</p>
    </div>
    <div class="card" style="margin-top:16px"><table class="log">
      <thead><tr><th>Created</th><th>Type</th><th>File</th><th>Size</th></tr></thead>
      <tbody>${list.map((b) => `<tr><td class="nowrap">${esc(fmtDateTime(b.created_at))}</td><td>${b.kind}</td>
        <td>${esc(b.file)}</td><td>${size(b.size)}</td></tr>`).join('')}</tbody></table>
      ${list.length ? '' : '<div class="empty">No backups yet.</div>'}</div>`;
}

async function renderSearch(q) {
  $('#search').value = q;
  const r = await api.get(`/search?q=${encodeURIComponent(q)}`);
  main().innerHTML = `<h1>Search: “${esc(q)}”</h1>
    <div class="grid dash">
      <div class="card"><h2>Projects</h2>${r.projects.length ? `<ul class="mini">${r.projects.map((p) => `<li><a href="#/project/${p.id}">${esc(p.name)}</a> <span class="small muted">${PSTATUS[p.status]}</span></li>`).join('')}</ul>` : '<div class="empty">None</div>'}</div>
      <div class="card"><h2>Tasks</h2>${r.tasks.length ? `<ul class="mini">${r.tasks.map(miniTask).join('')}</ul>` : '<div class="empty">None</div>'}</div>
      <div class="card"><h2>Notes</h2>${r.notes.length ? `<ul class="mini">${r.notes.map((n) => `<li style="display:block">
        <div class="small muted">${esc(fmtDateTime(n.created_at))} · <a href="#/project/${n.project_id}">${esc(n.project_name)}</a></div>
        <div class="pre">${esc(n.body)}</div></li>`).join('')}</ul>` : '<div class="empty">None</div>'}</div>
    </div>`;
}

// ======================================================================
// Modals
// ======================================================================

const modal = () => $('#modal');
function openModal(html) {
  $('#modal-body').innerHTML = html;
  if (!modal().open) modal().showModal();
}
function closeModal() { modal().close(); }
modal().addEventListener('close', () => { if (state.modalDirty) { state.modalDirty = false; refresh(); } });

function projectForm(p = {}) {
  const isNew = !p.id;
  openModal(`
    <div class="modal-head"><h2 style="margin:0">${isNew ? 'New project' : 'Edit project'}</h2>
      <button class="icon" data-action="close-modal">✕</button></div>
    <form id="project-form" class="form-grid">
      <label class="f full">Name<input type="text" name="name" required value="${esc(p.name)}"></label>
      <label class="f full">Description / goal<textarea name="description" rows="3">${esc(p.description)}</textarea></label>
      <label class="f">Priority<select name="priority">${options(PRIORITY, p.priority || 2)}</select></label>
      <label class="f">Start date<input type="date" name="start_date" value="${esc(p.start_date || (isNew ? new Date().toLocaleDateString('sv') : ''))}"></label>
      <label class="f">Due<input type="datetime-local" name="due_at" value="${toLocalInput(p.due_at)}"></label>
      ${isNew ? `
        <label class="f full">Baseline tasks — one per line (you can add more at any time)
          <textarea name="baseline_tasks" rows="5" placeholder="Gather requirements&#10;Draft proposal&#10;Review with manager"></textarea></label>
        <label class="f full">First note (optional)<textarea name="initial_note" rows="2"></textarea></label>` : `
        <label class="f">Status<select name="status">${options(PSTATUS, p.status)}</select></label>`}
      <div class="full row">
        ${isNew ? '' : '<button type="button" class="danger" data-action="delete-project">Delete project…</button>'}
        <div class="spacer"></div>
        <button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">${isNew ? 'Create project' : 'Save'}</button>
      </div>
    </form>`);
  $('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.due_at = fromLocalInput(f.due_at);
    f.priority = Number(f.priority);
    if (isNew) {
      f.baseline_tasks = f.baseline_tasks.split('\n');
      const created = await api.post('/projects', f);
      closeModal();
      toast('Project created — baseline set');
      location.hash = `#/project/${created.id}`;
      await loadProjects();
    } else {
      await api.patch(`/projects/${p.id}`, f);
      closeModal();
      toast('Project saved');
      await refresh();
    }
  });
}

async function taskModal(id) {
  const t = await api.get(`/tasks/${id}`);
  const p = state.projects.find((x) => x.id === t.project_id);
  const baselineText = t.is_baseline ? '<span class="badge baseline">Baseline task</span>'
    : (p && p.baseline_set_at ? '<span class="badge added">Added after baseline</span>' : '');
  openModal(`
    <div class="modal-head">
      <div class="small muted">${esc(t.project_name)}${t.parent_id ? ' · subtask' : ''} ${baselineText}</div>
      <div class="row"><span class="saved-flag" id="saved-flag">✓ Saved</span><button class="icon" data-action="close-modal">✕</button></div>
    </div>
    <div class="form-grid" id="task-form" data-id="${t.id}">
      <label class="f full">Title<input type="text" name="title" value="${esc(t.title)}"></label>
      <label class="f full">Description<textarea name="description" rows="3">${esc(t.description)}</textarea></label>
      <label class="f">Status<select name="status">${options(STATUS, t.status)}</select></label>
      <label class="f">Priority<select name="priority">${options(PRIORITY, t.priority)}</select></label>
      <label class="f">Due<input type="datetime-local" name="due_at" value="${toLocalInput(t.due_at)}"></label>
    </div>
    <div class="small muted" style="margin-top:8px">Created ${esc(fmtDateTime(t.created_at))} · Updated ${esc(fmtDateTime(t.updated_at))}
      ${t.completed_at ? ` · Completed ${esc(fmtDateTime(t.completed_at))}` : ''}</div>

    <div class="section">
      <h3>Subtasks <span class="muted small">${t.subtasks.filter((s) => s.status === 'done').length}/${t.subtasks.length}</span></h3>
      <ul class="tasks">${t.subtasks.map((s) => `<li class="task ${s.status === 'done' ? 'done' : ''}"><div class="task-line">
        <input type="checkbox" data-action="toggle-task" data-id="${s.id}" data-subs="${s.subtask_count - s.subtask_done}" ${s.status === 'done' ? 'checked' : ''}>
        <span class="task-title" data-action="open-task" data-id="${s.id}">${esc(s.title)}</span>
        ${statusChip(s.status)} ${s.priority !== 2 ? prioPill(s.priority) : ''} ${dueChip(s)}</div></li>`).join('')}</ul>
      <input type="text" id="modal-add-sub" placeholder="+ Add subtask… (Enter)" autocomplete="off">
    </div>

    <div class="section">
      <h3>Reminders</h3>
      <ul class="mini">${t.reminders.filter((r) => r.status === 'pending').map((r) => `<li>
        <span class="t">⏰ ${esc(fmtDateTime(r.remind_at))} <span class="muted small">(${fmtRelative(r.remind_at)})</span> ${r.message ? `— ${esc(r.message)}` : ''}</span>
        <button class="icon" data-action="delete-reminder" data-id="${r.id}" title="Delete">✕</button></li>`).join('') || '<li class="empty">None set</li>'}</ul>
      <button data-action="remind-task" data-id="${t.id}" style="margin-top:6px">🔔 Add reminder</button>
    </div>

    <div class="section">
      <h3>Notes</h3>
      <div class="quick-note"><textarea id="modal-note" placeholder="Add a note to this task… (Enter to save)"></textarea>
        <button class="primary" data-action="save-task-note" data-id="${t.id}">Add</button></div>
      <ul class="timeline">${t.notes.map((n) => timelineItem({ type: 'note', ...n })).join('')}</ul>
    </div>

    <div class="section">
      <details><summary class="muted">History (${t.history.length})</summary>
        <ul class="timeline" style="margin-top:8px">${t.history.map((e) => timelineItem({ type: 'event', ...e })).join('')}</ul>
      </details>
    </div>
    <div class="section row">
      <button class="danger" data-action="delete-task" data-id="${t.id}">Delete task</button>
      <div class="spacer"></div>
      ${t.parent_id ? `<button data-action="open-task" data-id="${t.parent_id}">↑ Parent task</button>` : ''}
      <button class="primary" data-action="close-modal">Done</button>
    </div>`);

  // Auto-save each field as it changes.
  $$('#task-form [name]').forEach((el) => el.addEventListener('change', async () => {
    let value = el.value;
    if (el.name === 'due_at') value = fromLocalInput(value);
    if (el.name === 'priority') value = Number(value);
    if (el.name === 'title' && !value.trim()) { el.value = t.title; return; }
    await api.patch(`/tasks/${t.id}`, { [el.name]: value });
    state.modalDirty = true;
    const flag = $('#saved-flag');
    flag.classList.add('show');
    setTimeout(() => flag.classList.remove('show'), 1200);
  }));
  $('#modal-add-sub').addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = parseQuick(e.target.value);
    if (!q.title) return;
    await api.post('/tasks', { parent_id: t.id, ...q });
    state.modalDirty = true;
    await taskModal(t.id);
    $('#modal-add-sub').focus();
  });
  $('#modal-note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveTaskNote(t.id); }
  });
}

async function saveTaskNote(taskId) {
  const body = $('#modal-note').value.trim();
  if (!body) return;
  await api.post('/notes', { task_id: taskId, body });
  state.modalDirty = true;
  await taskModal(taskId);
  $('#modal-note').focus();
}

// Reminder dialog: quick buttons or a custom time.
function reminderDialog({ taskId, projectId, label, returnToTask }) {
  const quick = [
    ['In 15 min', () => new Date(Date.now() + 15 * 60000)],
    ['In 1 hour', () => new Date(Date.now() + 60 * 60000)],
    ['In 3 hours', () => new Date(Date.now() + 180 * 60000)],
    ['Today 16:00', () => at(0, 16)],
    ['Next workday 9:00', nextWorkdayAt9],
    ['In 1 week', () => at(7, 9)],
  ];
  openModal(`
    <div class="modal-head"><h2 style="margin:0">🔔 Remind me</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="muted">${esc(label)}</p>
    <label class="f">Message (optional)<input type="text" id="rem-msg" placeholder="${esc(label)}"></label>
    <div class="quick-times" style="margin:12px 0">${quick.map(([l], i) => `<button data-quick="${i}">${l}</button>`).join('')}</div>
    <div class="row"><label class="f" style="flex:1">Custom time<input type="datetime-local" id="rem-at" value="${toLocalInput(new Date(Date.now() + 3600000))}"></label>
      <button class="primary" id="rem-save" style="align-self:flex-end">Set reminder</button></div>`);
  const save = async (when) => {
    if (!when || Number.isNaN(when.getTime())) return toast('Pick a valid time', 'error');
    await api.post('/reminders', { task_id: taskId || null, project_id: projectId || null, remind_at: when.toISOString(), message: $('#rem-msg').value.trim() || null });
    toast(`Reminder set for ${fmtDateTime(when)}`);
    state.modalDirty = true;
    if (returnToTask) await taskModal(taskId); else closeModal();
  };
  $$('[data-quick]').forEach((b) => b.addEventListener('click', () => save(quick[b.dataset.quick][1]())));
  $('#rem-save').addEventListener('click', () => save(new Date($('#rem-at').value)));
  ensureNotificationPermission();
}

function quickNoteDialog() {
  const active = state.projects.filter((p) => p.status !== 'archived');
  if (!active.length) { toast('Create a project first'); return projectForm(); }
  const current = state.view === 'project' ? Number(state.projectId) : store.get('lastNoteProject');
  openModal(`
    <div class="modal-head"><h2 style="margin:0">📝 Quick note</h2><button class="icon" data-action="close-modal">✕</button></div>
    <label class="f">Project<select id="qn-project">${active.map((p) => `<option value="${p.id}" ${p.id === current ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <label class="f" style="margin-top:10px">Note — time-stamped automatically<textarea id="qn-body" rows="5" placeholder="What happened? (Ctrl+Enter to save)"></textarea></label>
    <div class="row" style="margin-top:12px"><div class="spacer"></div><button data-action="close-modal">Cancel</button>
      <button class="primary" id="qn-save">Save note</button></div>`);
  const save = async () => {
    const body = $('#qn-body').value.trim();
    if (!body) return;
    const projectId = Number($('#qn-project').value);
    await api.post('/notes', { project_id: projectId, body });
    store.set('lastNoteProject', projectId);
    toast('Note saved');
    closeModal();
    await refresh();
  };
  $('#qn-save').addEventListener('click', save);
  $('#qn-body').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
  $('#qn-body').focus();
}

// ======================================================================
// Actions (event delegation)
// ======================================================================

async function setTaskStatus(id, status, openSubtasks = 0) {
  let cascade = false;
  if (status === 'done' && openSubtasks > 0) {
    cascade = confirm(`This task has ${openSubtasks} open subtask(s). Mark them done too?`);
  }
  await api.patch(`/tasks/${id}`, { status, cascade });
  if (modal().open) { state.modalDirty = true; await taskModal($('#task-form')?.dataset.id || id); } else await refresh();
}

const actions = {
  'toggle-sidebar': () => document.body.classList.toggle('sidebar-open'),
  'new-project': () => projectForm(),
  'edit-project': () => projectForm(state.project),
  'close-modal': () => closeModal(),
  'quick-note': () => quickNoteDialog(),
  'save-note': () => saveProjectNote(),
  'save-task-note': (el) => saveTaskNote(el.dataset.id),
  'open-task': (el) => taskModal(el.dataset.id),
  'toggle-task': (el) => setTaskStatus(el.dataset.id, el.checked ? 'done' : 'todo', Number(el.dataset.subs || 0)),
  'toggle-hide-done': (el) => { store.set('hideDone', el.checked); route(); },
  'toggle-notes-only': (el) => { store.set('notesOnly', el.checked); route(); },
  'project-field': async (el) => {
    await api.patch(`/projects/${state.project.id}`, { [el.dataset.field]: el.value });
    toast('Project updated');
    await refresh();
  },
  'set-baseline': async () => {
    const msg = state.project.baseline_set_at
      ? 'Re-baseline? All current tasks and the current due date become the new baseline.'
      : 'Set the baseline? All current tasks and the due date are frozen as the original plan.';
    if (!confirm(msg)) return;
    await api.post(`/projects/${state.project.id}/baseline`);
    toast('Baseline set');
    await refresh();
  },
  'delete-project': async () => {
    const p = state.project;
    const typed = prompt(`This permanently deletes "${p.name}" with all its tasks and notes (the activity log keeps a record).\nConsider setting the status to Archived instead.\n\nType the project name to confirm:`);
    if (typed !== p.name) return;
    await api.del(`/projects/${p.id}`);
    closeModal();
    toast('Project deleted');
    location.hash = '#/dashboard';
    await loadProjects();
  },
  'add-subtask': (el) => {
    const slot = $(`[data-slot="${el.dataset.id}"]`);
    if (slot.firstChild) { slot.firstChild.focus(); return; }
    slot.innerHTML = '<input type="text" placeholder="Subtask title… (Enter to add, Esc to cancel)">';
    const input = slot.firstChild;
    input.focus();
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { slot.innerHTML = ''; return; }
      if (e.key !== 'Enter') return;
      const q = parseQuick(input.value);
      if (!q.title) return;
      await api.post('/tasks', { parent_id: el.dataset.id, ...q });
      await refresh();
      $(`[data-action="add-subtask"][data-id="${el.dataset.id}"]`)?.click();
    });
  },
  'remind-task': (el) => {
    const inModal = modal().open;
    const title = inModal ? $('#task-form [name=title]').value : state.project?.tasks.find((t) => String(t.id) === el.dataset.id)?.title;
    reminderDialog({ taskId: el.dataset.id, label: title || 'Task', returnToTask: inModal });
  },
  'remind-project': () => reminderDialog({ projectId: state.project.id, label: state.project.name }),
  'delete-task': async (el) => {
    if (!confirm('Delete this task and its subtasks? (The activity log keeps a record.)')) return;
    await api.del(`/tasks/${el.dataset.id}`);
    state.modalDirty = true;
    closeModal();
  },
  'delete-note': async (el) => {
    if (!confirm('Delete this note? (The activity log keeps a copy.)')) return;
    await api.del(`/notes/${el.dataset.id}`);
    if (modal().open) { state.modalDirty = true; await taskModal($('#task-form').dataset.id); } else await refresh();
  },
  'delete-reminder': async (el) => {
    await api.del(`/reminders/${el.dataset.id}`);
    if (modal().open) { state.modalDirty = true; await taskModal($('#task-form').dataset.id); } else await refresh();
  },
  'backup-now': async (el) => {
    el.disabled = true;
    try {
      const r = await api.post('/backups');
      toast(r.pgdump ? 'Backup done (JSON + pg_dump)' : 'Backup done (JSON)');
      await renderBackups();
    } finally { el.disabled = false; }
  },
  'enable-notifications': () => ensureNotificationPermission(true),
};

async function runAction(el, e) {
  const fn = actions[el.dataset.action];
  if (!fn) return;
  try { await fn(el, e); } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT' || el.type === 'checkbox') return;
  e.preventDefault();
  runAction(el, e);
});
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-action]');
  if (el && (el.tagName === 'SELECT' || el.type === 'checkbox')) runAction(el, e);
});

// Keyboard shortcuts: N = quick note, T = add task, / = search
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || modal().open) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  if (e.key === 'n') { e.preventDefault(); quickNoteDialog(); }
  if (e.key === 't' && $('#add-task-input')) { e.preventDefault(); $('#add-task-input').focus(); }
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
});

$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) location.hash = `#/search/${encodeURIComponent(e.target.value.trim())}`;
});
$('#show-archived').addEventListener('change', loadProjects);

// ======================================================================
// Reminders & alerts
// ======================================================================

const popups = new Map(); // key -> element
let seenDue = store.get('seenDue', {});

function ensureNotificationPermission(explicit) {
  if (!('Notification' in window)) { if (explicit) toast('This browser does not support desktop notifications', 'error'); return; }
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(updateNotifyButton);
  } else if (explicit && Notification.permission === 'denied') {
    toast('Desktop alerts are blocked — allow notifications for this site in the browser settings', 'error');
  }
}
function updateNotifyButton() {
  $('#notify-btn').hidden = !('Notification' in window) || Notification.permission === 'granted';
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.25].forEach((offset) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + offset);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.2);
      o.start(ctx.currentTime + offset); o.stop(ctx.currentTime + offset + 0.22);
    });
  } catch { /* audio unavailable */ }
}

function desktopNotify(key, title, body, onClick) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(title, { body, tag: key, requireInteraction: true });
  n.onclick = () => { window.focus(); onClick?.(); n.close(); };
}

function showPopup(key, { title, body, overdue, buttons }) {
  if (popups.has(key)) return false;
  const el = document.createElement('div');
  el.className = `popup ${overdue ? 'overdue' : ''}`;
  el.innerHTML = `<div class="ptitle">${esc(title)}</div><div class="small pre">${esc(body)}</div>
    <div class="actions">${buttons.map((b, i) => `<button data-i="${i}" class="${b.primary ? 'primary' : ''}">${esc(b.label)}</button>`).join('')}</div>`;
  el.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', async () => {
    const b = buttons[btn.dataset.i];
    try {
      await b.run();
      if (!b.keep) closePopup(key); // "Open" leaves the popup up until it's dealt with
    } catch (err) { toast(err.message, 'error'); }
  }));
  $('#popups').append(el);
  popups.set(key, el);
  return true;
}
function closePopup(key) {
  popups.get(key)?.remove();
  popups.delete(key);
}

async function pollAlerts() {
  let a;
  try { a = await api.get('/alerts'); } catch { return; }
  const liveKeys = new Set();

  for (const r of a.reminders) {
    const key = `rem-${r.id}-${r.remind_at}`;
    liveKeys.add(key);
    const title = `🔔 ${r.message || r.task_title || r.project_name || 'Reminder'}`;
    const body = [r.message && r.task_title ? r.task_title : '', r.project_name, `Set for ${fmtDateTime(r.remind_at)}`]
      .filter(Boolean).join('\n');
    const open = () => (r.task_id ? taskModal(r.task_id) : (location.hash = `#/project/${r.project_id}`));
    const snooze = (minutes) => async () => { await api.patch(`/reminders/${r.id}`, { action: 'snooze', minutes }); refresh(); };
    const isNew = showPopup(key, {
      title, body,
      buttons: [
        { label: 'Snooze 10m', run: snooze(10) },
        { label: '1h', run: snooze(60) },
        { label: 'Tomorrow', run: async () => { await api.patch(`/reminders/${r.id}`, { action: 'snooze', minutes: Math.round((nextWorkdayAt9() - Date.now()) / 60000) }); refresh(); } },
        { label: 'Open', keep: true, run: open },
        { label: 'Dismiss', primary: true, run: async () => { await api.patch(`/reminders/${r.id}`, { action: 'dismiss' }); refresh(); } },
      ],
    });
    if (isNew) { beep(); desktopNotify(key, title, body, open); }
  }

  // Due-date alerts: pop up once per task/due time when overdue or due within 15 minutes.
  const soon = Date.now() + 15 * 60000;
  for (const t of a.due_tasks) {
    const key = `due-${t.id}-${t.due_at}`;
    if (seenDue[key] || new Date(t.due_at) > soon) continue;
    liveKeys.add(key);
    const overdue = new Date(t.due_at) < new Date();
    const title = `${overdue ? '⚠ Overdue' : '⏳ Due soon'}: ${t.title}`;
    const body = `${t.project_name}\nDue ${fmtDateTime(t.due_at)} (${fmtRelative(t.due_at)})`;
    const markSeen = () => { seenDue[key] = Date.now(); store.set('seenDue', seenDue); };
    const isNew = showPopup(key, {
      title, body, overdue,
      buttons: [
        { label: 'Mark done', run: async () => { markSeen(); await setTaskStatus(t.id, 'done', t.subtask_count - t.subtask_done); } },
        { label: 'Remind in 1h', run: async () => { markSeen(); await api.post('/reminders', { task_id: t.id, remind_at: new Date(Date.now() + 3600000).toISOString() }); refresh(); } },
        { label: 'Open', keep: true, run: () => taskModal(t.id) },
        { label: 'OK', primary: true, run: async () => markSeen() },
      ],
    });
    if (isNew) { beep(); desktopNotify(key, title, body, () => taskModal(t.id)); }
  }

  // Drop popups that are no longer relevant (dismissed/snoozed elsewhere, task completed).
  for (const key of [...popups.keys()]) if (!liveKeys.has(key)) closePopup(key);

  // Prune remembered due alerts older than 30 days.
  const cutoff = Date.now() - 30 * 86400000;
  for (const [k, v] of Object.entries(seenDue)) if (v < cutoff) delete seenDue[k];

  const count = a.due_tasks.filter((t) => new Date(t.due_at) < new Date()).length + a.reminders.length;
  $('#bell-count').hidden = !count;
  $('#bell-count').textContent = count;
  document.title = count ? `(${count}) Task Manager` : 'Task Manager';
}

// ======================================================================
// Start-up
// ======================================================================

function tickClock() {
  const d = new Date();
  $('#clock').textContent = `${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

window.addEventListener('hashchange', route);
(async function init() {
  tickClock();
  setInterval(tickClock, 15000);
  updateNotifyButton();
  try { await loadProjects(); } catch (err) { toast(err.message, 'error'); }
  await route();
  pollAlerts();
  setInterval(pollAlerts, 30000);
})();
