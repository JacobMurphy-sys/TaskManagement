// 👥 Several people on one CI Manager (the shared server, src/collab.js):
// - your name, asked once, so others see who's here and who changed what;
// - 👥 in the top bar: who else has it open, and where; on a page someone else is on, a line says so;
// - when someone else changes what you're looking at: lists refresh by themselves (unless you're in
//   the middle of something), other pages say what changed with a 🔄 Refresh button;
// - the dialog for two edits of the same text (see request() in app.js), and 🕘 History with ↩ Put back.
const COLLAB = { on: false, seq: -1, others: [], timer: null, notes: [] };
const COLLAB_VIEWS = { dashboard: 'Dashboard', tasks: 'Tasks', calendar: 'Calendar', kanban: 'Board', ideas: 'Ideas', idea: 'an idea', library: 'Library', kpi: 'KPIs',
  planning: 'Planning', report: 'Report', contacts: 'Contacts', settings: 'Settings', log: 'Activity log', backups: 'Backups', project: 'a project', search: 'Search' };

// What the open page shows: the topics a change must touch to concern it, and whether it's a list
// (refreshed by itself) or a page someone may be editing (told, with a Refresh button).
function collabPage() {
  const [view = 'dashboard', id] = location.hash.replace(/^#\/?/, '').split('/');
  const page = (topics, list = false) => ({ view: view || 'dashboard', id: id || null, topics, list });
  switch (view || 'dashboard') {
    case 'project': return page([`project:${id}`]);
    case 'idea': return page([`idea:${id}`]);
    case 'dashboard': case 'tasks': case 'kanban': case 'calendar': return page(['task', 'project', 'idea', 'meeting', 'reminder', 'note'], true);
    case 'ideas': return page(['idea'], true);
    case 'contacts': return page(['name_list', 'name_list_item', 'project_team'], true);
    case 'kpi': return page(['kpi']);
    case 'planning': return page(['planning', 'settings']);
    case 'settings': return page(['settings', 'area', 'lookup', 'name_list', 'name_list_item']);
    default: return page([]);
  }
}
const collabWhere = (o) => {
  const [v, id] = String(o.view || '').replace(/^#\/?/, '').split('/');
  if (v === 'project' && id) { const p = state.projects?.find((x) => String(x.id) === id); if (p) return `“${p.name}”`; }
  return COLLAB_VIEWS[v || 'dashboard'] || v;
};
// Someone is typing or a dialog is open: don't pull the page from under them.
const collabBusy = () => !!document.querySelector('dialog[open]') || document.activeElement?.matches?.('input, textarea, select, [contenteditable="true"]');

// ---- a dialog over everything (stacks over an open task or meeting) ------------------------------
function collabDialog(html, cls = '') {
  const d = document.createElement('dialog');
  d.className = `cdialog ${cls}`;
  d.innerHTML = html;
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}

// ---- your name ----------------------------------------------------------------------------------
function collabAskName(again = false) {
  return new Promise((resolve) => {
    const d = collabDialog(`<form method="dialog" class="cd-name"><h3 style="margin-top:0">👋 ${again ? 'Your name' : 'Who\'s using the CI Manager?'}</h3>
      <p class="small muted">Several people use this copy. Your name shows others who's here and who changed what, and goes in the history of each change. It's kept in this browser.</p>
      <input type="text" name="n" required maxlength="60" value="${esc(me.name)}" placeholder="e.g. Sam Taylor" autocomplete="name">
      <div class="row" style="margin-top:10px"><span class="spacer"></span>${again ? '<button value="cancel" formnovalidate>Cancel</button>' : ''}<button class="primary" value="ok">Save</button></div></form>`);
    d.querySelector('input').select();
    d.addEventListener('close', () => {
      const n = d.querySelector('input').value.trim();
      if (d.returnValue === 'ok' && n) { me.setName(n); toast(`Hello, ${n}`); }
      resolve(me.name);
    });
    if (!again) d.addEventListener('cancel', (e) => e.preventDefault());
  });
}

// ---- who's here and what changed ------------------------------------------------------------------
async function collabTick() {
  if (!COLLAB.on) return;
  const pg = collabPage();
  let r;
  try { r = await api.post('/presence', { id: me.id, name: me.name, view: location.hash || '#/dashboard', topic: pg.topics[0] || null, seq: COLLAB.seq }); } catch { return; }
  COLLAB.others = r.others || [];
  const first = COLLAB.seq < 0;
  COLLAB.seq = r.seq;
  collabChip();
  collabHere();
  if (first) return;
  const mine = (c) => c.topics.some((t) => pg.topics.includes(t));
  const task = $('#task-form')?.dataset.id;
  for (const c of r.changes || []) {
    // the task open in a dialog: say so in the dialog
    if (task && c.topics.includes(`task:${task}`)) collabModalNote(c, task);
    else if (mine(c)) COLLAB.notes.push(c);
  }
  if (!COLLAB.notes.length) return;
  if (pg.list && !collabBusy()) {
    const n = COLLAB.notes; COLLAB.notes = [];
    await refresh();
    toast(n.length === 1 ? `${n[0].by} ${n[0].text}` : `Updated: ${n.length} changes by ${[...new Set(n.map((c) => c.by))].join(', ')}`);
  } else collabBanner();
}
function collabChip() {
  const el = $('#collab-chip'); if (!el) return;
  const names = [...new Set(COLLAB.others.map((o) => o.name))];
  el.hidden = false;
  el.innerHTML = names.length ? `👥 <span class="collab-n">${names.length}</span>` : '👤';
  el.title = names.length ? `Also here:\n${COLLAB.others.map((o) => `${o.name} — ${collabWhere(o)}`).join('\n')}` : 'Nobody else has the CI Manager open';
}
function collabHere() {
  const el = $('#collab-here'); if (!el) return;
  const hash = location.hash || '#/dashboard';
  const pg = collabPage();
  const same = COLLAB.others.filter((o) => (pg.list ? false : o.view === hash));
  el.hidden = !same.length;
  el.textContent = same.length ? `👥 ${[...new Set(same.map((o) => o.name))].join(', ')} ${same.length === 1 ? 'is' : 'are'} also on this page` : '';
}
function collabBanner() {
  const el = $('#collab-banner'); if (!el) return;
  const n = COLLAB.notes;
  const hm = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  el.hidden = !n.length;
  el.innerHTML = n.length ? `<div>✏ ${n.slice(-3).map((c) => `<b>${esc(c.by)}</b> ${esc(c.text)} <span class="muted small">${hm(c.at)}</span>`).join('<br>')}${n.length > 3 ? `<br><span class="small muted">and ${n.length - 3} more</span>` : ''}</div>
    <div class="row"><button class="primary small" data-collab="refresh">🔄 Refresh</button><button class="icon" data-collab="dismiss" title="Hide">✕</button></div>` : '';
}
function collabModalNote(c, taskId) {
  const head = $('#modal-body .modal-head'); if (!head) return;
  let note = $('#collab-modal-note');
  if (!note) { note = document.createElement('div'); note.id = 'collab-modal-note'; note.className = 'collab-banner'; head.after(note); }
  note.innerHTML = `<div>✏ <b>${esc(c.by)}</b> ${esc(c.text)}</div><button class="small" data-action="open-task" data-id="${esc(taskId)}">🔄 Reload this task</button>`;
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-collab]'); if (!b) return;
  if (b.dataset.collab === 'refresh') { COLLAB.notes = []; collabBanner(); await refresh(); }
  if (b.dataset.collab === 'dismiss') { COLLAB.notes = []; collabBanner(); }
  if (b.dataset.collab === 'who') { toast($('#collab-chip').title.replace(/\n/g, ' · ')); }
});
window.addEventListener('hashchange', () => { COLLAB.notes = []; collabBanner(); setTimeout(collabTick, 300); });

