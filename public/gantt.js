'use strict';
// Gantt chart: one renderer used for a project's tasks and for the portfolio of
// projects. Bars run from start to due date; a thin grey bar underneath shows the
// baseline plan; arrows show dependencies (red when a task starts before the
// task it depends on is due); drag a bar to move it, drag its ends to resize.
// Loaded before app.js; uses its helpers (esc, api, dateKey, …) at call time.

const GANTT_PX = { day: 32, week: 14, month: 4 };
const GANTT_ZOOM_LABEL = { day: 'Days', week: 'Weeks', month: 'Months' };
const DAY_MS = 86400000;
const ROW_H = 34;

const gDate = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };
const gAdd = (key, n) => { const d = gDate(key); d.setDate(d.getDate() + n); return dateKey(d); };
const gDiff = (a, b) => Math.round((gDate(b) - gDate(a)) / DAY_MS); // days from a to b
const gFmt = (key) => gDate(key).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const gDays = (n) => `${n} day${n === 1 ? '' : 's'}`;

let ganttTip;
function tipShow(html, e) {
  if (!ganttTip) {
    ganttTip = document.createElement('div');
    ganttTip.className = 'gantt-tip';
    document.body.append(ganttTip);
  }
  ganttTip.innerHTML = html;
  ganttTip.hidden = false;
  const pad = 14;
  const { innerWidth: w, innerHeight: h } = window;
  const r = ganttTip.getBoundingClientRect();
  ganttTip.style.left = `${Math.min(e.clientX + pad, w - r.width - 8)}px`;
  ganttTip.style.top = `${e.clientY + pad + r.height > h ? e.clientY - r.height - pad : e.clientY + pad}px`;
}
const tipHide = () => { if (ganttTip) ganttTip.hidden = true; };

/**
 * rows: [{ id, label (html), indent, start, end ('YYYY-MM-DD'; start null = milestone at end),
 *          cls, progress (0..1 or null), baseline: { start, end } | null, tip (html), draggable }]
 * opts: { key (zoom memory), links: [{ from, to }], markers: [{ date, label, cls }],
 *         legend (html), onOpen(row), onMove(row, start, end) -> Promise }
 */
