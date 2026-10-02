'use strict';
// 📅 Calendar: the app's own meetings in month, week and day views. Click a meeting to
// open it, click an empty slot to add one, drag to reschedule, drag the bottom edge
// (week/day) to change its length. Loaded before app.js; uses its helpers.

const CAL_HOUR_PX = 48; // height of one hour in week/day view
const CAL_SNAP = 15; // minutes
const calDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const calAddDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const calMonday = (d) => calAddDays(calDay(d), -((new Date(d).getDay() + 6) % 7));
const calTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const calSameDay = (a, b) => dateKey(a) === dateKey(b);

// One colour per project (and grey for meetings of their own).
function calColour(m) {
  if (!m.project_id) return '#7a8496';
  const hues = [212, 145, 28, 280, 350, 180, 48, 255, 100, 320];
  return `hsl(${hues[m.project_id % hues.length]}, 62%, 48%)`;
}

function calRange(view, anchor) {
  if (view === 'month') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const start = calMonday(first);
    return [start, calAddDays(start, 42)];
  }
  if (view === 'week') { const start = calMonday(anchor); return [start, calAddDays(start, 7)]; }
  const start = calDay(anchor);
  return [start, calAddDays(start, 1)];
}

async function renderCalendar() {
  const view = store.get('calView', 'week');
  const anchor = new Date(`${store.get('calDate', dateKey(new Date()))}T12:00`);
  const filter = store.get('calProject', '');
  const [from, to] = calRange(view, anchor);
  let meetings = await api.get(`/meetings?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
  if (filter === 'none') meetings = meetings.filter((m) => !m.project_id);
  else if (filter) meetings = meetings.filter((m) => String(m.project_id) === filter);
  const title = view === 'month' ? anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : view === 'week' ? `${from.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${calAddDays(to, -1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`
      : anchor.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const projects = state.projects.filter((p) => p.status !== 'archived');
  const shown = new Map(meetings.map((m) => [m.project_id || 0, m.project_name || 'No project']));
  main().innerHTML = `
    <div class="kanban-tools cal-tools">
      <h1 style="margin:0">📅 Calendar</h1>
      <div class="row" style="gap:4px"><button data-cal-nav="-1" title="Previous (←)">‹</button><button data-cal-nav="0">Today</button>
        <button data-cal-nav="1" title="Next (→)">›</button></div>
      <h2 class="cal-title">${esc(title)}</h2>
      <div class="spacer"></div>
      <select id="cal-project" title="Show meetings of">
        <option value="">All meetings</option><option value="none" ${filter === 'none' ? 'selected' : ''}>No project</option>
        ${projects.map((p) => `<option value="${p.id}" ${String(p.id) === filter ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <div class="seg" role="group">${['month', 'week', 'day'].map((v) =>
        `<button data-cal-view="${v}" class="${view === v ? 'on' : ''}">${v[0].toUpperCase()}${v.slice(1)}</button>`).join('')}</div>
      <button class="primary" data-cal-new>＋ Meeting</button>
    </div>
    ${shown.size ? `<div class="cal-legend small">${[...shown].map(([id, name]) =>
      `<span><i style="background:${calColour({ project_id: id })}"></i>${esc(name)}</span>`).join('')}</div>` : ''}
    <div class="card cal-card" id="cal-root"></div>
    <div class="small muted" style="margin-top:6px">Click a meeting to open it · click an empty ${view === 'month' ? 'day' : 'time'} to add one ·
      drag to move${view === 'month' ? '' : ' · drag the bottom edge to change the length'}</div>`;
  const root = $('#cal-root');
  if (view === 'month') calMonth(root, anchor, from, meetings); else calWeek(root, from, view === 'week' ? 7 : 1, meetings);

  const go = (date, v = view) => { store.set('calDate', dateKey(date)); store.set('calView', v); renderCalendar(); };
  $$('[data-cal-nav]').forEach((b) => b.addEventListener('click', () => {
    const n = Number(b.dataset.calNav);
    if (!n) return go(new Date());
    if (view === 'month') return go(new Date(anchor.getFullYear(), anchor.getMonth() + n, 1));
    return go(calAddDays(anchor, n * (view === 'week' ? 7 : 1)));
  }));
  $$('[data-cal-view]').forEach((b) => b.addEventListener('click', () => go(anchor, b.dataset.calView)));
  $('#cal-project').addEventListener('change', (e) => { store.set('calProject', e.target.value); renderCalendar(); });
  $('[data-cal-new]').addEventListener('click', () => calNew(calDay(view === 'month' && !calSameDay(anchor, new Date()) ? anchor : new Date()), true));
  root.addEventListener('click', (e) => {
    const day = e.target.closest('[data-cal-goto]');
    if (day) { e.stopPropagation(); go(new Date(`${day.dataset.calGoto}T12:00`), 'day'); }
  });
}

// New meeting at a day (09:00, or the next half hour today) or an exact time.
function calNew(when, dayOnly) {
  const at = new Date(when);
  if (dayOnly) {
    const now = new Date();
    if (calSameDay(at, now) && now.getHours() >= 9) at.setHours(now.getHours() + (now.getMinutes() >= 30 ? 1 : 0), now.getMinutes() >= 30 ? 0 : 30, 0, 0);
    else at.setHours(9, 0, 0, 0);
  }
  const filter = store.get('calProject', '');
  newMeetingDialog({ at: at.toISOString(), pickProject: true, projectId: filter && filter !== 'none' ? Number(filter) : null });
}

async function calMove(m, start, duration) {
  const body = {};
  if (start && start.toISOString() !== new Date(m.held_at).toISOString()) body.held_at = start.toISOString();
  if (duration && duration !== m.duration_min) body.duration_min = duration;
  if (!Object.keys(body).length) return renderCalendar();
  try {
    await api.patch(`/meetings/${m.id}`, body);
    const s = start || new Date(m.held_at);
    toast(`“${m.title}” ${s.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${calTime(s)}–${calTime(new Date(s.getTime() + (duration || m.duration_min) * 60000))}`);
  } catch (err) { toast(err.message, 'error'); }
  renderCalendar();
}

const calTip = (m) => [m.title, `${calTime(new Date(m.held_at))}–${calTime(meetingEnd(m))}`, m.project_name || 'No project',
  m.task_title && `re: ${m.task_title}`, m.location && `📍 ${m.location}`, m.attendees && `👥 ${m.attendees}`,
  m.action_count && `☑ ${m.actions_done}/${m.action_count} actions`].filter(Boolean).join('\n');

// ---- month -----------------------------------------------------------------------------

function calMonth(root, anchor, start, meetings) {
  const today = new Date();
  const days = Array.from({ length: 42 }, (_, i) => calAddDays(start, i));
  const byDay = new Map();
  for (const m of meetings) {
    const k = dateKey(new Date(m.held_at));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(m);
  }
  const names = Array.from({ length: 7 }, (_, i) => calAddDays(start, i).toLocaleDateString(undefined, { weekday: 'short' }));
  root.innerHTML = `<div class="cal-month">${names.map((n) => `<div class="cal-dow">${esc(n)}</div>`).join('')}
    ${days.map((d) => {
      const list = byDay.get(dateKey(d)) || [];
      const more = list.length > 4 ? list.length - 3 : 0;
      return `<div class="cal-cell ${d.getMonth() !== anchor.getMonth() ? 'other' : ''} ${calSameDay(d, today) ? 'today' : ''}
          ${d.getDay() === 0 || d.getDay() === 6 ? 'weekend' : ''}" data-day="${dateKey(d)}">
        <button class="cal-date" data-cal-goto="${dateKey(d)}" title="Open the day">${d.getDate()}</button>
        ${(more ? list.slice(0, 3) : list).map((m) => `<div class="cal-ev" draggable="true" data-id="${m.id}" style="--c:${calColour(m)}" title="${esc(calTip(m))}">
          <b>${calTime(new Date(m.held_at))}</b> ${esc(m.title)}</div>`).join('')}
        ${more ? `<button class="link small cal-more" data-cal-goto="${dateKey(d)}">+${more} more</button>` : ''}
      </div>`;
    }).join('')}</div>`;
  const find = (id) => meetings.find((m) => String(m.id) === String(id));
  root.addEventListener('click', (e) => {
    const ev = e.target.closest('.cal-ev');
    if (ev) return meetingEditor(ev.dataset.id);
    const cell = e.target.closest('.cal-cell');
    if (cell && !e.target.closest('button')) calNew(new Date(`${cell.dataset.day}T12:00`), true);
  });
  root.addEventListener('dragstart', (e) => {
    const ev = e.target.closest('.cal-ev');
    if (!ev) return;
    e.dataTransfer.setData('text/plain', ev.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
  });
  root.addEventListener('dragover', (e) => {
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    e.preventDefault();
    $$('.cal-cell.drop', root).forEach((c) => c !== cell && c.classList.remove('drop'));
    cell.classList.add('drop');
  });
  root.addEventListener('drop', (e) => {
    const cell = e.target.closest('.cal-cell');
    const m = find(e.dataTransfer.getData('text/plain'));
    if (!cell || !m) return;
    e.preventDefault();
    const old = new Date(m.held_at);
    const [y, mo, d] = cell.dataset.day.split('-').map(Number);
    calMove(m, new Date(y, mo - 1, d, old.getHours(), old.getMinutes()));
  });
}

// ---- week / day --------------------------------------------------------------------------

// Side-by-side columns for meetings that overlap.
function calLayout(list) {
  const items = list.map((m) => ({ m, s: new Date(m.held_at).getTime(), e: meetingEnd(m).getTime() })).sort((a, b) => a.s - b.s || b.e - a.e);
  let group = [];
  let groupEnd = 0;
  const flush = () => {
    const cols = [];
    for (const it of group) {
      let c = cols.findIndex((end) => end <= it.s);
      if (c < 0) { c = cols.length; cols.push(0); }
      cols[c] = it.e;
      it.col = c;
    }
    for (const it of group) it.cols = cols.length;
    group = [];
  };
  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    group.push(it);
    groupEnd = Math.max(groupEnd, it.e);
  }
  flush();
  return items;
}

function calWeek(root, start, count, meetings) {
  const days = Array.from({ length: count }, (_, i) => calAddDays(start, i));
  const today = new Date();
  // Hours shown: 07:00–19:00, widened to fit the meetings in view.
  let first = 7;
  let last = 19;
  for (const m of meetings) {
    const s = new Date(m.held_at);
    const e = meetingEnd(m);
    if (days.some((d) => calSameDay(d, s))) {
      first = Math.min(first, s.getHours());
      last = Math.max(last, calSameDay(s, e) ? Math.ceil(e.getHours() + e.getMinutes() / 60) : 24);
    }
  }
  const hours = Array.from({ length: last - first }, (_, i) => first + i);
  const px = (min) => (min / 60) * CAL_HOUR_PX;
  const colHtml = (d) => {
    const list = meetings.filter((m) => calSameDay(new Date(m.held_at), d));
    const blocks = calLayout(list).map(({ m, col, cols }) => {
      const s = new Date(m.held_at);
      const top = px((s.getHours() - first) * 60 + s.getMinutes());
      const end = Math.min(px((last - first) * 60), top + px(m.duration_min || 60));
      const h = Math.max(18, end - top - 2);
      return `<div class="cal-block ${h < 34 ? 'short' : ''}" data-id="${m.id}" style="--c:${calColour(m)};top:${top}px;height:${h}px;
          left:calc(${(col / cols) * 100}% + 2px);width:calc(${100 / cols}% - 4px)" title="${esc(calTip(m))}">
        <div class="cal-block-time">${calTime(s)}–${calTime(meetingEnd(m))}</div><div class="cal-block-title">${esc(m.title)}</div>
        ${m.project_name ? `<div class="cal-block-sub">${esc(m.project_name)}</div>` : ''}${m.location ? `<div class="cal-block-sub">📍 ${esc(m.location)}</div>` : ''}
        <div class="cal-resize" title="Drag to change the length"></div></div>`;
    }).join('');
    const now = calSameDay(d, today) && today.getHours() >= first && today.getHours() < last
      ? `<div class="cal-now" style="top:${px((today.getHours() - first) * 60 + today.getMinutes())}px"></div>` : '';
    return `<div class="cal-col ${calSameDay(d, today) ? 'today' : ''}" data-day="${dateKey(d)}" style="height:${px(hours.length * 60)}px">${blocks}${now}</div>`;
  };
  root.innerHTML = `<div class="cal-week" style="--days:${count}">
    <div class="cal-corner"></div>
    ${days.map((d) => `<button class="cal-head ${calSameDay(d, today) ? 'today' : ''}" data-cal-goto="${dateKey(d)}">
      <span>${esc(d.toLocaleDateString(undefined, { weekday: 'short' }))}</span><b>${d.getDate()}</b></button>`).join('')}
    <div class="cal-hours">${hours.map((h) => `<div style="height:${CAL_HOUR_PX}px">${pad(h)}:00</div>`).join('')}</div>
    ${days.map(colHtml).join('')}
  </div>`;
  const grid = $('.cal-week', root);
  grid.style.setProperty('--hour', `${CAL_HOUR_PX}px`);
  const cols = $$('.cal-col', root);
  const find = (id) => meetings.find((m) => String(m.id) === String(id));
  const snap = (min) => Math.round(min / CAL_SNAP) * CAL_SNAP;
  const minutesAt = (col, y) => snap(((y - col.getBoundingClientRect().top) / CAL_HOUR_PX) * 60) + first * 60;
  const dayDate = (col, min) => {
    const [y, mo, d] = col.dataset.day.split('-').map(Number);
    return new Date(y, mo - 1, d, 0, Math.max(0, Math.min(24 * 60 - CAL_SNAP, min)));
  };

  // Pointer handling: click opens / creates; drag moves; dragging the bottom edge resizes.
  let act = null;
  grid.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const block = e.target.closest('.cal-block');
    const col = e.target.closest('.cal-col');
    if (block) {
      e.preventDefault();
      const m = find(block.dataset.id);
      const s = new Date(m.held_at);
      act = { kind: e.target.closest('.cal-resize') ? 'resize' : 'move', m, block, x: e.clientX, y: e.clientY, moved: false,
        grab: (s.getHours() * 60 + s.getMinutes()) - minutesAt(block.parentElement, e.clientY) };
    } else if (col) act = { kind: 'new', col, y: e.clientY };
  });
  document.addEventListener('mousemove', calMouseMove);
  document.addEventListener('mouseup', calMouseUp);
  function calMouseMove(e) {
    if (!act || act.kind === 'new') return;
    if (Math.abs(e.clientX - act.x) + Math.abs(e.clientY - act.y) > 4) act.moved = true;
    if (!act.moved) return;
    act.block.classList.add('dragging');
    if (act.kind === 'resize') {
      // The original length plus how far the edge has been dragged, in 15-minute steps.
      const delta = snap(((e.clientY - act.y) / CAL_HOUR_PX) * 60);
      act.duration = Math.min(1440, Math.max(CAL_SNAP, (act.m.duration_min || 60) + delta));
      act.block.style.height = `${px(act.duration) - 2}px`;
      $('.cal-block-time', act.block).textContent = `${calTime(new Date(act.m.held_at))}–${calTime(new Date(new Date(act.m.held_at).getTime() + act.duration * 60000))}`;
      return;
    }
    const col = cols.find((c) => { const r = c.getBoundingClientRect(); return e.clientX >= r.left && e.clientX < r.right; }) || act.block.parentElement;
    if (col !== act.block.parentElement) col.append(act.block);
    const min = Math.max(first * 60, Math.min(last * 60 - CAL_SNAP, minutesAt(col, e.clientY) + act.grab));
    act.start = dayDate(col, snap(min));
    act.block.style.top = `${px(min - first * 60)}px`;
    act.block.style.left = '2px';
    act.block.style.width = 'calc(100% - 4px)';
    $('.cal-block-time', act.block).textContent = `${calTime(act.start)}–${calTime(new Date(act.start.getTime() + (act.m.duration_min || 60) * 60000))}`;
  }
  function calMouseUp(e) {
    if (!document.body.contains(grid)) { // this view has been redrawn or left
      document.removeEventListener('mousemove', calMouseMove);
      document.removeEventListener('mouseup', calMouseUp);
      return;
    }
    if (!act) return;
    const a = act;
    act = null;
    if (a.kind === 'new') {
      if (Math.abs(e.clientY - a.y) < 5 && e.target.closest('.cal-col') === a.col) calNew(dayDate(a.col, Math.floor(minutesAt(a.col, a.y - 12) / 30) * 30), false);
      return;
    }
    if (!a.moved) return meetingEditor(a.m.id);
    if (a.kind === 'resize') return calMove(a.m, null, a.duration);
    return calMove(a.m, a.start, null);
  }
  // Start the day view / week view scrolled near the working day or the first meeting.
  const firstMeeting = meetings.map((m) => new Date(m.held_at)).filter((d) => days.some((x) => calSameDay(x, d))).sort((a, b) => a - b)[0];
  const focus = Math.max(first, Math.min(firstMeeting ? firstMeeting.getHours() : 8, today.getHours() - 1));
  main().scrollTop = Math.max(0, root.getBoundingClientRect().top + main().scrollTop - main().getBoundingClientRect().top + px((focus - first) * 60) - 80);
}

// ← / → page through the calendar.
document.addEventListener('keydown', (e) => {
  if (state.view !== 'calendar' || e.ctrlKey || e.altKey || e.metaKey || $('dialog[open]')) return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    $(`[data-cal-nav="${e.key === 'ArrowLeft' ? -1 : 1}"]`)?.click();
  }
});
