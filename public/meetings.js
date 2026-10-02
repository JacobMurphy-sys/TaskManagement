'use strict';
// Meetings on projects and tasks: date/time, attendees, formatted notes and the
// actions agreed (which are real tasks). Loaded before app.js; uses its helpers.

const RT_BUTTONS = [
  ['bold', '<b>B</b>', 'Bold (Ctrl+B)'],
  ['italic', '<i>I</i>', 'Italic (Ctrl+I)'],
  ['underline', '<u>U</u>', 'Underline (Ctrl+U)'],
  ['highlight', '<mark>H</mark>', 'Highlight'],
  ['insertUnorderedList', '• List', 'Bullet points'],
  ['insertOrderedList', '1. List', 'Numbered list'],
  ['removeFormat', '✕ Format', 'Clear formatting from the selection'],
];

// A small rich-text box (bold, italic, underline, highlight, lists). onChange(html) is
// called a moment after typing stops; the server keeps only those formats.
function richEditor(root, html, onChange) {
  root.innerHTML = `<div class="rt-bar" role="toolbar">${RT_BUTTONS.map(([cmd, label, title]) =>
    `<button type="button" data-rt="${cmd}" title="${title}">${label}</button>`).join('')}</div>
    <div class="rt-area" contenteditable="true" spellcheck="true"></div>`;
  const area = $('.rt-area', root);
  area.innerHTML = html || '';
  let timer = null;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => onChange(area.innerHTML), 700); };
  $('.rt-bar', root).addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  $('.rt-bar', root).addEventListener('click', (e) => {
    const b = e.target.closest('[data-rt]');
    if (!b) return;
    area.focus();
    if (b.dataset.rt === 'highlight') {
      // Toggle: highlighted text is cleared, anything else gets the marker colour.
      const node = window.getSelection().anchorNode;
      const el = node && (node.nodeType === 1 ? node : node.parentElement);
      const lit = el && el.closest('mark, span[style*="background"]') && area.contains(el);
      document.execCommand('hiliteColor', false, lit ? 'transparent' : '#fff176');
    } else document.execCommand(b.dataset.rt);
    changed();
  });
  area.addEventListener('input', changed);
  // Pasted text keeps the formats we support; the rest is cleaned up on save.
  area.addEventListener('blur', () => { if (timer) { clearTimeout(timer); timer = null; onChange(area.innerHTML); } });
  return { flush: () => { if (timer) { clearTimeout(timer); timer = null; onChange(area.innerHTML); } } };
}

// ---- Date & time: a date box plus a time box with a 15-minute list (type any time too) ----

// "9", "930", "9:30", "9.30", "2pm", "14:05" -> minutes after midnight (or null).
function parseTime(text) {
  const t = String(text).trim().toLowerCase().replace(/\s+/g, '').replace(/[.h]/, ':');
  const m = t.match(/^(\d{1,2})(?::(\d{1,2}))?(am|pm|a|p)?$/) || t.match(/^(\d{1,2})(\d{2})(am|pm|a|p)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3][0] === 'p' ? 12 : 0);
  }
  return h > 23 || min > 59 ? null : h * 60 + min;
}
const hhmm = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

// The fields; the chosen value is kept in a hidden "held_at" input (local "YYYY-MM-DDTHH:MM")
// that fires "change" like any other field.
function whenFieldHtml(iso) {
  const v = toLocalInput(iso);
  return `<div class="f when-field"><span>Date &amp; time</span><div class="when-row">
    <input type="date" class="when-date" value="${v.slice(0, 10)}" required>
    <span class="time-pick"><input type="text" class="when-time" value="${v.slice(11, 16)}" autocomplete="off" inputmode="numeric"
      title="Pick from the list, or type e.g. 930, 14:15 or 2pm (↑ ↓ change by 15 minutes)"><span class="tp-menu" hidden></span></span>
    <span class="small muted when-end"></span>
    <input type="hidden" name="held_at" value="${v}"></div></div>`;
}

