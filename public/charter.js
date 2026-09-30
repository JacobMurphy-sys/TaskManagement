'use strict';
// Project charter (the standard project template), the standalone Tasks page, and
// their Settings sections. Loaded before app.js; uses its helpers at call time.

const CHARTER_REQUIRED = ['name', 'problem', 'goals', 'sponsor', 'leader'];

async function loadLookups() {
  state.lookups = await api.get('/lookups');
  return state.lookups;
}
const lookupList = (id, list) => `<datalist id="${id}">${(state.lookups?.[list] || []).filter((l) => l.active)
  .map((l) => `<option value="${esc(l.name)}">`).join('')}</datalist>`;

// Charter fields for the new-project / escalate / promote forms. `v` pre-fills values.
function charterFieldsHtml(v = {}) {
  const req = '<span class="req" title="Required">*</span>';
  const ta = (name, label, rows = 3, required = false, hint = '') => `<label class="f full"><span>${label}${required ? req : ''}</span>
    <textarea name="${name}" rows="${rows}" ${required ? 'required' : ''} placeholder="${esc(hint)}">${esc(v[name])}</textarea></label>`;
  const inp = (name, label, required = false, extra = '') => `<label class="f"><span>${label}${required ? req : ''}</span>
    <input type="text" name="${name}" value="${esc(v[name])}" ${required ? 'required' : ''} ${extra}></label>`;
  return `
    <label class="f full"><span>Project title${req}</span><input type="text" name="name" required value="${esc(v.name)}"></label>
    ${ta('problem', 'Problem definition', 3, true, 'What is the problem, where and how big is it?')}
    ${ta('goals', 'Goals of the project', 2, true, 'What will be different when the project is done?')}
    ${inp('sponsor', 'Management sponsor', true, 'list="people"')}
    ${inp('leader', 'Project leader', true, 'list="people"')}
    ${inp('project_code', 'Project ID', false, 'placeholder="automatic (PRJ-…) if blank"')}
    ${inp('policy_deployment', 'Policy deployment', false, 'list="lk-policy"')}
    ${inp('category', 'Category', false, 'list="lk-category"')}
    ${inp('gm_effect', 'Gross margin effect', false, 'placeholder="e.g. +0.5% or £40k/yr"')}
    <details class="full"><summary class="muted small">Scope and benefits (can be completed later on the Charter tab)</summary>
      <div class="form-grid" style="margin-top:8px">
        ${ta('in_scope', 'In scope', 2)}${ta('out_scope', 'Out of scope', 2)}
        ${ta('benefits_quantified', 'Quantified business benefits', 2)}${ta('benefits_other', 'Not quantified business benefits', 2)}
      </div>
    </details>
    ${lookupList('lk-policy', 'policy_deployment')}${lookupList('lk-category', 'category')}
    <datalist id="people">${[...new Set(state.projects.flatMap((p) => [p.sponsor, p.leader]).filter(Boolean))]
      .map((n) => `<option value="${esc(n)}">`).join('')}</datalist>`;
}
const CHARTER_FORM_KEYS = ['name', 'problem', 'goals', 'sponsor', 'leader', 'project_code', 'policy_deployment', 'category',
  'gm_effect', 'in_scope', 'out_scope', 'benefits_quantified', 'benefits_other'];

// ---- Charter tab ----------------------------------------------------------------

// Red / Yellow / Green, as in the template's Status column (same rules as the Excel export).
function ragStatus(t) {
  if (t.status === 'done') return 'Green';
  if (t.due_at && dayDiff(t.due_at) < 0) return 'Red';
  if (t.status === 'blocked' || (t.status === 'todo' && t.due_at && dayDiff(t.due_at) <= 7)) return 'Yellow';
  return 'Green';
}
const RAG_ICON = { Green: '🟢', Yellow: '🟡', Red: '🔴' };
// A phase: Red with overdue tasks or past its end, Yellow when something is blocked or it ends soon without starting.
function phaseRag(ph) {
  if (ph.status === 'done') return 'Green';
  if (ph.overdue_count) return 'Red';
  return ragStatus({ status: ph.blocked_count ? 'blocked' : ph.started_count ? 'in_progress' : 'todo', due_at: ph.due_at });
}

