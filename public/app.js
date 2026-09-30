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
    headers: { 'X-Requested-With': 'TaskManager', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
// Local calendar date as YYYY-MM-DD (the value format of <input type="date">).
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDateInput = (iso) => (iso ? dateKey(new Date(iso)) : '');
const fmtShortDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
// Whole local days from today to the due date (negative = overdue).
function dayDiff(iso) {
  const due = new Date(iso);
  const now = new Date();
  return Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate())
    - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}
function dueLabel(iso) {
  const n = dayDiff(iso);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return n < 0 ? `${-n}d overdue` : `in ${n}d`;
}

// <input type="datetime-local"> <-> ISO (used for reminder times)
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

// Quick-add syntax:  "Call supplier !high @tomorrow *weekly"
//   priority: !low !med !high !crit (or !1..!4)
//   due date: @today @tomorrow @mon..@sun @2026-10-03
//   repeats:  *daily *weekdays *weekly *fortnightly *monthly *quarterly *yearly
function parseQuick(text) {
  let priority; let due; let recurrence;
  const repeatMap = { daily: 'daily', weekdays: 'weekdays', weekly: 'weekly', fortnightly: 'fortnightly', biweekly: 'fortnightly',
    monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', annually: 'yearly' };
  const prioMap = { low: 1, l: 1, 1: 1, med: 2, medium: 2, m: 2, 2: 2, high: 3, h: 3, 3: 3, crit: 4, critical: 4, c: 4, 4: 4 };
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const title = text.replace(/(^|\s)!(\w+)/g, (m, sp, w) => {
    const p = prioMap[w.toLowerCase()];
    if (!p) return m;
    priority = p; return sp;
  }).replace(/(^|\s)\*(\w+)/g, (m, sp, w) => {
    const r = repeatMap[w.toLowerCase()];
    if (!r) return m;
    recurrence = r; return sp;
  }).replace(/(^|\s)@([\w:-]+)/g, (m, sp, w) => {
    const lw = w.toLowerCase();
    let d;
    if (lw === 'today') d = at(0, 12);
    else if (lw === 'tomorrow' || lw === 'tmr') d = at(1, 12);
    else if (days.includes(lw.slice(0, 3)) && /^[a-z]+$/.test(lw)) {
      const target = days.indexOf(lw.slice(0, 3));
      let add = (target - new Date().getDay() + 7) % 7;
      if (add === 0) add = 7;
      d = at(add, 12);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(lw)) {
      d = new Date(`${w}T12:00`);
    }
    if (!d || Number.isNaN(d.getTime())) return m;
    due = dateKey(d); return sp;
  }).replace(/\s+/g, ' ').trim();
  return { title, priority, due_at: due, recurrence };
}

// ---- small renderers ---------------------------------------------------

const prioPill = (p) => `<span class="pill prio-${p}" title="Priority">${PRIORITY[p]}</span>`;

function dueChip(t) {
  if (!t.due_at) return '';
  const n = dayDiff(t.due_at);
  let cls = '';
  if (t.status !== 'done') {
    if (n < 0) cls = 'overdue';
    else if (n <= 1) cls = 'soon';
  }
  return `<span class="chip ${cls}" title="Due ${esc(fmtDate(t.due_at))}">📅 ${esc(fmtShortDate(t.due_at))}${cls ? ` (${dueLabel(t.due_at)})` : ''}</span>`;
}
function statusChip(s) {
  return s === 'in_progress' || s === 'blocked' ? `<span class="pill status-${s}">${STATUS[s]}</span>` : '';
}
const options = (map, selected) => Object.entries(map)
  .map(([v, l]) => `<option value="${v}" ${String(v) === String(selected ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('');

const REPEAT = { '': 'Never', daily: 'Daily', weekdays: 'Every weekday', weekly: 'Weekly', fortnightly: 'Every 2 weeks',
  monthly: 'Monthly', quarterly: 'Quarterly', yearly: 'Yearly' };
const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));
function waitingChip(t) {
  if (!t.waiting_on) return '';
  const d = t.waiting_since ? daysSince(t.waiting_since) : null;
  return `<span class="chip waiting" title="Waiting on ${esc(t.waiting_on)}${t.waiting_since ? ` since ${esc(fmtDate(t.waiting_since))}` : ''}">⏳ ${esc(t.waiting_on)}${d !== null ? ` · ${d}d` : ''}</span>`;
}
const ownerChip = (t) => (t.owner ? `<span class="small muted" title="Owner">👤 ${esc(t.owner)}</span>` : '');
const repeatChip = (t) => (t.recurrence ? `<span class="small muted" title="Repeats: ${REPEAT[t.recurrence]}">🔁</span>` : '');
const SHORTCUTS_HELP = 'Shortcuts: <code>!high</code> <code>!crit</code> · <code>@today</code> <code>@fri</code> <code>@2026-10-31</code> · <code>*weekly</code> <code>*monthly</code>';

// Web links and Windows paths in text become clickable. Paths (C:\… or \\server\…;
// wrap in "quotes" if they contain spaces) open in File Explorer via the server.
const LINK_RE = /(https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]]|mailto:[^\s<>"']+|onenote:[^\s<>"']+|"(?:[A-Za-z]:\\|\\\\)[^"\r\n]+"|(?:[A-Za-z]:\\|\\\\)[^\s<>"']+)/g;
function linkHtml(raw) {
  if (/^(https?|mailto|onenote):/i.test(raw)) {
    return `<a href="${esc(raw)}" target="_blank" rel="noopener noreferrer">${esc(raw)}</a>`;
  }
  const p = raw.replace(/^"|"$/g, '');
  return `<a href="#" class="path-link" data-action="open-path" data-path="${esc(p)}" title="Show in File Explorer">📁 ${esc(p)}</a>`;
}
function linkify(text) {
  const str = String(text ?? '');
  let out = '';
  let last = 0;
  for (const m of str.matchAll(LINK_RE)) {
    out += esc(str.slice(last, m.index)) + linkHtml(m[0]);
    last = m.index + m[0].length;
  }
  return out + esc(str.slice(last));
}
// Links found in an editable description, shown under the text box.
function linkList(text) {
  const found = [...String(text ?? '').matchAll(LINK_RE)].map((m) => linkHtml(m[0]));
  return found.length ? `<div class="link-list small">🔗 ${found.join(' · ')}</div>` : '';
}

// ======================================================================
// State, routing & sidebar
// ======================================================================

const state = { projects: [], view: null, project: null, settings: { currency: '£' }, areas: [] };
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
  const nav = state.view === 'idea' ? 'ideas' : state.view;
  $$('#sidebar nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
}

async function route() {
  document.body.classList.remove('sidebar-open');
  const [view = 'dashboard', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  state.view = view;
  state.projectId = view === 'project' ? rest[0] : null;
  renderSidebar();
  try {
    if (view === 'project') await renderProject(rest[0], rest[1]);
    else if (view === 'tasks') await renderTasks();
    else if (view === 'kanban') await renderKanban();
    else if (view === 'ideas') await renderIdeas();
    else if (view === 'idea') await renderIdea(rest[0]);
    else if (view === 'settings') await renderSettings();
    else if (view === 'report') await renderReport(rest[0]);
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

// "🧭 Phase 2/3: Roll-out · ends 12 Dec" for projects split into phases.
function phaseLine(p) {
  if (!p.phase_count) return '';
  if (!p.current_phase) return `🧭 All ${p.phase_count} phases complete`;
  const ph = p.current_phase;
  const late = ph.due_at && p.status !== 'completed' && dayDiff(ph.due_at) < 0;
  return `🧭 Phase ${ph.position}/${p.phase_count}: ${esc(ph.name)}${ph.due_at
    ? ` · <span class="${late ? 'status-blocked' : ''}">${late ? 'was due' : 'ends'} ${esc(fmtShortDate(ph.due_at))}</span>` : ''}`;
}

function miniTask(t) {
  return `<li class="${t.status === 'done' ? 'done' : ''}">
    <input type="checkbox" data-action="toggle-task" data-id="${t.id}" data-subs="${t.subtask_count - t.subtask_done}" ${t.status === 'done' ? 'checked' : ''}>
    <span class="t" data-action="open-task" data-id="${t.id}">${esc(t.title)}</span>
    ${t.project_id ? `<a class="small" href="#/project/${t.project_id}">${esc(t.project_name)}</a>` : '<a class="small muted" href="#/tasks">✅ Tasks</a>'}
    ${prioPill(t.priority)} ${dueChip(t)} ${ownerChip(t)} ${waitingChip(t)} ${repeatChip(t)}
  </li>`;
}

// Health of an ongoing project, always shown as icon + word (never colour alone).
function projectHealth(p) {
  if (p.status === 'on_hold') return { key: 'hold', icon: '⏸', label: 'On hold', why: 'Project is on hold' };
  const risk = [];
  if (p.overdue_count) risk.push(`${p.overdue_count} overdue task${p.overdue_count === 1 ? '' : 's'}`);
  if (p.due_at && dayDiff(p.due_at) < 0) risk.push('project is past its due date');
  if (risk.length) return { key: 'risk', icon: '⚠', label: 'At risk', why: risk.join(', ') };
  const watch = [];
  if (p.blocked_count) watch.push(`${p.blocked_count} blocked task${p.blocked_count === 1 ? '' : 's'}`);
  if (p.due_at && dayDiff(p.due_at) <= 7) watch.push(`project due ${dueLabel(p.due_at)}`);
  if (watch.length) return { key: 'watch', icon: '◐', label: 'Watch', why: watch.join(', ') };
  return { key: 'ok', icon: '✓', label: 'On track', why: 'Nothing overdue or blocked' };
}
const HEALTH_ORDER = { risk: 0, watch: 1, ok: 2, hold: 3 };

async function renderDashboard() {
  const [d] = await Promise.all([api.get('/dashboard'), loadProjects()]);
  const ongoing = state.projects
    .filter((p) => p.status === 'active' || p.status === 'on_hold')
    .map((p) => ({ ...p, health: projectHealth(p) }))
    .sort((a, b) => HEALTH_ORDER[a.health.key] - HEALTH_ORDER[b.health.key] || b.priority - a.priority
      || String(a.due_at || '9').localeCompare(String(b.due_at || '9')));
  const active = ongoing.filter((p) => p.status === 'active');
  const onHold = ongoing.length - active.length;
  const atRisk = ongoing.filter((p) => p.health.key === 'risk').length;
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
  const recentlyDone = state.projects.filter((p) => p.status === 'completed' && p.completed_at > monthAgo).length;

  const kpi = (label, value, sub, target) => `<button class="kpi" data-action="dash-jump" data-target="${target}">
      <span class="kpi-label">${label}</span><span class="kpi-value">${value.toLocaleString()}</span>
      <span class="kpi-sub">${sub || '&nbsp;'}</span></button>`;
  const section = (id, title, items, render, empty) => `<div class="card" id="${id}"><h3>${title} <span class="muted small">${items.length}</span></h3>
    ${items.length ? `<ul class="mini">${items.map(render).join('')}</ul>` : `<div class="empty">${empty}</div>`}</div>`;

  const projectRow = (p) => {
    const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
    const issues = [
      p.overdue_count && `<span class="chip overdue">⚠ ${p.overdue_count} overdue</span>`,
      p.blocked_count && `<span class="status-blocked small">⛔ ${p.blocked_count} blocked</span>`,
      p.in_progress_count && `<span class="small muted">▶ ${p.in_progress_count} in progress</span>`,
    ].filter(Boolean).join(' ');
    return `<tr class="clickable" data-action="open-project" data-id="${p.id}">
      <td><b>${esc(p.name)}</b>${phaseLine(p) ? `<div class="small muted">${phaseLine(p)}</div>` : ''}</td>
      <td class="nowrap"><span class="health health-${p.health.key}" title="${esc(p.health.why)}">${p.health.icon} ${p.health.label}</span></td>
      <td>${prioPill(p.priority)}</td>
      <td class="nowrap"><div class="meter" title="${p.done_count} of ${p.task_count} tasks done (${pct}%)"><div style="width:${pct}%"></div></div>
        <span class="small muted num-inline">${p.done_count}/${p.task_count}</span></td>
      <td>${issues || '<span class="small muted">—</span>'}</td>
      <td class="nowrap small">${p.next_due_at ? `${esc(fmtShortDate(p.next_due_at))} <span class="muted">(${dueLabel(p.next_due_at)})</span>` : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${p.due_at ? dueChip({ ...p, status: '' }) : '<span class="small muted">—</span>'}</td>
      <td class="nowrap small"><a href="#/project/${p.id}/charter" title="Open the charter">${p.charter_pct === 100 ? '✓ 100%' : `${p.charter_pct}%`}</a></td>
      <td class="nowrap small muted" title="${esc(fmtDateTime(p.last_activity_at))}">${p.last_activity_at ? fmtRelative(p.last_activity_at) : '—'}</td>
    </tr>`;
  };

  main().innerHTML = `
    <div class="row" style="margin-bottom:14px"><h1 style="margin:0">Dashboard</h1><div class="spacer"></div>
      <span class="muted">${esc(fmtDate(new Date()))}</span>
      <a class="button" href="#/report">📰 Status report</a>
      <a class="button" href="/api/export.xlsx" title="Download everything as an Excel workbook">⬇ Export to Excel</a></div>

    <div class="kpis">
      ${kpi('Active projects', active.length, [onHold && `${onHold} on hold`, recentlyDone && `${recentlyDone} completed this month`].filter(Boolean).join(' · '), 'dash-projects')}
      ${kpi(`${atRisk ? '⚠ ' : ''}Projects at risk`, atRisk, atRisk ? 'overdue work or past due date' : 'none', 'dash-projects')}
      ${kpi(`${d.overdue.length ? '⚠ ' : ''}Overdue tasks`, d.overdue.length, '', 'dash-overdue')}
      ${kpi('Due in the next 7 days', d.today.length + d.week.length, `${d.today.length} today`, 'dash-today')}
      ${kpi('Blocked tasks', d.blocked.length, '', 'dash-blocked')}
      ${kpi('Waiting on others', d.waiting.length, d.waiting.length ? `oldest ${Math.max(...d.waiting.map((t) => daysSince(t.waiting_since || t.updated_at)))}d` : '', 'dash-waiting')}
      ${kpi('Open ideas', d.ideas.open, d.ideas.cost ? `${money(d.ideas.cost)} total cost` : '', 'ideas')}
    </div>

    <h2 class="dash-heading">Projects</h2>
    <div class="card" id="dash-projects" style="overflow-x:auto">
      ${ongoing.length ? `<table class="log dash-projects">
        <thead><tr><th>Project</th><th>Health</th><th>Priority</th><th>Progress</th><th>Open issues</th><th>Next task due</th><th>Project due</th><th title="How much of the project charter is filled in">Charter</th><th>Last activity</th></tr></thead>
        <tbody>${ongoing.map(projectRow).join('')}</tbody></table>
        <div class="small muted" style="margin-top:8px">⚠ At risk = overdue tasks or past its due date · ◐ Watch = blocked tasks or due within 7 days · ✓ On track = neither</div>`
        : '<div class="empty">No ongoing projects. <button class="link" data-action="new-project">Create one</button></div>'}
    </div>

    <h2 class="dash-heading">Tasks &amp; notes</h2>
    <div class="grid dash">
      ${section('dash-overdue', '⚠ Overdue', d.overdue, miniTask, 'Nothing overdue 🎉')}
      ${section('dash-today', '📅 Due today', d.today, miniTask, 'Nothing else due today')}
      ${section('dash-week', '🗓 Next 7 days', d.week, miniTask, 'Nothing due this week')}
      ${section('dash-blocked', '⛔ Blocked', d.blocked, miniTask, 'Nothing blocked')}
      ${section('dash-waiting', '⏳ Waiting on others', d.waiting, miniTask, 'Not waiting on anyone')}
      ${section('dash-high', '🔥 High-priority tasks', d.high_priority, miniTask, 'No open high-priority tasks')}
      ${section('dash-reminders', '🔔 Upcoming reminders', d.reminders, (r) => `<li>
          <span class="t" ${r.task_id ? `data-action="open-task" data-id="${r.task_id}"` : ''}>${esc(r.message || r.task_title || 'Reminder')}</span>
          ${r.project_name ? `<a class="small" href="#/project/${r.project_id}">${esc(r.project_name)}</a>` : ''}
          <span class="chip">⏰ ${esc(fmtDateTime(r.remind_at, { weekday: false }))} (${fmtRelative(r.remind_at)})</span>
          <button class="icon" data-action="delete-reminder" data-id="${r.id}" title="Delete reminder">✕</button>
        </li>`, 'No reminders set')}
      ${section('dash-notes', '📝 Latest notes', d.recent_notes, (n) => `<li style="display:block">
          <div class="small muted">${esc(fmtDateTime(n.created_at))} · ${n.project_id ? `<a href="#/project/${n.project_id}">${esc(n.project_name)}</a>` : '<a href="#/tasks">✅ Tasks</a>'}${n.task_title ? ` · <a href="javascript:void 0" data-action="open-task" data-id="${n.task_id}">${esc(n.task_title)}</a>` : ''}</div>
          <div class="pre">${linkify(n.body)}</div></li>`, 'No notes yet')}
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
      ${statusChip(t.status)} ${t.priority !== 2 ? prioPill(t.priority) : ''} ${dueChip(t)} ${ownerChip(t)} ${waitingChip(t)} ${repeatChip(t)}
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
      <div class="note-body pre">${linkify(i.body)}</div></li>`;
  }
  return `<li class="event"><span title="${esc(fmtDateTime(i.at))}">${esc(fmtDateTime(i.at, { weekday: false }))}</span> — ${esc(i.text)}</li>`;
}

// ---- Phases: a project's internal split into milestones ----------------------------

const phaseDates = (ph) => [ph.start_date && fmtShortDate(`${ph.start_date}T12:00`), ph.due_at && fmtShortDate(ph.due_at)]
  .filter(Boolean).join(' → ');

function phaseSlip(ph) {
  if (!ph.baseline_due_at || !ph.due_at || ph.baseline_due_at === ph.due_at) return '';
  const days = Math.round((new Date(ph.due_at) - new Date(ph.baseline_due_at)) / 86400000);
  return days ? ` <span class="chip ${days > 0 ? 'overdue' : ''}" title="Baseline end ${esc(fmtDate(ph.baseline_due_at))}">${days > 0 ? '+' : ''}${days}d vs baseline</span>` : '';
}

function phasesBox(p) {
  const phases = p.charter.phases;
  if (!phases.length) {
    return `<div class="baseline-box"><span>🧭 Bigger project? Split it into phases or milestones (e.g. <i>Phase 1: pilot</i>, <i>Phase 2: roll-out</i>)
      and group its tasks under them.</span><button class="link" data-action="add-phase">＋ Add a phase</button></div>`;
  }
  const current = phases.find((ph) => ph.status !== 'done');
  const card = (ph, i) => {
    const pct = ph.task_count ? Math.round((ph.done_count / ph.task_count) * 100) : 0;
    const rag = phaseRag(ph);
    const where = ph.status === 'done' ? `✓ Complete${ph.completed_at ? ` ${esc(fmtShortDate(ph.completed_at))}` : ''}`
      : ph === current ? '▶ Current' : 'Upcoming';
    return `<div class="phase-card ${ph.status === 'done' ? 'done' : ''} ${ph === current ? 'current' : ''}" data-action="edit-phase" data-id="${ph.id}" title="Edit phase">
      <div class="ph-name"><span class="ph-num">${i + 1}</span>${esc(ph.name)}</div>
      <div class="small muted">${phaseDates(ph) || 'No dates yet'}${phaseSlip(ph)}</div>
      <div class="progress" title="${pct}% of its tasks done"><div style="width:${pct}%"></div></div>
      <div class="small">${where} · ${ph.done_count}/${ph.task_count} tasks
        ${ph.status === 'done' ? '' : `<span title="Red: overdue tasks or past its end · Yellow: blocked, or ends within a week without starting">${RAG_ICON[rag]}</span>`}</div>
    </div>`;
  };
  return `<div class="phase-strip">${phases.map(card).join('<span class="ph-arrow">›</span>')}
    <button class="phase-add" data-action="add-phase" title="Add a phase">＋ Phase</button></div>`;
}

// Add (no phase) or edit a phase. New phases can take over existing tasks that have no phase yet.
function phaseDialog(p, phase) {
  const phases = p.charter.phases;
  const idx = phase ? phases.findIndex((x) => x.id === phase.id) : -1;
  const free = p.tasks.filter((t) => !t.parent_id && !t.phase_id);
  openModal(`
    <div class="modal-head"><h2 style="margin:0">🧭 ${phase ? `Phase ${idx + 1}` : 'New phase'} — ${esc(p.name)}</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="phase-form" class="form-grid">
      <label class="f full">Name<input type="text" name="name" required value="${esc(phase?.name || '')}" placeholder="e.g. Phase ${phases.length + 1}: roll-out to site B"></label>
      <label class="f">Start<input type="date" name="start_date" value="${esc(phase?.start_date || '')}"></label>
      <label class="f">End / milestone date<input type="date" name="due_at" value="${phase?.due_at ? toDateInput(phase.due_at) : ''}"></label>
      <label class="f full">What this phase delivers — optional<textarea name="description" rows="2">${esc(phase?.description || '')}</textarea></label>
      ${!phase && free.length ? `<div class="f full"><span>Move these tasks into it <span class="muted small">(tasks without a phase; subtasks come along)</span></span>
        <div class="phase-pick">${free.map((t) => `<label class="row small"><input type="checkbox" name="task_ids" value="${t.id}"> ${esc(t.title)}
          ${t.status === 'done' ? '<span class="muted">✓</span>' : ''}</label>`).join('')}</div></div>` : ''}
      ${phase ? `<div class="full small muted">${phase.done_count}/${phase.task_count} tasks done${phase.baseline_due_at ? ` · baseline end ${esc(fmtDate(phase.baseline_due_at))}` : ''}
        · created ${esc(fmtDateTime(phase.created_at))}${phase.completed_at ? ` · completed ${esc(fmtDateTime(phase.completed_at))}` : ''}</div>` : ''}
      <div class="full row">
        ${phase ? `<button type="button" class="danger" data-phase-act="delete">Delete</button>
          <button type="button" data-phase-act="up" ${idx === 0 ? 'disabled' : ''} title="Move earlier">◀</button>
          <button type="button" data-phase-act="down" ${idx === phases.length - 1 ? 'disabled' : ''} title="Move later">▶</button>
          <button type="button" data-phase-act="toggle">${phase.status === 'done' ? '↺ Reopen phase' : '✓ Mark phase complete'}</button>` : ''}
        <div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">${phase ? 'Save' : 'Add phase'}</button></div>
    </form>`);
  const form = $('#phase-form');
  form.querySelector('[name=name]').focus();
  const done = async (msg) => { closeModal(); if (msg) toast(msg); await refresh(); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const body = { name: fd.get('name'), start_date: fd.get('start_date') || null, due_at: fd.get('due_at') || null, description: fd.get('description') || null };
    try {
      if (phase) await api.patch(`/phases/${phase.id}`, body);
      else await api.post(`/projects/${p.id}/phases`, { ...body, task_ids: fd.getAll('task_ids').map(Number) });
      await done(phase ? 'Phase saved' : 'Phase added');
    } catch (err) { toast(err.message, 'error'); }
  });
  $$('[data-phase-act]', form).forEach((b) => b.addEventListener('click', async () => {
    try {
      if (b.dataset.phaseAct === 'delete') {
        if (!confirm(`Delete the phase "${phase.name}"? Its ${phase.task_count} task(s) are kept, just without a phase.`)) return;
        await api.del(`/phases/${phase.id}`);
        return done('Phase deleted');
      }
      if (b.dataset.phaseAct === 'toggle') {
        const open = phase.task_count - phase.done_count;
        if (phase.status !== 'done' && open && !confirm(`${open} task(s) in this phase aren't done yet. Mark the phase complete anyway?`)) return;
        await api.patch(`/phases/${phase.id}`, { status: phase.status === 'done' ? 'open' : 'done' });
        return done(phase.status === 'done' ? 'Phase reopened' : `✓ ${phase.name} complete`);
      }
      const ids = phases.map((x) => x.id);
      const j = idx + (b.dataset.phaseAct === 'up' ? -1 : 1);
      [ids[idx], ids[j]] = [ids[j], ids[idx]];
      await api.post(`/projects/${p.id}/phases/order`, { ids });
      await done();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

// Which phase new tasks go into: the last one picked, else the current (first unfinished) phase.
function phaseSelect(p) {
  const phases = p.charter.phases;
  if (!phases.length) return '';
  const remembered = store.get(`addPhase:${p.id}`);
  const pick = phases.some((ph) => ph.id === remembered) || remembered === null ? remembered : phases.find((ph) => ph.status !== 'done')?.id;
  return `<select id="add-phase" title="Phase for new tasks">${phases.map((ph, i) => `<option value="${ph.id}" ${ph.id === pick ? 'selected' : ''}>${i + 1}. ${esc(ph.name)}</option>`).join('')}
    <option value="" ${pick === null ? 'selected' : ''}>No phase</option></select>`;
}

// The checklist, grouped under each phase (finished phases start collapsed).
function phasedTaskList(p, shown, hideDone) {
  const phases = p.charter.phases;
  const known = new Set(phases.map((ph) => ph.id));
  const groups = phases.map((ph, i) => ({ ph, i, list: shown.filter((t) => t.phase_id === ph.id) }));
  const loose = shown.filter((t) => !known.has(t.phase_id));
  const block = (list, empty) => (list.length ? `<ul class="tasks">${list.map((t) => taskRow(t, p, hideDone)).join('')}</ul>` : `<div class="empty small">${empty}</div>`);
  return groups.map(({ ph, i, list }) => `<details class="phase-group" ${ph.status === 'done' ? '' : 'open'}>
      <summary><span class="ph-num">${i + 1}</span><b>${esc(ph.name)}</b>
        <span class="small muted">${ph.done_count}/${ph.task_count} done${phaseDates(ph) ? ` · ${phaseDates(ph)}` : ''}</span>
        ${ph.status === 'done' ? '<span class="small" style="color:var(--ok)">✓ Complete</span>' : ''}</summary>
      ${block(list, hideDone && ph.task_count ? 'All done' : 'No tasks in this phase yet')}</details>`).join('')
    + (loose.length ? `<details class="phase-group" open><summary><b>No phase</b> <span class="small muted">${loose.length}</span></summary>${block(loose, '')}</details>` : '');
}

async function renderProject(id, tab) {
  const [p, timeline] = await Promise.all([api.get(`/projects/${id}`), api.get(`/projects/${id}/timeline`), loadLookups()]);
  state.project = p;
  const tabs = `<div class="tabs"><a href="#/project/${p.id}" class="${tab === 'charter' ? '' : 'on'}">Overview</a>
    <a href="#/project/${p.id}/charter" class="${tab === 'charter' ? 'on' : ''}">📋 Charter <span class="small muted">${p.charter.completeness.pct}%</span></a></div>`;
  const hideDone = store.get('hideDone', false);
  const view = store.get('tasksView', 'list');
  const board = view === 'board';
  const gantt = view === 'gantt';
  const notesOnly = store.get('notesOnly', false);
  const tree = buildTree(p.tasks);
  const shown = hideDone ? tree.filter((t) => t.status !== 'done') : tree;
  const done = p.tasks.filter((t) => t.status === 'done').length;
  const items = notesOnly ? timeline.filter((i) => i.type === 'note') : timeline;

  main().innerHTML = `
    <div class="project-head">
      <div class="title">
        <h1>${esc(p.name)} <span class="muted small">${esc(p.project_code || '')}</span></h1>
        ${p.sponsor || p.leader ? `<div class="small muted">${p.leader ? `Leader: <b>${esc(p.leader)}</b>` : ''}${p.sponsor ? ` · Sponsor: <b>${esc(p.sponsor)}</b>` : ''}${p.category ? ` · ${esc(p.category)}` : ''}</div>` : ''}
        ${p.escalated_from ? `<div class="small" style="margin-bottom:4px"><a href="#/idea/${p.escalated_from.id}">💡 Escalated from ${esc(p.escalated_from.ref)}</a></div>` : ''}
        ${p.description ? `<div class="pre muted">${linkify(p.description)}</div>` : ''}
        <div class="small muted" style="margin-top:4px">Created ${esc(fmtDateTime(p.created_at))} · Updated ${esc(fmtDateTime(p.updated_at))}
          ${p.completed_at ? ` · Completed ${esc(fmtDateTime(p.completed_at))}` : ''}</div>
      </div>
      <div class="meta">
        <select data-action="project-field" data-field="status" title="Status">${options(PSTATUS, p.status)}</select>
        <select data-action="project-field" data-field="priority" title="Priority">${options(PRIORITY, p.priority)}</select>
        ${p.due_at ? dueChip({ ...p, status: p.status === 'completed' ? 'done' : '' }) : ''}
        <button data-action="edit-project">✎ Edit</button>
        <button data-action="remind-project" title="Project reminder">🔔</button>
        <a class="button" href="#/report/${p.id}" title="Status report for this project">📰 Report</a>
        <a class="button" href="/api/export.xlsx?scope=project&id=${p.id}" title="Download this project as an Excel workbook">⬇ Excel</a>
      </div>
    </div>
    ${tabs}
    ${tab === 'charter' ? '<div id="charter-root"></div>' : `
    ${charterNudge(p)}
    ${baselineBox(p)}
    ${budgetBox(p)}
    ${phasesBox(p)}
    <div class="quick-note">
      <textarea id="note-input" placeholder="Add a note to this project… (Enter to save, Shift+Enter for a new line; lines starting [ ] become tasks)"></textarea>
      <select id="note-task" title="Attach note to a task (optional)">
        <option value="">Whole project</option>
        ${p.tasks.filter((t) => t.status !== 'done').map((t) => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}
      </select>
      <button class="primary" data-action="save-note">Add note</button>
    </div>
    <div class="grid ${board || gantt ? 'one' : 'two'}">
      <div class="card">
        <div class="list-tools">
          <h2 style="margin:0">Tasks <span class="muted small">${done}/${p.tasks.length} done</span></h2>
          <div class="row">
            ${board ? '' : `<label class="small muted row"><input type="checkbox" data-action="toggle-hide-done" ${hideDone ? 'checked' : ''}> Hide completed</label>`}
            <div class="seg" role="group" aria-label="Task view">
              <button data-action="tasks-view" data-view="list" class="${view === 'list' ? 'on' : ''}" title="Checklist">☰ List</button>
              <button data-action="tasks-view" data-view="board" class="${board ? 'on' : ''}" title="Mini Kanban">▦ Board</button>
              <button data-action="tasks-view" data-view="gantt" class="${gantt ? 'on' : ''}" title="Gantt chart">▤ Gantt</button>
            </div>
          </div>
        </div>
        ${gantt ? '<div id="gantt-root"></div>' : board ? taskBoardHtml(p.tasks.filter((t) => !t.parent_id)) : `
        ${p.charter.phases.length ? phasedTaskList(p, shown, hideDone)
          : shown.length ? `<ul class="tasks">${shown.map((t) => taskRow(t, p, hideDone)).join('')}</ul>` : '<div class="empty">No tasks yet — add one below.</div>'}
        <div class="add-task row">
          <input type="text" id="add-task-input" placeholder="Add a task… (Enter)   e.g. Send report !high @fri" autocomplete="off" style="flex:1">
          ${phaseSelect(p)}
        </div>`}
        ${gantt ? '' : `<div class="small muted" style="margin-top:4px">${SHORTCUTS_HELP}</div>`}
      </div>
      <div class="card">
        <div class="list-tools">
          <h2 style="margin:0">Timeline</h2>
          <label class="small muted row"><input type="checkbox" data-action="toggle-notes-only" ${notesOnly ? 'checked' : ''}> Notes only</label>
        </div>
        ${items.length ? `<ul class="timeline">${items.map(timelineItem).join('')}</ul>` : '<div class="empty">Nothing yet.</div>'}
      </div>
    </div>`}`;

  if (tab === 'charter') { renderCharterTab($('#charter-root'), p); return; }
  $('#note-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveProjectNote(); }
  });
  for (const id of ['#add-task-input', '#board-add']) {
    $(id)?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const q = parseQuick(e.target.value);
      if (!q.title) return;
      // The list view has a phase picker; the board adds to the current phase.
      const phaseId = $('#add-phase') ? Number($('#add-phase').value) || null
        : p.charter.phases.find((ph) => ph.status !== 'done')?.id ?? null;
      if ($('#add-phase')) store.set(`addPhase:${p.id}`, phaseId);
      await api.post('/tasks', { project_id: p.id, ...q, phase_id: phaseId });
      await refresh();
      $(id)?.focus();
    });
  }
  if (gantt) renderProjectGantt($('#gantt-root'), p, hideDone);
  if (board) {
    wireDrag(main(), async (id, status) => {
      const t = p.tasks.find((x) => String(x.id) === id);
      if (!t || t.status === status) return;
      await setTaskStatus(t.id, status, t.subtask_count - t.subtask_done);
    });
  }
}

