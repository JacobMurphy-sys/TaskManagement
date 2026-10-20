'use strict';
// 📆 KPIs › ⏱ Production › D+ (due out): how much notice work orders come with (src/dplus.js) — D+0 due
// out the day they came in, D+1 the next working day… — over a time frame, as totals and an average a
// working day, with the arrivals day by day. Click a row for that bucket's customers, job sizes,
// shippers, priorities, weekdays, how it went and its largest work orders. Loaded before app.js.

const DPL = {
  colors: { past: '#b23b3b', d0: '#e0672f', d1: '#e3a32b', d2: '#9bbb4a', d3: '#4fa36a', d4: '#3b8bb5', d5: '#6c6fc4' },
  quick: [['28', 'Last 4 weeks'], ['7', 'Last 7 days'], ['90', 'Last 90 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['all', 'All history']],
};
const dplState = { from: null, to: null, bucket: null };
const dplDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function dplRange(q, since) {
  const t = new Date(); t.setHours(12, 0, 0, 0);
  if (q === 'month') return [dplDay(new Date(t.getFullYear(), t.getMonth(), 1)), dplDay(t)];
  if (q === 'lastmonth') return [dplDay(new Date(t.getFullYear(), t.getMonth() - 1, 1)), dplDay(new Date(t.getFullYear(), t.getMonth(), 0))];
  if (q === 'all') return [since || dplDay(t), dplDay(t)];
  const f = new Date(t); f.setDate(f.getDate() - Number(q) + 1); return [dplDay(f), dplDay(t)];
}

async function renderKpiDplus() {
  if (!dplState.from) [dplState.from, dplState.to] = dplRange('28');
  const q = `/prod/dplus?from=${dplState.from}&to=${dplState.to}${dplState.bucket ? `&bucket=${dplState.bucket}` : ''}`;
  const d = await api.get(q);
  const n = (v, dp = 0) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: dp }));
  const pc = (v) => (v === null || v === undefined ? '—' : `${n(v, 1)}%`);
  const T = d.total;
  const short = d.buckets.filter((b) => ['past', 'd0', 'd1'].includes(b.key)).reduce((t, b) => t + b.wos, 0);
  const tile = (l, v, s = '') => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${v}</div>${s ? `<div class="kdb-tile-s">${s}</div>` : ''}</div>`;
  const maxPct = Math.max(1, ...d.buckets.map((b) => b.wos_pct || 0));
  const maxDay = Math.max(1, ...d.daily.map((x) => x.wos));
  const dayLbl = (x) => { const dt = new Date(`${x}T12:00`); return `${dt.toLocaleDateString('en-GB', { weekday: 'short' })}<br>${dt.getDate()}/${dt.getMonth() + 1}`; };

  const table = (rows, { label, name = false }) => `<div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>${label}</th><th class="num">WOs</th><th>Share of WOs</th><th class="num">Cards</th><th class="num">% cards</th><th class="num">Avg cards</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.label)}</b>${name && r.name ? ` <span class="small muted">${esc(r.name)}</span>` : ''}</td><td class="num">${n(r.wos)}</td>
      <td><div class="pllx-share"><div class="pll-track"><div style="width:${r.wos_pct || 0}%"></div></div><span>${pc(r.wos_pct)}</span></div></td>
      <td class="num">${n(r.cards)}</td><td class="num">${pc(r.cards_pct)}</td><td class="num">${n(r.avg_cards)}</td></tr>`).join('')}
  </tbody></table></div>`;
  const D = d.detail;
  const detailHtml = !D ? '' : `<div class="card dpl-detail" id="dpl-detail">
    <div class="row"><h3 class="pl-h" style="margin:0">${D.bucket !== 'all' ? `<span class="dpl-key" style="background:${DPL.colors[D.bucket]}"></span>` : ''}${esc(D.label)} <span class="muted small">— ${esc(fmtDate(`${d.from}T12:00`))} to ${esc(fmtDate(`${d.to}T12:00`))}</span></h3>
      <span class="spacer"></span><button class="icon" data-dpl-close title="Close">✕</button></div>
    <div class="kdb-tiles">${tile('Work orders', n(D.wos), `${n(D.jobs)} jobs`)}${tile('Cards', n(D.cards), `${n(D.avg_cards)} a work order`)}
      ${tile('Done', n(D.outcome.done), `${n(D.outcome.open)} still open`)}${tile('Late', pc(D.outcome.late_pct), D.outcome.late ? `${n(D.outcome.late)} WOs · ${fmtSpan(D.outcome.avg_late)} on average` : 'none of those done')}
      ${tile('Turnaround', D.outcome.median_hours === null ? '—' : fmtSpan(Math.round(D.outcome.median_hours * 60)), 'arrived → done, the middle one')}</div>
    <div class="grid pll-grid">
      <div><h4 class="dpl-h">Customers</h4>${table(D.customers, { label: 'Customer', name: true })}</div>
      <div><h4 class="dpl-h">Job size <span class="muted small">— cards in the work order</span></h4>${table(D.sizes, { label: 'Cards' })}</div>
      <div><h4 class="dpl-h">Shippers</h4>${table(D.shippers, { label: 'Shipper' })}</div>
      <div><h4 class="dpl-h">Priority</h4>${table(D.prios, { label: 'Priority' })}<h4 class="dpl-h">Day it came in</h4>${table(D.weekdays, { label: 'Weekday' })}</div>
    </div>
    ${D.largest.length ? `<h4 class="dpl-h">Largest work orders</h4><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Work order</th><th>Customer</th><th class="num">Cards</th><th class="num">Jobs</th><th>Came in</th><th>Due out</th><th>Done</th></tr></thead><tbody>
      ${D.largest.map((w) => `<tr><td>${modOk('planning') ? `<a href="#" data-dpl-wo="${esc(w.wo)}">${esc(w.wo)}</a>` : esc(w.wo)}</td><td>${esc(w.customer)}</td><td class="num">${n(w.qty)}</td><td class="num">${n(w.jobs)}</td>
        <td class="small">${esc(fmtDateTime(w.arrived))}</td><td class="small">${esc(fmtDate(`${w.due}T12:00`))}</td>
        <td class="small">${w.done_at ? `${esc(fmtDateTime(w.done_at))}${w.late_minutes > 0 ? ` <span class="pl-late">${fmtSpan(w.late_minutes)} late</span>` : ''}` : '<span class="muted">open</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : ''}</div>`;

  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 KPIs</h1>
      <div class="seg"><a href="#/kpi">A3 Weekly Report</a><a href="#/kpi/0/database">Database</a><a href="#/kpi/sources">Sources</a><a href="#/kpi/production" class="on">⏱ Production</a></div>
      <div class="seg"><button type="button" data-prod-source="perso">Perso</button><button type="button" data-prod-source="otto">Matching</button><button type="button" data-prod-source="dplus" class="on">📆 D+ due out</button></div>
    </div>
    <p class="small muted" style="margin:6px 0 10px">How much notice perso work orders come with: the day each first appeared in the open work orders export against its due-out day, in working days (Planning's working days).
      <b>D+0</b> is due out the day it came in, <b>D+1</b> the next working day, and so on. ${d.since ? `Recorded since ${esc(fmtDate(`${d.since}T12:00`))}; the work orders already in the export when recording began are left out (when they came in isn't known).` : ''}</p>
    ${!d.since ? '<div class="card muted">Nothing recorded yet. This builds up from 🏭 Planning\'s plan history: each new version of the linked open work orders export is recorded, and the work orders new in it counted.</div>' : `
    <div class="row dpl-controls" style="gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:10px">
      <label class="f"><span>From</span><input type="date" id="dpl-from" value="${esc(d.from)}"></label>
      <label class="f"><span>To</span><input type="date" id="dpl-to" value="${esc(d.to)}"></label>
      <label class="f"><span>Quick</span><select id="dpl-quick"><option value="">—</option>${DPL.quick.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <span class="small muted">${n(d.working_days)} working day${d.working_days === 1 ? '' : 's'} in this frame</span></div>
    <div class="kdb-tiles">${tile('Work orders in', n(T.wos), `${n(T.cards)} cards · ${n(T.avg_cards)} a WO`)}${tile('A working day', n(T.per_day, 1), `all history: ${n(T.all_per_day, 1)}`)}
      ${tile('Short notice', pc(T.wos ? (short / T.wos) * 100 : null), 'D+0 and D+1 (and past due)')}
      ${d.buckets.filter((b) => b.key === 'd0').map((b) => tile('Same day (D+0)', n(b.per_day, 1), `a working day · ${pc(b.wos_pct)} of WOs`)).join('')}</div>
    <div class="card"><h3 class="pl-h">By notice <span class="muted small">— click a row for its customers, job sizes and more</span></h3>
      <div class="kdb-scroll"><table class="log pll-t dpl-t"><thead><tr><th>Notice</th><th class="num">WOs</th><th>Share</th><th class="num">A working day</th><th class="num" title="Over everything recorded">All history</th><th class="num">Cards</th><th class="num">% cards</th><th class="num">Cards a day</th><th class="num">Avg cards</th></tr></thead><tbody>
        ${d.buckets.map((b) => `<tr data-dpl-bucket="${b.key}" class="${dplState.bucket === b.key ? 'on' : ''}" title="${esc(b.what)} — click for more"><td><span class="dpl-key" style="background:${DPL.colors[b.key]}"></span><b>${esc(b.label)}</b> <span class="small muted">${esc(b.what)}</span></td>
          <td class="num">${n(b.wos)}</td><td><div class="pllx-share"><div class="pll-track"><div style="width:${((b.wos_pct || 0) / maxPct) * 100}%;background:${DPL.colors[b.key]}"></div></div><span>${pc(b.wos_pct)}</span></div></td>
          <td class="num"><b>${n(b.per_day, 1)}</b></td><td class="num muted">${n(b.all_per_day, 1)}</td><td class="num">${n(b.cards)}</td><td class="num">${pc(b.cards_pct)}</td><td class="num">${n(b.cards_per_day)}</td><td class="num">${n(b.avg_cards)}</td></tr>`).join('')}
      </tbody><tfoot><tr data-dpl-bucket="all" class="${dplState.bucket === 'all' ? 'on' : ''}" title="Click for all of them"><td><b>All</b></td><td class="num"><b>${n(T.wos)}</b></td><td></td><td class="num"><b>${n(T.per_day, 1)}</b></td><td class="num muted">${n(T.all_per_day, 1)}</td>
        <td class="num"><b>${n(T.cards)}</b></td><td class="num">100%</td><td class="num">${n(d.working_days ? T.cards / d.working_days : null)}</td><td class="num">${n(T.avg_cards)}</td></tr></tfoot></table></div></div>
    ${detailHtml}
    ${d.daily.length > 1 ? `<div class="card"><h3 class="pl-h">Day by day <span class="muted small">— work orders that came in each day, by notice</span></h3>
      <div class="pl-hist dpl-hist">${d.daily.map((x) => `<div class="pl-hist-col" title="${esc(fmtDate(`${x.day}T12:00`))}: ${x.wos} work orders, ${n(x.cards)} cards\n${d.buckets.filter((b) => x.by[b.key]).map((b) => `${b.label}: ${x.by[b.key]}`).join('\n')}">
        <div class="pl-hist-n">${x.wos || ''}</div><div class="dpl-stack" style="height:${Math.round((x.wos / maxDay) * 150)}px">${d.buckets.slice().reverse().filter((b) => x.by[b.key]).map((b) => `<div style="flex:${x.by[b.key]};background:${DPL.colors[b.key]}"></div>`).join('')}</div>
        <div class="pl-hist-d">${dayLbl(x.day)}</div></div>`).join('')}</div>
      <div class="small muted" style="margin-top:6px">${d.buckets.map((b) => `<span class="dpl-key" style="background:${DPL.colors[b.key]}"></span>${esc(b.label)}`).join(' &nbsp; ')}</div></div>` : ''}`}`;

  const hist = $('.dpl-hist'); if (hist) hist.scrollLeft = hist.scrollWidth;
  if (D) $('#dpl-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const reload = () => renderKpiDplus().catch((err) => toast(err.message, 'error'));
  $('#dpl-from')?.addEventListener('change', (e) => { if (e.target.value) { dplState.from = e.target.value; reload(); } });
  $('#dpl-to')?.addEventListener('change', (e) => { if (e.target.value) { dplState.to = e.target.value; reload(); } });
  $('#dpl-quick')?.addEventListener('change', (e) => { if (e.target.value) { [dplState.from, dplState.to] = dplRange(e.target.value, d.since); reload(); } });
  main().onclick = (e) => {
    const s = e.target.closest('[data-prod-source]'); if (s) { store.set('prodSource', s.dataset.prodSource); renderKpiProduction(); return; }
    const b = e.target.closest('[data-dpl-bucket]'); if (b) { dplState.bucket = dplState.bucket === b.dataset.dplBucket ? null : b.dataset.dplBucket; reload(); return; }
    if (e.target.closest('[data-dpl-close]')) { dplState.bucket = null; reload(); return; }
    const w = e.target.closest('[data-dpl-wo]'); if (w && typeof pfOpen === 'function') { e.preventDefault(); pfBack.length = 0; pfOpen('wo', w.dataset.dplWo); }
  };
}
