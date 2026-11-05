'use strict';
// 🚚 OTD: Reporting's tab for logging late deliveries (the Despatch module, src/otdentry.js). Logistics types a
// work order (or a customer) and picks it from what the planner knows; the customer, cards, due out and so the
// reporting week fill themselves in. They say internal or external, and why. The week's delays are listed beside.
// Loaded after quality.js; uses app.js's helpers and kpi.js's kpiTabsHtml.

let otdState = { wo: null, editing: null, type: null };
const OTDN = (v) => Number(v || 0).toLocaleString('en-GB');
const otdDue = (dl) => (dl ? `${fmtShortDate(dl.slice(0, 10))}${dl.length > 10 && !dl.endsWith('T23:59') ? ` ${dl.slice(11, 16)}` : ''}` : '—');
// the pickup a work order can go with: the next one while it's open, the one after it was finished otherwise
const otdPickup = (x, { long = false } = {}) => {
  if (!x?.pickup) return `<span class="muted">${x?.cutoff === null && x?.shipper !== undefined ? 'no shipping time on the planner' : '—'}</span>`;
  const day = new Date(`${x.pickup.slice(0, 10)}T00:00:00`); const t = x.pickup.slice(11, 16);
  const today = new Date(); today.setHours(0, 0, 0, 0); const diff = Math.round((day - today) / 86400000);
  const when = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `<span class="otd-pick ${x.pickup_kind === 'next' ? 'next' : ''}" title="${esc(x.pickup_kind === 'next' ? 'The next pickup from now: the shipper\'s cut-off on the next working day' : 'The first pickup after it was finished')}">${x.pickup_kind === 'went' ? (long ? 'went with ' : 'went ') : ''}${esc(when)} ${esc(t)}</span>${x.shipper ? `<div class="small muted">${esc(x.shipper)}</div>` : ''}`;
};
const otdDay = (s) => new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const otdStamp = (s) => { const d = new Date(s); return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const otdTypePill = (t) => `<span class="otd-pill ${t === 'Internal' ? 'int' : 'ext'}">${t === 'Internal' ? '🏭 Internal' : '👤 External'}</span>`;

async function renderOtdTab() {
  let d;
  try { d = await api.get(`/kpi/otd${store.get('otdWeek', '') ? `?week=${encodeURIComponent(store.get('otdWeek', ''))}` : ''}`); } catch (err) { main().innerHTML = `<div class="card">${esc(err.message)}</div>`; return; }
  otdState = { wo: null, editing: null, type: null };
  otdWeekMonths = new Map(d.weeks.map((w) => [w.week, w.month]));
  const sourcesLink = modOk('kpi_sources') ? '<a class="button small" href="#/kpi/sources">Change it on Sources</a>' : '<span class="small muted">an admin can change it on Reporting › Sources</span>';
  const note = d.counted ? '' : `<div class="kpi-action notice"><span>ℹ These delays are kept, but OTD is still counted from the Excel OTD report, so they don't reach the Weekly SC Report yet.</span>${sourcesLink}</div>`;
  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 Reporting</h1>
      <select id="otd-week" class="kpi-pick" title="The reporting week to show (how many delays are logged in it)">${d.weeks.map((w) => `<option value="${w.week}" ${w.week === d.week ? 'selected' : ''}>${esc(w.week)} · ${esc(w.month)}${w.n ? ` (${w.n})` : ''}</option>`).join('')}</select>
      ${kpiTabsHtml('otd')}
      <div class="spacer"></div>
      <span class="small muted">${d.counted ? '🚚 OTD is counted from these entries' : '🚚 Not counted yet (OTD report in use)'}</span>
    </div>
    ${note}
    <div class="otd-grid">
      <div class="card otd-form" id="otd-form">${otdFormHtml(d)}</div>
      <div class="card otd-week">${otdWeekHtml(d)}</div>
    </div>`;
  $('#otd-week').addEventListener('change', (e) => { store.set('otdWeek', e.target.value); renderOtdTab(); });
  wireOtd(d);
}

function otdFormHtml(d) {
  const e = otdState.editing;
  return `<h2 style="margin-top:0">${e ? `✎ Change the delay on ${esc(e.wo)}` : '➕ Log a late delivery'}</h2>
    <label class="otd-l">Work order
      <div class="otd-search"><input id="otd-wo" type="text" autocomplete="off" spellcheck="false" placeholder="Type a work order or customer, e.g. CADXS…" value="${esc(otdState.wo?.wo || '')}">
        <div class="otd-sugg" id="otd-sugg" hidden></div></div></label>
    <div id="otd-wo-card">${otdWoCard()}</div>
    <div class="otd-fields" ${otdState.wo ? '' : 'hidden'}>
      <div class="otd-l">Whose delay?
        <div class="otd-type">
          <button type="button" data-otd-type="Internal" class="${otdState.type === 'Internal' ? 'on' : ''}"><b>🏭 Internal</b><span>the Service Center's own (counts against OTD SC)</span></button>
          <button type="button" data-otd-type="External" class="${otdState.type === 'External' ? 'on' : ''}"><b>👤 External</b><span>the customer's (counts against OTD C)</span></button>
        </div></div>
      <div class="otd-row">
        <label class="otd-l">Cards delayed <input id="otd-qty" type="number" min="1" step="1" value="${esc(e ? e.qty : otdState.wo?.qty || '')}"><span class="small muted" id="otd-qty-of">${otdState.wo ? `of ${OTDN(otdState.wo.qty)} on the work order` : ''}</span></label>
        <label class="otd-l">Reporting week <input id="otd-wk" type="text" value="${esc(e ? e.week : otdState.wo?.week || '')}" title="The week it was due out; change it if it belongs to another week (e.g. W2644, or W2644_1 for a split week)"></label>
      </div>
      <label class="otd-l">Reason <input id="otd-reason" type="text" list="otd-reasons" maxlength="200" value="${esc(e?.reason || '')}" placeholder="Pick one used before or type a new one">
        <datalist id="otd-reasons">${d.reasons.map((r) => `<option value="${esc(r)}">`).join('')}</datalist></label>
      ${d.reasons.length ? `<div class="otd-chips">${d.reasons.slice(0, 8).map((r) => `<button type="button" class="otd-chip" data-otd-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>` : ''}
      <label class="otd-l"><span>Note <span class="small">(optional)</span></span><input id="otd-note" type="text" maxlength="500" value="${esc(e?.note || '')}"></label>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="primary" id="otd-save">${e ? '💾 Save changes' : '✔ Log this delay'}</button>
        ${e ? '<button id="otd-cancel">Cancel</button>' : '<button id="otd-clear">Clear</button>'}
      </div>
    </div>
    ${otdState.wo ? '' : `<p class="small muted" style="margin:10px 0 0">Only work orders the planner knows can be picked: open ones, and those finished in the last 4 weeks. The customer, cards, due out and reporting week are filled in from the planner.</p>`}`;
}

function otdWoCard() {
  const w = otdState.wo; if (!w) return '';
  const status = w.open ? '<span class="otd-st open">open on the planner</span>' : !w.done_at ? '<span class="otd-st">no longer on the planner</span>'
    : `<span class="otd-st done">finished ${esc(fmtShortDate(String(w.done_at).slice(0, 10)))}${w.late_minutes > 0 ? ` · ${Math.round(w.late_minutes / 60)} h late` : ''}</span>`;
  return `<div class="otd-wo">
    <div class="otd-wo-h"><b>${esc(w.wo)}</b>${status}${w.renewal ? '<span class="otd-st">renewal</span>' : '<span class="otd-st">daily</span>'}</div>
    <div class="otd-facts">
      <div><span>Customer</span><b>${esc(w.customer || '—')}</b>${w.name ? `<i>${esc(w.name)}</i>` : ''}</div>
      <div><span>Cards</span><b>${OTDN(w.qty)}</b>${w.lines?.length > 1 ? `<i>${w.lines.length} lines</i>` : ''}</div>
      <div><span>Due out</span><b>${esc(otdDue(w.deadline))}</b></div>
      <div><span>Week</span><b>${esc(w.week || '—')}</b>${w.week ? `<i>${esc(otdMonthOf(w.week))}</i>` : ''}</div>
    </div>
    <div class="otd-pickline"><span>${w.pickup_kind === 'went' ? '🚚 Pickup after it was finished' : '🚚 Next possible pickup'}</span>${otdPickup(w)}</div>
    ${w.logged ? `<div class="small" style="color:var(--warn);margin-top:6px">⚠ Already logged ${w.logged.n}× (${OTDN(w.logged.q)} cards): check it isn't a second entry for the same delay.</div>` : ''}
  </div>`;
}
let otdWeekMonths = new Map();
const otdMonthOf = (wk) => otdWeekMonths.get(wk) || '';

function otdWeekHtml(d) {
  const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
  return `<div class="row" style="align-items:baseline;gap:8px;flex-wrap:wrap"><h2 style="margin:0">${esc(d.week)} <span class="muted small">${esc(d.month || '')}</span></h2><div class="spacer"></div>
      <span class="small muted">${d.entries.length} delay${d.entries.length === 1 ? '' : 's'} logged</span></div>
    <div class="otd-sum">
      <div class="q-tile"><div class="q-tile-l">🏭 Internal</div><div class="q-tile-v">${OTDN(d.internal)}</div><div class="q-tile-s">cards late, the Service Center's</div></div>
      <div class="q-tile"><div class="q-tile-l">👤 External</div><div class="q-tile-v">${OTDN(d.external)}</div><div class="q-tile-s">cards late, the customer's</div></div>
      <div class="q-tile"><div class="q-tile-l">OTD SC this week</div><div class="q-tile-v">${pct(d.otd_sc)}</div><div class="q-tile-s">${d.shipped ? `of ${OTDN(d.shipped)} cards shipped · OTD C ${pct(d.otd_c)}` : 'cards shipped not read yet'}</div></div>
    </div>
    ${d.entries.length ? `<div class="kdb-scroll"><table class="log otd-table"><thead><tr><th>Work order</th><th>Customer</th><th class="num">Cards</th><th>Due out</th><th title="The shipper's next cut-off on a working day (or, once finished, the one it went with)">Next pickup</th><th>Delay</th><th>Reason</th><th>Logged</th><th></th></tr></thead><tbody>
      ${d.entries.map((e) => `<tr><td><b>${esc(e.wo)}</b></td><td>${esc(e.customer || '')}${e.name ? `<div class="small muted">${esc(e.name)}</div>` : ''}</td>
        <td class="num">${OTDN(e.qty)}${e.wo_qty && e.wo_qty !== e.qty ? `<div class="small muted">of ${OTDN(e.wo_qty)}</div>` : ''}</td><td class="nowrap">${e.due ? esc(otdDay(e.due)) : '—'}</td><td>${otdPickup(e)}</td>
        <td>${otdTypePill(e.type)}</td><td>${esc(e.reason)}${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</td>
        <td class="small muted nowrap" title="${esc(`Logged ${fmtDateTime(e.created_at)}${e.updated_by ? ` · changed ${fmtDateTime(e.updated_at)} by ${e.updated_by}` : ''}`)}">${esc(otdStamp(e.created_at))}${e.created_by ? `<div>${esc(e.created_by)}</div>` : ''}</td>
        <td class="nowrap"><button class="icon" data-otd-edit="${e.id}" title="Change">✎</button><button class="icon" data-otd-del="${e.id}" title="Remove">🗑</button></td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty small" style="margin-top:12px">No late deliveries logged for this week.</div>'}
    ${otdDaysHtml(d)}`;
}

// 📅 day by day: OTD SC and C from cards shipped and the delays logged against that due-out day; beside it,
// the planner's work orders due that day and how many cards were finished by their deadline
function otdDaysHtml(d) {
  const days = (d.days || []).filter((x) => !x.weekend || x.shipped || x.due || x.internal || x.external);
  if (!days.length) return '';
  const pct = (v) => (v === null || v === undefined ? '<span class="muted">—</span>' : `<span class="ops-pct ${v >= 0.98 ? 'good' : v >= 0.9 ? 'warn' : 'bad'}">${(v * 100).toFixed(1)}%</span>`);
  const dayName = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return `<h3 class="otd-days-h">Day by day</h3>
    <div class="kdb-scroll"><table class="log otd-days"><thead><tr><th>Day</th><th class="num">Cards shipped</th><th class="num">🏭 Internal</th><th class="num">👤 External</th><th class="num">OTD SC</th><th class="num">OTD C</th>
      <th class="num" title="From the planner: of the cards on work orders due out that day and finished, the share finished by their deadline">Planner on time</th></tr></thead><tbody>
      ${days.map((x) => `<tr class="${x.future ? 'muted' : ''}"><td class="nowrap"><b>${esc(dayName(x.day))}</b></td>
        <td class="num">${x.shipped ? OTDN(x.shipped) : '<span class="muted">—</span>'}</td><td class="num">${x.internal ? OTDN(x.internal) : ''}</td><td class="num">${x.external ? OTDN(x.external) : ''}</td>
        <td class="num">${x.shipped ? pct(x.otd_sc) : '<span class="muted">—</span>'}</td><td class="num">${x.shipped ? pct(x.otd_c) : '<span class="muted">—</span>'}</td>
        <td class="num" title="${esc(`${OTDN(x.due)} cards due: ${OTDN(x.on_time)} on time, ${OTDN(x.late)} late, ${OTDN(x.open)} not finished`)}">${pct(x.planner_pct)}${x.due ? `<span class="small muted"> of ${OTDN(x.due)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>
    <div class="small muted" style="margin:6px 0 0">OTD per day = 1 − cards logged late (by due-out day) ÷ cards shipped that day: as complete as what's logged. <i>Planner on time</i> needs no logging (hover a day for its cards).</div>`;
}

function wireOtd(d) {
  const form = $('#otd-form');
  const redraw = () => { form.innerHTML = otdFormHtml(d); wireOtdForm(d); };
  wireOtdForm(d);
  $('.otd-week').addEventListener('click', async (e) => {
    const ed = e.target.closest('[data-otd-edit]'); const del = e.target.closest('[data-otd-del]');
    if (ed) {
      const entry = d.entries.find((x) => x.id === Number(ed.dataset.otdEdit)); if (!entry) return;
      try { otdState.wo = await api.get(`/kpi/otd/wo/${encodeURIComponent(entry.wo)}`); } catch { otdState.wo = { wo: entry.wo, customer: entry.customer, qty: entry.wo_qty || entry.qty, deadline: entry.due, week: entry.week, open: false }; }
      otdState.editing = entry; otdState.type = entry.type; redraw(); form.scrollIntoView({ block: 'nearest' });
    }
    if (del) {
      const entry = d.entries.find((x) => x.id === Number(del.dataset.otdDel)); if (!entry) return;
      if (!confirm(`Remove the delay on ${entry.wo} (${OTDN(entry.qty)} cards, ${entry.type.toLowerCase()})?`)) return;
      try { await api.del(`/kpi/otd/${entry.id}`); toast('Delay removed'); renderOtdTab(); } catch (err) { toast(err.message, 'error'); }
    }
  });
  form.addEventListener('otd-redraw', redraw);
}

function wireOtdForm(d) {
  const form = $('#otd-form'); const inp = $('#otd-wo'); const box = $('#otd-sugg');
  let list = []; let sel = -1; let timer = null; let seq = 0;
  const show = () => {
    box.hidden = !list.length && !inp.value.trim();
    box.innerHTML = list.length ? list.map((w, i) => `<button type="button" class="otd-s${i === sel ? ' on' : ''}" data-i="${i}">
        <span class="otd-s-wo"><b>${esc(w.wo)}</b> ${w.open ? '<span class="otd-st open">open</span>' : `<span class="otd-st done">finished ${esc(fmtShortDate(String(w.done_at).slice(0, 10)))}</span>`}${w.logged ? ' <span class="otd-st warn">logged</span>' : ''}</span>
        <span class="otd-s-sub">${esc(w.customer || '')}${w.name ? ` · ${esc(w.name)}` : ''} · ${OTDN(w.qty)} cards · due ${esc(otdDue(w.deadline))}</span></button>`).join('')
      : inp.value.trim().length >= 2 ? '<div class="otd-s none small muted">No work order like that on the planner (open, or finished in the last 4 weeks)</div>' : '';
  };
  const pick = (w) => {
    otdState.wo = { ...w, week: w.week || null };
    if (!otdState.wo.week) api.get(`/kpi/otd/wo/${encodeURIComponent(w.wo)}`).then((full) => { otdState.wo = { ...otdState.wo, ...full }; form.dispatchEvent(new Event('otd-redraw')); }).catch(() => {});
    form.dispatchEvent(new Event('otd-redraw'));
    setTimeout(() => $('[data-otd-type]')?.focus(), 0);
  };
  inp.addEventListener('input', () => {
    if (otdState.wo && inp.value.trim().toUpperCase() !== otdState.wo.wo) { otdState.wo = null; $('#otd-wo-card').innerHTML = ''; $('.otd-fields').hidden = true; }
    clearTimeout(timer); const q = inp.value.trim();
    if (q.length < 2) { list = []; sel = -1; show(); return; }
    timer = setTimeout(async () => { const n = ++seq; try { const r = await api.get(`/kpi/otd/wo?q=${encodeURIComponent(q)}`); if (n !== seq) return; list = r; sel = r.length ? 0 : -1; show(); } catch { /* typing on */ } }, 160);
  });
  inp.addEventListener('keydown', (e) => {
    if (box.hidden || !list.length) return;
    if (e.key === 'ArrowDown') { sel = (sel + 1) % list.length; show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = (sel - 1 + list.length) % list.length; show(); e.preventDefault(); }
    else if (e.key === 'Enter' && sel >= 0) { e.preventDefault(); pick(list[sel]); }
    else if (e.key === 'Escape') { box.hidden = true; }
  });
  inp.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
  inp.addEventListener('focus', () => { if (list.length) show(); });
  box.addEventListener('mousedown', (e) => { const b = e.target.closest('[data-i]'); if (b) { e.preventDefault(); pick(list[Number(b.dataset.i)]); } });
  if (!otdState.wo && !otdState.editing) setTimeout(() => inp.focus(), 0);

  form.querySelectorAll('[data-otd-type]').forEach((b) => b.addEventListener('click', () => {
    otdState.type = b.dataset.otdType; form.querySelectorAll('[data-otd-type]').forEach((x) => x.classList.toggle('on', x === b)); $('#otd-reason')?.focus();
  }));
  form.querySelectorAll('[data-otd-reason]').forEach((b) => b.addEventListener('click', () => { $('#otd-reason').value = b.dataset.otdReason; }));
  $('#otd-clear')?.addEventListener('click', () => { otdState = { wo: null, editing: null, type: null }; form.dispatchEvent(new Event('otd-redraw')); });
  $('#otd-cancel')?.addEventListener('click', () => { otdState = { wo: null, editing: null, type: null }; form.dispatchEvent(new Event('otd-redraw')); });
  $('#otd-save')?.addEventListener('click', async () => {
    if (!otdState.wo) return toast('Pick a work order from the list first', 'error');
    if (!otdState.type) return toast('Pick internal or external', 'error');
    const body = { wo: otdState.wo.wo, type: otdState.type, qty: $('#otd-qty').value, week: $('#otd-wk').value.trim(), reason: $('#otd-reason').value.trim(), note: $('#otd-note').value.trim() };
    if (!body.reason) { $('#otd-reason').focus(); return toast('Give a reason for the delay', 'error'); }
    try {
      const saved = otdState.editing ? await api.patch(`/kpi/otd/${otdState.editing.id}`, body) : await api.post('/kpi/otd', body);
      toast(`${otdState.editing ? 'Saved' : 'Logged'}: ${saved.wo}, ${OTDN(saved.qty)} cards ${saved.type.toLowerCase()}, in ${saved.week}`);
      store.set('otdWeek', saved.week); renderOtdTab();
    } catch (err) { toast(err.message, 'error'); }
  });
}