const noteToast = (note) => (note.created_tasks?.length
  ? `Note added · ${note.created_tasks.length} task${note.created_tasks.length === 1 ? '' : 's'} created from [ ] lines`
  : 'Note added');

function budgetBox(p) {
  const spent = p.spent || 0;
  const budget = p.budget;
  const pct = budget ? Math.round((spent / budget) * 100) : null;
  const over = budget !== null && budget !== undefined && spent > budget;
  const level = over ? 'over' : pct !== null && pct >= 90 ? 'near' : '';
  const showCosts = store.get('showCosts', false);
  return `<div class="baseline-box budget-box">
    <span>💰 Budget: <b>${budget !== null && budget !== undefined ? money(budget) : '—'}</b></span>
    <span>Spent: <b>${money(spent)}</b>${pct !== null ? ` <span class="muted">(${pct}%)</span>` : ''}</span>
    ${budget !== null && budget !== undefined ? `
      <span class="meter wide ${level}" title="${pct}% of the budget spent"><span style="width:${Math.min(pct, 100)}%"></span></span>
      <span>${over ? `<span class="chip overdue">⚠ Over budget by ${money(spent - budget)}</span>` : `Remaining: <b>${money(budget - spent)}</b>`}</span>`
      : '<button class="link" data-action="edit-project">Set a budget</button>'}
    <button class="link" data-action="log-cost">＋ Log a cost</button>
    ${p.costs.length ? `<button class="link" data-action="toggle-costs">${showCosts ? 'Hide' : 'Show'} ${p.costs.length} cost${p.costs.length === 1 ? '' : 's'}</button>` : ''}
  </div>
  ${p.costs.length && showCosts ? `<div class="card costs-card"><table class="log">
    <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th><th></th></tr></thead>
    <tbody>${p.costs.map((c) => `<tr><td class="nowrap">${esc(c.spent_on ? fmtShortDate(`${c.spent_on}T12:00`) : '')}</td>
      <td>${linkify(c.description)}</td><td class="num nowrap">${money(c.amount)}</td>
      <td><button class="icon" data-action="delete-cost" data-id="${c.id}" title="Delete">✕</button></td></tr>`).join('')}</tbody>
    <tfoot><tr><th colspan="2">Total</th><th class="num">${money(spent)}</th><th></th></tr></tfoot></table></div>` : ''}`;
}

