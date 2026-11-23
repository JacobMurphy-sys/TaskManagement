// SIM (Short Interval Management): the KPI part of the daily briefing between shifts and departments. One day —
// the last working day by default — on one page of four equal panels: Quality, Safety, Scrap and OTD. Each shows the
// day's result large, coloured as the weekly report's arrows (green / yellow / red against the target), the month
// to date as a line chart with the target marked, and what made the result.

const simDayAdd = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
let SIM_CHARTS = []; // the charts on the page, drawn to their boxes (again when the window is resized)

async function renderSim(dayArg) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg || '') ? dayArg : '';
  const d = await api.get(`/sim${day ? `?day=${day}` : ''}`);
  const T = d.topics;
  const fmt = simFmt; // simsvg.js
  const tgt = (t, f) => (t.target === null || t.target === undefined ? '<button type="button" class="link small sim-set-tg" title="Without a target the result can\'t be coloured">🎯 Set a target</button>'
    : `target ${t.better === 'down' ? '≤' : '≥'} ${f(t.target)}`);
  // no figure for the day: say whether its report hasn't been read that far yet
  const short = (dd) => new Date(`${dd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const vol = (t, n, what) => (n || (t.read_to && t.read_to >= d.day) ? `${simNum(n)} ${what}`
    : `<span class="pl-late" title="The day's figures come in when the report is read (Reporting › Sources)">${what} not read yet${t.read_to ? ` (to ${esc(short(t.read_to))})` : ''}</span>`);
  const big = (colour, value) => `<div class="sim-big ${colour ? `sim-${colour}` : 'sim-none'}"><div class="sim-val">${value}</div></div>`;
  const facts = (lines) => `<div class="sim-facts">${lines.filter(Boolean).map((l) => `<div>${l}</div>`).join('')}</div>`;
  const mtd = (t, f) => `Month to date <b class="${t.mtd.colour ? `sim-t-${t.mtd.colour}` : ''}">${f(t.mtd.value)}</b>`;
  // side: the lists in a column of their own down the panel's right (scrap, OTD: their top 5s use the full height);
  // else the chart takes the room and a small strip under it lists what there is (quality, safety)
  const panel = (key, title, unit, result, chartId, lists, { side = false, action = '' } = {}) => {
    const head = `<header class="sim-head"><h2>${title}</h2><span class="small muted">${unit}</span>${action ? `<span class="spacer"></span>${action}` : ''}</header>`;
    return side
      ? `<section class="card sim-panel sim-side" data-sim="${key}"><div class="sim-main">${head}<div class="sim-result">${result}</div><div class="sim-chart" id="${chartId}"></div></div><div class="sim-lists">${lists}</div></section>`
      : `<section class="card sim-panel" data-sim="${key}">${head}<div class="sim-result">${result}</div><div class="sim-chart" id="${chartId}"></div><div class="sim-lists sim-lists-low">${lists}</div></section>`;
  };
  const list = (title, rows, empty) => `<div class="sim-list"><h3>${title}</h3>${rows.length ? `<ul>${rows.join('')}</ul>` : `<div class="small muted">${empty}</div>`}</div>`;
  const cust = (c, name) => `${esc(c || '?')}${name ? ` <span class="muted">${esc(name)}</span>` : ''}`;

  // ---- Quality
  const q = T.quality;
  const quality = panel('quality', 'Quality', 'CPMS: customer complaints per million cards shipped',
    `${big(q.colour, fmt.quality(q.value))}${facts([`${q.complaints.length} complaint${q.complaints.length === 1 ? '' : 's'} · ${vol(q, q.shipped, 'cards shipped')}`, tgt(q, fmt.quality), mtd(q, fmt.quality), `Internal reports <b>${q.internal.length}</b> <span class="muted">(month: ${q.mtd.internal})</span>`])}`,
    'sim-c-quality',
    `${list('Customer complaints opened', q.complaints.map((c) => `<li><b>${esc(c.ref || '—')}</b> ${cust(c.customer)}${c.severity ? ` <span class="pill">${esc(c.severity)}</span>` : ''}${c.summary ? `<div class="small muted">${esc(c.summary)}</div>` : ''}</li>`), 'None opened that day.')}
     <div class="sim-list"><h3>Internal reports</h3>${q.internal.length ? `<ul>${q.internal.map((r) => `<li>${r.area ? `<b>${esc(r.area)}</b> · ` : ''}${esc(r.text)}<button type="button" class="icon small" data-sim-del="${r.id}" title="Remove">✕</button>${r.created_by ? ` <span class="small muted">${esc(r.created_by)}</span>` : ''}</li>`).join('')}</ul>` : '<div class="small muted">None noted yet (＋ adds one).</div>'}</div>`,
    { action: '<button type="button" class="sim-plus" id="sim-add-btn" title="Note an internal report for this day">＋ Internal report</button>' });

  // ---- Safety
  const s = T.safety;
  const safety = panel('safety', 'Safety', 'safety concern forms by incident date',
    `${big(s.colour, `${s.ac}<small>accident${s.ac === 1 ? '' : 's'}</small>`)}${facts([`${s.nm} near miss${s.nm === 1 ? '' : 'es'} · ${s.sc} safety concern${s.sc === 1 ? '' : 's'}`, `<span class="muted">${esc(s.rule)}</span>`, `Month to date <b class="${s.mtd.ac ? 'sim-t-red' : ''}">${s.mtd.ac} AC</b> · <b>${s.mtd.nm} NM</b> · <b>${s.mtd.sc} SC</b>`])}`,
    'sim-c-safety',
    list('Forms that day', s.forms.map((f) => `<li><span class="sim-kind sim-k-${esc(f.kind.toLowerCase())}">${esc(f.kind)}</span> ${f.location ? `<b>${esc(f.location)}</b>` : ''}${f.detail ? ` · ${esc(f.detail)}` : ''}${f.description ? `<div class="small muted">${esc(f.description)}</div>` : ''}</li>`), 'No forms that day.'));

  // ---- Scrap
  const sc = T.scrap;
  const scrap = panel('scrap', 'Scrap', 'scrap rate: scrap ÷ cards persoed',
    `${big(sc.colour, fmt.scrap(sc.value))}${facts([`${simNum(sc.scrap)} cards scrapped · ${vol(sc, sc.persoed, 'persoed')}`, tgt(sc, fmt.scrap), mtd(sc, fmt.scrap), `<span class="muted">${simNum(sc.mtd.scrap)} scrapped of ${simNum(sc.mtd.persoed)} this month</span>`])}`,
    'sim-c-scrap',
    list('Top 5 scrap that day', sc.top.map((t) => `<li><span class="sim-q">${simNum(t.qty)}</span> <b>${esc(t.wo || '—')}</b> ${cust(t.customer, t.name)}<div class="small muted">${esc(t.cause)}${t.item ? ` · ${esc(t.item)}` : ''}</div></li>`), 'No scrap that day.'), { side: true });

  // ---- OTD
  const o = T.otd;
  const otd = panel('otd', 'OTD', 'OTD SC: 1 − SC delays ÷ cards shipped',
    `${big(o.colour, fmt.otd(o.value))}${facts([`${simNum(o.sc)} SC delays · ${simNum(o.customer)} customer · ${vol(o, o.shipped, 'shipped')}`, tgt(o, fmt.otd), mtd(o, fmt.otd),
      o.undated.rows ? `<span class="pl-late" title="Delays of ${esc(o.undated.week)} in the OTD report with only the week typed in: they can't be put on a day">${o.undated.rows} delay${o.undated.rows === 1 ? '' : 's'} of ${esc(o.undated.week)} without a date (${simNum(o.undated.qty)} cards)</span>` : ''])}`,
    'sim-c-otd',
    `${list('Delays that day', o.delays.map((x) => `<li><span class="sim-q">${simNum(x.qty)}</span> <span class="sim-kind ${x.kind === 'SC' ? 'sim-k-ac' : 'sim-k-sc'}">${x.kind}</span> ${cust(x.customer)}${x.wo ? ` · ${esc(x.wo)}` : ''}${x.reason ? `<div class="small muted">${esc(x.reason)}</div>` : ''}</li>`), 'No dated delays that day.')}
     ${list('Late work orders due that day', o.late_wos.map((j) => `<li><span class="sim-q">${simNum(j.qty)}</span> <b>${esc(j.wo)}</b> ${cust(j.customer, j.name)}<div class="small muted">${j.open ? `still open, ${simNum(j.late_hours, 1)} h past its deadline` : `finished ${simNum(j.late_hours, 1)} h late`}</div></li>`), 'None late (from the planner).')}`, { side: true });

  const isDefault = d.day === d.default_day;
  main().innerHTML = `
    <div class="kanban-tools sim-tools"><h1 style="margin:0">SIM</h1>
      <div class="seg"><button type="button" data-sim-go="${simDayAdd(d.day, -1)}" title="The day before">◀</button><button type="button" data-sim-go="${simDayAdd(d.day, 1)}" title="The day after" ${d.day >= d.today ? 'disabled' : ''}>▶</button></div>
      <input type="date" id="sim-day" value="${d.day}" max="${d.today}" style="width:auto">
      <b>${esc(d.label)}</b>${isDefault ? '<span class="pill">last working day</span>' : `<button type="button" class="link small" data-sim-go="">Back to the last working day</button>`}${d.worked ? '' : '<span class="pill" title="Not a working day in Production\'s calendar">not a working day</span>'}
      <div class="spacer"></div><button type="button" id="sim-read" title="Read the reports SIM is fed from again (cards shipped and persoed, scrap, OTD, complaints, safety forms) — the ones that changed">⟳ Read the reports</button>${ddMenu('⋯', `<button type="button" id="sim-bands">🎯 Targets and colours…</button><a href="/api/sim/picture.png?day=${d.day}&download=1" download>🖼 Download as a picture</a><button type="button" id="sim-auto">⏱ Automatic picture…</button>`, { title: 'Targets, colours and the picture' })}</div>
    <div class="sim-grid">${quality}${safety}${scrap}${otd}</div>`;

  // the line charts, drawn to their boxes
  SIM_CHARTS = simChartSpecs(d); // simsvg.js
  const drawAll = () => SIM_CHARTS.forEach((c) => { const el = document.getElementById(c.id); if (el) simLineChart(el, c, d.day); });
  drawAll();
  if (!window.__simResize) { window.__simResize = true; let t = null; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => SIM_CHARTS.forEach((c) => { const el = document.getElementById(c.id); if (el) simLineChart(el, c, el.dataset.day); }), 120); }); }

  const go = (dd) => { location.hash = dd ? `#/sim/${dd}` : '#/sim'; };
  $$('[data-sim-go]').forEach((b) => { b.onclick = () => go(b.dataset.simGo); });
  $('#sim-day').onchange = (e) => { if (e.target.value) go(e.target.value); };
  main().addEventListener('click', (e) => { const c = e.target.closest('[data-sim-day]'); if (c && main().contains(c)) go(c.dataset.simDay); });
  $('#sim-add-btn').onclick = () => {
    openModal(`<div class="modal-head"><h2 style="margin:0">Internal report</h2><button class="icon" data-action="close-modal">✕</button></div>
      <p class="small muted" style="margin-top:0">For ${esc(d.label)}.</p>
      <form id="sim-add" class="form-grid"><label class="f full">Area<input type="text" name="area" maxlength="120" placeholder="e.g. Embossing"></label>
        <label class="f full">What happened<textarea name="text" rows="3" maxlength="1000" required></textarea></label>
        <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">Add</button></div></form>`);
    $('#sim-add [name=area]').focus();
    $('#sim-add').onsubmit = async (e) => {
      e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
      try { await api.post('/sim/reports', { day: d.day, text: f.text, area: f.area }); closeModal(); toast('Internal report noted'); renderSim(d.day === d.default_day ? '' : d.day); } catch (err) { toast(err.message, 'error'); }
    };
  };
  $$('[data-sim-del]').forEach((b) => { b.onclick = async () => { if (!confirm('Remove this internal report?')) return; try { await api.del(`/sim/reports/${b.dataset.simDel}`); renderSim(d.day); } catch (err) { toast(err.message, 'error'); } }; });
  $('#sim-bands').onclick = () => simBands(d);
  $('#sim-auto').onclick = () => simAutoDialog();
  $$('.sim-set-tg').forEach((b) => { b.onclick = () => simBands(d); });
  $('#sim-read').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = '⏳ Reading…';
    try {
      const res = await api.post('/sim/read', {});
      const bad = res.filter((r) => r.status === 'error' || r.status === 'missing'); const done = res.filter((r) => r.status === 'imported');
      if (bad.length) toast(bad.map((r) => `${r.source}: ${r.error || `can't find ${r.file}`}`).join(' · '), 'error');
      else toast(done.length ? `Read ${done.map((r) => r.source).join(', ')}` : 'The reports haven\'t changed since they were last read');
      renderSim(d.day === d.default_day ? '' : d.day);
    } catch (err) { toast(err.message, 'error'); b.disabled = false; b.textContent = '⟳ Read the reports'; }
  };
}

// The month to date as a line chart, drawn to its box (simsvg.js draws it)
function simLineChart(el, c, day) {
  el.dataset.day = day;
  el.innerHTML = simChartSvg(c, day, Math.max(200, el.clientWidth), Math.max(90, el.clientHeight));
}

// 🎯 each topic's target (Operations' site KPI targets, shared with it) and amber band: how far off still shows yellow
function simBands(d) {
  const T = d.topics; const pct = (v, dp) => (v === null || v === undefined ? '' : String(Math.round(v * 100 * 10 ** dp) / 10 ** dp));
  const row = (k, label, target, hint) => `<div class="sim-tg-row"><b>${label}</b>
      <label class="f">Target <span class="small muted">${hint}</span><input type="number" name="t_${k}" step="any" min="0" value="${target}"></label>
      <label class="f">Yellow within<span class="row" style="gap:6px"><input type="number" name="b_${k}" min="0" max="100" step="1" value="${Math.round(d.bands[k] * 100)}" style="max-width:90px"> % of it</span></label></div>`;
  openModal(`<div class="modal-head"><h2 style="margin:0">Targets and colours</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted" style="margin-top:0">Each result is <b style="color:${SIM_COL.green}">green</b> when it meets its target, <b style="color:#b38600">yellow</b> when it's off by no more than the share given, and <b style="color:${SIM_COL.red}">red</b> beyond; without a target it stays grey. The targets are the same as on Reporting › Operations. Safety is red with an accident, yellow with a near miss, green otherwise. Changing these needs the setup right.</p>
    <form id="sim-bands-f">${row('quality', 'Quality', T.quality.target ?? '', 'CPMS, at most')}${row('scrap', 'Scrap rate', pct(T.scrap.target, 3), '%, at most')}${row('otd', 'OTD SC', pct(T.otd.target, 2), '%, at least')}
      <div class="row" style="margin-top:10px"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">Save</button></div></form>`);
  $('#sim-bands-f').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const num = (v) => Number(String(v).replace(',', '.'));
    const bands = Object.fromEntries(['quality', 'scrap', 'otd'].map((k) => [`sim_band_${k}`, f[`b_${k}`] === '' ? '' : String(Math.min(100, Math.max(0, num(f[`b_${k}`]))) / 100)]));
    const targets = { quality: f.t_quality === '' ? null : num(f.t_quality), scrap: f.t_scrap === '' ? null : num(f.t_scrap) / 100, otd: f.t_otd === '' ? null : num(f.t_otd) / 100 };
    try { await api.put('/sim/targets', targets); await api.patch('/settings', bands); closeModal(); toast('Saved'); renderSim(d.day === d.default_day ? '' : d.day); } catch (err) { toast(err.message, 'error'); }
  };
}