async function collabStart() {
  COLLAB.on = true;
  if (!me.name) await collabAskName();
  const bell = $('#bell');
  if (bell && !$('#collab-chip')) bell.insertAdjacentHTML('beforebegin', '<button id="collab-chip" class="collab-chip" data-collab="who" hidden>👤</button>');
  const main = $('#main');
  if (main && !$('#collab-banner')) main.insertAdjacentHTML('beforebegin', '<div id="collab-here" class="collab-here" hidden></div><div id="collab-banner" class="collab-banner" hidden></div>');
  const menu = $('#top-menu');
  if (menu && !$('[data-action="set-name"]')) menu.insertAdjacentHTML('afterbegin', '<button data-action="set-name">👤 Your name</button><hr>');
  await collabTick();
  COLLAB.timer = setInterval(collabTick, 10000);
}

// ---- two edits of the same text ----------------------------------------------------------------
// → the text to save: theirs, or yours (as you leave it in the box: you can copy bits across).
function collabConflict(c, mine) {
  return new Promise((resolve) => {
    const d = collabDialog(`<h3 style="margin-top:0">✏ ${esc(c.by)} changed this while you were editing it</h3>
      <p class="small muted">Their version was saved ${esc(fmtDateTime(c.at))}. Keep theirs, or save yours — edit it first to take in anything of theirs. Whichever isn't kept stays in the 🕘 History.</p>
      <div class="cd-two"><label class="f">Theirs (saved)<textarea readonly rows="10">${esc(c.theirs)}</textarea></label>
        <label class="f">Yours<textarea rows="10" id="cd-mine">${esc(mine)}</textarea></label></div>
      <div class="row" style="margin-top:10px"><span class="spacer"></span><button data-cd="theirs">Keep theirs</button><button class="primary" data-cd="mine">Save mine</button></div>`, 'wide');
    let done = false;
    const finish = (v) => { if (done) return; done = true; COLLAB.notes = []; collabBanner(); resolve(v); d.close(); };
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cd]'); if (!b) return;
      finish(b.dataset.cd === 'mine' ? d.querySelector('#cd-mine').value : String(c.theirs ?? ''));
    });
    d.addEventListener('cancel', (e) => { e.preventDefault(); });
  });
}

