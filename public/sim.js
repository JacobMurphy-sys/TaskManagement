// 📣 SIM (Short Interval Management): the KPI part of the daily briefing between shifts and departments. One day —
// the last working day by default — on one page of four equal panels: Quality, Safety, Scrap and OTD. Each shows the
// day's result large, coloured as the weekly report's arrows (green / yellow / red against the target), the month
// to date as a line chart with the target marked, and what made the result.

const SIM_COL = { green: '#00B050', yellow: '#FFC000', red: '#FF0000' }; // the A3's arrow colours
const simDayAdd = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const simPct = (v, dp = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`);
const simNum = (v, dp = 0) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
let SIM_CHARTS = []; // the charts on the page, drawn to their boxes (again when the window is resized)

async function renderSim(dayArg) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg || '') ? dayArg : '';
  const d = await api.get(`/sim${day ? `?day=${day}` : ''}`);
  const T = d.topics;
  const fmt = { quality: (v) => simNum(v, 2), scrap: (v) => simPct(v, 2), otd: (v) => simPct(v, 1) };
  const tgt = (t, f) => (t.target === null || t.target === undefined ? '<button type="button" class="link small sim-set-tg" title="Without a target the result can\'t be coloured">🎯 Set a target</button>'
    : `target ${t.better === 'down' ? '≤' : '≥'} ${f(t.target)}`);
  // no figure for the day: say whether its report hasn't been read that far yet
  const short = (dd) => new Date(`${dd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const vol = (t, n, what) => (n || (t.read_to && t.read_to >= d.day) ? `${simNum(n)} ${what}`
    : `<span class="pl-late" title="The day's figures come in when the report is read (📊 Reporting › Sources)">${what} not read yet${t.read_to ? ` (to ${esc(short(t.read_to))})` : ''}</span>`);
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
    <div class="kanban-tools sim-tools"><h1 style="margin:0">📣 SIM</h1>
      <div class="seg"><button type="button" data-sim-go="${simDayAdd(d.day, -1)}" title="The day before">◀</button><button type="button" data-sim-go="${simDayAdd(d.day, 1)}" title="The day after" ${d.day >= d.today ? 'disabled' : ''}>▶</button></div>
      <input type="date" id="sim-day" value="${d.day}" max="${d.today}" style="width:auto">
      <b>${esc(d.label)}</b>${isDefault ? '<span class="pill">last working day</span>' : `<button type="button" class="link small" data-sim-go="">Back to the last working day</button>`}${d.worked ? '' : '<span class="pill" title="Not a working day in Production\'s calendar">not a working day</span>'}
      <div class="spacer"></div><button type="button" id="sim-read" title="Read the reports SIM is fed from again (cards shipped and persoed, scrap, OTD, complaints, safety forms) — the ones that changed">⟳ Read the reports</button>${ddMenu('⋯', '<button type="button" id="sim-bands">🎯 Targets and colours…</button>', { title: 'How the colours are decided' })}</div>
    <div class="sim-grid">${quality}${safety}${scrap}${otd}</div>`;

  // the line charts, drawn to their boxes
  SIM_CHARTS = [
    { id: 'sim-c-quality', rows: q.by_day, series: [{ val: (r) => r.value, colour: (r) => r.colour }], target: q.target, better: 'down', f: fmt.quality },
    { id: 'sim-c-safety', rows: s.by_day, series: [{ key: 'ac', label: 'AC', col: SIM_COL.red }, { key: 'nm', label: 'NM', col: '#d9a400' }, { key: 'sc', label: 'SC', col: '#8a90ad' }].map((x) => ({ ...x, val: (r) => (r.worked || r[x.key] ? r[x.key] ?? 0 : null), colour: () => null })),
      target: 0, better: 'down', f: (v) => String(Math.round(v)), targetLabel: '0 AC', integer: true },
    { id: 'sim-c-scrap', rows: sc.by_day, series: [{ val: (r) => r.value, colour: (r) => r.colour }], target: sc.target, better: 'down', f: fmt.scrap },
    { id: 'sim-c-otd', rows: o.by_day, series: [{ val: (r) => r.value, colour: (r) => r.colour }], target: o.target, better: 'up', f: fmt.otd },
  ];
  const drawAll = () => SIM_CHARTS.forEach((c) => { const el = document.getElementById(c.id); if (el) simLineChart(el, c, d.day); });
  drawAll();
  if (!window.__simResize) { window.__simResize = true; let t = null; window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => SIM_CHARTS.forEach((c) => { const el = document.getElementById(c.id); if (el) simLineChart(el, c, el.dataset.day); }), 120); }); }

  const go = (dd) => { location.hash = dd ? `#/sim/${dd}` : '#/sim'; };
  $$('[data-sim-go]').forEach((b) => { b.onclick = () => go(b.dataset.simGo); });
  $('#sim-day').onchange = (e) => { if (e.target.value) go(e.target.value); };
  main().addEventListener('click', (e) => { const c = e.target.closest('[data-sim-day]'); if (c && main().contains(c)) go(c.dataset.simDay); });
  $('#sim-add-btn').onclick = () => {
    openModal(`<div class="modal-head"><h2 style="margin:0">＋ Internal report</h2><button class="icon" data-action="close-modal">✕</button></div>
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

// The month to date as a line chart in a box (drawn at the box's own size): a line per series through the days with
// a figure, each day's point in its result's colour, the target as a dashed line with its label and the side that
// meets it shaded, the day shown highlighted; a click on a day opens it.
function simLineChart(el, c, day) {
  el.dataset.day = day;
  const W = Math.max(200, el.clientWidth); const H = Math.max(90, el.clientHeight);
  const L = 70; const R = 10; const Tp = 8; const B = 18; const n = c.rows.length || 1;
  const step = (W - L - R) / Math.max(1, n - 1 || 1); const xOf = (i) => (n === 1 ? L + (W - L - R) / 2 : L + i * step);
  const vals = c.rows.flatMap((r) => c.series.map((s) => s.val(r))).filter((v) => v !== null && v !== undefined);
  const tg = c.target;
  let lo = 0; let hi = Math.max(...vals, tg ?? 0, c.integer ? 2 : 0);
  if (c.better === 'up') { lo = Math.max(0, Math.min(Math.min(...(vals.length ? vals : [tg ?? 0.9]), tg ?? 1) - 0.02, 0.98)); hi = 1; }
  if (hi <= lo) hi = lo + (c.integer ? 2 : 1);
  const top = hi; hi += (hi - lo) * (c.better === 'up' ? 0.06 : 0.1); // headroom (a share can't pass 100%: its top label stays at it)
  const yOf = (v) => Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - B);
  const parts = [];
  // the side that meets the target, shaded
  if (tg !== null && tg !== undefined) {
    const yt = yOf(tg);
    parts.push(c.better === 'down' ? `<rect x="${L}" y="${yt}" width="${W - L - R}" height="${H - B - yt}" class="sim-okzone"/>` : `<rect x="${L}" y="${Tp}" width="${W - L - R}" height="${yt - Tp}" class="sim-okzone"/>`);
  }
  // the day shown, and the clickable days (weekends and holidays paler)
  c.rows.forEach((r, i) => {
    const x = xOf(i); const w = n === 1 ? 30 : step;
    if (r.day === day) parts.push(`<rect x="${x - w / 2}" y="${Tp}" width="${w}" height="${H - Tp - B}" class="sim-selbg"/>`);
    const every = step < 16 ? 2 : 1;
    if (i % every === 0 || r.day === day) parts.push(`<text x="${x}" y="${H - 5}" class="sim-ax${r.worked ? '' : ' off'}${r.day === day ? ' sel' : ''}">${Number(r.day.slice(8))}</text>`);
  });
  // y axis: bottom, top (left out where the target's tag sits)
  const clear = (v) => tg === null || tg === undefined || Math.abs(yOf(v) - yOf(tg)) > 30;
  parts.push(`${clear(lo) ? `<text x="${L - 6}" y="${yOf(lo) + 3}" class="sim-yax">${c.f(lo)}</text>` : ''}${clear(top) ? `<text x="${L - 6}" y="${yOf(top) + 3}" class="sim-yax">${c.f(top)}</text>` : ''}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="sim-base"/>`);
  // the target
  if (tg !== null && tg !== undefined) {
    // in the left margin, on the line: it never covers a day's point
    const yt = yOf(tg); const label = c.targetLabel || `${c.better === 'down' ? '≤' : '≥'} ${c.f(tg)}`;
    const tw = L - 6; const by = Math.min(H - B - 8, Math.max(Tp + 1, yt - 7.5));
    parts.push(`<line x1="${L}" x2="${W - R}" y1="${yt}" y2="${yt}" class="sim-target"/><rect x="2" y="${by}" width="${tw}" height="15" rx="4" class="sim-tbox"><title>Target ${esc(label)}</title></rect><text x="${2 + tw / 2}" y="${by + 11}" class="sim-tlabel">${esc(label)}</text><text x="${L - 6}" y="${by - 3 < Tp + 4 ? by + 25 : by - 3}" class="sim-tword">TARGET</text>`);
  }
  // the lines and their points
  for (const s of c.series) {
    // joined up over the days without a figure (weekends, holidays, a report not read): Friday straight to Monday
    let path = '';
    c.rows.forEach((r, i) => { const v = s.val(r); if (v === null || v === undefined) return; path += `${path ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`; });
    if (path) parts.push(`<path d="${path}" class="sim-line" style="stroke:${s.col || 'var(--accent)'}"/>`);
    c.rows.forEach((r, i) => {
      const v = s.val(r); if (v === null || v === undefined) return;
      if (s.key && !v && r.day !== day) return; // a count of 0: no dot
      const col = s.col || SIM_COL[s.colour(r)] || 'var(--muted)'; const sel = r.day === day;
      parts.push(`<circle cx="${xOf(i)}" cy="${yOf(v)}" r="${sel ? 5.5 : 3.5}" fill="${col}" class="sim-dot${sel ? ' sel' : ''}"><title>${esc(fmtDate(r.day))}: ${s.label ? `${s.label} ` : ''}${c.f(v)}</title></circle>`);
    });
  }
  if (c.series.some((s) => s.label)) parts.push(`<g class="sim-legend">${c.series.map((s, i) => `<g transform="translate(${L + 6 + i * 44},${Tp + 6})"><line x1="0" x2="12" y1="0" y2="0" style="stroke:${s.col}" class="sim-line"/><text x="16" y="3">${s.label}</text></g>`).join('')}</g>`);
  // a click on a day's column opens it
  c.rows.forEach((r, i) => { const w = n === 1 ? 30 : step; parts.push(`<rect x="${xOf(i) - w / 2}" y="0" width="${w}" height="${H}" fill="transparent" class="sim-hit" data-sim-day="${r.day}"><title>${esc(fmtDate(r.day))}</title></rect>`); });
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="The month to date, day by day">${parts.join('')}</svg>`;
}

// 🎯 each topic's target (Operations' site KPI targets, shared with it) and amber band: how far off still shows yellow
function simBands(d) {
  const T = d.topics; const pct = (v, dp) => (v === null || v === undefined ? '' : String(Math.round(v * 100 * 10 ** dp) / 10 ** dp));
  const row = (k, label, target, hint) => `<div class="sim-tg-row"><b>${label}</b>
      <label class="f">Target <span class="small muted">${hint}</span><input type="number" name="t_${k}" step="any" min="0" value="${target}"></label>
      <label class="f">Yellow within<span class="row" style="gap:6px"><input type="number" name="b_${k}" min="0" max="100" step="1" value="${Math.round(d.bands[k] * 100)}" style="max-width:90px"> % of it</span></label></div>`;
  openModal(`<div class="modal-head"><h2 style="margin:0">🎯 Targets and colours</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted" style="margin-top:0">Each result is <b style="color:${SIM_COL.green}">green</b> when it meets its target, <b style="color:#b38600">yellow</b> when it's off by no more than the share given, and <b style="color:${SIM_COL.red}">red</b> beyond; without a target it stays grey. The targets are the same as on 📊 Reporting › Operations. Safety is red with an accident, yellow with a near miss, green otherwise. Changing these needs the setup right.</p>
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