function renderGantt(root, rows, opts = {}) {
  const zoomKey = `ganttZoom:${opts.key || 'default'}`;
  const zoom = store.get(zoomKey, 'week');
  const px = GANTT_PX[zoom] || GANTT_PX.week;
  const today = dateKey(new Date());

  // ---- range: everything shown, padded, aligned to a Monday (or the 1st in month view)
  const dates = [today];
  for (const r of rows) {
    dates.push(r.end);
    if (r.start) dates.push(r.start);
    if (r.baseline) dates.push(...[r.baseline.start, r.baseline.end].filter(Boolean));
  }
  for (const m of opts.markers || []) dates.push(m.date);
  dates.sort();
  let from = gAdd(dates[0], -7);
  let to = gAdd(dates[dates.length - 1], 21);
  if (zoom === 'month') { const d = gDate(from); d.setDate(1); from = dateKey(d); } else {
    const d = gDate(from);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    from = dateKey(d);
  }
  if (gDiff(from, to) < 56) to = gAdd(from, 56);
  const total = gDiff(from, to) + 1;
  const W = total * px;
  const x = (key) => gDiff(from, key) * px;

  // ---- scale: months row + (days | weeks) row
  const months = [];
  for (let d = gDate(from); d <= gDate(to); d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const k = dateKey(d);
    const next = dateKey(new Date(d.getFullYear(), d.getMonth() + 1, 1));
    const left = Math.max(0, x(k));
    const right = Math.min(W, x(next));
    months.push(`<div class="g-month" style="left:${left}px;width:${right - left}px"><span>${esc(d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}</span></div>`);
  }
  const ticks = [];
  if (zoom === 'day') {
    for (let i = 0; i < total; i++) {
      const d = gDate(gAdd(from, i));
      const we = d.getDay() === 0 || d.getDay() === 6;
      ticks.push(`<div class="g-tick ${we ? 'we' : ''}" style="left:${i * px}px;width:${px}px">${d.getDate()}</div>`);
    }
  } else if (zoom === 'week') {
    for (let i = 0; i < total; i += 7) {
      ticks.push(`<div class="g-tick" style="left:${i * px}px;width:${7 * px}px">${gDate(gAdd(from, i)).getDate()}</div>`);
    }
  }

  // ---- rows
  const rowIndex = new Map(rows.map((r, i) => [String(r.id), i]));
  const conflicts = new Set();
  for (const l of opts.links || []) {
    const a = rows[rowIndex.get(String(l.from))];
    const b = rows[rowIndex.get(String(l.to))];
    if (a && b && (b.start || b.end) <= a.end) conflicts.add(String(l.to));
  }
  const bar = (r) => {
    const base = r.baseline && r.baseline.end ? (() => {
      const bs = r.baseline.start || r.baseline.end;
      return `<div class="g-base" style="left:${x(bs)}px;width:${(gDiff(bs, r.baseline.end) + 1) * px}px"></div>`;
    })() : '';
    const slip = r.baseline && r.baseline.end ? gDiff(r.baseline.end, r.end) : 0;
    const slipLabel = slip ? `<span class="g-slip" style="left:${x(r.end) + px + 4}px" title="${slip > 0 ? 'Later' : 'Earlier'} than the baseline">${slip > 0 ? '▲ +' : '▼ '}${slip}d</span>` : '';
    if (!r.start) {
      return `${base}<div class="g-ms ${r.cls || ''} ${r.draggable ? 'drag' : ''}" data-row="${esc(r.id)}" style="left:${x(r.end) + px / 2 - 8}px"></div>${slipLabel}`;
    }
    const width = (gDiff(r.start, r.end) + 1) * px;
    return `${base}<div class="g-bar ${r.cls || ''} ${r.draggable ? 'drag' : ''}" data-row="${esc(r.id)}" style="left:${x(r.start)}px;width:${width}px">
        ${r.progress !== null && r.progress !== undefined ? `<span class="g-prog" style="width:${Math.round(r.progress * 100)}%"></span>` : ''}
        ${r.draggable ? '<span class="g-h l"></span><span class="g-h r"></span>' : ''}
        <span class="g-text">${r.barText ?? ''}</span></div>${slipLabel}`;
  };
  const weekend = zoom === 'month' ? '' : `background-image:linear-gradient(90deg, transparent ${5 * px}px, var(--g-weekend) ${5 * px}px, var(--g-weekend) ${7 * px}px);background-size:${7 * px}px 100%;`;

  root.innerHTML = `
    <div class="gantt-toolbar">
      <div class="seg" role="group" aria-label="Zoom">${Object.entries(GANTT_ZOOM_LABEL).map(([z, l]) =>
        `<button data-zoom="${z}" class="${z === zoom ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button class="link small" data-g="today">Scroll to today</button>
      <div class="spacer"></div>
      <div class="gantt-legend small">${opts.legend || ''}</div>
    </div>
    <div class="gantt"><div class="g-scroll"><div class="g-inner" style="width:calc(var(--g-label) + ${W}px)">
      <div class="g-head">
        <div class="g-corner">${esc(opts.labelHeader || 'Task')}</div>
        <div class="g-scale" style="width:${W}px"><div class="g-months">${months.join('')}</div><div class="g-ticks">${ticks.join('')}</div></div>
      </div>
      <div class="g-body">
        ${rows.map((r) => `<div class="g-row">
          <div class="g-label" style="padding-left:${10 + (r.indent || 0) * 18}px" data-open="${esc(r.id)}" title="Open">
            ${conflicts.has(String(r.id)) ? '<span class="g-warn" title="Starts before a task it depends on is due">⚠</span>' : ''}${r.label}</div>
          <div class="g-track" style="width:${W}px;${weekend}">${bar(r)}</div>
        </div>`).join('')}
        <div class="g-overlay" style="width:${W}px;height:${rows.length * ROW_H}px">
          ${(opts.markers || []).filter((m) => m.date >= from && m.date <= to).map((m) =>
            `<div class="g-marker ${m.cls || ''}" style="left:${x(m.date) + px / 2}px" title="${esc(m.label)}: ${esc(gFmt(m.date))}"><span>${esc(m.label)}</span></div>`).join('')}
          <div class="g-marker today" style="left:${x(today) + px / 2}px"><span>Today</span></div>
          <svg class="g-links" width="${W}" height="${rows.length * ROW_H}">
            <defs><marker id="g-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" fill="context-stroke"/></marker></defs>
            ${(opts.links || []).map((l) => {
              const ai = rowIndex.get(String(l.from));
              const bi = rowIndex.get(String(l.to));
              if (ai === undefined || bi === undefined) return '';
              const a = rows[ai];
              const b = rows[bi];
              const x1 = x(a.end) + (a.start ? px : px / 2 + 8);
              const y1 = ai * ROW_H + ROW_H / 2 - 4;
              const x2 = (b.start ? x(b.start) : x(b.end) + px / 2 - 8);
              const y2 = bi * ROW_H + ROW_H / 2 - 4;
              const mid = y2 > y1 ? bi * ROW_H - 1 : (bi + 1) * ROW_H + 1;
              const d = x2 - 8 >= x1 + 8
                ? `M${x1},${y1} H${x1 + 8} V${y2} H${x2}`
                : `M${x1},${y1} H${x1 + 8} V${mid} H${x2 - 10} V${y2} H${x2}`;
              return `<path class="g-link ${conflicts.has(String(l.to)) ? 'conflict' : ''}" d="${d}" marker-end="url(#g-arrow)"/>`;
            }).join('')}
          </svg>
        </div>
      </div>
    </div></div></div>
    ${opts.footer || ''}`;

  const scroller = $('.g-scroll', root);
  const scrollToToday = () => { scroller.scrollLeft = Math.max(0, x(today) - scroller.clientWidth / 3); };
  scrollToToday();

  $$('[data-zoom]', root).forEach((b) => b.addEventListener('click', () => {
    store.set(zoomKey, b.dataset.zoom);
    renderGantt(root, rows, opts);
  }));
  $('[data-g="today"]', root).addEventListener('click', scrollToToday);
  $$('[data-open]', root).forEach((el) => el.addEventListener('click', () => opts.onOpen?.(rows[rowIndex.get(el.dataset.open)])));

  // ---- hover tooltips and drag-to-reschedule
  $$('.g-bar, .g-ms', root).forEach((el) => {
    const r = rows[rowIndex.get(el.dataset.row)];
    el.addEventListener('pointerenter', (e) => { if (!el.classList.contains('dragging')) tipShow(r.tip, e); });
    el.addEventListener('pointermove', (e) => { if (!el.classList.contains('dragging')) tipShow(r.tip, e); });
    el.addEventListener('pointerleave', tipHide);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const mode = e.target.classList.contains('l') ? 'start' : e.target.classList.contains('r') ? 'end' : 'move';
      const startX = e.clientX;
      const left0 = parseFloat(el.style.left);
      const width0 = el.offsetWidth;
      let days = 0;
      let moved = false;
      el.setPointerCapture(e.pointerId);
      const dates = () => {
        let s = r.start;
        let en = r.end;
        if (mode === 'move') { s = s && gAdd(s, days); en = gAdd(en, days); }
        if (mode === 'start') s = gAdd(s, Math.min(days, gDiff(r.start, r.end)));
        if (mode === 'end') en = gAdd(en, Math.max(days, -gDiff(r.start, r.end)));
        return [s, en];
      };
      const onMove = (ev) => {
        if (!r.draggable) return;
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 3) moved = true;
        if (!moved) return;
        el.classList.add('dragging');
        days = Math.round(dx / px);
        const [s, en] = dates();
        if (s) {
          el.style.left = `${x(s)}px`;
          el.style.width = `${(gDiff(s, en) + 1) * px}px`;
        } else el.style.left = `${x(en) + px / 2 - 8}px`;
        tipShow(`<b>${s ? `${esc(gFmt(s))} → ` : 'Due '}${esc(gFmt(en))}</b>${s ? `<br>${gDays(gDiff(s, en) + 1)}` : ''}`, ev);
      };
      const onUp = async () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.classList.remove('dragging');
        tipHide();
        if (!moved) { opts.onOpen?.(r); return; }
        const [s, en] = dates();
        if (!days || !opts.onMove) { el.style.left = `${left0}px`; el.style.width = `${width0}px`; return; }
        try { await opts.onMove(r, s, en); } catch (err) {
          toast(err.message, 'error');
          el.style.left = `${left0}px`;
          el.style.width = `${width0}px`;
        }
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
    });
  });
}

const GANTT_STATUS_LEGEND = '<span class="lg g-todo"></span>To do <span class="lg g-in_progress"></span>In progress'
  + ' <span class="lg g-blocked"></span>Blocked <span class="lg g-overdue"></span>Overdue <span class="lg g-done"></span>Done'
  + ' <span class="lg g-base-lg"></span>Baseline <span class="lg-ms"></span>Due date only <span class="lg-link"></span>Depends on';

// A project's tasks as a Gantt chart.
function renderProjectGantt(root, p, hideDone) {
  const baseline = new Map(((p.baseline_snapshot || {}).tasks || []).map((t) => [t.id, t]));
  const flat = [];
  const walk = (list, depth) => list.forEach((t) => {
    if (hideDone && t.status === 'done') return;
    flat.push({ t, depth });
    walk(t.children, depth + 1);
  });
  walk(buildTree(p.tasks), 0);

  const rows = [];
  const unscheduled = [];
  for (const { t, depth } of flat) {
    const end = t.due_at ? toDateInput(t.due_at) : t.start_date;
    if (!end) { unscheduled.push(t); continue; }
    const start = t.start_date || null;
    const overdue = t.status !== 'done' && t.due_at && dayDiff(t.due_at) < 0;
    const cls = t.status === 'done' ? 'g-done' : overdue ? 'g-overdue' : `g-${t.status}`;
    const b = baseline.get(t.id);
    const base = b && b.due_at ? { start: b.start_date || null, end: toDateInput(b.due_at) } : null;
    const slip = base ? gDiff(base.end, end) : 0;
    rows.push({
      id: t.id, indent: depth, start, end, cls, draggable: true, task: t,
      label: `<span class="g-status">${{ todo: '○', in_progress: '◐', blocked: '⛔', done: '✓' }[t.status]}</span> ${esc(t.title)}${t.waiting_on ? ' <span class="small muted">⏳</span>' : ''}${t.recurrence ? ' <span class="small muted">🔁</span>' : ''}`,
      barText: esc(t.title),
      baseline: base,
      tip: `<b>${esc(t.title)}</b><br>${esc(STATUS[t.status])}${overdue ? ' · <b>overdue</b>' : ''}<br>`
        + (start ? `${esc(gFmt(start))} → ${esc(gFmt(end))} (${gDays(gDiff(start, end) + 1)})` : `Due ${esc(gFmt(end))} <span class="muted">(no start date)</span>`)
        + (base ? `<br>Baseline: ${base.start ? `${esc(gFmt(base.start))} → ` : ''}${esc(gFmt(base.end))}${slip ? ` · <b>${slip > 0 ? '+' : ''}${slip}d</b>` : ' · on plan'}` : '')
        + (t.owner ? `<br>👤 ${esc(t.owner)}` : '')
        + (t.waiting_on ? `<br>⏳ Waiting on ${esc(t.waiting_on)}` : '')
        + '<br><span class="muted">Drag to move · drag the ends to change dates · click to open</span>',
    });
  }
  const markers = [];
  if (p.due_at) markers.push({ date: toDateInput(p.due_at), label: 'Project due', cls: 'due' });
  if (p.baseline_due_at && p.baseline_due_at !== p.due_at) markers.push({ date: toDateInput(p.baseline_due_at), label: 'Baseline due', cls: 'base' });

  if (!rows.length) {
    root.innerHTML = `<div class="empty">No tasks have dates yet. Open a task and give it a start and due date
      (or just a due date) to see it on the chart.</div>${unscheduledHtml(unscheduled)}`;
    return;
  }
  renderGantt(root, rows, {
    key: 'project',
    links: p.links.map((l) => ({ from: l.depends_on_id, to: l.task_id })),
    markers,
    legend: GANTT_STATUS_LEGEND,
    footer: unscheduledHtml(unscheduled),
    onOpen: (r) => taskModal(r.id),
    onMove: async (r, start, end) => {
      await api.patch(`/tasks/${r.id}`, { start_date: start || null, due_at: end });
      toast(`"${r.task.title}": ${start ? `${gFmt(start)} → ` : 'due '}${gFmt(end)}`);
      await refresh();
    },
  });
}

function unscheduledHtml(list) {
  if (!list.length) return '';
  return `<div class="small muted" style="margin-top:10px">Not on the chart (no dates): ${list.map((t) =>
    `<a href="#" data-action="open-task" data-id="${t.id}">${esc(t.title)}</a>`).join(' · ')}</div>`;
}

// All ongoing projects on one timeline, with progress and baseline due dates.
function renderPortfolioGantt(root, projects) {
  const today = dateKey(new Date());
  const rows = [];
  const undated = [];
  for (const p of projects) {
    const health = projectHealth(p);
    const start = p.start_date || toDateInput(p.created_at);
    const due = p.due_at ? toDateInput(p.due_at) : null;
    if (!due && !p.start_date) { undated.push(p); continue; }
    const end = due || (today > start ? today : start);
    const base = p.baseline_due_at ? { start, end: toDateInput(p.baseline_due_at) } : null;
    const progress = p.task_count ? p.done_count / p.task_count : 0;
    rows.push({
      id: p.id, start, end: end < start ? start : end, draggable: !!due, project: p,
      cls: `${{ risk: 'g-overdue', watch: 'g-blocked', ok: 'g-in_progress', hold: 'g-todo' }[health.key]}${due ? '' : ' g-open'}`,
      progress,
      label: `<span class="g-status" title="${esc(health.why)}">${health.icon}</span> ${esc(p.name)}`,
      barText: `${Math.round(progress * 100)}%`,
      baseline: base,
      tip: `<b>${esc(p.name)}</b><br>${health.icon} ${esc(health.label)} — ${esc(health.why)}<br>`
        + `${esc(gFmt(start))} → ${due ? esc(gFmt(due)) : '<i>no due date</i>'}<br>`
        + `${p.done_count}/${p.task_count} tasks done (${Math.round(progress * 100)}%)`
        + (base ? `<br>Baseline due ${esc(gFmt(base.end))}${due && base.end !== due ? ` · <b>${gDiff(base.end, due) > 0 ? '+' : ''}${gDiff(base.end, due)}d</b>` : ''}` : '')
        + (due ? '<br><span class="muted">Drag to move the project\'s dates · click to open</span>' : '<br><span class="muted">Set a due date to plan this project</span>'),
    });
  }
  if (!rows.length) {
    root.innerHTML = '<div class="empty">No projects with dates yet. Give a project a start and due date (✎ Edit) to see it here.</div>';
    return;
  }
  renderGantt(root, rows, {
    key: 'portfolio',
    labelHeader: 'Project',
    legend: '<span class="lg g-overdue"></span>⚠ At risk <span class="lg g-blocked"></span>◐ Watch <span class="lg g-in_progress"></span>✓ On track'
      + ' <span class="lg g-todo"></span>⏸ On hold <span class="lg g-base-lg"></span>Baseline · fill = tasks done',
    footer: undated.length ? `<div class="small muted" style="margin-top:10px">No dates: ${undated.map((p) =>
      `<a href="#/project/${p.id}">${esc(p.name)}</a>`).join(' · ')}</div>` : '',
    onOpen: (r) => { location.hash = `#/project/${r.id}`; },
    onMove: async (r, start, end) => {
      await api.patch(`/projects/${r.id}`, { start_date: start, due_at: end });
      toast(`"${r.project.name}": ${gFmt(start)} → ${gFmt(end)}`);
      await refresh();
    },
  });
}