// ⏱ the automatic picture: the SIM of the last working day saved as a PNG in a folder at set times (each run
// overwrites the same file, e.g. for a screen at the briefing board), like Production's automatic plans
async function simAutoDialog() {
  let a; try { a = await api.get('/sim/auto'); } catch (err) { toast(err.message, 'error'); return; }
  const DAYS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
  const when = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const lastLine = (x) => (!x.last ? '<span class="muted">Not made yet.</span>'
    : x.last.ok ? `<span class="pa-ok">✔ Made ${esc(when(x.last.at))}</span> (the SIM of ${esc(fmtDate(x.last.day))})` : `<span class="pl-late">${esc(when(x.last.at))}: ${esc(x.last.error)}</span>`);
  const nextLine = (x) => (x.next ? `Next: ${esc(when(x.next))}` : x.enabled ? '' : 'Switched off.');
  openModal(`<div class="modal-head"><h2 style="margin:0">Automatic picture</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted" style="margin-top:0">At the times below SIM reads its reports and saves the last working day's SIM as a picture (PNG) in the folder, over the one before — so a screen or a shortcut always shows the latest. Changing this needs the setup right.</p>
    <form id="sim-auto-f" class="form-grid">
      <label class="full row" style="gap:8px"><input type="checkbox" name="enabled" ${a.enabled ? 'checked' : ''} style="width:auto"> Make the picture automatically</label>
      <label class="f">Times <span class="small muted">e.g. 06:00, 13:45</span><input type="text" name="times" value="${esc(a.times.join(', '))}"></label>
      <div class="f"><span>Days</span><div class="row" style="gap:10px;flex-wrap:wrap">${DAYS.map(([n, l]) => `<label class="row" style="gap:4px"><input type="checkbox" name="day" value="${n}" ${a.days.includes(n) ? 'checked' : ''} style="width:auto">${l}</label>`).join('')}</div></div>
      <label class="f full">Folder <span class="small muted">a full path the server can write to, e.g. S:\\Production\\SIM or \\\\server\\share\\SIM</span><input type="text" name="folder" value="${esc(a.folder)}"></label>
      <label class="f">File name <span class="small muted">(saved as .png)</span><input type="text" name="file" value="${esc(a.file)}"></label>
      <div class="f small" id="sim-auto-st"><span>${lastLine(a)}</span><span class="muted">${nextLine(a)}</span></div>
      <div class="full row"><button type="button" id="sim-auto-now" title="Save it now and make the picture">▶ Make it now</button><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">Save</button></div></form>`);
  const body = () => { const f = $('#sim-auto-f'); return { enabled: f.enabled.checked, times: f.times.value, days: $$('#sim-auto-f [name=day]:checked').map((c) => Number(c.value)), folder: f.folder.value, file: f.file.value }; };
  $('#sim-auto-f').onsubmit = async (e) => { e.preventDefault(); try { await api.put('/sim/auto', body()); closeModal(); toast('Saved'); } catch (err) { toast(err.message, 'error'); } };
  $('#sim-auto-now').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = '⏳ Making it…';
    try {
      await api.put('/sim/auto', body());
      const r = await fetch('/api/sim/auto/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' }, body: '{}' }).then((x) => x.json());
      $('#sim-auto-st').innerHTML = `<span>${lastLine(r)}</span><span class="muted">${nextLine(r)}</span>`;
      if (r.error) toast(r.error, 'error'); else toast(`Saved ${r.last.file}`);
    } catch (err) { toast(err.message, 'error'); }
    b.disabled = false; b.textContent = '▶ Make it now';
  };
}