function wireWhenField(root) {
  const dateIn = $('.when-date', root);
  const timeIn = $('.when-time', root);
  const hidden = $('input[name=held_at]', root);
  const menu = $('.tp-menu', root);
  const durSel = root.querySelector('[name=duration_min]') || root.closest('form, .form-grid')?.querySelector('[name=duration_min]');
  let current = parseTime(timeIn.value) ?? 540;
  const showEnd = () => {
    const end = current + Number(durSel?.value || 60);
    $('.when-end', root).textContent = `ends ${hhmm(end)}${end >= 1440 ? ' (next day)' : ''}`;
  };
  const commit = () => {
    const parsed = parseTime(timeIn.value);
    if (parsed === null) timeIn.classList.add('bad'); else { timeIn.classList.remove('bad'); current = parsed; }
    timeIn.value = hhmm(current);
    showEnd();
    const v = dateIn.value && `${dateIn.value}T${hhmm(current)}`;
    if (v && v !== hidden.value) {
      hidden.value = v;
      hidden.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  const open = () => {
    menu.innerHTML = Array.from({ length: 96 }, (_, k) => k * 15).map((t) =>
      `<span class="tp-opt ${t === current ? 'on' : ''} ${t >= 420 && t < 1140 ? 'work' : ''}" data-t="${t}">${hhmm(t)}</span>`).join('');
    menu.hidden = false;
    // Float above the window (fixed), below the box or above it if there's no room.
    const r = timeIn.getBoundingClientRect();
    const below = window.innerHeight - r.bottom > 240;
    Object.assign(menu.style, { position: 'fixed', left: `${r.left}px`, top: below ? `${r.bottom + 2}px` : 'auto',
      bottom: below ? 'auto' : `${window.innerHeight - r.top + 2}px` });
    const near = $(`.tp-opt[data-t="${Math.round(current / 15) * 15 % 1440}"]`, menu);
    if (near) menu.scrollTop = near.offsetTop - menu.clientHeight / 2 + near.offsetHeight / 2;
  };
  const step = (d) => {
    current = (Math.round(current / 15) * 15 + d + 1440) % 1440;
    timeIn.value = hhmm(current);
    if (!menu.hidden) open();
    commit();
  };
  timeIn.addEventListener('focus', () => { open(); timeIn.select(); });
  timeIn.addEventListener('click', () => { if (menu.hidden) open(); });
  timeIn.addEventListener('blur', () => { menu.hidden = true; commit(); });
  timeIn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); step(e.key === 'ArrowDown' ? 15 : -15); }
    if (e.key === 'Enter') { e.preventDefault(); commit(); menu.hidden = true; }
    if (e.key === 'Escape' && !menu.hidden) { e.preventDefault(); e.stopPropagation(); menu.hidden = true; }
  });
  menu.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.tp-opt');
    e.preventDefault(); // keep focus in the box
    if (!opt) return;
    current = Number(opt.dataset.t);
    timeIn.value = hhmm(current);
    menu.hidden = true;
    commit();
  });
  dateIn.addEventListener('change', commit);
  // The list floats in place, so close it if the window behind it scrolls.
  root.closest('dialog')?.addEventListener('scroll', (e) => { if (e.target !== menu) menu.hidden = true; }, true);
  durSel?.addEventListener('change', showEnd);
  showEnd();
}

const meetingEnd = (m) => new Date(new Date(m.held_at).getTime() + (m.duration_min || 60) * 60000);
const meetingWhen = (m) => `${fmtDateTime(m.held_at)}–${pad(meetingEnd(m).getHours())}:${pad(meetingEnd(m).getMinutes())}`;
const actionsLabel = (m) => (m.action_count ? `☑ ${m.actions_done}/${m.action_count} action${m.action_count === 1 ? '' : 's'}` : '');