function phaseTimelineBox(phases) {
  return `<div class="ch-box"><label>Timeline — sub projects <span class="small muted">— the project's phases; dates are set on the Overview tab</span></label>
    <table class="ch-table ro"><thead><tr><th>Phase</th><th>Tasks</th><th>Baseline</th><th>Planned complete</th><th>Actual start</th><th>Completed</th><th>Status</th></tr></thead><tbody>
    ${phases.map((ph, i) => {
      const rag = phaseRag(ph);
      return `<tr><td>${i + 1}. ${esc(ph.name)}</td><td class="nowrap">${ph.done_count}/${ph.task_count}</td>
        <td class="nowrap">${ph.baseline_due_at ? esc(fmtShortDate(ph.baseline_due_at)) : '—'}</td>
        <td class="nowrap">${ph.due_at ? dueChip({ ...ph, status: ph.status === 'done' ? 'done' : 'todo' }) : '—'}</td>
        <td class="nowrap">${ph.actual_start ? esc(fmtShortDate(ph.actual_start)) : ''}</td>
        <td class="nowrap">${ph.completed_at ? esc(fmtShortDate(ph.completed_at)) : ''}</td>
        <td class="nowrap">${RAG_ICON[rag]} ${ph.status === 'done' ? 'Complete' : rag}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function timelineBox(title, what, list, baseline) {
  return `<div class="ch-box"><label>${title} <span class="small muted">— ${what}; owners and dates are set in each task</span></label>
    ${list.length ? `<table class="ch-table ro"><thead><tr><th>Task</th><th>Owner</th><th>Baseline</th><th>Planned complete</th><th>Actual start</th><th>Completed</th><th>Status</th></tr></thead><tbody>
    ${list.map((m) => {
      const b = baseline.get(m.id);
      const rag = ragStatus(m);
      return `<tr><td><a href="#" data-action="open-task" data-id="${m.id}">${esc(m.title)}</a></td>
        <td>${esc(m.owner || '')}</td>
        <td class="nowrap">${b && b.due_at ? esc(fmtShortDate(b.due_at)) : '—'}</td>
        <td class="nowrap">${m.due_at ? dueChip(m) : '—'}</td>
        <td class="nowrap">${m.actual_start ? esc(fmtShortDate(m.actual_start)) : ''}</td>
        <td class="nowrap">${m.completed_at ? esc(fmtShortDate(m.completed_at)) : ''}</td>
        <td class="nowrap" title="Red: overdue · Yellow: blocked, or due within a week and not started · Green: on track or complete">${RAG_ICON[rag]} ${m.status === 'done' ? 'Complete' : rag}</td></tr>`;
    }).join('')}</tbody></table>` : '<div class="empty small">None yet.</div>'}
  </div>`;
}

function charterMeter(c) {
  const level = c.missing_required.length ? 'over' : c.pct < 100 ? 'near' : '';
  return `<span class="meter wide ${level}" title="${c.pct}% of the charter completed"><span style="width:${c.pct}%"></span></span>`;
}

function charterNudge(p) {
  const c = p.charter.completeness;
  if (c.pct === 100) return '';
  return `<div class="baseline-box charter-nudge">
    <span>📋 Charter <b>${c.pct}%</b> complete</span> ${charterMeter(c)}
    ${c.missing_required.length ? `<span class="chip overdue">⚠ Missing: ${esc(c.missing_required.join(', '))}</span>` : ''}
    <a href="#/project/${p.id}/charter">Complete the charter →</a></div>`;
}

function renderCharterTab(root, p) {
  const c = p.charter.completeness;
  const box = (name, label, rows = 3) => `<div class="ch-box"><label for="ch-${name}">${label}${CHARTER_REQUIRED.includes(name) ? '<span class="req">*</span>' : ''}</label>
    <textarea id="ch-${name}" name="${name}" rows="${Math.max(rows, String(p[name] || '').split('\n').length + 1)}">${esc(p[name])}</textarea></div>`;
  const small = (name, label, list) => `<div class="ch-box"><label for="ch-${name}">${label}${CHARTER_REQUIRED.includes(name) ? '<span class="req">*</span>' : ''}</label>
    <input id="ch-${name}" type="text" name="${name}" value="${esc(p[name])}" ${list ? `list="${list}"` : ''}></div>`;
  const baseline = new Map(((p.baseline_snapshot || {}).tasks || []).map((t) => [t.id, t]));
  root.innerHTML = `
    <div class="charter-bar row">
      <span>Charter <b>${c.pct}%</b> complete</span> ${charterMeter(c)}
      ${c.missing.length ? `<span class="small muted">To do: ${esc(c.missing.join(', '))}</span>` : '<span class="small muted">✓ Every section is filled in</span>'}
      <div class="spacer"></div>
      <a class="button" href="/api/projects/${p.id}/charter.xlsx" title="Your standard template filled in (set it up under Settings)">⬇ Charter (Excel)</a>
      <button data-action="print-charter">🖨 Print</button>
    </div>
    <div class="charter card" id="charter-form">
      <div class="ch-title"><label for="ch-name">Project title<span class="req">*</span></label><input id="ch-name" type="text" name="name" value="${esc(p.name)}"></div>
      <div class="ch-grid">
        <div class="ch-col">
          ${box('problem', 'Problem definition', 6)}
          ${box('goals', 'Goals of the project', 3)}
          <div class="ch-box"><label>Team (incl. capacity p.p.)</label>
            <table class="ch-table"><thead><tr><th>Name</th><th>Role</th><th>Capacity</th><th></th></tr></thead><tbody>
            ${p.charter.team.map((m) => `<tr data-team="${m.id}">
              <td><input type="text" name="name" value="${esc(m.name)}" list="people"></td>
              <td><input type="text" name="role" value="${esc(m.role)}"></td>
              <td><input type="text" name="capacity" value="${esc(m.capacity)}" placeholder="e.g. 20% / 1 day a week"></td>
              <td><button class="icon" data-action="del-team" data-id="${m.id}" title="Remove">✕</button></td></tr>`).join('')}
            <tr class="ch-add" data-add="team"><td><input type="text" name="name" placeholder="+ Add person… (Enter)" list="people"></td>
              <td><input type="text" name="role" placeholder="Role"></td><td><input type="text" name="capacity" placeholder="Capacity"></td><td></td></tr>
            </tbody></table></div>
          ${box('in_scope', 'In scope', 2)}
          ${box('out_scope', 'Out of scope', 2)}
          ${box('benefits_quantified', 'Quantified business benefits', 2)}
          ${box('benefits_other', 'Not quantified business benefits', 2)}
        </div>
        <div class="ch-col">
          <div class="ch-row3">${small('sponsor', 'Management sponsor', 'people')}${small('leader', 'Project leader', 'people')}
            <div class="ch-box"><label>Current date</label><div class="ch-static">${esc(fmtDate(new Date()))}</div></div></div>
          <div class="ch-row3">${small('policy_deployment', 'Policy deployment', 'lk-policy')}${small('category', 'Category', 'lk-category')}
            ${small('gm_effect', 'Gross margin effect')}</div>
          <div class="ch-row3 ch-id">${small('project_code', 'Project ID')}
            <div class="ch-box"><label>Budget</label><div class="ch-static">${p.budget !== null && p.budget !== undefined ? money(p.budget) : '—'}
              <span class="small muted">· spent ${money(p.spent || 0)}</span></div></div>
            <div class="ch-box"><label>Due date</label><div class="ch-static">${p.due_at ? esc(fmtDate(p.due_at)) : '—'}</div></div></div>
          <div class="ch-box"><label>Improvement KPIs</label>
            <table class="ch-table"><thead><tr><th>KPI</th><th>Unit</th><th>Baseline</th><th>Target</th><th>Current</th><th></th></tr></thead><tbody>
            ${p.charter.kpis.map((k) => `<tr data-kpi="${k.id}">
              <td><input type="text" name="name" value="${esc(k.name)}"></td><td><input type="text" name="unit" value="${esc(k.unit)}"></td>
              <td><input type="text" name="baseline" value="${esc(k.baseline)}"></td><td><input type="text" name="target" value="${esc(k.target)}"></td>
              <td><input type="text" name="current" value="${esc(k.current)}"></td>
              <td><button class="icon" data-action="del-kpi" data-id="${k.id}" title="Remove">✕</button></td></tr>`).join('')}
            <tr class="ch-add" data-add="kpis"><td><input type="text" name="name" placeholder="+ Add KPI… (Enter)"></td>
              <td><input type="text" name="unit" placeholder="Unit"></td><td><input type="text" name="baseline" placeholder="Baseline"></td>
              <td><input type="text" name="target" placeholder="Target"></td><td><input type="text" name="current" placeholder="Current"></td><td></td></tr>
            </tbody></table></div>
          ${p.charter.phases.length ? `${phaseTimelineBox(p.charter.phases)}
          ${timelineBox('Timeline — actions agreed', 'the project\'s tasks', p.charter.tasks.filter((t) => !t.parent_id), baseline)}` : `
          ${timelineBox('Timeline — sub projects', 'the project\'s top-level tasks (or add phases on the Overview tab)', p.charter.tasks.filter((t) => !t.parent_id), baseline)}
          ${timelineBox('Timeline — actions agreed', 'subtasks of those tasks', p.charter.tasks.filter((t) => t.parent_id), baseline)}`}
        </div>
      </div>
      ${lookupList('lk-policy', 'policy_deployment')}${lookupList('lk-category', 'category')}
      <datalist id="people">${[...new Set([...state.projects.flatMap((x) => [x.sponsor, x.leader]), ...p.charter.team.map((m) => m.name)].filter(Boolean))]
        .map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
    </div>`;

  // Autosave project fields.
  $$('#charter-form [name]', root).forEach((el) => {
    if (el.closest('tr')) return;
    el.addEventListener('change', async () => {
      try {
        await api.patch(`/projects/${p.id}`, { [el.name]: el.value });
        toast('Charter saved');
        if (el.name === 'name') loadProjects();
      } catch (err) {
        toast(err.message, 'error');
        el.value = p[el.name] ?? '';
      }
    });
  });
  // Team / KPI rows: edit in place, Enter on the add row to add.
  for (const [attr, path] of [['team', 'team'], ['kpi', 'kpis']]) {
    $$(`tr[data-${attr}] input`, root).forEach((el) => el.addEventListener('change', async () => {
      try { await api.patch(`/${path}/${el.closest('tr').dataset[attr]}`, { [el.name]: el.value }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
    }));
  }
  $$('tr[data-add] input', root).forEach((el) => el.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const row = el.closest('tr');
    const body = Object.fromEntries($$('input', row).map((i) => [i.name, i.value.trim()]));
    if (!body.name) { $('input[name=name]', row).focus(); return; }
    try {
      await api.post(`/projects/${p.id}/${row.dataset.add}`, body);
      await route();
      $(`tr[data-add="${row.dataset.add}"] input[name=name]`)?.focus();
    } catch (err) { toast(err.message, 'error'); }
  }));
}

function printCharter() {
  document.body.classList.add('printing-charter');
  const style = document.createElement('style');
  style.textContent = '@page { size: A4 landscape; margin: 10mm; }';
  document.head.append(style);
  window.print();
  setTimeout(() => { document.body.classList.remove('printing-charter'); style.remove(); }, 500);
}

// ---- promote a standalone task to a project ---------------------------------------

async function promoteDialog(t) {
  await loadLookups();
  openModal(`
    <div class="modal-head"><h2 style="margin:0">🚀 Promote to a project</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="muted">"${esc(t.title)}" becomes a project. Its subtasks become the project's tasks and its notes move across.
      Fill in the core of the project charter; the rest can be completed later on the Charter tab.</p>
    <form id="promote-form" class="form-grid">
      ${charterFieldsHtml({ name: t.title, problem: t.description })}
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">Create project</button></div>
    </form>`, { wide: true });
  $('#promote-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const p = await api.post(`/tasks/${t.id}/promote`, f);
      closeModal();
      toast(`"${p.name}" is now a project`);
      await loadProjects();
      location.hash = `#/project/${p.id}`;
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---- standalone Tasks page ----------------------------------------------------------

async function renderTasks() {
  const list = await api.get('/tasks?standalone=1');
  const board = store.get('standaloneView', 'list') === 'board';
  const hideDone = store.get('hideDoneStandalone', false);
  const tree = buildTree(list);
  const shown = hideDone ? tree.filter((t) => t.status !== 'done') : tree;
  const open = list.filter((t) => t.status !== 'done').length;
  const pseudo = { baseline_set_at: null };
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">✅ Tasks</h1>
      <span class="muted small">${open} open · ad-hoc work that doesn't need a project</span><div class="spacer"></div>
      ${board ? '' : `<label class="small muted row"><input type="checkbox" data-action="toggle-hide-done-standalone" ${hideDone ? 'checked' : ''}> Hide completed</label>`}
      <div class="seg" role="group" aria-label="View">
        <button data-action="standalone-view" data-view="list" class="${board ? '' : 'on'}">☰ List</button>
        <button data-action="standalone-view" data-view="board" class="${board ? 'on' : ''}">▦ Board</button>
      </div></div>
    <div class="card">
      ${board ? taskBoardHtml(list.filter((t) => !t.parent_id)) : `
        ${shown.length ? `<ul class="tasks">${shown.map((t) => taskRow(t, pseudo, hideDone)).join('')}</ul>` : '<div class="empty">No tasks here yet. Add one below.</div>'}
        <div class="add-task"><input type="text" id="add-task-input" placeholder="Add a task… (Enter)   e.g. Renew parking permit @fri !high" autocomplete="off"></div>`}
      <div class="small muted" style="margin-top:6px">${SHORTCUTS_HELP} · Open a task to move it into a project, or to 🚀 promote it to a project of its own.</div>
    </div>`;
  for (const id of ['#add-task-input', '#board-add']) {
    $(id)?.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      const q = parseQuick(e.target.value);
      if (!q.title) return;
      await api.post('/tasks', q);
      await refresh();
      $(id)?.focus();
    });
  }
  if (board) {
    wireDrag(main(), async (id, status) => {
      const t = list.find((x) => String(x.id) === id);
      if (!t || t.status === status) return;
      await setTaskStatus(t.id, status, t.subtask_count - t.subtask_done);
    });
  }
}

// ---- Settings: pick-lists and the Excel template ----------------------------------------

async function renderCharterSettings(root) {
  const [lookups, tpl] = await Promise.all([loadLookups(), api.get('/charter-template')]);
  const listCard = (list, title, hint) => `<div class="card"><h2>${title}</h2><p class="small muted">${hint}</p>
    <table class="log"><thead><tr><th>Name</th><th>Active</th><th class="num">Projects</th><th></th></tr></thead>
    <tbody>${lookups[list].map((l) => `<tr>
      <td><input type="text" value="${esc(l.name)}" data-lookup-name="${l.id}"></td>
      <td><input type="checkbox" data-lookup-active="${l.id}" ${l.active ? 'checked' : ''}></td>
      <td class="num">${l.used}</td>
      <td><button class="icon" data-action="del-lookup" data-id="${l.id}" title="Delete">✕</button></td></tr>`).join('')}</tbody></table>
    ${lookups[list].length ? '' : '<div class="empty small">Nothing yet. Add the options you use.</div>'}
    <div class="row" style="margin-top:8px;flex-wrap:nowrap"><input type="text" data-lookup-add="${list}" placeholder="Add… (Enter)"></div></div>`;
  const fieldRow = (f) => {
    const m = tpl.mapping[f.key] || {};
    return `<tr data-field="${f.key}"><td>${esc(f.label)}</td>
      <td><select name="sheet"><option value="">— not used —</option>${(tpl.sheets || []).map((s) =>
        `<option ${s === m.sheet ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></td>
      <td><input type="text" name="cell" value="${esc(m.cell || '')}" placeholder="e.g. B4" style="width:80px"></td>
      <td><select name="mode">${options({ replace: 'Put value in the cell', append: 'Add under the label in the cell' }, m.mode || 'replace')}</select></td>
      <td class="small muted">${m.label_cell ? `label in ${esc(m.label_cell)}` : (m.cell ? 'set by you' : '<span class="chip overdue">not found</span>')}</td></tr>`;
  };
  root.innerHTML = `
    <div class="grid dash" style="margin-top:16px">
      ${listCard('category', 'Project categories', 'The choices offered for a project charter\'s <b>Category</b>. Renaming one updates the projects using it.')}
      ${listCard('policy_deployment', 'Policy deployment', 'The choices offered for <b>Policy deployment</b> (e.g. your strategic objectives).')}
    </div>
    <div class="card" style="margin-top:16px">
      <h2>📋 Project charter Excel template</h2>
      <p class="small muted">Upload your standard project template (.xlsx). The app finds each label (Problem definition, Management
        Sponsor, …) and fills the box next to it, so <b>⬇ Charter (Excel)</b> on a project produces your own form filled in.
        Check the cells below and correct any that are wrong. Until a template is uploaded, a plain one-sheet charter is produced.</p>
      <div class="row">
        <label class="button">📤 ${tpl.uploaded ? 'Replace template' : 'Upload template'}<input type="file" id="tpl-file" accept=".xlsx" hidden></label>
        ${tpl.uploaded ? `<span class="small">Current: <b>${esc(tpl.file_name || 'template.xlsx')}</b>${tpl.uploaded_at ? ` · uploaded ${esc(fmtDateTime(tpl.uploaded_at))}` : ''}</span>
          <button data-action="tpl-detect">↻ Detect again</button><button class="danger" data-action="tpl-remove">Remove</button>` : ''}
      </div>
      ${tpl.error ? `<p class="chip overdue">⚠ ${esc(tpl.error)}</p>` : ''}
      ${tpl.timelines?.length ? `<p class="small">📅 Timeline grids found: ${tpl.timelines.map((g) => `<b>${esc(g.title)}</b> (${esc(g.sheet)}, rows ${g.first_row}–${g.last_row}, ${g.rows} rows, ${g.months} month columns)`).join(' and ')}.
        ${tpl.timelines.some((g) => g.kind === 'sub') ? 'Sub projects are filled from the project\'s top-level tasks' : ''}${tpl.timelines.some((g) => g.kind === 'actions') ? ', actions from their subtasks' : ''}:
        owner, planned complete date, planned months shaded, <b>S</b> in the month work actually started, <b>x</b> in the month it was completed,
        and Red / Yellow / Green status. The year headers are set to the project's years.</p>` : ''}
      ${tpl.output_sheets?.length ? `<p class="small">📄 Downloaded charters contain only: <b>${tpl.output_sheets.map(esc).join(', ')}</b>.${tpl.dropped_sheets?.length
        ? ` <span class="muted">Left out: ${tpl.dropped_sheets.map(esc).join(', ')}.</span>` : ''}</p>` : ''}
      ${tpl.uploaded ? `<table class="log" id="tpl-map" style="margin-top:12px">
        <thead><tr><th>Charter field</th><th>Sheet</th><th>Cell</th><th>How</th><th></th></tr></thead>
        <tbody>${tpl.fields.map(fieldRow).join('')}</tbody></table>
        <div class="row" style="margin-top:10px"><button class="primary" data-action="tpl-save">Save cell mapping</button>
          <span class="small muted">Tip: open your template in Excel to see each box's top-left cell (e.g. <b>B4</b>).
          For a merged box, use its top-left cell.</span></div>` : ''}
    </div>`;

  const reload = () => renderCharterSettings(root);
  $$('[data-lookup-name]', root).forEach((el) => el.addEventListener('change', async () => {
    try { await api.patch(`/lookups/${el.dataset.lookupName}`, { name: el.value }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
    reload();
  }));
  $$('[data-lookup-active]', root).forEach((el) => el.addEventListener('change', async () => {
    await api.patch(`/lookups/${el.dataset.lookupActive}`, { active: el.checked });
    reload();
  }));
  $$('[data-lookup-add]', root).forEach((el) => el.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !el.value.trim()) return;
    try { await api.post('/lookups', { list: el.dataset.lookupAdd, name: el.value }); } catch (err) { toast(err.message, 'error'); }
    await reload();
    $(`[data-lookup-add="${el.dataset.lookupAdd}"]`, root)?.focus();
  }));
  $('#tpl-file', root)?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = await fetch('/api/charter-template', { method: 'POST', body: file,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(file.name) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { toast(data.error || 'Upload failed', 'error'); return; }
    const found = Object.keys(data.mapping).length;
    toast(`Template uploaded: ${found} of ${data.fields.length} fields found`);
    reload();
  });
  root.onclick = async (e) => { // assigned (not added) so re-rendering doesn't stack handlers
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'tpl-save') {
      const mapping = {};
      for (const row of $$('#tpl-map tr[data-field]', root)) {
        const sheet = $('[name=sheet]', row).value;
        const cell = $('[name=cell]', row).value.trim();
        if (sheet && cell) mapping[row.dataset.field] = { sheet, cell, mode: $('[name=mode]', row).value };
      }
      try { await api.patch('/charter-template', { mapping }); toast('Cell mapping saved'); reload(); } catch (err) { toast(err.message, 'error'); }
    } else if (el.dataset.action === 'tpl-detect') {
      await api.post('/charter-template/detect');
      toast('Labels detected again');
      reload();
    } else if (el.dataset.action === 'tpl-remove') {
      if (!confirm('Remove the uploaded template? Charters will use the plain layout until you upload one again.')) return;
      await api.del('/charter-template');
      reload();
    } else if (el.dataset.action === 'del-lookup') {
      if (!confirm('Delete this item? Projects keep the value they already have.')) return;
      await api.del(`/lookups/${el.dataset.id}`);
      reload();
    }
  };
}
