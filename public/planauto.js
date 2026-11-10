'use strict';
// 📄 Automatic plans (Production › Setup, src/planauto.js): the 📄 Generate plan PDF made on a schedule, like a
// report subscription. Each is a saved set-up (Perso or Matching, order, cells or lists, layout, rows, overdue
// apart, testing), the times and days it runs, and the file it overwrites each time. Loaded after planning.js.

const PA_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PA_OTTO_LISTS = ['Incoming', 'Ready', 'In Progress'];
let paState = { plans: [], dirty: false, cells: [] };

// p: the plan just drawn (for the cells there are now)
async function planAutoLoad(p) {
  const box = $('#pl-auto'); if (!box) return;
  paState.cells = [...new Set([...cellsOf([...(p?.running || []), ...(p?.queue || [])]).map((c) => c.type), 'DOD', 'Emboss', 'Laser'])];
  try { paState.plans = (await api.get('/plan/auto')).plans; paState.dirty = false; } catch (err) { box.innerHTML = `<p class="small muted">${esc(err.message)}</p>`; return; }
  planAutoDraw();
}
const paWhen = (k) => (k ? new Date(k.length === 16 ? `${k}:00` : k).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
function planAutoDraw() {
  const box = $('#pl-auto'); if (!box) return;
  const item = (s, i) => {
    const otto = s.half === 'otto';
    const lists = otto ? PA_OTTO_LISTS : [...new Set([...paState.cells, ...s.cells])];
    const last = s.last;
    const status = !last ? '<span class="muted">Not made yet.</span>'
      : last.ok ? `<span class="pa-ok">✔ Made ${esc(paWhen(last.at))}</span> · ${n0(last.rows)} rows · <a href="/api/plan/auto/${esc(s.id)}/file" target="_blank" rel="noopener">📄 open it</a>`
        : `<span class="pa-bad">⚠ ${esc(paWhen(last.at))}: ${esc(last.error || 'failed')}</span>`;
    return `<div class="pa-item${s.enabled ? '' : ' off'}" data-pa="${i}">
      <div class="pa-head">
        <label class="pa-switch" title="Runs at its times while on"><input type="checkbox" data-pa-f="enabled" ${s.enabled ? 'checked' : ''}> On</label>
        <input type="text" class="pa-name" data-pa-f="name" value="${esc(s.name)}" maxlength="80" placeholder="e.g. Morning plan for the floor">
        <div class="spacer"></div>
        <button type="button" class="small" data-pa-act="run" title="Make it now and overwrite the file (saves first)">▶ Run now</button>
        <button type="button" class="icon" data-pa-act="del" title="Remove this automatic plan">🗑</button>
      </div>
      <div class="pa-grid">
        <label class="f">Plan<select data-pa-f="half"><option value="perso" ${otto ? '' : 'selected'}>💳 Perso — a sheet per cell</option><option value="otto" ${otto ? 'selected' : ''}>✉️ Matching — Incoming / Ready / In Progress</option></select></label>
        ${otto ? '<div></div>' : `<label class="f">Order<select data-pa-f="mode">${PL_MODES.map(([k, l]) => `<option value="${k}" ${s.mode === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`}
        <label class="f">Layout<select data-pa-f="layout"><option value="pages" ${s.layout !== 'side' ? 'selected' : ''}>A page per ${otto ? 'list' : 'cell'} (portrait)</option><option value="side" ${s.layout === 'side' ? 'selected' : ''}>Side by side (landscape)</option></select></label>
        <label class="f">Rows per ${otto ? 'list' : 'cell'}<input type="number" data-pa-f="limit" min="0" max="500" step="1" value="${s.limit || ''}" placeholder="All"></label>
        <div class="f full"><span>${otto ? 'Lists' : 'Cells'} <span class="muted small">— none ticked: all of them</span></span><div class="row">${lists.map((c) => `<label class="row small"><input type="checkbox" data-pa-cell="${esc(c)}" ${s.cells.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div></div>
        <div class="f full row small" style="gap:14px"><label class="row"><input type="checkbox" data-pa-f="split" ${s.split ? 'checked' : ''}> Overdue on a separate list</label><label class="row"><input type="checkbox" data-pa-f="testing" ${s.testing ? 'checked' : ''}> 🧪 Testing mode</label></div>
        <label class="f">Times <span class="muted small">— 24 h, e.g. 05:45, 13:45</span><input type="text" data-pa-f="times" value="${esc(s.times.join(', '))}" placeholder="05:45, 13:45, 21:45"></label>
        <div class="f"><span>Days</span><div class="row">${PA_DAYS.map((d, k) => `<label class="row small"><input type="checkbox" data-pa-day="${k}" ${s.days.includes(k) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
        <label class="f full">Save into the folder <span class="muted small">— as the server sees it, e.g. S:\\Production\\Plans or \\\\server\\share\\Plans</span><input type="text" data-pa-f="folder" value="${esc(s.folder)}" placeholder="S:\\Production\\Plans"></label>
        <label class="f">File name <span class="muted small">(.pdf, overwritten each time)</span><input type="text" data-pa-f="file" value="${esc(s.file)}" placeholder="Production plan"></label>
        <div class="f"><span>Next run</span><b class="small">${s.enabled && s.next ? esc(paWhen(s.next)) : '<span class="muted">—</span>'}</b></div>
      </div>
      <div class="pa-status small">${status}${s.path ? ` <span class="muted" title="${esc(s.path)}">· ${esc(s.path)}</span>` : ''}</div>
    </div>`;
  };
  const n0 = (v) => Number(v || 0).toLocaleString('en-GB');
  box.innerHTML = `${paState.plans.map(item).join('') || '<p class="small muted">None yet. An automatic plan makes the 📄 Generate plan PDF at set times and saves it over the same file, so whoever opens that file sees the latest plan, like a report subscription.</p>'}
    <div class="row" style="gap:8px;margin-top:8px"><button type="button" data-pa-act="add">＋ Add an automatic plan</button><div class="spacer"></div>
      <span class="small muted" id="pa-dirty" ${paState.dirty ? '' : 'hidden'}>Not saved yet</span><button type="button" class="primary" data-pa-act="save" ${paState.dirty ? '' : 'disabled'}>💾 Save</button></div>`;
}
// what's on the page → the list (kept until saved)
function planAutoRead() {
  for (const el of $$('#pl-auto [data-pa]')) {
    const s = paState.plans[Number(el.dataset.pa)]; if (!s) continue;
    for (const f of el.querySelectorAll('[data-pa-f]')) {
      const k = f.dataset.paF;
      s[k] = f.type === 'checkbox' ? f.checked : k === 'times' ? f.value.split(/[\s,;]+/).filter(Boolean) : k === 'limit' ? Number(f.value) || 0 : f.value;
    }
    s.cells = [...el.querySelectorAll('[data-pa-cell]:checked')].map((x) => x.dataset.paCell);
    s.days = [...el.querySelectorAll('[data-pa-day]:checked')].map((x) => Number(x.dataset.paDay));
  }
}
function planAutoDirty() { paState.dirty = true; const d = $('#pa-dirty'); if (d) d.hidden = false; const b = $('#pl-auto [data-pa-act="save"]'); if (b) b.disabled = false; }
async function planAutoSave() {
  planAutoRead();
  const r = await api.put('/plan/auto', { plans: paState.plans });
  paState.plans = r.plans; paState.dirty = false; planAutoDraw();
}
document.addEventListener('input', (e) => { if (e.target.closest('#pl-auto [data-pa]')) planAutoDirty(); });
document.addEventListener('change', (e) => {
  if (!e.target.closest('#pl-auto [data-pa]')) return;
  planAutoDirty();
  if (e.target.dataset.paF === 'half' || e.target.dataset.paF === 'enabled') { planAutoRead(); if (e.target.dataset.paF === 'half') paState.plans[Number(e.target.closest('[data-pa]').dataset.pa)].cells = []; planAutoDraw(); planAutoDirty(); }
});
document.addEventListener('click', async (e) => {
  const b = e.target.closest('#pl-auto [data-pa-act]'); if (!b) return;
  const act = b.dataset.paAct; const i = Number(b.closest('[data-pa]')?.dataset.pa);
  try {
    if (act === 'add') {
      planAutoRead();
      paState.plans.push({ id: '', name: `Plan ${paState.plans.length + 1}`, enabled: true, half: 'perso', mode: store.get('planMode', 'fifo'), cells: [], layout: 'pages', limit: 0, split: false, testing: false,
        times: ['06:00'], days: [1, 2, 3, 4, 5], folder: '', file: 'Production plan', last: null, next: null });
      planAutoDraw(); planAutoDirty(); $(`#pl-auto [data-pa="${paState.plans.length - 1}"] .pa-name`)?.focus();
    } else if (act === 'del') {
      planAutoRead();
      if (!confirm(`Remove “${paState.plans[i].name}”? Its file stays where it is.`)) return;
      paState.plans.splice(i, 1); planAutoDraw(); planAutoDirty();
    } else if (act === 'save') {
      await planAutoSave(); toast('Automatic plans saved');
    } else if (act === 'run') {
      if (paState.dirty) await planAutoSave();
      const s = paState.plans[i]; b.disabled = true; b.textContent = '⏳ Making it…';
      const r = await api.post(`/plan/auto/${s.id}/run`, {}).catch((err) => ({ ok: false, error: err.message }));
      if (r.plans) paState.plans = r.plans; else await planAutoLoad(planNow);
      planAutoDraw();
      toast(r.ok ? `Made: ${r.file}` : `Not made: ${r.error}`, r.ok ? '' : 'error');
    }
  } catch (err) { toast(err.message, 'error'); }
});