// The Meetings card on a project's Overview tab.
function meetingsCard(p, list) {
  const now = new Date().toISOString();
  const upcoming = list.filter((m) => m.held_at > now).sort((a, b) => a.held_at.localeCompare(b.held_at));
  const past = list.filter((m) => m.held_at <= now);
  const showAll = store.get(`allMeetings:${p.id}`, false);
  const shown = showAll ? past : past.slice(0, 5);
  const row = (m) => `<li class="meeting-row" data-action="open-meeting" data-id="${m.id}" title="Open meeting">
      <div><b>${esc(m.title)}</b>${m.task_title ? ` <span class="small muted">re: ${esc(m.task_title)}</span>` : ''}
        <div class="small muted">🗓 ${esc(meetingWhen(m))}${m.location ? ` · ${esc(m.location)}` : ''}</div></div>
      <span class="small muted nowrap">${actionsLabel(m)}</span></li>`;
  return `<div class="card">
    <div class="list-tools"><h2 style="margin:0">🗓 Meetings <span class="muted small">${list.length}</span></h2>
      <button data-action="new-meeting" data-project="${p.id}">＋ New meeting</button></div>
    ${upcoming.length ? `<div class="small muted" style="margin-top:6px">Coming up</div><ul class="meeting-list">${upcoming.map(row).join('')}</ul>` : ''}
    ${past.length ? `${upcoming.length ? '<div class="small muted" style="margin-top:6px">Held</div>' : ''}<ul class="meeting-list">${shown.map(row).join('')}</ul>
      ${past.length > 5 ? `<button class="link small" data-action="toggle-all-meetings" data-id="${p.id}">${showAll ? 'Show fewer' : `Show all ${past.length}`}</button>` : ''}` : ''}
    ${list.length ? '' : '<div class="small muted">Record meetings with their notes and the actions agreed — actions become tasks you can tick off.</div>'}
  </div>`;
}

// The task window's Meetings section.
function taskMeetingsHtml(t) {
  return `<div class="section">
    <h3>Meetings <span class="muted small">${t.meetings.length || ''}</span></h3>
    <ul class="mini">${t.meetings.map((m) => `<li><span class="t" data-action="open-meeting" data-id="${m.id}" data-return-task="${t.id}">🗓 ${esc(m.title)}
      <span class="small muted">${esc(meetingWhen(m))}</span></span> <span class="small muted">${actionsLabel(m)}</span></li>`).join('') || '<li class="empty">None yet</li>'}</ul>
    <button data-action="new-meeting" data-task="${t.id}" style="margin-top:6px">＋ New meeting</button>
  </div>`;
}

// Step 1: title and time. Step 2 (the editor) has notes, attendees and actions.
const DURATIONS = { 15: '15 min', 30: '30 min', 45: '45 min', 60: '1 hour', 90: '1½ hours', 120: '2 hours', 180: '3 hours',
  240: '4 hours', 480: 'All day (8 h)' };
const durationOptions = (current = 60) => options({ ...(DURATIONS[current] ? {} : { [current]: `${current} min` }), ...DURATIONS }, current);