function costDialog(p) {
  openModal(`
    <div class="modal-head"><h2 style="margin:0">💰 Log a cost — ${esc(p.name)}</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="cost-form" class="form-grid">
      <label class="f full">Description<input type="text" name="description" required placeholder="e.g. Movers deposit, PO 4411"></label>
      <label class="f">Amount (${esc(state.settings.currency)})<input type="number" name="amount" min="0" step="0.01" required></label>
      <label class="f">Date<input type="date" name="spent_on" value="${dateKey(new Date())}"></label>
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">Add cost</button></div>
    </form>`);
  $('#cost-form [name=description]').focus();
  $('#cost-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      await api.post(`/projects/${p.id}/costs`, f);
      closeModal();
      toast('Cost logged');
      store.set('showCosts', true);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function saveProjectNote() {
  const input = $('#note-input');
  const body = input.value.trim();
  if (!body) return;
  const note = await api.post('/notes', { project_id: state.project.id, task_id: $('#note-task').value || null, body });
  input.value = '';
  toast(noteToast(note));
  await refresh();
  $('#note-input')?.focus();
}

// ======================================================================
// Kanban
// ======================================================================

const PROJECT_COLUMNS = { active: 'Active', on_hold: 'On hold', completed: 'Completed' };

// Makes the cards in `root` draggable between its columns; onDrop(id, newStatus).
function wireDrag(root, onDrop) {
  $$('.kcard[draggable]', root).forEach((c) => {
    c.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', c.dataset.id); c.classList.add('dragging'); });
    c.addEventListener('dragend', () => c.classList.remove('dragging'));
  });
  $$('.column', root).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-over');
      try { await onDrop(e.dataTransfer.getData('text/plain'), col.dataset.status); } catch (err) { toast(err.message, 'error'); }
    });
  });
}