// ---- 🕘 a record's history, with ↩ Put back ------------------------------------------------------
const HIST_NAMES = { title: 'Title', name: 'Name', description: 'Description', status: 'Status', priority: 'Priority', owner: 'Owner', due_at: 'Due', start_at: 'Start',
  proposed_solution: 'Proposed solution', resolution: 'Resolution', benefit: 'Benefit', submitted_by: 'Submitted by', area_id: 'Area', cost: 'Cost', notes: 'Notes', body: 'Text' };
const histName = (f) => HIST_NAMES[f] || f.replace(/_at$/, '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const HIST_FIXED = /(^id$|_id$|^project_id$|^parent_id$|^is_|^baseline)/;
function histValue(v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">(empty)</span>';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return esc(fmtDateTime(v));
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 160 ? `<details><summary>${esc(s.slice(0, 160))}…</summary><div class="pre">${esc(s)}</div></details>` : `<span class="pre">${esc(s)}</span>`;
}
async function collabHistory(kind, id, title = '') {
  let rows;
  try { rows = await api.get(`/history/${kind}/${id}`); } catch (err) { toast(err.message, 'error'); return; }
  const verb = { INSERT: 'created it', DELETE: 'removed it', UPDATE: 'changed' };
  const d = collabDialog(`<div class="row"><h3 style="margin:0">🕘 History${title ? ` — ${esc(title)}` : ''}</h3><span class="spacer"></span><button class="icon" data-hist="close">✕</button></div>
    <p class="small muted">Every change, newest first. ↩ Put back sets a field to what it was before that change (itself a new change, so it can be undone too).</p>
    <div class="hist-list">${rows.map((r) => `<div class="hist-row"><div class="small"><b>${esc(r.by || 'Someone')}</b> ${verb[r.action] || r.action} · <span class="muted">${esc(fmtDateTime(r.at))}</span></div>
      ${r.action === 'UPDATE' ? `<table class="log small"><tbody>${r.fields.map((f) => `<tr><td class="nowrap"><b>${esc(histName(f.field))}</b></td><td>${histValue(f.old)}</td><td>→</td><td>${histValue(f.new)}</td>
        <td>${HIST_FIXED.test(f.field) && f.field !== 'area_id' ? '' : `<button class="small" data-hist-back="${esc(f.field)}" data-val="${esc(JSON.stringify(f.old))}" title="Set ${esc(histName(f.field))} back to this change's earlier value">↩ Put back</button>`}</td></tr>`).join('')}</tbody></table>` : ''}</div>`).join('') || '<p class="muted">No changes recorded.</p>'}</div>`, 'wide');
  d.addEventListener('click', async (e) => {
    if (e.target.closest('[data-hist="close"]')) { d.close(); return; }
    const b = e.target.closest('[data-hist-back]'); if (!b) return;
    let v = JSON.parse(b.dataset.val);
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) && /_at$/.test(b.dataset.histBack)) v = toDateInput(v);
    try {
      await api.patch(`/${kind}/${id}`, { [b.dataset.histBack]: v });
      toast(`${histName(b.dataset.histBack)} put back`);
      d.close();
      if ($('#modal')?.open) closeModal();
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---- copying a path (the clipboard API needs https or localhost: fall back to the old way) ------
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* not available here */ }
  const t = document.createElement('textarea');
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
  (document.querySelector('dialog[open]') || document.body).append(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* blocked */ }
  t.remove();
  return ok;
}