// From a project or task, or from the calendar ({ at, duration, pickProject }), where the
// project can be chosen (or none).
function newMeetingDialog({ projectId, taskId, at, duration = 60, pickProject = false }) {
  const now = at ? new Date(at) : new Date();
  if (!at) now.setMinutes(Math.floor(now.getMinutes() / 15) * 15, 0, 0);
  const projects = state.projects.filter((p) => p.status === 'active' || p.status === 'on_hold');
  openModal(`
    <div class="modal-head"><h2 style="margin:0">🗓 New meeting</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="meeting-new" class="form-grid">
      <label class="f full">Title<input type="text" name="title" required placeholder="e.g. Weekly progress review" value="Progress meeting"></label>
      ${whenFieldHtml(now.toISOString())}
      <label class="f">Duration<select name="duration_min">${durationOptions(duration)}</select></label>
      <label class="f">Location<input type="text" name="location" placeholder="Room, Teams… (optional)"></label>
      ${pickProject ? `<label class="f">Project<select name="project_id"><option value="">— None (a meeting of its own) —</option>
        ${projects.map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>` : ''}
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">Create &amp; open</button></div>
    </form>`);
  const form = $('#meeting-new');
  wireWhenField(form);
  form.querySelector('[name=title]').select();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    try {
      const m = await api.post('/meetings', { ...f, held_at: fromLocalInput(f.held_at), duration_min: Number(f.duration_min),
        project_id: (pickProject ? Number(f.project_id) : projectId) || null, task_id: taskId || null });
      state.modalDirty = true;
      await meetingEditor(m.id, { returnTask: taskId || null });
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function meetingEditor(id, opts = {}) {
  const m = await api.get(`/meetings/${id}`);
  const groups = await ownerOptions(m.project_id);
  const where = [m.project_name && `<a href="#/project/${m.project_id}" data-action="close-modal-go">${esc(m.project_name)}</a>`,
    m.task_title && `<a href="#" data-action="open-task" data-id="${m.task_id}">re: ${esc(m.task_title)}</a>`].filter(Boolean).join(' · ');
  const actionRow = (a) => `<tr class="${a.status === 'done' ? 'done' : ''}">
      <td><input type="checkbox" data-mt-done="${a.id}" ${a.status === 'done' ? 'checked' : ''} title="Done"></td>
      <td><span class="t" data-action="open-task" data-id="${a.id}">${esc(a.title)}</span></td>
      <td>${a.owner ? esc(a.owner) : '<span class="muted">—</span>'}</td>
      <td class="nowrap">${a.due_at ? dueChip(a) : '<span class="muted">—</span>'}</td>
      <td>${statusChip(a.status)}</td></tr>`;
  openModal(`
    <div class="modal-head">
      <div class="small muted">🗓 Meeting${where ? ` · ${where}` : ''}</div>
      <div class="row"><span class="saved-flag" id="saved-flag">✓ Saved</span><button class="icon" data-action="close-modal">✕</button></div>
    </div>
    <div class="form-grid" id="meeting-form">
      <label class="f full">Title<input type="text" name="title" value="${esc(m.title)}"></label>
      ${whenFieldHtml(m.held_at)}
      <label class="f">Duration<select name="duration_min">${durationOptions(m.duration_min)}</select></label>
      <label class="f">Location<input type="text" name="location" value="${esc(m.location || '')}" placeholder="Room, Teams…"></label>
      <div class="f full"><span>Attendees</span><div id="mt-attendees"></div></div>
    </div>
    <div class="section">
      <h3>Notes</h3>
      <div class="rt" id="mt-notes"></div>
    </div>
    ${attachmentsHtml(m.attachments, { kind: 'meetings', id: m.id })}
    <div class="section">
      <h3>Actions agreed <span class="muted small">— each becomes a ${m.task_id ? 'subtask of the task' : 'task in the project'}, with owner and due date</span></h3>
      <table class="log mt-actions"><tbody>${m.actions.map(actionRow).join('') || ''}</tbody></table>
      <div class="mt-add">
        <input type="text" id="mt-action" placeholder="+ Action agreed… (Enter)   e.g. Send revised quote !high" autocomplete="off">
        <div id="mt-owner"></div>
        <input type="date" id="mt-due" title="Due date">
        <button id="mt-add-btn">Add</button>
      </div>
    </div>
    <div class="small muted" style="margin-top:8px">Created ${esc(fmtDateTime(m.created_at))} · Updated ${esc(fmtDateTime(m.updated_at))}</div>
    <div class="section row">
      <button class="danger" data-mt="delete">Delete meeting</button>
      <div class="spacer"></div>
      <button data-mt="copy" title="Copy the minutes (formatted, for an email)">📋 Copy minutes</button>
      ${opts.returnTask ? `<button data-mt="back">↑ Back to task</button>` : ''}
      <button class="primary" data-mt="done">Done</button>
    </div>`, { wide: true });

  const saved = () => {
    const flag = $('#saved-flag');
    if (!flag) return;
    flag.classList.add('show');
    setTimeout(() => flag.classList.remove('show'), 1200);
  };
  const save = async (body) => {
    try { await api.patch(`/meetings/${m.id}`, body); state.modalDirty = true; saved(); } catch (err) { toast(err.message, 'error'); }
  };
  wireWhenField($('#meeting-form'));
  $$('#meeting-form [name]').forEach((el) => el.addEventListener('change', () => {
    if (el.name === 'title' && !el.value.trim()) { el.value = m.title; return; }
    save({ [el.name]: el.name === 'held_at' ? fromLocalInput(el.value) : el.name === 'duration_min' ? Number(el.value) : el.value });
  }));
  // Attendees: type to search, or 📇 for the contacts book (project team, lists, names used before).
  ownerPicker($('#mt-attendees'), { value: m.attendees, groups, placeholder: 'Add attendee…', bookTitle: 'Choose attendees', wholeDepartments: true,
    onChange: (attendees) => save({ attendees: attendees || '' }) });
  const editor = richEditor($('#mt-notes'), m.notes, (html) => save({ notes: html }));
  modal().addEventListener('close', () => editor.flush(), { once: true }); // however it's closed
  wireAttachments($('#modal-body'), m.attachments, () => { editor.flush(); return meetingEditor(m.id, opts); });

  const ownersBox = ownerPicker($('#mt-owner'), { groups, placeholder: 'Owners', bookTitle: 'Who owns this action?' });
  const addAction = async () => {
    const title = $('#mt-action').value.trim();
    if (!title) { $('#mt-action').focus(); return; }
    try {
      await api.post(`/meetings/${m.id}/actions`, { title, owner: ownersBox.value, due_at: $('#mt-due').value || null });
      state.modalDirty = true;
      editor.flush();
      await meetingEditor(m.id, opts);
      $('#mt-action').focus();
    } catch (err) { toast(err.message, 'error'); }
  };
  $('#mt-add-btn').addEventListener('click', addAction);
  for (const sel of ['#mt-action', '#mt-owner', '#mt-due']) {
    $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); addAction(); } });
  }
  $$('[data-mt-done]').forEach((cb) => cb.addEventListener('change', async () => {
    await api.patch(`/tasks/${cb.dataset.mtDone}`, { status: cb.checked ? 'done' : 'todo' });
    state.modalDirty = true;
    editor.flush();
    await meetingEditor(m.id, opts);
  }));
  $$('[data-mt]').forEach((b) => b.addEventListener('click', async () => {
    editor.flush();
    const act = b.dataset.mt;
    if (act === 'delete') {
      if (!confirm(`Delete the meeting "${m.title}"?${m.actions.length ? ` Its ${m.actions.length} action(s) are kept as tasks.` : ''}`)) return;
      await api.del(`/meetings/${m.id}`);
      state.modalDirty = true;
      toast('Meeting deleted');
      return opts.returnTask ? taskModal(opts.returnTask) : closeModal();
    }
    if (act === 'copy') return copyMinutes(m.id);
    if (act === 'back') return taskModal(opts.returnTask);
    closeModal();
  }));
}