// Main Kanban: every ongoing project as a card, by project status.
async function renderKanban() {
  await loadProjects();
  const timeline = store.get('projectsView', 'board') === 'timeline';
  const doneLimit = 20;
  const byStatus = Object.fromEntries(Object.keys(PROJECT_COLUMNS).map((st) => [st, state.projects.filter((p) => p.status === st)]));
  byStatus.completed.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));

  const card = (p) => {
    const pct = p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0;
    const stats = [
      `☑ ${p.done_count}/${p.task_count} tasks`,
      p.in_progress_count && `▶ ${p.in_progress_count} in progress`,
      p.blocked_count && `<span class="status-blocked">⛔ ${p.blocked_count} blocked</span>`,
      p.overdue_count && `<span class="chip overdue">⚠ ${p.overdue_count} overdue</span>`,
    ].filter(Boolean).join(' · ');
    return `<div class="kcard p${p.priority} ${p.status === 'completed' ? 'done' : ''}" draggable="true" data-id="${p.id}"
        data-action="open-project" title="Open project">
      <div class="ktitle"><span>${esc(p.name)}</span></div>
      <div class="kmeta">${prioPill(p.priority)} ${p.due_at ? dueChip({ ...p, status: p.status === 'completed' ? 'done' : '' }) : ''}</div>
      ${phaseLine(p) ? `<div class="small" style="margin-top:6px">${phaseLine(p)}</div>` : ''}
      <div class="small muted" style="margin-top:6px">${stats}</div>
      ${p.task_count ? `<div class="progress" title="${pct}% done"><div style="width:${pct}%"></div></div>` : ''}
      <div class="small muted" style="margin-top:6px">
        ${p.status === 'completed' && p.completed_at ? `Completed ${esc(fmtShortDate(p.completed_at))}`
          : [p.next_due_at && `Next task due ${esc(fmtShortDate(p.next_due_at))}`,
             p.last_note_at && `last note ${fmtRelative(p.last_note_at)}`].filter(Boolean).join(' · ')}
      </div>
    </div>`;
  };

  main().innerHTML = `
    <div class="kanban-tools">
      <h1 style="margin:0">Projects board</h1><div class="spacer"></div>
      <span class="small muted">${timeline ? 'Drag a bar to change a project\'s dates' : 'Drag a project to change its status'} · open a project for its own tasks</span>
      <div class="seg" role="group" aria-label="Projects view">
        <button data-action="projects-view" data-view="board" class="${timeline ? '' : 'on'}">▦ Board</button>
        <button data-action="projects-view" data-view="timeline" class="${timeline ? 'on' : ''}">▤ Timeline</button>
      </div>
      <button class="primary" data-action="new-project">+ New project</button>
    </div>
    ${timeline ? '<div class="card"><div id="gantt-root"></div></div>' : `<div class="kanban projects">
      ${Object.entries(PROJECT_COLUMNS).map(([st, label]) => {
        const list = st === 'completed' ? byStatus.completed.slice(0, doneLimit) : byStatus[st];
        return `<div class="column" data-status="${st}">
          <h3>${label} <span class="muted small">${byStatus[st].length}</span></h3>
          ${list.map(card).join('') || '<div class="empty small">None</div>'}
          ${st === 'completed' && byStatus.completed.length > doneLimit ? `<div class="small muted">Showing latest ${doneLimit}</div>` : ''}
        </div>`;
      }).join('')}
    </div>`}`;

  if (timeline) return renderPortfolioGantt($('#gantt-root'), state.projects.filter((p) => p.status === 'active' || p.status === 'on_hold'));
  wireDrag(main(), async (id, status) => {
    const p = state.projects.find((x) => String(x.id) === id);
    if (!p || p.status === status) return;
    await api.patch(`/projects/${p.id}`, { status });
    toast(`"${p.name}" → ${PROJECT_COLUMNS[status]}`);
    await refresh();
  });
}

// A project's own mini Kanban of its top-level tasks.
function taskBoardHtml(tasks) {
  const cols = Object.keys(STATUS);
  const doneLimit = 30;
  const byStatus = Object.fromEntries(cols.map((st) => [st, tasks.filter((t) => t.status === st)]));
  byStatus.done.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at)));
  const card = (t) => `<div class="kcard p${t.priority} ${t.status === 'done' ? 'done' : ''}" draggable="true" data-id="${t.id}">
      <div class="ktitle"><input type="checkbox" data-action="toggle-task" data-id="${t.id}" data-subs="${t.subtask_count - t.subtask_done}" ${t.status === 'done' ? 'checked' : ''}>
        <span data-action="open-task" data-id="${t.id}" style="cursor:pointer">${esc(t.title)}</span></div>
      ${t.phase_name ? `<div class="small muted" title="Phase">🧭 ${esc(t.phase_name)}</div>` : ''}
      <div class="kmeta">${t.priority !== 2 ? prioPill(t.priority) : ''} ${dueChip(t)} ${ownerChip(t)}
        ${t.subtask_count ? `<span class="small muted">☑ ${t.subtask_done}/${t.subtask_count}</span>` : ''}
        ${t.next_reminder ? '<span class="small">🔔</span>' : ''}${t.note_count ? `<span class="small muted">📝 ${t.note_count}</span>` : ''}</div>
      ${t.subtask_count ? `<div class="progress"><div style="width:${Math.round((t.subtask_done / t.subtask_count) * 100)}%"></div></div>` : ''}
    </div>`;
  return `<div class="kanban mini">${cols.map((st) => {
    const list = st === 'done' ? byStatus.done.slice(0, doneLimit) : byStatus[st];
    return `<div class="column" data-status="${st}">
      <h3>${STATUS[st]} <span class="muted small">${byStatus[st].length}</span></h3>
      ${list.map(card).join('')}
      ${st === 'done' && byStatus.done.length > doneLimit ? `<div class="small muted">Showing latest ${doneLimit}</div>` : ''}
      ${st === 'todo' ? '<input type="text" id="board-add" placeholder="+ Add task… (Enter)" autocomplete="off">' : ''}
    </div>`;
  }).join('')}</div>`;
}

// ======================================================================
// Ideation
// ======================================================================

const IDEA_STATUS = { new: 'New', reviewing: 'Under review', approved: 'Approved', rejected: 'Rejected', implemented: 'Implemented', escalated: 'Escalated' };
const OPEN_IDEA_STATUSES = ['new', 'reviewing', 'approved'];
const IMPACT = { '': '—', 1: '1 · minimal', 2: '2 · minor', 3: '3 · moderate', 4: '4 · significant', 5: '5 · major' };
const EFFORT = { '': '—', 1: '1 · trivial', 2: '2 · small', 3: '3 · medium', 4: '4 · large', 5: '5 · huge' };
// Value score 1–25: high impact and low effort score highest.
const ideaScore = (i) => (i.impact && i.effort ? i.impact * (6 - i.effort) : null);
const scoreTitle = (i) => (ideaScore(i) === null ? 'Set impact and effort to score this idea'
  : `Impact ${i.impact} × (6 − effort ${i.effort}) = ${ideaScore(i)}`);
const IDEA_SORTS = { newest: 'Newest first', value: 'Best value first', due: 'Due date', cost: 'Cost (highest first)' };

