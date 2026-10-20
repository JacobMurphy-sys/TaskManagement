// 📅 Rescheduling (src/reschedule.js): moving a due date (task, project, phase, idea) or a meeting's
// time with a reason, and every earlier date kept with the record. Any change of the date, from any
// screen, is logged; the dialog adds the reason and quick picks.
const RESCHED = {
  task: { path: (id) => `/tasks/${id}`, field: 'due_at', label: 'task' },
  project: { path: (id) => `/projects/${id}`, field: 'due_at', label: 'project' },
  phase: { path: (id) => `/phases/${id}`, field: 'due_at', label: 'phase' },
  idea: { path: (id) => `/ideas/${id}`, field: 'due_at', label: 'idea' },
  meeting: { path: (id) => `/meetings/${id}`, field: 'held_at', label: 'meeting', time: true },
};
const reschedWhen = (kind, iso) => (!iso ? 'no date' : RESCHED[kind]?.time ? fmtDateTime(iso) : fmtDate(iso));

// The earlier dates, newest first.
function reschedListHtml(kind, moves) {
  if (!moves.length) return '<p class="small muted">Not moved yet.</p>';
  return `<ol class="resched-list">${moves.map((m) => `<li><span class="resched-from">${esc(reschedWhen(kind, m.from_value))}</span> → <b>${esc(reschedWhen(kind, m.to_value))}</b>
    <span class="small muted">· ${m.by_name ? `${esc(m.by_name)}, ` : ''}${esc(fmtDateTime(m.created_at))}</span>${m.reason ? `<div class="small">${esc(m.reason)}</div>` : ''}</li>`).join('')}</ol>`;
}

// The dialog: the new date (quick picks: +1 day, +1 week, +2 weeks, next Monday), why, and the earlier dates.
async function reschedOpen(kind, id, after = null) {
  const k = RESCHED[kind]; if (!k) return;
  let h; try { h = await api.get(`/reschedules/${kind}/${id}`); } catch (err) { toast(err.message, 'error'); return; }
  const cur = h.current ? new Date(h.current) : null;
  const val = (d) => (k.time ? toLocalInput(d.toISOString()) : dateKey(d));
  const d = collabDialog(`<form method="dialog" id="rs-form"><div class="row"><h3 style="margin:0">📅 Reschedule the ${k.label}</h3><span class="spacer"></span><button class="icon" value="cancel" formnovalidate>✕</button></div>
      <p class="small muted">Now: <b>${esc(reschedWhen(kind, h.current))}</b>. The earlier dates stay listed with it.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-end">
        <label class="f"><span>New ${k.time ? 'date and time' : 'date'}</span><input type="${k.time ? 'datetime-local' : 'date'}" name="to" required value="${cur ? esc(val(cur)) : ''}"></label>
        ${cur ? `<div class="row small" style="gap:4px">${[['+1 day', 1], ['+1 week', 7], ['+2 weeks', 14]].map(([l, n]) => `<button type="button" class="small" data-rs-add="${n}">${l}</button>`).join('')}<button type="button" class="small" data-rs-monday>Next Monday</button></div>` : ''}</div>
      <label class="f"><span>Why <span class="muted small">— kept with the date</span></span><input type="text" name="reason" maxlength="500" placeholder="e.g. waiting on the supplier's parts"></label>
      <div class="row" style="margin-top:8px"><span class="spacer"></span><button value="cancel" formnovalidate>Cancel</button><button class="primary" value="ok">Move it</button></div>
      <h4 style="margin:14px 0 6px">Earlier dates <span class="muted small">${h.moves.length}</span></h4>${reschedListHtml(kind, h.moves)}</form>`);
  const input = d.querySelector('[name=to]');
  const base = () => (input.value ? new Date(k.time ? input.value : `${input.value}T12:00`) : cur ? new Date(cur) : new Date());
  d.addEventListener('click', (e) => {
    const add = e.target.closest('[data-rs-add]');
    if (add) { const x = cur ? new Date(cur) : new Date(); x.setDate(x.getDate() + Number(add.dataset.rsAdd)); input.value = val(x); }
    if (e.target.closest('[data-rs-monday]')) { const x = base(); x.setDate(x.getDate() + (((8 - x.getDay()) % 7) || 7)); input.value = val(x); }
  });
  d.querySelector('form').addEventListener('submit', async (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    const to = input.value; if (!to) return;
    try {
      await api.patch(k.path(id), { [k.field]: k.time ? fromLocalInput(to) : to, reschedule_reason: d.querySelector('[name=reason]').value.trim() || null });
      toast(`Moved to ${reschedWhen(kind, k.time ? fromLocalInput(to) : `${to}T12:00`)}`);
      d.close();
      if (after) await after(); else await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// "📅 Reschedule · moved 2× (was 12 Oct, 19 Oct)" next to a date: placeholders
// <span data-resched="kind:id"></span> filled in after a page or dialog is drawn.
async function reschedHydrate(root = document, after = null) {
  for (const el of $$('[data-resched]', root)) {
    const [kind, id] = el.dataset.resched.split(':');
    let h; try { h = await api.get(`/reschedules/${kind}/${id}`); } catch { continue; }
    const was = h.moves.slice(0, 3).map((m) => (m.from_value ? (RESCHED[kind].time ? fmtDateTime(m.from_value) : fmtShortDate(m.from_value)) : '—'));
    el.innerHTML = `<button type="button" class="small" data-rs-open>📅 Reschedule</button>${h.moves.length ? ` <span class="small resched-was" title="${esc(h.moves.map((m) => `${reschedWhen(kind, m.from_value)} → ${reschedWhen(kind, m.to_value)}${m.reason ? ` (${m.reason})` : ''}`).join('\n'))}">↻ moved ${h.moves.length}× · was ${esc(was.join(', '))}${h.moves.length > 3 ? ', …' : ''}</span>` : ''}`;
    // after a move: the task or meeting dialog opens again with it; a phase's closes; pages are drawn again
    const next = after || (kind === 'task' ? async () => { state.modalDirty = true; await taskModal(id); }
      : kind === 'meeting' ? async () => { state.modalDirty = true; await meetingEditor(id); }
        : kind === 'phase' ? async () => { closeModal(); await refresh(); } : () => refresh());
    el.querySelector('[data-rs-open]').addEventListener('click', () => reschedOpen(kind, id, next));
  }
}