// Minutes as formatted text (pastes into Outlook/Word) with a plain-text fallback.
async function copyMinutes(id) {
  const m = await api.get(`/meetings/${id}`);
  const head = [m.project_name, m.task_title && `re: ${m.task_title}`].filter(Boolean).join(' — ');
  // Only the actions still open, as "Action — owner" (no due dates).
  const open = m.actions.filter((a) => a.status !== 'done');
  const actions = open.map((a) => `${a.title}${a.owner ? ` — ${a.owner}` : ''}`);
  // No date or time in the copy: location, project and attendees under the title.
  const details = [m.location && esc(m.location), head && esc(head), m.attendees && `<b>Attendees:</b> ${esc(m.attendees)}`].filter(Boolean);
  const html = `<h3>${esc(m.title)}</h3>${details.length ? `<p>${details.join('<br>')}</p>` : ''}`
    + `${m.notes ? `<p><b>Notes</b></p>${m.notes}` : ''}`
    + `${actions.length ? `<p><b>Actions agreed</b></p><ul>${actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}`;
  const tmp = document.createElement('div');
  tmp.innerHTML = m.notes || '';
  $$('li', tmp).forEach((li) => li.prepend(li.parentElement?.tagName === 'OL' ? `${[...li.parentElement.children].indexOf(li) + 1}. ` : '• '));
  $$('ul, ol', tmp).forEach((list) => list.before('\n'));
  $$('br', tmp).forEach((br) => br.replaceWith('\n'));
  $$('li, p, div', tmp).forEach((el) => el.append('\n'));
  const text = [m.title, m.location || null, head || null, m.attendees && `Attendees: ${m.attendees}`, '',
    m.notes && 'Notes', tmp.textContent.replace(/\n{3,}/g, '\n\n').trim(), '',
    actions.length && 'Actions agreed', ...actions.map((a) => `• ${a}`)].filter((x) => x !== null && x !== undefined && x !== false).join('\n');
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]);
  } catch {
    await navigator.clipboard.writeText(text);
  }
  const done = m.actions.length - open.length;
  toast(`Minutes copied${done ? ` (${done} completed action${done === 1 ? '' : 's'} left out)` : ''} — paste into an email or document`);
}