const money = (v) => (v === null || v === undefined || v === '' ? ''
  : `${state.settings.currency}${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const ideaStatusPill = (s) => `<span class="pill istatus-${s}">${IDEA_STATUS[s] || esc(s)}</span>`;
// Colour the due date only while the idea is still open.
const ideaDue = (i) => (i.due_at ? dueChip({ ...i, status: OPEN_IDEA_STATUSES.includes(i.status) ? '' : 'done' }) : '');

async function loadAreas() {
  state.areas = await api.get('/areas');
  return state.areas;
}
function areaOptions(selected) {
  const list = state.areas.filter((a) => a.active || a.id === selected);
  return '<option value="">— none —</option>' + list.map((a) =>
    `<option value="${a.id}" ${a.id === selected ? 'selected' : ''}>${esc(a.name)}${a.active ? '' : ' (inactive)'}</option>`).join('');
}
const submitterList = (names) => `<datalist id="submitters">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;

// Reads an idea form's fields into API values.
function ideaValue(name, value) {
  if (name === 'due_at') return value || null;
  if (name === 'priority') return Number(value);
  if (name === 'area_id') return value ? Number(value) : null;
  if (name === 'cost') return value === '' ? null : value;
  if (name === 'impact' || name === 'effort') return value ? Number(value) : null;
  return value;
}

async function renderIdeas() {
  const f = { status: 'open', area: '', q: '', sort: 'newest', view: 'list', ...store.get('ideaFilter', {}) };
  const qs = new URLSearchParams({ status: f.status });
  if (f.area) qs.set('area_id', f.area);
  if (f.q) qs.set('q', f.q);
  const [ideas] = await Promise.all([api.get(`/ideas?${qs}`), loadAreas()]);
  const sorters = {
    newest: (a, b) => b.id - a.id,
    value: (a, b) => (ideaScore(b) ?? -1) - (ideaScore(a) ?? -1) || b.id - a.id,
    due: (a, b) => String(a.due_at || '9').localeCompare(String(b.due_at || '9')),
    cost: (a, b) => (b.cost ?? -1) - (a.cost ?? -1),
  };
  ideas.sort(sorters[f.sort] || sorters.newest);
  const total = ideas.reduce((sum, i) => sum + (i.cost || 0), 0);
  const filtered = f.status !== 'open' || f.area || f.q;

  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">💡 Ideation</h1><div class="spacer"></div>
      <div class="seg" role="group" aria-label="Ideas view">
        <button data-action="ideas-view" data-view="list" class="${f.view === 'matrix' ? '' : 'on'}">☰ List</button>
        <button data-action="ideas-view" data-view="matrix" class="${f.view === 'matrix' ? 'on' : ''}" title="Impact vs effort">▦ Quick wins</button>
      </div>
      <a class="button" href="/api/export.xlsx?scope=ideas" title="Download all ideas as an Excel workbook">⬇ Excel</a>
      <button class="primary" data-action="new-idea">+ New idea</button></div>
    <div class="kanban-tools">
      <input type="search" id="idea-q" placeholder="Filter by name, ref or submitter… (Enter)" value="${esc(f.q)}" style="max-width:300px">
      <select id="idea-status">${options({ open: 'Open (new, under review, approved)', all: 'All statuses', ...IDEA_STATUS }, f.status)}</select>
      <select id="idea-sort" title="Sort">${options(IDEA_SORTS, f.sort)}</select>
      <select id="idea-area"><option value="">All areas</option>
        ${state.areas.map((a) => `<option value="${a.id}" ${String(a.id) === String(f.area) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>
      <span class="muted small">${ideas.length} idea${ideas.length === 1 ? '' : 's'}${total ? ` · total cost ${money(total)}` : ''}</span>
    </div>
    ${f.view === 'matrix' ? ideaMatrix(ideas) : `<div class="card" style="overflow-x:auto">
      ${ideas.length ? `<table class="log ideas">
        <thead><tr><th>Ref</th><th>Idea</th><th>Area</th><th>Submitted by</th><th>Priority</th><th class="num" title="Impact × (6 − effort), 1–25">Score</th><th>Due</th><th class="num">Cost</th><th>Status</th><th>Raised</th></tr></thead>
        <tbody>${ideas.map((i) => `<tr class="clickable" data-action="open-idea" data-id="${i.id}">
          <td class="nowrap"><b>${esc(i.ref)}</b></td>
          <td>${esc(i.title)}${i.note_count ? ` <span class="small muted" title="Notes">📝 ${i.note_count}</span>` : ''}</td>
          <td>${esc(i.area_name || '')}</td>
          <td>${esc(i.submitted_by || '')}</td>
          <td>${prioPill(i.priority)}</td>
          <td class="num" title="${esc(scoreTitle(i))}">${ideaScore(i) ?? '<span class="muted">—</span>'}</td>
          <td class="nowrap">${ideaDue(i)}</td>
          <td class="num nowrap">${money(i.cost)}</td>
          <td class="nowrap">${ideaStatusPill(i.status)}${i.project_id ? ` <a class="small" href="#/project/${i.project_id}">→ ${esc(i.project_name)}</a>` : ''}</td>
          <td class="nowrap small muted">${esc(fmtDateTime(i.created_at, { weekday: false }))}</td>
        </tr>`).join('')}</tbody></table>`
        : `<div class="empty">${filtered ? 'No ideas match these filters.' : 'No open ideas yet — click “+ New idea” to log one.'}</div>`}
    </div>`}`;

  const save = (patch) => { store.set('ideaFilter', { ...f, ...patch }); renderIdeas(); };
  $('#idea-status').addEventListener('change', (e) => save({ status: e.target.value }));
  $('#idea-area').addEventListener('change', (e) => save({ area: e.target.value }));
  $('#idea-sort').addEventListener('change', (e) => save({ sort: e.target.value }));
  $('#idea-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') save({ q: e.target.value.trim() }); });
  $('#idea-q').addEventListener('search', (e) => { if (!e.target.value && f.q) save({ q: '' }); });
}

// 2×2 impact/effort grid. High = 3 or more on the 1–5 scale.
function ideaMatrix(ideas) {
  const card = (i) => `<div class="icard" data-action="open-idea" data-id="${i.id}" title="${esc(scoreTitle(i))}">
      <b>${esc(i.ref)}</b> ${esc(i.title)}
      <div class="small muted">Impact ${i.impact} · Effort ${i.effort} · score ${ideaScore(i)}${i.cost !== null ? ` · ${money(i.cost)}` : ''}</div></div>`;
  const scored = ideas.filter((i) => ideaScore(i) !== null);
  const quad = (hiImpact, hiEffort) => scored
    .filter((i) => (i.impact >= 3) === hiImpact && (i.effort >= 3) === hiEffort)
    .sort((a, b) => ideaScore(b) - ideaScore(a));
  const box = (title, hint, list, cls) => `<div class="quad ${cls}"><h3>${title} <span class="muted small">${list.length}</span></h3>
    <div class="small muted" style="margin-bottom:6px">${hint}</div>${list.map(card).join('') || '<div class="empty small">None</div>'}</div>`;
  const unscored = ideas.filter((i) => ideaScore(i) === null);
  return `<div class="matrix">
      <div class="axis-y">Impact →</div>
      ${box('⭐ Quick wins', 'High impact, low effort: do these first', quad(true, false), 'q-win')}
      ${box('🏗 Big projects', 'High impact, high effort: plan and consider escalating', quad(true, true), 'q-big')}
      ${box('🧩 Fill-ins', 'Low impact, low effort: when there is spare time', quad(false, false), 'q-fill')}
      ${box('🤔 Reconsider', 'Low impact, high effort: probably not worth it', quad(false, true), 'q-no')}
      <div class="axis-x">Effort →</div>
    </div>
    ${unscored.length ? `<div class="card" style="margin-top:14px"><h3>Not scored yet <span class="muted small">${unscored.length}</span></h3>
      <div class="small muted" style="margin-bottom:6px">Open an idea and set its impact and effort to place it on the grid.</div>
      <ul class="mini">${unscored.map((i) => `<li><span class="t" data-action="open-idea" data-id="${i.id}"><b>${esc(i.ref)}</b> ${esc(i.title)}</span> ${ideaStatusPill(i.status)}</li>`).join('')}</ul></div>` : ''}`;
}

async function ideaForm() {
  const [submitters] = await Promise.all([api.get('/ideas/submitters'), loadAreas()]);
  openModal(`
    <div class="modal-head"><h2 style="margin:0">💡 New idea</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="idea-form" class="form-grid">
      <label class="f full">Name<input type="text" name="title" required></label>
      <label class="f full">Description<textarea name="description" rows="3"></textarea></label>
      <label class="f">Submitted by<input type="text" name="submitted_by" list="submitters" autocomplete="off" value="${esc(store.get('lastSubmitter', ''))}"></label>
      <label class="f">Area<select name="area_id">${areaOptions(null)}</select></label>
      <label class="f">Priority<select name="priority">${options(PRIORITY, 2)}</select></label>
      <label class="f">Due date<input type="date" name="due_at"></label>
      <label class="f">Cost (${esc(state.settings.currency)})<input type="number" name="cost" min="0" step="0.01" inputmode="decimal"></label>
      <label class="f">Impact<select name="impact">${options(IMPACT, '')}</select></label>
      <label class="f">Effort<select name="effort">${options(EFFORT, '')}</select></label>
      <div class="f" style="justify-content:flex-end"><button type="button" class="link small" data-action="goto-settings">Manage areas…</button></div>
      ${submitterList(submitters)}
      <div class="full row"><div class="spacer"></div>
        <button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">Create idea</button></div>
    </form>`);
  $('#idea-form [name=title]').focus();
  $('#idea-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, v] of new FormData(e.target)) body[k] = ideaValue(k, v);
    try {
      const idea = await api.post('/ideas', body);
      if (body.submitted_by) store.set('lastSubmitter', body.submitted_by);
      closeModal();
      toast(`${idea.ref} created`);
      if (state.view === 'ideas') await renderIdeas(); else location.hash = '#/ideas';
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function renderIdea(id) {
  const [i, submitters] = await Promise.all([api.get(`/ideas/${id}`), api.get('/ideas/submitters'), loadAreas()]);
  state.idea = i;
  const locked = i.status === 'escalated';
  const statusOpts = locked ? { escalated: 'Escalated' }
    : Object.fromEntries(Object.entries(IDEA_STATUS).filter(([k]) => k !== 'escalated'));

  main().innerHTML = `
    <div class="project-head">
      <div class="title">
        <div class="small"><a href="#/ideas">💡 Ideation</a> ›</div>
        <h1><span class="muted">${esc(i.ref)}</span> ${esc(i.title)}</h1>
        <div class="small muted">Raised ${esc(fmtDateTime(i.created_at))}${i.submitted_by ? ` by <b>${esc(i.submitted_by)}</b>` : ''}
          · Updated ${esc(fmtDateTime(i.updated_at))}</div>
      </div>
      <div class="meta">
        ${ideaStatusPill(i.status)}
        ${locked ? '' : '<button class="primary" data-action="escalate-idea">🚀 Escalate to project</button>'}
        <button class="danger" data-action="delete-idea">Delete</button>
      </div>
    </div>
    ${locked ? `<div class="baseline-box">🚀 Escalated to project
      ${i.project_id ? `<a href="#/project/${i.project_id}"><b>${esc(i.project_name)}</b></a>` : '<i>(project since deleted)</i>'}</div>` : ''}
    <div class="grid two">
      <div class="card">
        <div class="list-tools"><h2 style="margin:0">Details</h2><span class="saved-flag" id="saved-flag">✓ Saved</span></div>
        <div class="form-grid" id="idea-edit">
          <label class="f full">Name<input type="text" name="title" value="${esc(i.title)}"></label>
          <label class="f full">Description<textarea name="description" rows="4">${esc(i.description)}</textarea>${linkList(i.description)}</label>
          <label class="f">Status<select name="status" ${locked ? 'disabled' : ''}>${options(statusOpts, i.status)}</select></label>
          <label class="f">Priority<select name="priority">${options(PRIORITY, i.priority)}</select></label>
          <label class="f">Area<select name="area_id">${areaOptions(i.area_id)}</select></label>
          <label class="f">Submitted by<input type="text" name="submitted_by" list="submitters" autocomplete="off" value="${esc(i.submitted_by)}"></label>
          <label class="f">Due date<input type="date" name="due_at" value="${toDateInput(i.due_at)}"></label>
          <label class="f">Cost (${esc(state.settings.currency)})<input type="number" name="cost" min="0" step="0.01" inputmode="decimal" value="${i.cost ?? ''}"></label>
          <label class="f">Impact<select name="impact">${options(IMPACT, i.impact)}</select></label>
          <label class="f">Effort<select name="effort">${options(EFFORT, i.effort)}</select></label>
          <div class="f"><span>Value score</span><b title="${esc(scoreTitle(i))}">${ideaScore(i) ?? '—'} <span class="small muted">/ 25</span></b></div>
          ${submitterList(submitters)}
        </div>
      </div>
      <div class="card">
        <h2>Notes <span class="muted small">${i.notes.length}</span></h2>
        <div class="quick-note"><textarea id="idea-note" placeholder="Add a note… (Enter to save, Shift+Enter for a new line)"></textarea>
          <button class="primary" data-action="save-idea-note">Add</button></div>
        ${i.notes.length ? `<ul class="timeline">${i.notes.map((n) => `<li class="note">
          <div class="when">🕘 ${esc(fmtDateTime(n.created_at))}<span class="spacer"></span>
            <button class="icon" data-action="delete-idea-note" data-id="${n.id}" title="Delete note">✕</button></div>
          <div class="note-body pre">${linkify(n.body)}</div></li>`).join('')}</ul>` : '<div class="empty">No notes yet.</div>'}
        <details class="section"><summary class="muted">History (${i.history.length})</summary>
          <ul class="timeline" style="margin-top:8px">${i.history.map((e) => timelineItem({ type: 'event', ...e })).join('')}</ul></details>
      </div>
    </div>`;

  // Auto-save each field as it changes.
  $$('#idea-edit [name]').forEach((el) => el.addEventListener('change', async () => {
    if (el.name === 'title' && !el.value.trim()) { el.value = i.title; return; }
    try {
      await api.patch(`/ideas/${i.id}`, { [el.name]: ideaValue(el.name, el.value) });
      if (el.name === 'submitted_by' && el.value) store.set('lastSubmitter', el.value);
      if (['status', 'title', 'submitted_by', 'impact', 'effort', 'description'].includes(el.name)) return renderIdea(i.id);
      const flag = $('#saved-flag');
      flag.classList.add('show');
      setTimeout(() => flag.classList.remove('show'), 1200);
    } catch (err) {
      toast(err.message, 'error');
      renderIdea(i.id);
    }
  }));
  $('#idea-note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveIdeaNote(); }
  });
}

async function saveIdeaNote() {
  const body = $('#idea-note').value.trim();
  if (!body) return;
  await api.post(`/ideas/${state.idea.id}/notes`, { body });
  toast('Note added');
  await renderIdea(state.idea.id);
  $('#idea-note').focus();
}

async function escalateDialog(i) {
  await loadLookups();
  openModal(`
    <div class="modal-head"><h2 style="margin:0">🚀 Escalate ${esc(i.ref)} to a project</h2>
      <button class="icon" data-action="close-modal">✕</button></div>
    <p class="muted">Creates a new project from this idea. The idea is marked <b>Escalated</b> and linked to the project,
      and a summary (submitter, area, cost) is added to the project's timeline.</p>
    <form id="escalate-form" class="form-grid">
      ${charterFieldsHtml({ name: i.title, problem: i.description })}
      <label class="f">Priority<select name="priority">${options(PRIORITY, i.priority)}</select></label>
      <label class="f">Start date<input type="date" name="start_date" value="${new Date().toLocaleDateString('sv')}"></label>
      <label class="f">Due date<input type="date" name="due_at" value="${toDateInput(i.due_at)}"></label>
      <label class="f full">Baseline tasks — one per line (you can add more later)
        <textarea name="baseline_tasks" rows="4"></textarea></label>
      <label class="full row small"><input type="checkbox" name="copy_notes" ${i.notes.length ? 'checked' : 'disabled'}>
        Copy this idea's ${i.notes.length} note${i.notes.length === 1 ? '' : 's'} into the project timeline</label>
      <div class="full row"><div class="spacer"></div>
        <button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">Create project</button></div>
    </form>`, { wide: true });
  $('#escalate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const project = await api.post(`/ideas/${i.id}/escalate`, {
        ...Object.fromEntries(CHARTER_FORM_KEYS.map((k) => [k, f[k]])),
        name: f.name, priority: Number(f.priority), start_date: f.start_date || null,
        due_at: f.due_at || null, baseline_tasks: f.baseline_tasks.split('\n'), copy_notes: f.copy_notes === 'on',
      });
      closeModal();
      toast(`${i.ref} escalated to a project`);
      await loadProjects();
      location.hash = `#/project/${project.id}`;
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ======================================================================
// Settings
// ======================================================================

async function renderSettings() {
  const [areas, settings] = await Promise.all([loadAreas(), api.get('/settings')]);
  state.settings = settings;
  main().innerHTML = `
    <h1>⚙ Settings</h1>
    <div class="grid dash">
      <div class="card">
        <h2>Areas</h2>
        <p class="small muted">The choices in the “Area” drop-down on ideas. Rename an area by editing its name.
          Untick <b>Active</b> to hide it from the drop-down without changing ideas that already use it.</p>
        <table class="log">
          <thead><tr><th>Name</th><th>Active</th><th class="num">Ideas</th><th></th></tr></thead>
          <tbody>${areas.map((a) => `<tr>
            <td><input type="text" value="${esc(a.name)}" data-area-name="${a.id}"></td>
            <td><input type="checkbox" data-area-active="${a.id}" ${a.active ? 'checked' : ''}></td>
            <td class="num">${a.idea_count}</td>
            <td>${a.idea_count ? '' : `<button class="icon" data-action="delete-area" data-id="${a.id}" title="Delete">✕</button>`}</td>
          </tr>`).join('')}</tbody>
        </table>
        ${areas.length ? '' : '<div class="empty">No areas yet.</div>'}
        <div class="row" style="margin-top:10px;flex-wrap:nowrap">
          <input type="text" id="new-area" placeholder="New area… (Enter)" autocomplete="off">
          <button data-action="add-area">Add</button></div>
      </div>
      <div class="card">
        <h2>General</h2>
        <label class="f">Currency symbol for idea costs
          <input type="text" id="currency" value="${esc(settings.currency)}" maxlength="5" style="max-width:120px"></label>
      </div>
    </div>`;

  const patchArea = async (id, body) => {
    try { await api.patch(`/areas/${id}`, body); toast('Area saved'); } catch (err) { toast(err.message, 'error'); }
    renderSettings();
  };
  $$('[data-area-name]').forEach((el) => el.addEventListener('change', () => patchArea(el.dataset.areaName, { name: el.value })));
  $$('[data-area-active]').forEach((el) => el.addEventListener('change', () => patchArea(el.dataset.areaActive, { active: el.checked })));
  $('#new-area').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') actions['add-area']().catch((err) => toast(err.message, 'error'));
  });
  $('#currency').addEventListener('change', async (e) => {
    state.settings = await api.patch('/settings', { currency: e.target.value || '£' });
    toast('Currency saved');
  });
  const extra = document.createElement('div');
  main().append(extra);
  await renderCharterSettings(extra);
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
    <p class="muted small">Every insert, change and delete is recorded by the database itself — including edits made directly in DBeaver. Showing the latest 500.</p>
    <div class="card" style="overflow-x:auto"><table class="log">
      <thead><tr><th>When</th><th>Project</th><th>What</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td class="nowrap">${esc(fmtDateTime(r.changed_at))}</td>
        <td>${r.project_id ? (names[r.project_id] ? `<a href="#/project/${r.project_id}">${esc(names[r.project_id])}</a>` : `#${r.project_id}`) : ''}</td>
        <td>${esc(r.summary)}</td></tr>`).join('')}</tbody>
    </table>${rows.length ? '' : '<div class="empty">No activity yet.</div>'}</div>`;
  $('#log-project').addEventListener('change', (e) => { store.set('logProject', e.target.value); renderLog(); });
}

async function renderBackups() {
  const [list, info] = await Promise.all([api.get('/backups'), api.get('/info')]);
  const size = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">Backups</h1><div class="spacer"></div>
      <button data-action="restore-pick" title="Replace all data with a backup file (.db or .json)">⤺ Restore from file…</button>
      <input type="file" id="restore-file" accept=".db,.json" hidden>
      <button class="primary" data-action="backup-now">💾 Back up now</button></div>
    <div class="card stack">
      <p><b>Your data folder:</b> <code>${esc(info.data_dir)}</code><br>
        <span class="small muted">Database: <code>${esc(info.db_file)}</code> (open this in DBeaver) ·
        Backups: <code>${esc(info.backup_dir)}</code> · Logs: <code>${esc(info.log_dir)}</code><br>
        This is outside the app folder, so updating the app never touches it.</span></p>
      <p>Backups run automatically (at start-up and on the interval set in <code>.env</code>). Each backup is a
        complete copy of the <b>database file</b> (<code>.db</code> — opens in DBeaver) plus a <b>JSON export</b> of every table.</p>
      <p class="small muted"><b>Restore</b> replaces <i>all</i> current data with a backup: use <b>Restore</b> on a row below, or
        <b>Restore from file…</b> for a backup kept somewhere else (e.g. a copy on OneDrive). You'll see what's in the backup
        and confirm first, and a safety backup of the current data is always taken, so a restore can itself be undone.</p>
    </div>
    <div class="card" style="margin-top:16px"><table class="log">
      <thead><tr><th>Created</th><th>Type</th><th>File</th><th>Size</th><th></th></tr></thead>
      <tbody>${list.map((b) => `<tr><td class="nowrap">${esc(fmtDateTime(b.created_at))}</td><td>${b.kind}</td>
        <td>${esc(b.file)}</td><td>${size(b.size)}</td>
        <td><button class="small" data-action="restore-listed" data-kind="${esc(b.kind)}" data-file="${esc(b.file)}">⤺ Restore</button></td></tr>`).join('')}</tbody></table>
      ${list.length ? '' : '<div class="empty">No backups yet.</div>'}</div>`;
}

// Restore: read the backup first (?check=1), show what's in it, and only replace
// the data once confirmed. `send(check)` posts the file or names the listed backup.
async function restoreFlow(label, send) {
  let info;
  try { info = await send(true); } catch (err) { toast(err.message, 'error'); return; }
  const c = info.counts;
  const line = (n, word) => `<b>${n}</b> ${word}${n === 1 ? '' : 's'}`;
  openModal(`
    <div class="modal-head"><h2 style="margin:0">⤺ Restore backup?</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p><b>${esc(label)}</b>${info.created ? `<br><span class="small muted">Backup taken ${esc(fmtDateTime(info.created))}</span>` : ''}</p>
    <p>It contains ${line(c.projects, 'project')}, ${line(c.tasks, 'task')}, ${line(c.notes, 'note')} and ${line(c.ideas, 'idea')}.</p>
    <p class="restore-warn">⚠ This <b>replaces all current data</b> with the backup's.
      A safety backup of the current data is taken first, so you can restore that if needed.</p>
    <div class="row" style="margin-top:12px"><div class="spacer"></div><button data-action="close-modal">Cancel</button>
      <button class="danger" id="restore-go">Replace all data</button></div>`);
  $('#restore-go').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Restoring…';
    try {
      const r = await send(false);
      closeModal();
      toast(r.problems ? `Restored, but ${r.problems} item(s) point at missing records` : 'Backup restored', r.problems ? 'error' : '');
      await loadProjects();
      await renderBackups();
      renderSidebar();
      pollAlerts();
    } catch (err) {
      toast(`Restore failed: ${err.message}`, 'error');
      e.target.disabled = false;
      e.target.textContent = 'Replace all data';
    }
  });
}

async function restoreUpload(file) {
  await restoreFlow(file.name, async (check) => {
    const res = await fetch(`/api/backups/restore${check ? '?check=1' : ''}`, { method: 'POST', body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(file.name) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return check && !data.created ? { ...data, created: new Date(file.lastModified).toISOString() } : data;
  });
}

async function renderSearch(q) {
  $('#search').value = q;
  const r = await api.get(`/search?q=${encodeURIComponent(q)}`);
  main().innerHTML = `<h1>Search: “${esc(q)}”</h1>
    <div class="grid dash">
      <div class="card"><h2>Projects</h2>${r.projects.length ? `<ul class="mini">${r.projects.map((p) => `<li><a href="#/project/${p.id}">${esc(p.name)}</a> <span class="small muted">${PSTATUS[p.status]}</span></li>`).join('')}</ul>` : '<div class="empty">None</div>'}</div>
      <div class="card"><h2>Tasks</h2>${r.tasks.length ? `<ul class="mini">${r.tasks.map(miniTask).join('')}</ul>` : '<div class="empty">None</div>'}</div>
      <div class="card"><h2>Ideas</h2>${r.ideas.length ? `<ul class="mini">${r.ideas.map((i) => `<li>
        <span class="t" data-action="open-idea" data-id="${i.id}"><b>${esc(i.ref)}</b> ${esc(i.title)}</span> ${ideaStatusPill(i.status)}</li>`).join('')}</ul>` : '<div class="empty">None</div>'}</div>
      <div class="card"><h2>Notes</h2>${r.notes.length ? `<ul class="mini">${r.notes.map((n) => `<li style="display:block">
        <div class="small muted">${esc(fmtDateTime(n.created_at))} · <a href="#/project/${n.project_id}">${esc(n.project_name)}</a></div>
        <div class="pre">${esc(n.body)}</div></li>`).join('')}</ul>` : '<div class="empty">None</div>'}</div>
    </div>`;
}

// ======================================================================
// Modals
// ======================================================================

const modal = () => $('#modal');
function openModal(html, opts = {}) {
  modal().classList.toggle('wide', !!opts.wide);
  $('#modal-body').innerHTML = html;
  if (!modal().open) modal().showModal();
}
function closeModal() { modal().close(); }
modal().addEventListener('close', () => { if (state.modalDirty) { state.modalDirty = false; refresh(); } });

async function projectForm(p = {}) {
  const isNew = !p.id;
  if (isNew) await loadLookups();
  openModal(`
    <div class="modal-head"><h2 style="margin:0">${isNew ? '📋 New project — charter' : 'Edit project'}</h2>
      <button class="icon" data-action="close-modal">✕</button></div>
    ${isNew ? '<p class="muted small" style="margin-top:0">Fields marked <span class="req">*</span> are needed to create the project; complete the rest of the charter (team, KPIs, scope, benefits) on its Charter tab.</p>' : ''}
    <form id="project-form" class="form-grid">
      ${isNew ? charterFieldsHtml() : `<label class="f full">Name<input type="text" name="name" required value="${esc(p.name)}"></label>`}
      <label class="f full">${isNew ? 'Notes / description (optional)' : 'Description'}<textarea name="description" rows="2">${esc(p.description)}</textarea></label>
      <label class="f">Priority<select name="priority">${options(PRIORITY, p.priority || 2)}</select></label>
      <label class="f">Start date<input type="date" name="start_date" value="${esc(p.start_date || (isNew ? new Date().toLocaleDateString('sv') : ''))}"></label>
      <label class="f">Due date<input type="date" name="due_at" value="${toDateInput(p.due_at)}"></label>
      <label class="f">Budget (${esc(state.settings.currency)})<input type="number" name="budget" min="0" step="0.01" value="${p.budget ?? ''}" placeholder="optional"></label>
      ${isNew ? `
        <label class="f full">Baseline tasks — one per line (you can add more at any time)
          <textarea name="baseline_tasks" rows="5" placeholder="Gather requirements&#10;Draft proposal&#10;Review with manager"></textarea></label>
        <label class="f full">First note (optional)<textarea name="initial_note" rows="2"></textarea></label>` : `
        <label class="f">Status<select name="status">${options(PSTATUS, p.status)}</select></label>
        <div class="f full small muted">Charter fields (problem, goals, sponsor, team, KPIs…) are edited on the project's <a href="#/project/${p.id}/charter" data-action="close-modal-go">📋 Charter</a> tab.</div>`}
      <div class="full row">
        ${isNew ? '' : '<button type="button" class="danger" data-action="delete-project">Delete project…</button>'}
        <div class="spacer"></div>
        <button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">${isNew ? 'Create project' : 'Save'}</button>
      </div>
    </form>`, { wide: isNew });
  $('#project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    f.due_at = f.due_at || null;
    f.priority = Number(f.priority);
    if (isNew) {
      f.baseline_tasks = f.baseline_tasks.split('\n');
      let created;
      try { created = await api.post('/projects', f); } catch (err) { toast(err.message, 'error'); return; }
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
  const [siblings, waitingNames, ownerNames, phases] = await Promise.all([
    t.project_id ? api.get(`/tasks?project_id=${t.project_id}`) : Promise.resolve([]), api.get('/tasks/waiting-names'),
    api.get(`/tasks/owner-names${t.project_id ? `?project_id=${t.project_id}` : ''}`),
    t.project_id ? api.get(`/projects/${t.project_id}/phases`) : Promise.resolve([])]);
  const projectChoices = state.projects.filter((x) => x.status !== 'archived' && x.status !== 'completed' || x.id === t.project_id);
  // Tasks this one could depend on: same project, not itself, its subtasks, or ones already linked.
  const below = new Set([t.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of siblings) if (s.parent_id && below.has(s.parent_id) && !below.has(s.id)) { below.add(s.id); grew = true; }
  }
  const linked = new Set(t.depends_on.map((d) => d.id));
  const candidates = siblings.filter((s) => !below.has(s.id) && !linked.has(s.id))
    .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
  const p = state.projects.find((x) => x.id === t.project_id);
  const baselineText = t.is_baseline ? '<span class="badge baseline">Baseline task</span>'
    : (p && p.baseline_set_at ? '<span class="badge added">Added after baseline</span>' : '');
  openModal(`
    <div class="modal-head">
      <div class="small muted">${t.project_id ? esc(t.project_name) : '✅ Tasks (no project)'}${t.parent_id ? ' · subtask' : ''} ${baselineText}</div>
      <div class="row"><span class="saved-flag" id="saved-flag">✓ Saved</span><button class="icon" data-action="close-modal">✕</button></div>
    </div>
    <div class="form-grid" id="task-form" data-id="${t.id}">
      <label class="f full">Title<input type="text" name="title" value="${esc(t.title)}"></label>
      <label class="f full">Description<textarea name="description" rows="3">${esc(t.description)}</textarea>${linkList(t.description)}</label>
      <label class="f">Status<select name="status">${options(STATUS, t.status)}</select></label>
      <label class="f">Priority<select name="priority">${options(PRIORITY, t.priority)}</select></label>
      <label class="f">Repeats<select name="recurrence">${options(REPEAT, t.recurrence)}</select></label>
      <label class="f">Start date<input type="date" name="start_date" value="${esc(t.start_date || '')}"></label>
      <label class="f">Due date<input type="date" name="due_at" value="${toDateInput(t.due_at)}"></label>
      <label class="f">Owner<input type="text" name="owner" list="owner-names" autocomplete="off" placeholder="who's responsible" value="${esc(t.owner)}"></label>
      <datalist id="owner-names">${ownerNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
      <label class="f">Waiting on<input type="text" name="waiting_on" list="waiting-names" autocomplete="off" placeholder="person or team" value="${esc(t.waiting_on)}"></label>
      ${t.parent_id ? '' : `<label class="f">Project<select name="project_id" title="Move this task (and its subtasks) to another project">
        <option value="">✅ Tasks (no project)</option>${projectChoices.map((x) => `<option value="${x.id}" ${x.id === t.project_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>`}
      ${phases.length && !t.parent_id ? `<label class="f">Phase<select name="phase_id" title="Which phase of the project this task (and its subtasks) belongs to">
        <option value="">— No phase —</option>${phases.map((ph, i) => `<option value="${ph.id}" ${ph.id === t.phase_id ? 'selected' : ''}>${i + 1}. ${esc(ph.name)}${ph.status === 'done' ? ' ✓' : ''}</option>`).join('')}</select></label>` : ''}
      ${t.parent_id && t.phase_name ? `<div class="f small muted" style="align-self:end">🧭 Phase: <b>${esc(t.phase_name)}</b> (from its parent task)</div>` : ''}
      <datalist id="waiting-names">${waitingNames.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    </div>
    ${t.waiting_on && t.waiting_since ? `<div class="small muted" style="margin-top:6px">⏳ Waiting on <b>${esc(t.waiting_on)}</b> since ${esc(fmtDate(t.waiting_since))} (${daysSince(t.waiting_since)} days)</div>` : ''}
    ${t.recurrence ? `<div class="small muted" style="margin-top:6px">🔁 Repeats ${esc(REPEAT[t.recurrence].toLowerCase())}: ticking it off creates the next one${t.next_task_id ? ' (next occurrence already created)' : ''}.</div>` : ''}
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

    ${t.project_id ? '' : `<div class="section row"><span class="small muted">Growing into something bigger?</span>
      <button data-action="promote-task" data-id="${t.id}">🚀 Promote to a project</button></div>`}
    ${!t.project_id ? '' : `<div class="section">
      <h3>Depends on <span class="muted small">— can't start until these are finished (shown as arrows on the Gantt chart)</span></h3>
      <ul class="mini">${t.depends_on.map((d) => `<li>
        <span class="t" data-action="open-task" data-id="${d.id}">${d.status === 'done' ? '✅' : '⏳'} ${esc(d.title)}</span> ${dueChip(d)}
        <button class="icon" data-action="remove-dep" data-id="${d.link_id}" title="Remove dependency">✕</button></li>`).join('') || '<li class="empty">Nothing</li>'}</ul>
      ${candidates.length ? `<select id="dep-add" style="margin-top:6px"><option value="">+ Add a task this depends on…</option>
        ${candidates.map((c) => `<option value="${c.id}">${c.parent_id ? '↳ ' : ''}${esc(c.title)}</option>`).join('')}</select>` : ''}
      ${t.blocking.length ? `<div class="small muted" style="margin-top:6px">Waiting for this task: ${t.blocking.map((b) =>
        `<a href="#" data-action="open-task" data-id="${b.id}">${esc(b.title)}</a>`).join(', ')}</div>` : ''}
    </div>`}

    <div class="section">
      <h3>Reminders</h3>
      <ul class="mini">${t.reminders.filter((r) => r.status === 'pending').map((r) => `<li>
        <span class="t">⏰ ${esc(fmtDateTime(r.remind_at))} <span class="muted small">(${fmtRelative(r.remind_at)})</span> ${r.message ? `— ${esc(r.message)}` : ''}</span>
        <button class="icon" data-action="delete-reminder" data-id="${r.id}" title="Delete">✕</button></li>`).join('') || '<li class="empty">None set</li>'}</ul>
      <button data-action="remind-task" data-id="${t.id}" style="margin-top:6px">🔔 Add reminder</button>
    </div>

    <div class="section">
      <h3>Notes</h3>
      <div class="quick-note"><textarea id="modal-note" placeholder="Add a note to this task… (Enter to save; [ ] lines become subtasks)"></textarea>
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
    if (['due_at', 'start_date', 'recurrence', 'waiting_on', 'project_id', 'owner', 'phase_id'].includes(el.name)) value = value || null;
    if ((el.name === 'project_id' || el.name === 'phase_id') && value) value = Number(value);
    if (el.name === 'priority') value = Number(value);
    if (el.name === 'title' && !value.trim()) { el.value = t.title; return; }
    try {
      const saved = await api.patch(`/tasks/${t.id}`, { [el.name]: value });
      state.modalDirty = true;
      if (saved.next_occurrence) toast(`🔁 Next one created, due ${fmtDate(saved.next_occurrence.due_at)}`);
      if (el.name === 'project_id') toast(value ? 'Moved to the project (counts as new scope there)' : 'Moved to ✅ Tasks');
      if (['waiting_on', 'recurrence', 'status', 'description', 'project_id'].includes(el.name)) return taskModal(t.id);
    } catch (err) {
      toast(err.message, 'error');
      return taskModal(t.id);
    }
    const flag = $('#saved-flag');
    flag.classList.add('show');
    setTimeout(() => flag.classList.remove('show'), 1200);
  }));
  $('#dep-add')?.addEventListener('change', async (e) => {
    if (!e.target.value) return;
    try {
      await api.post(`/tasks/${t.id}/dependencies`, { depends_on_id: Number(e.target.value) });
      state.modalDirty = true;
    } catch (err) { toast(err.message, 'error'); }
    await taskModal(t.id);
  });
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
  const note = await api.post('/notes', { task_id: taskId, body });
  if (note.created_tasks?.length) toast(noteToast(note).replace('tasks', 'subtasks').replace('task created', 'subtask created'));
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

// Quick note: goes onto an existing task, starts a new task (standalone or in a
// project), or onto a project as before. No project is needed.
async function quickNoteDialog() {
  const active = state.projects.filter((p) => p.status !== 'archived');
  const open = await api.get('/tasks?open=1');
  const byId = new Map(open.map((t) => [t.id, t]));
  const onProject = state.view === 'project' ? Number(state.projectId) : null;
  let mode = onProject ? 'project' : store.get('lastNoteMode', open.length ? 'task' : 'new');
  if (mode === 'task' && !open.length) mode = 'new';
  if (mode === 'project' && !active.length) mode = 'new';
  const lastTask = store.get('lastNoteTask');
  const taskLabel = (t) => `${t.parent_id && byId.get(t.parent_id) ? `↳ ${byId.get(t.parent_id).title} › ` : ''}${t.title}${t.due_at ? ` · due ${fmtDate(t.due_at)}` : ''}`;
  const taskOptions = (filter = '') => {
    const f = filter.trim().toLowerCase();
    const match = (t) => !f || taskLabel(t).toLowerCase().includes(f) || (t.project_name || '').toLowerCase().includes(f);
    const group = (label, list) => (list.length ? `<optgroup label="${esc(label)}">${list.map((t) =>
      `<option value="${t.id}" ${t.id === lastTask ? 'selected' : ''}>${esc(taskLabel(t))}</option>`).join('')}</optgroup>` : '');
    return group('Standalone tasks', open.filter((t) => !t.project_id && match(t)))
      + active.map((p) => group(p.name, open.filter((t) => t.project_id === p.id && match(t)))).join('');
  };
  const projectOptions = (selected) => active.map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  openModal(`
    <div class="modal-head"><h2 style="margin:0">📝 Quick note</h2><button class="icon" data-action="close-modal">✕</button></div>
    <div class="row"><span class="small muted">Add to</span><div class="seg" id="qn-mode">
      <button type="button" data-mode="task" ${open.length ? '' : 'disabled'}>Existing task</button>
      <button type="button" data-mode="new">New task</button>
      <button type="button" data-mode="project" ${active.length ? '' : 'disabled'}>Project</button></div></div>
    <div data-pane="task" style="margin-top:10px">
      <input id="qn-filter" placeholder="Filter tasks…" autocomplete="off" style="width:100%">
      <select id="qn-task" size="7" style="width:100%;margin-top:6px">${taskOptions()}</select></div>
    <div data-pane="new" style="margin-top:10px">
      <label class="f">New task title<input id="qn-title" placeholder="Blank = first line of the note · e.g. Call supplier !high @fri"></label>
      <label class="f" style="margin-top:8px">Project<select id="qn-new-project"><option value="">— None (standalone task) —</option>${projectOptions(onProject)}</select></label></div>
    <div data-pane="project" style="margin-top:10px">
      <label class="f">Project<select id="qn-project">${projectOptions(onProject || store.get('lastNoteProject'))}</select></label></div>
    <label class="f" style="margin-top:10px">Note — time-stamped automatically<textarea id="qn-body" rows="5" placeholder="What happened? (Ctrl+Enter to save; lines starting [ ] become tasks)"></textarea></label>
    <div class="row" style="margin-top:12px"><div class="spacer"></div><button data-action="close-modal">Cancel</button>
      <button class="primary" id="qn-save">Save note</button></div>`);
  const setMode = (m) => {
    mode = m;
    $$('#qn-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $$('[data-pane]').forEach((el) => { el.hidden = el.dataset.pane !== m; });
    const hint = { task: '[ ] lines become subtasks', new: '[ ] lines become subtasks of the new task', project: '[ ] lines become tasks' }[m];
    $('#qn-body').placeholder = `What happened? (Ctrl+Enter to save; ${hint})`;
  };
  setMode(mode);
  if (!$('#qn-task').value && $('#qn-task').options.length) $('#qn-task').selectedIndex = 0;
  $('#qn-mode').addEventListener('click', (e) => { const b = e.target.closest('button[data-mode]'); if (b && !b.disabled) setMode(b.dataset.mode); });
  $('#qn-filter').addEventListener('input', (e) => {
    const keep = $('#qn-task').value;
    $('#qn-task').innerHTML = taskOptions(e.target.value);
    $('#qn-task').value = keep;
    if (!$('#qn-task').value && $('#qn-task').options.length) $('#qn-task').selectedIndex = 0;
  });
  const save = async () => {
    const body = $('#qn-body').value.trim();
    if (!body) { $('#qn-body').focus(); return; }
    let payload;
    if (mode === 'task') {
      const taskId = Number($('#qn-task').value);
      if (!taskId) { toast('Pick a task'); return; }
      payload = { task_id: taskId };
      store.set('lastNoteTask', taskId);
    } else if (mode === 'new') {
      const title = $('#qn-title').value.trim() || body.split(/\r?\n/)[0].replace(/^\s*[-*•]?\s*\[\s?\]\s*/, '').slice(0, 120);
      payload = { new_task: { title, project_id: Number($('#qn-new-project').value) || null } };
    } else {
      payload = { project_id: Number($('#qn-project').value) };
      store.set('lastNoteProject', payload.project_id);
    }
    const note = await api.post('/notes', { ...payload, body });
    if (!onProject) store.set('lastNoteMode', mode);
    toast(note.task ? `Task “${note.task.title}” created with the note` : noteToast(note));
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
  const saved = await api.patch(`/tasks/${id}`, { status, cascade });
  if (saved.next_occurrence) toast(`🔁 Repeating task — next one due ${fmtDate(saved.next_occurrence.due_at)}`);
  if (modal().open) { state.modalDirty = true; await taskModal($('#task-form')?.dataset.id || id); } else await refresh();
}

const actions = {
  'toggle-sidebar': () => document.body.classList.toggle('sidebar-open'),
  'new-project': () => projectForm(),
  'edit-project': () => projectForm(state.project),
  'add-phase': () => phaseDialog(state.project, null),
  'edit-phase': (el) => phaseDialog(state.project, state.project.charter.phases.find((ph) => String(ph.id) === el.dataset.id)),
  'close-modal': () => closeModal(),
  'quick-note': () => quickNoteDialog(),
  'save-note': () => saveProjectNote(),
  'save-task-note': (el) => saveTaskNote(el.dataset.id),
  'open-task': (el) => taskModal(el.dataset.id),
  'toggle-task': (el) => setTaskStatus(el.dataset.id, el.checked ? 'done' : 'todo', Number(el.dataset.subs || 0)),
  'toggle-hide-done': (el) => { store.set('hideDone', el.checked); route(); },
  'tasks-view': (el) => { store.set('tasksView', el.dataset.view); route(); },
  'standalone-view': (el) => { store.set('standaloneView', el.dataset.view); route(); },
  'toggle-hide-done-standalone': (el) => { store.set('hideDoneStandalone', el.checked); route(); },
  'promote-task': async (el) => { const t = await api.get(`/tasks/${el.dataset.id}`); promoteDialog(t); },
  'print-charter': () => printCharter(),
  'close-modal-go': (el) => { closeModal(); location.hash = el.getAttribute('href'); },
  'del-team': async (el) => { await api.del(`/team/${el.dataset.id}`); route(); },
  'del-kpi': async (el) => { await api.del(`/kpis/${el.dataset.id}`); route(); },
  'projects-view': (el) => { store.set('projectsView', el.dataset.view); route(); },
  'ideas-view': (el) => { store.set('ideaFilter', { ...store.get('ideaFilter', {}), view: el.dataset.view }); route(); },
  'log-cost': () => costDialog(state.project),
  'toggle-costs': () => { store.set('showCosts', !store.get('showCosts', false)); route(); },
  'delete-cost': async (el) => {
    if (!confirm('Delete this cost? (The activity log keeps a record.)')) return;
    await api.del(`/costs/${el.dataset.id}`);
    await refresh();
  },
  'remove-dep': async (el) => {
    await api.del(`/task-links/${el.dataset.id}`);
    state.modalDirty = true;
    await taskModal($('#task-form').dataset.id);
  },
  'open-path': async (el) => {
    const p = el.dataset.path;
    try {
      const r = await api.post('/open-path', { path: p });
      if (r.opened) { toast('Opened in File Explorer'); return; }
    } catch (err) { toast(err.message, 'error'); }
    try { await navigator.clipboard.writeText(p); toast('Path copied — paste it into File Explorer'); } catch { /* clipboard unavailable */ }
  },
  'dash-jump': (el) => {
    if (el.dataset.target === 'ideas') { location.hash = '#/ideas'; return; }
    $(`#${el.dataset.target}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'open-project': (el) => { location.hash = `#/project/${el.dataset.id}`; },
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
  'restore-pick': () => {
    const input = $('#restore-file');
    input.value = '';
    input.onchange = () => { if (input.files[0]) restoreUpload(input.files[0]); };
    input.click();
  },
  'restore-listed': (el) => restoreFlow(el.dataset.file, (check) =>
    api.post(`/backups/${encodeURIComponent(el.dataset.kind)}/${encodeURIComponent(el.dataset.file)}/restore${check ? '?check=1' : ''}`)),
  'backup-now': async (el) => {
    el.disabled = true;
    try {
      const r = await api.post('/backups');
      toast('Backup done');
      await renderBackups();
    } finally { el.disabled = false; }
  },
  'enable-notifications': () => ensureNotificationPermission(true),
  'new-idea': () => ideaForm(),
  'open-idea': (el) => { location.hash = `#/idea/${el.dataset.id}`; },
  'escalate-idea': () => escalateDialog(state.idea),
  'save-idea-note': () => saveIdeaNote(),
  'delete-idea': async () => {
    const i = state.idea;
    if (!confirm(`Delete ${i.ref} "${i.title}" and its notes? (The activity log keeps a record.)`)) return;
    await api.del(`/ideas/${i.id}`);
    toast(`${i.ref} deleted`);
    location.hash = '#/ideas';
  },
  'delete-idea-note': async (el) => {
    if (!confirm('Delete this note? (The activity log keeps a copy.)')) return;
    await api.del(`/idea-notes/${el.dataset.id}`);
    await renderIdea(state.idea.id);
  },
  'goto-settings': () => { closeModal(); location.hash = '#/settings'; },
  'add-area': async () => {
    const input = $('#new-area');
    if (!input.value.trim()) return;
    await api.post('/areas', { name: input.value });
    toast('Area added');
    await renderSettings();
    $('#new-area').focus();
  },
  'delete-area': async (el) => {
    if (!confirm('Delete this area?')) return;
    await api.del(`/areas/${el.dataset.id}`);
    await renderSettings();
  },
  'stop-server': async () => {
    if (!confirm('Stop the CI Manager? Reminders won\'t pop up until you start it again.')) return;
    await api.post('/shutdown');
    document.body.innerHTML = `<div class="card" style="margin:40px auto;max-width:480px">
      <h2>CI Manager stopped</h2>
      <p>Start it again by double-clicking <b>start-hidden.vbs</b> (or <b>start.bat</b>) in the app folder.</p></div>`;
  },
};

async function runAction(el, e) {
  const fn = actions[el.dataset.action];
  if (!fn) return;
  try { await fn(el, e); } catch (err) { toast(err.message, 'error'); }
}

document.addEventListener('click', (e) => {
  const link = e.target.closest('a[href]');
  if (link && !link.dataset.action) return; // plain links (e.g. inside a clickable row) navigate normally
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
  const addTask = $('#add-task-input') || $('#board-add');
  if (e.key === 't' && addTask) { e.preventDefault(); addTask.focus(); }
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

  // Due-date alerts: pop up once when a task is due today, and again once it's overdue.
  for (const t of a.due_tasks) {
    const days = dayDiff(t.due_at);
    if (days > 0) continue;
    const overdue = days < 0;
    const key = `due-${t.id}-${t.due_at}-${overdue ? 'over' : 'today'}`;
    if (seenDue[key]) continue;
    liveKeys.add(key);
    const title = `${overdue ? '⚠ Overdue' : '⏳ Due today'}: ${t.title}`;
    const body = `${t.project_name}\nDue ${fmtDate(t.due_at)} (${dueLabel(t.due_at)})`;
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
  document.title = count ? `(${count}) CI Manager` : 'CI Manager';
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
  try {
    [state.settings] = await Promise.all([api.get('/settings'), loadProjects()]);
  } catch (err) { toast(err.message, 'error'); }
  await route();
  pollAlerts();
  setInterval(pollAlerts, 30000);
})();
