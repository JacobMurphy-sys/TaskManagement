'use strict';
// ⏱ KPIs › Production: what actually ran, from the daily timing reports (perso, Otto) — a Gantt
// of each machine's jobs, the load per machine per day, and the runs set aside as anomalies
// (far too quick, far too long) so they don't skew the picture. Loaded before app.js.

const prodState = { sel: null };
const PROD_COLORS = ['#3b78d8', '#3c9a5f', '#d07a1f', '#8a55c7', '#c2457a', '#2a9d9c', '#7a8a1f', '#b0553a', '#5468d4', '#9a7b2f'];
const prodColor = (key) => { let h = 0; for (const ch of String(key || '?')) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PROD_COLORS[h % PROD_COLORS.length]; };
const prodYmd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function renderKpiProduction() {
  const source = store.get('prodSource', 'perso') === 'otto' ? 'otto' : 'perso';
  const span = [1, 3, 7, 14, 31].includes(Number(store.get('prodSpan', 1))) ? Number(store.get('prodSpan', 1)) : 1;
  const view = ['gantt', 'load', 'runs'].includes(store.get('prodView', 'gantt')) ? store.get('prodView', 'gantt') : 'gantt';
  const sens = ['strict', 'normal', 'loose'].includes(store.get('prodSens', 'normal')) ? store.get('prodSens', 'normal') : 'normal';
  const withAnom = !!store.get('prodWithAnom', false);
  // the day picked, or (none picked) the latest day with runs
  const picked = /^\d{4}-\d{2}-\d{2}$/.test(store.get('prodFrom', '') || '') ? store.get('prodFrom') : null;
  const [p, settings] = await Promise.all([
    api.get(`/prod?source=${source}${picked ? `&from=${picked}` : ''}&days=${span}&sensitivity=${sens}${withAnom ? '&anomalies=1' : ''}`), api.get('/settings')]);
  const from = p.from.slice(0, 10);
  const n = (v) => PLF.num.format(Math.round(Number(v || 0)));
  const label = source === 'otto' ? 'Otto' : 'Perso';
  const unit = source === 'otto' ? 'items' : 'cards';
  const hm = (iso) => iso.slice(11, 16);
  const when = (iso) => `${PLF.day.format(new Date(`${iso.slice(0, 10)}T12:00`))} ${hm(iso)}`;
  const secs = (s) => (s === null || s === undefined ? '—' : s >= 90 ? `${PLF.one.format(s / 60)} min` : `${PLF.one.format(s)} s`);
  // working hours from Planning's Setup: for the utilisation and the shading
  const wStart = /^\d{1,2}:\d{2}$/.test(p.work.start || '') ? p.work.start : '06:00';
  const wEnd = /^\d{1,2}:\d{2}$/.test(p.work.end || '') ? p.work.end : '22:00';
  const toMin = (t) => Number(t.split(':')[0]) * 60 + Number(t.split(':')[1]);
  const shiftMin = ((toMin(wEnd) - toMin(wStart)) + 1440) % 1440 || 1440;
  const days = Array.from({ length: span }, (_, i) => { const d = new Date(`${from}T12:00`); d.setDate(d.getDate() + i); return prodYmd(d); });
  const workDays = days.filter((d) => p.work.days.includes(new Date(`${d}T12:00`).getDay()));
  const capacity = p.machines.length * workDays.length * shiftMin;
  const t = p.totals;
  const good = p.runs.filter((r) => !r.anomaly);
  const anomalies = p.runs.filter((r) => r.anomaly && r.anomaly.kind !== 'open');
  const shift = (d, by) => { const x = new Date(`${d}T12:00`); x.setDate(x.getDate() + by); return prodYmd(x); };

  const fileHtml = (s) => `<div class="row small" style="gap:8px;flex-wrap:wrap">
      <label class="f" style="flex:1;min-width:320px">${s === 'otto' ? 'Otto' : 'Perso'} timing report (where it's saved)
        <input type="text" data-prod-path="${s}" value="${esc(settings[`kpi_time_${s}`] || '')}" placeholder="e.g. S:\\…\\Daily${s === 'otto' ? 'Otto' : 'Perso'}Timing.xlsx"></label></div>`;
  const tiles = `<div class="kdb-tiles pl-tiles">
      <div class="kdb-tile"><div class="kdb-tile-l">${label} ${unit} made</div><div class="kdb-tile-v">${n(t.cards)}</div><div class="kdb-tile-s">${n(t.jobs)} job${t.jobs === 1 ? '' : 's'} · ${n(t.runs)} run${t.runs === 1 ? '' : 's'}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Machine time busy</div><div class="kdb-tile-v">${PLF.one.format(t.busy_minutes / 60)} h</div><div class="kdb-tile-s">${capacity ? `${Math.round((t.busy_minutes / capacity) * 100)}% of ${p.machines.length} machine${p.machines.length === 1 ? '' : 's'} × ${wStart}–${wEnd}` : 'no working days in view'}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Average a ${unit === 'cards' ? 'card' : 'item'}</div><div class="kdb-tile-v">${secs(t.spc)}</div><div class="kdb-tile-s">including set-up, all machines</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Remakes</div><div class="kdb-tile-v">${n(t.remakes)}</div><div class="kdb-tile-s">${unit}${t.cards ? ` · ${PLF.one.format((t.remakes / t.cards) * 100)}%` : ''}</div></div>
      <div class="kdb-tile" ${anomalies.length ? 'data-prod-jump="anom" style="cursor:pointer"' : ''} title="Runs far too quick or far too long for their machine and size — left out of the figures${withAnom ? ' (now counted anyway)' : ''}">
        <div class="kdb-tile-l">Anomalies set aside</div><div class="kdb-tile-v ${anomalies.length ? 'kdb-warn' : 'kdb-ok'}">${n(anomalies.length)}</div><div class="kdb-tile-s">${withAnom ? 'counted anyway' : 'left out of the figures'}${t.open ? ` · ${t.open} without an end` : ''}</div></div>
    </div>`;

  // Gantt: a row per machine, a bar per run, coloured by customer
  const ganttHtml = () => `<div class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h3 class="pl-h" style="margin:0">▤ What ran on each machine</h3>
      <div class="small muted">${[...new Set(good.map((r) => r.trigram || r.customer).filter(Boolean))].sort().slice(0, 14).map((c) => `<span class="prod-key" style="background:${prodColor(c)}"></span>${esc(c)}`).join(' ')}
        ${withAnom ? ' <span class="prod-key prod-anom"></span>anomaly' : ''} <span class="prod-key prod-remake" style="background:#888"></span>remake</div></div>
      <div id="prod-gantt" class="pl-gantt" style="margin-top:8px"></div><div id="prod-gantt-info" class="small" style="margin-top:6px"></div></div>`;

  // Load: busy hours per machine per day (overlapping runs counted once)
  const loadHtml = () => {
    const cell = (v) => {
      if (!v) return '<td class="pl-load-cell muted">—</td>';
      const pct = Math.round((v.busy_minutes / shiftMin) * 100);
      return `<td class="pl-load-cell" title="${n(v.cards)} ${unit} · ${v.jobs} job${v.jobs === 1 ? '' : 's'} · busy ${fmtSpan(v.busy_minutes)} (${pct}% of ${wStart}–${wEnd})">
        <div class="pl-load-bar ${pct > 100 ? 'full' : pct > 85 ? 'busy' : ''}" style="width:${Math.min(100, pct)}%"></div><span>${PLF.one.format(v.busy_minutes / 60)} h</span><div class="small muted" style="position:relative">${n(v.cards)} ${unit}</div></td>`;
    };
    const dayTot = (d) => p.load.reduce((a, l) => { const v = l.days[d]; return v ? { busy_minutes: a.busy_minutes + v.busy_minutes, cards: a.cards + v.cards, jobs: a.jobs + v.jobs } : a; }, { busy_minutes: 0, cards: 0, jobs: 0 });
    return `<div class="card"><h3 class="pl-h">▦ Load — machine time busy a day <span class="muted small">bar = share of the working day ${wStart}–${wEnd} (from Planning's Setup); runs that overlap on a machine count once</span></h3>
      <div class="kdb-scroll"><table class="log pl-load"><thead><tr><th>Machine</th>${days.map((d) => `<th class="num">${esc(PLF.day.format(new Date(`${d}T12:00`)))}</th>`).join('')}<th class="num">Total</th><th class="num">Avg a ${unit === 'cards' ? 'card' : 'item'}</th></tr></thead>
      <tbody>${p.load.map((l) => {
        const rs = good.filter((r) => r.machine === l.machine && r.spc);
        const spc = rs.reduce((a, r) => a + r.minutes * 60, 0) / Math.max(1, rs.reduce((a, r) => a + r.qty, 0));
        return `<tr><td><b>${esc(l.machine)}</b></td>${days.map((d) => cell(l.days[d])).join('')}<td class="num"><b>${PLF.one.format(l.busy_minutes / 60)} h</b><div class="small muted">${n(l.cards)} ${unit}</div></td><td class="num">${rs.length ? secs(spc) : '—'}</td></tr>`;
      }).join('') || `<tr><td colspan="${days.length + 3}" class="muted">Nothing ran in this period.</td></tr>`}
      ${p.load.length > 1 ? `<tr class="pl-load-total"><td>All</td>${days.map((d) => { const v = dayTot(d); return `<td class="num">${PLF.one.format(v.busy_minutes / 60)} h<div class="small muted">${n(v.cards)} ${unit}</div></td>`; }).join('')}<td class="num">${PLF.one.format(t.busy_minutes / 60)} h<div class="small muted">${n(t.cards)} ${unit}</div></td><td class="num">${secs(t.spc)}</td></tr>` : ''}</tbody></table></div></div>`;
  };

  const runRow = (r) => `<tr class="${r.anomaly && r.anomaly.kind !== 'open' ? 'pl-late-row' : ''}"><td>${esc(when(r.start_at))}</td><td>${r.end_at ? esc(hm(r.end_at)) : '—'}</td><td><b>${esc(r.machine)}</b></td><td>${esc(r.job)}${r.remake ? ' <span class="chip">remake</span>' : ''}</td>
      <td>${esc(r.trigram || '')}<div class="small muted">${esc(r.item_name || '')}</div></td><td class="num">${n(r.qty)}</td><td class="num">${r.minutes !== null ? fmtSpan(r.minutes) : '—'}</td>
      <td class="num">${secs(r.spc)}${r.usual ? `<div class="small muted" title="What this machine usually takes for a job this size">usual ${fmtSpan(r.usual.minutes)}</div>` : ''}</td><td class="small">${r.anomaly ? `<span class="${r.anomaly.kind === 'open' ? 'muted' : 'pl-late'}">${esc(r.anomaly.text)}</span>` : ''}</td></tr>`;
  const runHead = `<tr><th>Start</th><th>End</th><th>Machine</th><th>Job</th><th>Customer</th><th class="num">${unit[0].toUpperCase()}${unit.slice(1)}</th><th class="num">Took</th><th class="num">A ${unit === 'cards' ? 'card' : 'item'}</th><th></th></tr>`;
  const runsHtml = () => `<div class="card"><h3 class="pl-h">☰ Runs <span class="muted small">${n(p.runs.length)} in this period</span></h3>
      <div class="kdb-scroll"><table class="log">${runHead}${p.runs.slice(0, 400).map(runRow).join('')}</table></div>${p.runs.length > 400 ? `<div class="small muted">The first 400 of ${n(p.runs.length)}.</div>` : ''}</div>`;
  const anomHtml = anomalies.length ? `<div class="card" id="prod-anom"><h3 class="pl-h">⚠ Anomalies <span class="muted small">${n(anomalies.length)} run${anomalies.length === 1 ? '' : 's'} that can't be right for their machine and size — ${withAnom ? 'counted anyway (untick “count them anyway” to leave them out)' : 'left out of the figures above'}</span></h3>
      <div class="kdb-scroll"><table class="log">${runHead}${anomalies.map(runRow).join('')}</table></div>
      <p class="small muted">Each machine's usual set-up time and time a card are learned from its own runs over the last 120 days. Strictness: <b>${{ strict: 'Strict — 2× off', normal: 'Normal — 3× off', loose: 'Loose — 5× off' }[sens]}</b> what's usual, and well outside the machine's normal spread. Runs over 24 hours, ending before they start, or with nothing made are always set aside.</p></div>` : '';

  const linked = p.linked[source];
  // what the report itself held when last read, and every day kept (a bar each: click to open it)
  const lr = p.history.last_read;
  const coverageTxt = lr?.first ? `the report held ${n(lr.rows)} run${lr.rows === 1 ? '' : 's'} ${lr.days > 1 ? `over ${lr.days} days, ${lr.first} to ${lr.last}` : `from one day, ${lr.first}`}` : '';
  const histDays = p.history.days || [];
  const histNote = !histDays.length ? '' : (() => {
    const byDay = new Map(histDays.map((d) => [d.day, d]));
    const all = []; for (let d = histDays[0].day; d <= histDays[histDays.length - 1].day; d = shift(d, 1)) all.push(d);
    const max = Math.max(1, ...histDays.map((d) => d.cards));
    const inView = new Set(days);
    const bars = all.map((d) => { const v = byDay.get(d); const dt = new Date(`${d}T12:00`);
      return `<div class="prod-hday ${inView.has(d) ? 'on' : ''} ${dt.getDate() === 1 ? 'm1' : ''}" data-prod-goto="${d}" title="${esc(PLF.day.format(dt))} ${dt.getFullYear()}: ${v ? `${n(v.cards)} ${unit}, ${v.runs} runs` : 'nothing'}">
        <div class="prod-hbar" style="height:${v ? Math.max(2, Math.round((v.cards / max) * 46)) : 0}px"></div>${dt.getDate() === 1 || d === all[0] ? `<span>${esc(dt.toLocaleDateString('en-GB', { month: 'short' }))}</span>` : ''}</div>`; }).join('');
    return `<div class="card prod-hist"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px"><b class="small">History kept: ${n(p.history.runs)} runs, ${esc(histDays[0].day)} to ${esc(histDays[histDays.length - 1].day)} — ${n(histDays.length)} day${histDays.length === 1 ? '' : 's'}</b>
        <span class="small muted">${unit} a day as reported · click a day to open it</span></div>
      <div class="prod-hstrip" id="prod-hstrip">${bars}</div>
      ${histDays.length < 14 ? `<div class="small muted" style="margin-top:4px">Every run the report holds is kept, whatever its day${coverageTxt ? ` — when last read, ${esc(coverageTxt)}` : ''}. A report that only holds the current day builds the history up a day at a time; to fill in earlier weeks, export it once for a longer period (same columns) and load it with <b>📂 Load reports…</b>.</div>` : ''}</div>`;
  })();

  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 KPIs</h1>
      <div class="seg"><a href="#/kpi">A3 Weekly Report</a><a href="#/kpi/0/database">Database</a><a href="#/kpi/sources">Sources</a><a href="#/kpi/production" class="on">⏱ Production</a></div>
      <div class="seg"><button type="button" data-prod-source="perso" class="${source === 'perso' ? 'on' : ''}">Perso</button><button type="button" data-prod-source="otto" class="${source === 'otto' ? 'on' : ''}">Otto</button></div>
      <div class="spacer"></div>
      ${linked ? '<button data-prod="read" title="Read the report again now">📥 Read now</button>' : ''}
      <label class="button" title="Load older daily reports to fill in the history (several at once is fine)">📂 Load reports…<input type="file" accept=".xlsx,.xlsm" multiple hidden id="prod-files"></label>
    </div>
    ${linked ? `<div class="kpi-meta small muted">${esc(label)} timing report: <span title="${esc(p.file || '')}">${esc((p.file || '').split(/[\\/]/).pop())}</span>${p.history.last_read ? ` · read ${esc(fmtDateTime(p.history.last_read.at))}` : ''}
        · ${n(p.history.runs)} runs kept${p.history.first ? `, ${esc(p.history.first.slice(0, 10))} to ${esc(p.history.last.slice(0, 10))}` : ''} <details class="kpi-info"><summary>⚙</summary><div class="kpi-info-pop card">${fileHtml('perso')}${fileHtml('otto')}</div></details></div>`
    : `<div class="card"><h3 style="margin-top:0">Link the daily ${esc(label.toLowerCase())} timing report</h3>
        <p class="small">The report with each job's start and end on its machine (${source === 'otto' ? 'Otto\'s daily timing report' : 'e.g. DailyPersoTiming'}). It's read every 10 minutes and each run is kept, so the history builds up day by day even though the report only holds a day. Older reports can be loaded with 📂 Load reports….</p>${fileHtml(source)}</div>`}
    ${p.history.runs ? `
    <div class="row prod-controls" style="gap:8px;flex-wrap:wrap;align-items:center;margin:10px 0">
      <button class="small" data-prod-day="-1" title="Earlier">◀</button><input type="date" id="prod-from" value="${esc(from)}" style="width:auto"><button class="small" data-prod-day="1" title="Later">▶</button>
      <select id="prod-span" style="width:auto">${[[1, '1 day'], [3, '3 days'], [7, 'a week'], [14, 'two weeks'], [31, 'a month']].map(([v, l]) => `<option value="${v}" ${span === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <div class="seg">${[['gantt', '▤ Gantt'], ['load', '▦ Load'], ['runs', '☰ Runs']].map(([k, l]) => `<button type="button" data-prod-view="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="spacer"></span>
      <label class="row small" style="gap:6px">Anomalies <select id="prod-sens" style="width:auto">${[['strict', 'Strict (2× off)'], ['normal', 'Normal (3× off)'], ['loose', 'Loose (5× off)']].map(([k, l]) => `<option value="${k}" ${sens === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="row small"><input type="checkbox" id="prod-with" ${withAnom ? 'checked' : ''}> count them anyway</label>
    </div>
    ${histNote}
    ${tiles}
    ${!p.runs.length ? `<div class="card muted">Nothing ran in this period. Runs kept: ${esc(p.history.first.slice(0, 10))} to ${esc(p.history.last.slice(0, 10))}. <button class="link" data-prod-latest>Go to the latest day</button></div>`
      : view === 'gantt' ? ganttHtml() : view === 'load' ? loadHtml() : runsHtml()}
    ${anomHtml}` : linked ? '<div class="card muted">No runs read yet — 📥 Read now, or load older reports with 📂 Load reports….</div>' : ''}`;

  const hs = $('#prod-hstrip'); if (hs) { const on = hs.querySelector('.prod-hday.on'); hs.scrollLeft = on ? on.offsetLeft - hs.clientWidth / 2 : hs.scrollWidth; }
  if (view === 'gantt' && $('#prod-gantt')) {
    const draw = () => drawProdGantt($('#prod-gantt'), $('#prod-gantt-info'), p, { from, span, withAnom, wStart, wEnd, unit });
    draw();
    window.onresize = () => { if ($('#prod-gantt')) draw(); };
  }
  const set = (k, v) => { store.set(k, v); renderKpiProduction(); };
  $('#prod-from')?.addEventListener('change', (e) => e.target.value && set('prodFrom', e.target.value));
  $('#prod-span')?.addEventListener('change', (e) => set('prodSpan', Number(e.target.value)));
  $('#prod-sens')?.addEventListener('change', (e) => set('prodSens', e.target.value));
  $('#prod-with')?.addEventListener('change', (e) => set('prodWithAnom', e.target.checked));
  $$('[data-prod-path]').forEach((el) => el.addEventListener('change', async () => {
    try {
      await api.patch('/settings', { [`kpi_time_${el.dataset.prodPath}`]: el.value.trim().replace(/^"|"$/g, '') });
      const r = el.value.trim() ? await api.post('/prod/read', { source: el.dataset.prodPath }) : null;
      toast(!r ? 'Saved' : r.status === 'read' ? `Read ${r.rows} runs (${r.added} new)` : r.status === 'missing' ? 'Saved — but the file can\'t be found there' : r.error || 'Saved', r && (r.status === 'missing' || r.status === 'error') ? 'error' : '');
    } catch (err) { toast(err.message, 'error'); }
    renderKpiProduction();
  }));
  $('#prod-files').addEventListener('change', async (e) => {
    const files = [...e.target.files]; e.target.value = '';
    let added = 0; let rows = 0; const bad = [];
    for (const f of files) {
      try {
        const r = await fetch(`/api/prod/upload?source=${source}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name) } }).then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error || x.statusText); return j; });
        added += r.added; rows += r.rows;
      } catch (err) { bad.push(err.message); }
    }
    toast(bad.length ? bad.join(' · ') : `${files.length} report${files.length === 1 ? '' : 's'}: ${rows} runs, ${added} new`, bad.length ? 'error' : '');
    renderKpiProduction();
  });
  main().onclick = async (e) => {
    const s = e.target.closest('[data-prod-source]'); if (s) { prodState.sel = null; set('prodSource', s.dataset.prodSource); return; }
    const v = e.target.closest('[data-prod-view]'); if (v) { set('prodView', v.dataset.prodView); return; }
    const d = e.target.closest('[data-prod-day]'); if (d) { set('prodFrom', shift(from, Number(d.dataset.prodDay) * span)); return; }
    const go = e.target.closest('[data-prod-goto]'); if (go) { set('prodFrom', go.dataset.prodGoto); return; }
    if (e.target.closest('[data-prod-latest]')) { store.set('prodFrom', null); renderKpiProduction(); return; }
    if (e.target.closest('[data-prod-jump]')) { $('#prod-anom')?.scrollIntoView({ behavior: 'smooth' }); return; }
    if (e.target.closest('[data-prod="read"]')) {
      try { const r = await api.post('/prod/read', { source }); toast(r.status === 'read' ? `Read ${r.rows} runs (${r.added} new)` : r.status === 'missing' ? 'Can\'t find the report' : r.error || 'Read', r.status === 'read' ? '' : 'error'); } catch (err) { toast(err.message, 'error'); }
      renderKpiProduction();
    }
  };
}

function drawProdGantt(el, info, p, { from, span, withAnom, wStart, wEnd, unit }) {
  const start = new Date(`${from}T00:00`); const end = new Date(start); end.setDate(end.getDate() + span);
  const LBL = 96; const W = Math.max(400, el.clientWidth - LBL - 4); const ROW = 34;
  const x = (tm) => LBL + ((new Date(tm) - start) / (end - start)) * W;
  const machines = p.machines;
  const runs = p.runs.filter((r) => r.end_at && (!r.anomaly || (withAnom && r.anomaly.kind !== 'invalid')));
  const H = machines.length * ROW + 30;
  const step = span <= 1 ? 2 : span <= 3 ? 6 : span <= 7 ? 12 : 24;
  let ticks = '';
  for (let tm = new Date(start); tm <= end; tm = new Date(tm.getTime() + step * 3600000)) {
    const day = tm.getHours() === 0;
    ticks += `<div class="pg-tick ${day ? 'day' : ''}" style="left:${x(tm)}px;height:${H}px"><span>${day ? esc(PLF.day.format(tm)) : `${String(tm.getHours()).padStart(2, '0')}:00`}</span></div>`;
  }
  // outside the working day (Planning's Setup): lightly shaded
  let shade = '';
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const ws = new Date(`${prodYmd(d)}T${wStart.padStart(5, '0')}`); const we = new Date(`${prodYmd(d)}T${wEnd.padStart(5, '0')}`);
    const dayEnd = new Date(d); dayEnd.setDate(dayEnd.getDate() + 1);
    const work = p.work.days.includes(d.getDay());
    const gaps = !work ? [[new Date(d), dayEnd]] : we > ws ? [[new Date(d), ws], [we, dayEnd]] : [[we, ws]];
    for (const [a, b] of gaps) if (b > a) shade += `<div class="pg-off" style="left:${x(a)}px;width:${x(b) - x(a)}px;height:${H - 22}px"></div>`;
  }
  const rows = machines.map((m, i) => `<div class="pg-row" style="top:${22 + i * ROW}px;width:${LBL + W}px;height:${ROW}px"><div class="pg-name" style="width:${LBL - 8}px">${esc(m)}</div></div>`).join('');
  const sel = prodState.sel && runs.find((r) => r.id === prodState.sel);
  const bars = runs.map((r) => {
    const i = machines.indexOf(r.machine); if (i < 0) return '';
    const l = Math.max(LBL, x(r.start_at)); const rr = Math.min(LBL + W, x(r.end_at)); if (rr <= LBL || l >= LBL + W) return '';
    const w = Math.max(2, rr - l);
    return `<div class="pg-bar ${r.remake ? 'pg-run' : ''} ${r.anomaly ? 'prod-anom' : ''} ${sel && sel.id !== r.id ? 'pg-dim' : ''} ${sel && sel.id === r.id ? 'pg-sel' : ''}" data-prod-run="${r.id}"
      style="left:${l}px;width:${w}px;top:${22 + i * ROW + 5}px;height:${ROW - 10}px;background-color:${prodColor(r.trigram || r.customer)}" title="${esc(`${r.job} · ${r.trigram || r.customer || ''} · ${PLF.num.format(r.qty || 0)} ${unit}\n${r.start_at.slice(11, 16)}–${r.end_at.slice(11, 16)} (${fmtSpan(r.minutes)})${r.anomaly ? `\n⚠ ${r.anomaly.text}` : ''}`)}"><span>${esc(r.trigram || '')}</span></div>`;
  }).join('');
  el.style.height = `${H + 6}px`;
  el.innerHTML = `<div class="pg" style="width:${LBL + W}px;height:${H}px">${rows}${shade}${ticks}${bars}</div>`;
  info.innerHTML = sel ? `<b>${esc(sel.job)}</b> on <b>${esc(sel.machine)}</b>${sel.station ? ` (${esc(sel.station)})` : ''} · ${esc(sel.customer || sel.trigram || '')} · ${esc(sel.item_name || '')} · ${PLF.num.format(sel.qty || 0)} ${unit}${sel.remake ? ' · remake' : ''}
      · ${esc(sel.start_at.slice(11, 16))}–${esc(sel.end_at.slice(11, 16))}, ${fmtSpan(sel.minutes)}${sel.usual ? ` (usual for this size about ${fmtSpan(sel.usual.minutes)})` : ''}${sel.anomaly ? ` · <span class="pl-late">⚠ ${esc(sel.anomaly.text)}</span>` : ''} <button class="link small" data-prod-clear>✕</button>`
    : `<span class="muted">${runs.length ? 'Click a bar for the job. Gaps between bars are a machine standing still; shading is outside the working day.' : 'Nothing ran in this period.'}</span>`;
  el.onclick = (e) => { const b = e.target.closest('[data-prod-run]'); prodState.sel = b ? Number(b.dataset.prodRun) : null; drawProdGantt(el, info, p, { from, span, withAnom, wStart, wEnd, unit }); };
  info.onclick = (e) => { if (e.target.closest('[data-prod-clear]')) { prodState.sel = null; drawProdGantt(el, info, p, { from, span, withAnom, wStart, wEnd, unit }); } };
}
