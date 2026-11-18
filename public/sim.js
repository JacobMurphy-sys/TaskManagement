// 📣 SIM (Short Interval Management): the KPI part of the daily briefing between shifts and departments. One day —
// the last working day by default — in four panels: Quality, Safety, Scrap and OTD. Each shows the day's result
// large, coloured as the weekly report's arrows (green / yellow / red against the target), the month to date by
// day, and what made the result: the complaints and internal reports, the forms, the top scrap, the delays.

const SIM_COL = { green: '#00B050', yellow: '#FFC000', red: '#FF0000' }; // the A3's arrow colours
const simDayAdd = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const simPct = (v, dp = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`);
const simNum = (v, dp = 0) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }));

async function renderSim(dayArg) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayArg || '') ? dayArg : '';
  const d = await api.get(`/sim${day ? `?day=${day}` : ''}`);
  const T = d.topics;
  const fmt = { quality: (v) => simNum(v, 2), scrap: (v) => simPct(v, 2), otd: (v) => simPct(v, 1) };
  const tgt = (t, f) => (t.target === null || t.target === undefined ? '<span class="muted" title="Set it on 📊 Reporting › Operations (⚙ on its tiles)">no target set</span>'
    : `target ${t.better === 'down' ? '≤' : '≥'} ${f(t.target)}`);
  const big = (colour, value, sub) => `<div class="sim-big ${colour ? `sim-${colour}` : 'sim-none'}"><div class="sim-val">${value}</div>${sub ? `<div class="sim-sub">${sub}</div>` : ''}</div>`;
  const mtd = (t, f) => `<span class="sim-mtd" title="The month up to and including ${esc(d.label)}">Month to date <b class="${t.mtd.colour ? `sim-t-${t.mtd.colour}` : ''}">${f(t.mtd.value)}</b></span>`;
  const panel = (key, icon, title, unit, body) => `<section class="card sim-panel" data-sim="${key}"><header class="sim-head"><h2>${icon} ${title}</h2><span class="small muted">${unit}</span></header>${body}</section>`;

  // the month to date, a bar a day: coloured by its result, the day shown outlined; a click goes to that day
  const chart = (rows, { val = () => null, colour = () => null, target = null, better, f, stack }) => {
    const n = rows.length || 1; const W = 600; const H = 110; const bw = W / n; const top = 8; const base = H - 16;
    const vals = rows.map(val).filter((v) => v !== null && v !== undefined);
    let lo = 0; let hi = Math.max(...(stack ? rows.map((r) => stack.reduce((a, [k]) => a + (r[k] || 0), 0)) : vals), target ?? 0, stack ? 1 : 0) || 1;
    if (better === 'up' && vals.length) { lo = Math.max(0, Math.min(...vals, target ?? 1) - 0.03); hi = 1; }
    hi = hi + (hi - lo) * 0.12;
    const y = (v) => base - ((v - lo) / (hi - lo || 1)) * (base - top);
    const bars = rows.map((r, i) => {
      const x = i * bw + bw * 0.15; const w = bw * 0.7; const sel = r.day === d.day;
      const lbl = `<text x="${x + w / 2}" y="${H - 4}" class="sim-ax${r.worked ? '' : ' off'}${sel ? ' sel' : ''}">${Number(r.day.slice(8))}</text>`;
      const tip = `<title>${esc(fmtDate(r.day))}: ${stack ? stack.map(([k, l]) => `${r[k] || 0} ${l}`).join(', ') : val(r) === null ? 'no figure' : f(val(r))}</title>`;
      let shape = '';
      if (stack) { let acc = 0; shape = stack.map(([k, , c]) => { const v = r[k] || 0; if (!v) return ''; const y1 = y(acc + v); const y0 = y(acc); acc += v; return `<rect x="${x}" y="${y1}" width="${w}" height="${Math.max(1, y0 - y1)}" fill="${c}"/>`; }).join(''); }
      else if (val(r) !== null && val(r) !== undefined) { const yy = y(Math.max(lo, val(r))); shape = `<rect x="${x}" y="${yy}" width="${w}" height="${Math.max(1.5, base - yy)}" rx="1.5" fill="${SIM_COL[colour(r)] || 'var(--muted)'}"/>`; }
      return `<g class="sim-bar${sel ? ' sel' : ''}" data-sim-day="${r.day}">${sel ? `<rect x="${i * bw + 1}" y="${top - 4}" width="${bw - 2}" height="${base - top + 4}" class="sim-selbg"/>` : ''}<rect x="${i * bw}" y="0" width="${bw}" height="${H}" fill="transparent"/>${shape}${lbl}${tip}</g>`;
    }).join('');
    const tl = target !== null && target !== undefined && target >= lo && target <= hi ? `<line x1="0" x2="${W}" y1="${y(target)}" y2="${y(target)}" class="sim-target"/><text x="2" y="${y(target) - 3}" class="sim-tlabel">target ${f(target)}</text>` : '';
    return `<svg class="sim-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="The month to date, day by day">${bars}${tl}<line x1="0" x2="${W}" y1="${base}" y2="${base}" class="sim-base"/></svg>`;
  };
  const list = (title, rows, empty) => `<div class="sim-list"><h3>${title}</h3>${rows.length ? `<ul>${rows.join('')}</ul>` : `<div class="small muted">${empty}</div>`}</div>`;
  const cust = (c, name) => `${esc(c || '?')}${name ? ` <span class="muted">${esc(name)}</span>` : ''}`;

  // ---- Quality
  const q = T.quality;
  const quality = panel('quality', '🧪', 'Quality', 'CPMS: customer complaints per million cards shipped',
    `${big(q.colour, fmt.quality(q.value), `${q.complaints.length} complaint${q.complaints.length === 1 ? '' : 's'} · ${simNum(q.shipped)} cards shipped · ${tgt(q, fmt.quality)}`)}
     <div class="sim-row">${mtd(q, fmt.quality)}<span class="sim-mtd">Internal reports <b>${q.internal.length}</b> <span class="muted">(month: ${q.mtd.internal})</span></span></div>
     ${chart(q.by_day, { val: (r) => r.value, colour: (r) => r.colour, target: q.target, better: 'down', f: fmt.quality })}
     <div class="sim-lists">${list('Customer complaints opened', q.complaints.map((c) => `<li><b>${esc(c.ref || '—')}</b> ${cust(c.customer)}${c.severity ? ` <span class="pill">${esc(c.severity)}</span>` : ''}${c.summary ? `<div class="small muted">${esc(c.summary)}</div>` : ''}</li>`), 'None opened that day.')}
       <div class="sim-list"><h3>Internal reports</h3>${q.internal.length ? `<ul>${q.internal.map((r) => `<li>${r.area ? `<b>${esc(r.area)}</b> · ` : ''}${esc(r.text)}<button type="button" class="icon small" data-sim-del="${r.id}" title="Remove">✕</button>${r.created_by ? `<div class="small muted">${esc(r.created_by)}</div>` : ''}</li>`).join('')}</ul>` : '<div class="small muted">None noted yet.</div>'}
         <form class="sim-add" id="sim-add"><input type="text" name="area" placeholder="Area (optional)" maxlength="120"><input type="text" name="text" placeholder="＋ An internal report for this day… (Enter)" maxlength="1000" required></form></div></div>`);

  // ---- Safety
  const s = T.safety;
  const safetyStack = [['ac', 'accidents', SIM_COL.red], ['nm', 'near misses', SIM_COL.yellow], ['sc', 'safety concerns', '#9aa0b8']];
  const safety = panel('safety', '⛑', 'Safety', 'safety concern forms by incident date',
    `${big(s.colour, `${s.ac} accident${s.ac === 1 ? '' : 's'}`, `${s.nm} near miss${s.nm === 1 ? '' : 'es'} · ${s.sc} safety concern${s.sc === 1 ? '' : 's'} · <span title="${esc(s.rule)}">ⓘ</span>`)}
     <div class="sim-row"><span class="sim-mtd">Month to date <b class="${s.mtd.ac ? 'sim-t-red' : ''}">${s.mtd.ac} AC</b> · <b>${s.mtd.nm} NM</b> · <b>${s.mtd.sc} SC</b></span></div>
     ${chart(s.by_day, { stack: safetyStack, f: String })}
     <div class="sim-lists">${list('Forms that day', s.forms.map((f) => `<li><span class="sim-kind sim-k-${esc(f.kind.toLowerCase())}">${esc(f.kind)}</span> ${f.location ? `<b>${esc(f.location)}</b>` : ''}${f.detail ? ` · ${esc(f.detail)}` : ''}${f.description ? `<div class="small muted">${esc(f.description)}</div>` : ''}</li>`), 'No forms that day.')}</div>`);

  // ---- Scrap
  const sc = T.scrap;
  const scrap = panel('scrap', '♻', 'Scrap', 'scrap rate: scrap ÷ cards persoed',
    `${big(sc.colour, fmt.scrap(sc.value), `${simNum(sc.scrap)} cards scrapped · ${simNum(sc.persoed)} persoed · ${tgt(sc, fmt.scrap)}`)}
     <div class="sim-row">${mtd(sc, fmt.scrap)}<span class="sim-mtd muted">${simNum(sc.mtd.scrap)} scrapped of ${simNum(sc.mtd.persoed)}</span></div>
     ${chart(sc.by_day, { val: (r) => r.value, colour: (r) => r.colour, target: sc.target, better: 'down', f: fmt.scrap })}
     <div class="sim-lists">${list('Top 5 scrap that day', sc.top.map((t) => `<li><span class="sim-q">${simNum(t.qty)}</span> <b>${esc(t.wo || '—')}</b> ${cust(t.customer, t.name)}<div class="small muted">${esc(t.cause)}${t.item ? ` · ${esc(t.item)}` : ''}</div></li>`), 'No scrap that day.')}</div>`);

  // ---- OTD
  const o = T.otd;
  const otd = panel('otd', '🚚', 'OTD', 'OTD SC: 1 − SC delays ÷ cards shipped',
    `${big(o.colour, fmt.otd(o.value), `${simNum(o.sc)} SC delays · ${simNum(o.customer)} customer · ${simNum(o.shipped)} shipped · ${tgt(o, fmt.otd)}`)}
     <div class="sim-row">${mtd(o, fmt.otd)}${o.undated.rows ? `<span class="sim-mtd small pl-late" title="Delays of ${esc(o.undated.week)} in the OTD report with only the week typed in: they can't be put on a day">${o.undated.rows} delay${o.undated.rows === 1 ? '' : 's'} of ${esc(o.undated.week)} without a date (${simNum(o.undated.qty)} cards)</span>` : ''}</div>
     ${chart(o.by_day, { val: (r) => r.value, colour: (r) => r.colour, target: o.target, better: 'up', f: fmt.otd })}
     <div class="sim-lists">${list('Delays that day', o.delays.map((x) => `<li><span class="sim-q">${simNum(x.qty)}</span> <span class="sim-kind ${x.kind === 'SC' ? 'sim-k-ac' : 'sim-k-sc'}">${x.kind}</span> ${cust(x.customer)}${x.wo ? ` · ${esc(x.wo)}` : ''}${x.reason ? `<div class="small muted">${esc(x.reason)}</div>` : ''}</li>`), 'No dated delays that day.')}
       ${list('Late work orders due that day', o.late_wos.map((j) => `<li><span class="sim-q">${simNum(j.qty)}</span> <b>${esc(j.wo)}</b> ${cust(j.customer, j.name)}<div class="small muted">${j.open ? `still open, ${simNum(j.late_hours, 1)} h past its deadline` : `finished ${simNum(j.late_hours, 1)} h late`}</div></li>`), 'None late (from the planner).')}</div>`);

  const isDefault = d.day === d.default_day;
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">📣 SIM</h1>
      <div class="seg"><button type="button" data-sim-go="${simDayAdd(d.day, -1)}" title="The day before">◀</button><button type="button" data-sim-go="${simDayAdd(d.day, 1)}" title="The day after" ${d.day >= d.today ? 'disabled' : ''}>▶</button></div>
      <input type="date" id="sim-day" value="${d.day}" max="${d.today}" style="width:auto">
      <b>${esc(d.label)}</b>${isDefault ? '<span class="pill">last working day</span>' : `<button type="button" class="link small" data-sim-go="">Back to the last working day</button>`}${d.worked ? '' : '<span class="pill" title="Not a working day in Production\'s calendar">not a working day</span>'}
      <div class="spacer"></div>${ddMenu('⋯', '<button type="button" id="sim-bands">🎨 Colour bands…</button>', { title: 'How the colours are decided' })}</div>
    <div class="sim-grid">${quality}${safety}${scrap}${otd}</div>`;

  const go = (dd) => { location.hash = dd ? `#/sim/${dd}` : '#/sim'; };
  $$('[data-sim-go]').forEach((b) => { b.onclick = () => go(b.dataset.simGo); });
  $('#sim-day').onchange = (e) => { if (e.target.value) go(e.target.value); };
  $$('.sim-bar[data-sim-day]').forEach((g) => { g.onclick = () => go(g.dataset.simDay); });
  $('#sim-add').onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try { await api.post('/sim/reports', { day: d.day, text: f.text, area: f.area }); toast('Internal report noted'); renderSim(d.day); } catch (err) { toast(err.message, 'error'); }
  };
  $$('[data-sim-del]').forEach((b) => { b.onclick = async () => { if (!confirm('Remove this internal report?')) return; try { await api.del(`/sim/reports/${b.dataset.simDel}`); renderSim(d.day); } catch (err) { toast(err.message, 'error'); } }; });
  $('#sim-bands').onclick = () => simBands(d);
}

// 🎨 the amber band of each topic: how far off its target still shows yellow
function simBands(d) {
  const row = (k, label) => `<label class="f">${label}<span class="row" style="gap:6px"><input type="number" name="sim_band_${k}" min="0" max="100" step="1" value="${Math.round(d.bands[k] * 100)}" style="max-width:90px"> %</span></label>`;
  openModal(`<div class="modal-head"><h2 style="margin:0">🎨 Colour bands</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted" style="margin-top:0">Each result is <b style="color:${SIM_COL.green}">green</b> when it meets its target (set on 📊 Reporting › Operations), <b style="color:#b38600">yellow</b> when it's within this share of the target, and <b style="color:${SIM_COL.red}">red</b> beyond. Safety is red with an accident, yellow with a near miss, green otherwise. Changing these needs the setup right.</p>
    <form id="sim-bands-f" class="form-grid">${row('quality', 'Quality (CPMS)')}${row('scrap', 'Scrap rate')}${row('otd', 'OTD SC')}
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">Save</button></div></form>`);
  $('#sim-bands-f').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, v === '' ? '' : String(Math.min(100, Math.max(0, Number(v))) / 100)]));
    try { await api.patch('/settings', body); closeModal(); toast('Saved'); renderSim(d.day === d.default_day ? '' : d.day); } catch (err) { toast(err.message, 'error'); }
  };
}
