// 📐 CPM — capacity planning (Prod Management): the forecasts against the machines' capacity per
// technology by month or week, the forecasts against what was done (flex), the customers' split and
// OEE, the capacity settings, and each person's scenarios (src/cpm.js does the sums).
const CPM_TABS = [['overview', '📊 Overview'], ['flex', '📈 Forecast vs actual'], ['customers', '👥 Customers'], ['capacity', '⚙ Capacity'], ['scenarios', '🧪 Scenarios']];
const cpmN = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: d }));
const cpmK = (v) => (v === null || v === undefined ? '—' : Math.abs(v) >= 1e6 ? `${(v / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 2 })}M` : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3).toLocaleString('en-GB')}k` : cpmN(v));
const cpmPct = (v, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: d })}%`);
const cpmUtilCls = (u) => (u === null || u === undefined ? '' : u > 1 ? 'bad' : u > 0.85 ? 'warn' : 'ok');
const CPM_TECH_ICON = { DOD: '🖨', Emboss: '🔠', Laser: '🔆' };

async function renderCpm(tab) {
  tab = CPM_TABS.some(([k]) => k === tab) ? tab : store.get('cpmTab', 'overview');
  store.set('cpmTab', tab);
  const head = `<div class="kanban-tools"><h1 style="margin:0">📐 Capacity planning</h1>
      <div class="pl-halves cpm-tabs">${CPM_TABS.map(([k, l]) => `<div class="pl-half ${k === tab ? 'on' : ''}"><a href="#/cpm/${k}" class="button">${l}</a></div>`).join('')}</div></div>`;
  main().innerHTML = `${head}<div id="cpm-body"><p class="muted">Loading…</p></div>`;
  const body = $('#cpm-body');
  try {
    if (tab === 'overview') await cpmOverview(body);
    else if (tab === 'flex') await cpmFlex(body);
    else if (tab === 'customers') await cpmCustomers(body);
    else if (tab === 'capacity') await cpmCapacity(body);
    else await cpmScenarios(body);
  } catch (err) { body.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="pre">${esc(err.message)}</p></div>`; }
}

// ---- 📊 Overview: demand against capacity, per technology --------------------------------------------
async function cpmOverview(body) {
  const year = Number(store.get('cpmYear', new Date().getFullYear()));
  const period = store.get('cpmPeriod', 'month');
  const flex = store.get('cpmFlex', true);
  const scen = (store.get('cpmCompare', []) || []).slice(0, 2);
  const [d, all] = await Promise.all([api.get(`/cpm/overview?year=${year}&period=${period}&flex=${flex ? 1 : 0}&scenarios=${scen.join(',')}`), api.get('/cpm/scenarios')]);
  const now = new Date().toISOString().slice(0, 10);
  const SC_COL = ['#7a5cff', '#e0861a'];
  const chart = (t) => {
    const P = d.periods; const W = Math.max(640, P.length * (period === 'week' ? 18 : 64)); const H = 220; const L = 54; const B = 26; const T = 10;
    const max = Math.max(1, ...P.map((p) => Math.max(p.techs[t].need, p.techs[t].capacity, p.techs[t].actual)), ...d.scenarios.flatMap((s) => s.periods.map((p) => Math.max(p.techs[t].capacity, p.techs[t].need))));
    const x = (i) => L + (i + 0.5) * ((W - L - 6) / P.length); const bw = Math.max(4, ((W - L - 6) / P.length) * 0.62); const y = (v) => T + (H - T - B) * (1 - v / max);
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f);
    const line = (pts, col, dash = '') => `<polyline fill="none" stroke="${col}" stroke-width="2.2" ${dash ? `stroke-dasharray="${dash}"` : ''} points="${pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    return `<svg class="cpm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmK(v)}</text>`).join('')}
      ${P.map((p, i) => { const k = p.techs[t]; const u = k.util; return `<g><title>${esc(`${p.label}: needed ${cpmN(k.need)} (forecast ${cpmN(k.fc)}${flex ? `, flexed ${cpmN(k.demand)}` : ''}) · capacity ${cpmN(k.capacity)} · ${u === null ? '' : cpmPct(u)}${k.actual ? ` · actual ${cpmN(k.actual)}` : ''}`)}</title>
        <rect x="${x(i) - bw / 2}" y="${y(k.need)}" width="${bw}" height="${Math.max(0, y(0) - y(k.need))}" class="cpm-bar ${cpmUtilCls(u)}"/>
        <rect x="${x(i) - bw / 4}" y="${y(k.fc)}" width="${bw / 2}" height="${Math.max(0, y(0) - y(k.fc))}" class="cpm-bar-fc"/></g>`; }).join('')}
      ${line(P.map((p, i) => [i, p.techs[t].capacity]), 'var(--text)')}
      ${d.scenarios.map((s, j) => line(s.periods.map((p, i) => [i, p.techs[t].capacity]), SC_COL[j], '6 4')).join('')}
      ${P.map((p, i) => (p.techs[t].actual && p.end <= now ? `<circle cx="${x(i)}" cy="${y(p.techs[t].actual)}" r="3.6" class="cpm-act"><title>${esc(`${p.label}: actual ${cpmN(p.techs[t].actual)}`)}</title></circle>` : '')).join('')}
      ${P.map((p, i) => (period === 'month' || i % 4 === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="cpm-ax">${esc(period === 'week' ? p.key.slice(5) : p.label)}</text>` : '')).join('')}
    </svg>`;
  };
  const table = (t) => {
    const P = d.periods; const row = (label, f, cls = () => '') => `<tr><th>${label}</th>${P.map((p, i) => `<td class="num ${cls(p, i)}">${f(p, i)}</td>`).join('')}<td class="num"><b>${f(null)}</b></td></tr>`;
    const sum = (k) => P.reduce((a, p) => a + p.techs[t][k], 0);
    const tot = { fc: sum('fc'), demand: sum('demand'), need: sum('need'), capacity: sum('capacity'), actual: sum('actual') };
    const v = (k) => (p) => cpmK(p ? p.techs[t][k] : tot[k]);
    return `<div class="kdb-scroll"><table class="log small cpm-t"><thead><tr><th></th>${P.map((p) => `<th class="num">${esc(period === 'week' ? p.key.slice(5) : p.label)}</th>`).join('')}<th class="num">Year</th></tr></thead><tbody>
      ${row('Forecast', v('fc'))}${flex ? row('With flex', v('demand')) : ''}${row('Needed (÷ OEE)', v('need'))}${row('Capacity', v('capacity'))}
      ${row('Open', (p) => { const g = p ? p.techs[t].gap : tot.capacity - tot.need; return `<span class="${g < 0 ? 'pl-late' : ''}">${cpmK(g)}</span>`; })}
      ${row('Load', (p) => cpmPct(p ? p.techs[t].util : (tot.capacity ? tot.need / tot.capacity : null)), (p) => (p ? `cpm-u ${cpmUtilCls(p.techs[t].util)}` : ''))}
      ${row('Actual', (p) => (p ? (p.end <= now || p.techs[t].actual ? cpmK(p.techs[t].actual) : '') : cpmK(tot.actual)))}
      ${d.scenarios.map((s, j) => row(`<span style="color:${SC_COL[j]}">${esc(s.name)}</span>: load`, (p, i) => { const sp = p ? s.periods[i].techs[t] : null; return cpmPct(sp ? sp.util : null); }, (p, i) => (p ? `cpm-u ${cpmUtilCls(s.periods[i].techs[t].util)}` : ''))).join('')}
      </tbody></table></div>`;
  };
  const short = (res, t) => res.periods.filter((p) => p.techs[t].util > 1).length;
  const tiles = d.techs.map((t) => { const P = d.periods; const need = P.reduce((a, p) => a + p.techs[t].need, 0); const cap = P.reduce((a, p) => a + p.techs[t].capacity, 0); const s = short(d, t);
    return `<div class="kdb-tile"><div class="kdb-tile-l">${CPM_TECH_ICON[t] || ''} ${esc(t)} — year</div><div class="kdb-tile-v ${cpmUtilCls(cap ? need / cap : null) === 'bad' ? 'kdb-bad' : ''}">${cpmPct(cap ? need / cap : null)}</div>
      <div class="kdb-tile-s">of capacity needed · <b class="${s ? 'pl-late' : 'pl-ok'}">${s} ${period === 'week' ? 'week' : 'month'}${s === 1 ? '' : 's'} over</b>${d.scenarios.map((sc, j) => ` · <span style="color:${SC_COL[j]}">${esc(sc.name)}: ${short(sc, t)}</span>`).join('')}</div></div>`; }).join('');
  const years = [year - 1, year, year + 1];
  body.innerHTML = `
    <div class="row pl-filters" style="gap:10px;flex-wrap:wrap">
      <select id="cpm-year">${years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <div class="seg"><button type="button" data-cpm-period="month" class="${period === 'month' ? 'on' : ''}">By month</button><button type="button" data-cpm-period="week" class="${period === 'week' ? 'on' : ''}">By week</button></div>
      <label class="row small"><input type="checkbox" id="cpm-flex" ${flex ? 'checked' : ''}> apply flex${d.flex?.overall ? ` <span class="muted">(overall ${cpmPct(d.flex.overall - 1, 1)})</span>` : ''}</label>
      <span class="small muted">Compare:</span>${all.map((s) => `<label class="row small"><input type="checkbox" data-cpm-cmp="${s.id}" ${scen.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}${s.mine ? '' : ` <span class="muted">(${esc(s.owner_name || 'shared')})</span>`}</label>`).join('') || '<span class="small muted">no scenarios yet — <a href="#/cpm/scenarios">make one</a></span>'}
    </div>
    <p class="small muted">Forecast ${d.forecast_as_of ? `as read in ${esc(d.forecast_as_of)}` : '— none read yet: link the BeNeLux and Amex forecasts in Reporting › Sources'} · ${d.shifts} shifts × ${d.hours} productive hours · speeds from Production: ${d.techs.map((t) => `${esc(t)} ${d.speeds[t] ? `${cpmN(d.speeds[t])}/h` : '<b class="pl-late">none</b>'}`).join(' · ')}${d.cards ? '' : ' · <span class="pl-warn">card database not linked: actuals by machine only</span>'}</p>
    ${d.warnings.length ? `<div class="kc-note">⚠ ${d.warnings.map(esc).join('<br>⚠ ')}</div>` : ''}
    ${d.forecast_as_of && !d.forecast_total ? `<div class="kc-note">⚠ The forecast read in ${esc(d.forecast_as_of)} has nothing for ${d.year} — check the files linked in Reporting › Sources.</div>` : ''}
    ${d.unmapped_count ? `<div class="kc-note">🔗 <b>${d.unmapped_count} forecast name${d.unmapped_count === 1 ? '' : 's'} not linked to a customer</b> (${cpmK(d.unmapped_qty)} cards this year): counted with the mix of everything persoed and the default OEE until linked — ${d.unmapped.slice(0, 5).map((u) => esc(u.name)).join(' · ')}${d.unmapped_count > 5 ? ' …' : ''}. <a href="#/cpm/customers">Link them, or import the CPM workbook's Config sheet →</a></div>` : ''}
    <div class="kdb-tiles pl-tiles">${tiles}</div>
    ${cpmFcTotals(d)}
    ${d.techs.map((t) => `<div class="card cpm-tech"><h3 class="pl-h">${CPM_TECH_ICON[t] || ''} ${esc(t)} <span class="muted small">— bars: capacity needed (forecast${flex ? ' × flex' : ''} ÷ OEE), green / amber from 85% / red over · inner bar: the forecast · line: capacity${d.scenarios.length ? ' (dashed: scenarios)' : ''} · dots: actual</span></h3>
      ${chart(t)}${table(t)}</div>`).join('')}`;
  $('#cpm-year').onchange = (e) => { store.set('cpmYear', Number(e.target.value)); renderCpm('overview'); };
  $$('[data-cpm-period]').forEach((b) => { b.onclick = () => { store.set('cpmPeriod', b.dataset.cpmPeriod); renderCpm('overview'); }; });
  $('#cpm-flex').onchange = (e) => { store.set('cpmFlex', e.target.checked); renderCpm('overview'); };
  $$('[data-cpm-cmp]').forEach((c) => { c.onchange = () => { const id = Number(c.dataset.cpmCmp); let l = (store.get('cpmCompare', []) || []).filter((x) => x !== id); if (c.checked) l = [...l, id].slice(-2); store.set('cpmCompare', l); renderCpm('overview'); }; });
}

// ---- 📈 Forecast vs actual: the flex -----------------------------------------------------------------
async function cpmFlex(body) {
  const d = await api.get('/cpm/flex');
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const cell = (r) => (r === null || r === undefined ? '<td class="num muted">—</td>' : `<td class="num cpm-flex ${r > 1.1 ? 'up' : r < 0.9 ? 'down' : ''}" title="actual ÷ forecast = ${cpmPct(r, 1)}">${r >= 1 ? '+' : ''}${cpmPct(r - 1)}</td>`);
  body.innerHTML = `
    <div class="card"><h3 class="pl-h">Earlier years <span class="muted small">— uploaded forecast and actual figures, to learn the flex from</span></h3>
      <div class="kdb-scroll"><table class="log small"><thead><tr><th>Year</th><th>Kind</th><th class="num">Months</th><th class="num">Customers</th><th class="num">Cards</th><th>File</th><th></th></tr></thead><tbody>
      ${d.history.map((h) => `<tr><td><b>${h.year}</b></td><td>${esc(h.kind)}</td><td class="num">${h.months}</td><td class="num">${h.customers}</td><td class="num">${cpmK(h.qty)}</td><td class="small">${esc(h.file || '')} <span class="muted">${esc(fmtDateTime(h.at))}</span></td>
        <td><button class="link small" data-cpm-hdel="${h.year}|${esc(h.kind)}">remove</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing uploaded yet.</td></tr>'}</tbody></table></div>
      <div class="row small" style="gap:8px;flex-wrap:wrap;margin-top:8px">
        <select id="cpm-hkind"><option value="">Forecast / actual: from the file</option><option value="forecast">All forecast</option><option value="actual">All actual</option></select>
        <input type="number" id="cpm-hyear" placeholder="Year: from the file" style="width:150px">
        <label class="button small">⬆ Upload Excel files…<input type="file" accept=".xlsx,.xlsm" multiple hidden id="cpm-hfile"></label>
        <span class="muted">A row of months (JAN … DEC) with customers down the side (Trigram or Customer); the year and FORECAST / ACTUAL above the months, as in the CPM workbook — or chosen here. A newer upload replaces the same year, months and kind.</span></div></div>
    <div class="card"><h3 class="pl-h">Flex — actual ÷ forecast, by month <span class="muted small">— from ${cpmN(d.pairs)} customer-months (uploaded years, and the months gone by since the forecasts have been read here) · used on 📊 Overview as the expected flex</span></h3>
      <div class="kdb-scroll"><table class="log small cpm-t"><thead><tr><th>Customer</th>${M.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Year</th><th>By year</th></tr></thead><tbody>
      <tr class="pl-load-total"><td><b>Everyone</b></td>${d.overall.months.map(cell).join('')}${cell(d.overall.year)}<td></td></tr>
      ${d.customers.map((c) => `<tr><td><b>${esc(c.trigram)}</b></td>${c.months.map(cell).join('')}${cell(c.year)}<td class="small">${c.years.map((y) => `${y.year}: ${y.ratio >= 1 ? '+' : ''}${cpmPct(y.ratio - 1)}`).join(' · ')}</td></tr>`).join('') || `<tr><td colspan="15" class="muted">No months with both a forecast and an actual yet.</td></tr>`}
      </tbody></table></div>
      <p class="small muted">+12% = 12% more done than forecast. The expected flex for a customer and month is its own average for that month over the years; without one, its yearly flex, then everyone's for the month. Kept within ×0.2 – ×3.</p></div>`;
  $('#cpm-hfile').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = ''; const kind = $('#cpm-hkind').value; const year = $('#cpm-hyear').value;
    for (const f of files) {
      const r = await fetch(`/api/cpm/history?kind=${kind}&year=${year}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': f.name } });
      const x = await r.json().catch(() => ({}));
      toast(r.ok ? `${f.name}: ${cpmN(x.rows)} figures, ${x.customers} customers, ${x.years.join(', ')}${x.unmapped?.length ? ` — ${x.unmapped.length} names not matched to a customer` : ''}` : x.error || r.statusText, r.ok ? '' : 'error');
    }
    renderCpm('flex');
  };
  $$('[data-cpm-hdel]').forEach((b) => { b.onclick = async () => { const [y, k] = b.dataset.cpmHdel.split('|'); if (!confirm(`Remove the uploaded ${k} for ${y}?`)) return; await api.del(`/cpm/history?year=${y}&kind=${encodeURIComponent(k)}`); renderCpm('flex'); }; });
}

// ---- 👥 Customers: split, OEE, forecast names --------------------------------------------------------
async function cpmCustomers(body) {
  const d = await api.get('/cpm/customers');
  const T = d.techs;
  const pctIn = (c, field, t, ph) => `<input type="number" min="0" max="100" step="1" class="cpm-in" data-cpm-c="${esc(c.trigram)}" data-f="${field}" data-t="${t}" value="${c[field]?.[t] ? Math.round(c[field][t] * 100) : ''}" placeholder="${ph}">`;
  const row = (c) => `<tr class="${c.active ? '' : 'muted'}"><td><b>${esc(c.trigram)}</b></td>
    <td><input type="text" class="cpm-in" data-cpm-c="${esc(c.trigram)}" data-f="name" value="${esc(c.name || '')}"></td>
    <td><input type="text" class="cpm-in" data-cpm-c="${esc(c.trigram)}" data-f="fc_names" value="${esc(c.fc_names.join(' | '))}" placeholder="Cust_Nm in the forecast" title="The customer's name(s) in the forecast exports, | between several"></td>
    ${T.map((t) => `<td>${pctIn(c, 'split', t, c.learned?.[t] ? `${Math.round(c.learned[t] * 100)}` : '')}</td>`).join('')}
    ${T.map((t) => `<td>${pctIn(c, 'oee', t, c.prod_oee ? `${Math.round(c.prod_oee * 100)}` : `${Math.round(d.oee_default * 100)}`)}</td>`).join('')}
    <td class="num">${cpmK(c.forecast_year)}</td>
    <td><label class="row small"><input type="checkbox" data-cpm-active="${esc(c.trigram)}" ${c.active ? 'checked' : ''}> counted</label></td></tr>`;
  body.innerHTML = `
    <div class="card"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:8px"><h3 class="pl-h" style="margin:0">Customers <span class="muted small">— forecast ${d.forecast_as_of ? `read ${esc(d.forecast_as_of)}` : 'not read yet'}</span></h3>
      <label class="button small" title="The CPM workbook's Config sheet: customers, their split and OEE per technology, and trigram">⬆ Import from the CPM workbook<input type="file" accept=".xlsx,.xlsm" hidden id="cpm-cfg"></label></div>
      <p class="small muted">Split and OEE in %. Left blank, the split is <b>learned from what was persoed</b> over the last year (each card's type from the card database — shown greyed) — or, for Amex, its forecast's own technology rows; the OEE is Production's for the customer (⚙ Setup › OEE), else ${Math.round(d.oee_default * 100)}%.</p>
      <div class="kdb-scroll"><table class="log small cpm-cust"><thead><tr><th rowspan="2">Trigram</th><th rowspan="2">Name</th><th rowspan="2">Forecast names</th><th colspan="${T.length}">Split %</th><th colspan="${T.length}">OEE %</th><th rowspan="2" class="num">Forecast this year</th><th rowspan="2"></th></tr>
        <tr>${T.map((t) => `<th>${esc(t)}</th>`).join('')}${T.map((t) => `<th>${esc(t)}</th>`).join('')}</tr></thead>
        <tbody>${d.customers.map(row).join('') || `<tr><td colspan="${5 + T.length * 2}" class="muted">None yet — import the CPM workbook's Config sheet, or add them below.</td></tr>`}</tbody></table></div></div>
    ${d.unmapped.length ? `<div class="card"><h3 class="pl-h">Forecast names not linked to a customer <span class="muted small">— counted with the mix of everything persoed until linked; type the trigram (a new one is set up)</span></h3>
      <datalist id="cpm-tris">${[...d.customers.map((c) => [c.trigram, c.name]), ...d.not_set_up.map((c) => [c.trigram, ''])].map(([t, n]) => `<option value="${esc(t)}">${esc(n || '')}</option>`).join('')}</datalist>
      <table class="log small"><tbody>${d.unmapped.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td class="num">${cpmK(u.qty)}</td><td><input type="text" list="cpm-tris" data-cpm-map="${esc(u.name)}" placeholder="Trigram" style="width:110px"> <button class="small" data-cpm-link="${esc(u.name)}">Link</button></td></tr>`).join('')}</tbody></table></div>` : ''}
    ${d.not_set_up.length ? `<div class="card"><h3 class="pl-h">Persoed or forecast, not set up <span class="muted small">— add them to count them</span></h3>
      <div class="row" style="gap:6px;flex-wrap:wrap">${d.not_set_up.map((c) => `<button class="small" data-cpm-add="${esc(c.trigram)}">+ ${esc(c.trigram)}${c.learned ? ` <span class="muted">${Object.entries(c.learned).map(([t, s]) => `${t} ${Math.round(s * 100)}%`).join(' ')}</span>` : ''}</button>`).join('')}</div></div>` : ''}
    <div class="row small" style="gap:6px"><input type="text" id="cpm-new-tri" placeholder="Trigram (e.g. KBC)" style="width:160px"><button class="small" id="cpm-new">+ Add a customer</button></div>`;
  const save = async (tri, patch) => { try { await api.put(`/cpm/customers/${encodeURIComponent(tri)}`, patch); toast('Saved'); } catch (err) { toast(err.message, 'error'); } };
  $$('.cpm-in').forEach((el) => { el.onchange = async () => {
    const tri = el.dataset.cpmC; const f = el.dataset.f;
    if (f === 'split' || f === 'oee') { const o = {}; $$(`.cpm-in[data-cpm-c="${CSS.escape(tri)}"][data-f="${f}"]`).forEach((x) => { if (x.value !== '') o[x.dataset.t] = Number(x.value) / 100; }); await save(tri, { [f]: o }); }
    else await save(tri, { [f]: f === 'fc_names' ? el.value.split('|') : el.value });
  }; });
  $$('[data-cpm-active]').forEach((el) => { el.onchange = async () => { await save(el.dataset.cpmActive, { active: el.checked }); renderCpm('customers'); }; });
  const link = async (name) => {
    const el = $$('[data-cpm-map]').find((x) => x.dataset.cpmMap === name); const tri = el.value.trim().toUpperCase(); if (!tri) return el.focus();
    const c = d.customers.find((x) => x.trigram === tri);
    await save(tri, c ? { fc_names: [...c.fc_names, name] } : { name, fc_names: [name] }); renderCpm('customers');
  };
  $$('[data-cpm-link]').forEach((b) => { b.onclick = () => link(b.dataset.cpmLink); });
  $$('[data-cpm-map]').forEach((el) => { el.onkeydown = (e) => { if (e.key === 'Enter') link(el.dataset.cpmMap); }; });
  $$('[data-cpm-add]').forEach((b) => { b.onclick = async () => { await save(b.dataset.cpmAdd, {}); renderCpm('customers'); }; });
  $('#cpm-new').onclick = async () => { const t = $('#cpm-new-tri').value.trim(); if (t) { await save(t, {}); renderCpm('customers'); } };
  $('#cpm-cfg').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    const r = await fetch('/api/cpm/customers/import', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
    const x = await r.json().catch(() => ({})); toast(r.ok ? `${x.customers} customers from ${x.sheet}` : x.error || r.statusText, r.ok ? '' : 'error'); renderCpm('customers');
  };
}

// ---- ⚙ Capacity: shifts, productive hours, holidays, machines --------------------------------------
async function cpmCapacity(body) {
  const d = await api.get(`/cpm/overview?year=${new Date().getFullYear()}&period=month&flex=0`);
  const st = d.settings; const opts = (() => { try { return JSON.parse(st.cpm_machines || '{}'); } catch { return {}; } })();
  body.innerHTML = `<div class="card"><h3 class="pl-h">Working time</h3><div class="form-grid">
      <label class="f">Shifts a day<input type="number" min="0" max="4" step="1" data-cpm-set="cpm_shifts" value="${esc(st.cpm_shifts)}"></label>
      <label class="f" title="Breaks, change-overs and other non-productive time taken out">Productive hours a shift (breaks etc. out)<input type="number" min="0" max="12" step="0.25" data-cpm-set="cpm_hours" value="${esc(st.cpm_hours)}"></label>
      <label class="f">OEE when a customer has none<input type="number" min="1" max="100" step="1" data-cpm-set="cpm_oee_default" data-pct value="${Math.round(Number(st.cpm_oee_default) * 100)}"></label>
      <label class="f full">Holidays — no production (YYYY-MM-DD, one a line)<textarea rows="3" data-cpm-set="cpm_holidays" placeholder="2026-01-01&#10;2026-04-06">${esc(String(st.cpm_holidays || '').split(/[\s,;]+/).filter(Boolean).join('\n'))}</textarea></label>
      <div class="f full small muted">Working days are Production's (⚙ Setup). Capacity = speed × working days × shifts × productive hours × availability.</div></div></div>
    <div class="card"><h3 class="pl-h">Machines <span class="muted small">— Production's machines and speeds (⚙ Setup); here only what's particular to capacity planning</span></h3>
      <div class="kdb-scroll"><table class="log small"><thead><tr><th>Machine</th><th>Runs</th><th>Available for perso %</th>${d.techs.map((t) => `<th>${esc(t)} speed /h</th>`).join('')}</tr></thead><tbody>
      ${d.machines.filter((m) => !m.added).map((m) => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.techs.join(', '))}</td>
        <td><input type="number" min="0" max="100" step="1" data-cpm-m="${esc(m.name)}" data-f="avail" value="${opts[m.name]?.avail !== undefined ? Math.round(opts[m.name].avail * 100) : ''}" placeholder="100"></td>
        ${d.techs.map((t) => `<td>${m.techs.includes(t) ? `<input type="number" min="0" step="10" data-cpm-m="${esc(m.name)}" data-f="speed" data-t="${t}" value="${opts[m.name]?.speed?.[t] ?? ''}" placeholder="${d.speeds[t] || '—'}">` : ''}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="6" class="muted">No machines — add them in Production › ⚙ Setup.</td></tr>'}
      </tbody></table></div>
      <p class="small muted">A machine that runs several technologies gives its hours to whichever is short each month; what neither needs is shared. Blank speed: Production's for the technology.</p></div>`;
  $$('[data-cpm-set]').forEach((el) => { el.onchange = async () => {
    const v = el.hasAttribute('data-pct') ? String(Number(el.value) / 100) : el.tagName === 'TEXTAREA' ? el.value.split(/\s+/).filter(Boolean).join(',') : el.value;
    try { await api.put('/cpm/settings', { [el.dataset.cpmSet]: v }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
  }; });
  $$('[data-cpm-m]').forEach((el) => { el.onchange = async () => {
    const o = { ...opts }; const m = el.dataset.cpmM; o[m] = { ...(o[m] || {}) };
    if (el.dataset.f === 'avail') { if (el.value === '') delete o[m].avail; else o[m].avail = Number(el.value) / 100; } else { o[m].speed = { ...(o[m].speed || {}) }; if (el.value === '') delete o[m].speed[el.dataset.t]; else o[m].speed[el.dataset.t] = Number(el.value); }
    Object.assign(opts, o);
    try { await api.put('/cpm/settings', { cpm_machines: JSON.stringify(o) }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
  }; });
}

// ---- 🧪 Scenarios: changes over the base, each person's own -----------------------------------------
const CPM_CHANGES = {
  speed: { label: '⚡ Speed change', fields: ['machine', 'tech', 'pct'] },
  add_machine: { label: '➕ Add a machine', fields: ['name', 'techs'] },
  remove_machine: { label: '➖ Remove a machine / downtime', fields: ['machine'] },
  capabilities: { label: '🔁 Change what a machine runs', fields: ['machine', 'techs'] },
  shifts: { label: '🕐 Shifts and hours', fields: ['shifts', 'hours'] },
  oee: { label: '🎯 OEE change', fields: ['customer', 'tech', 'points'] },
  volume: { label: '📦 Customer volume', fields: ['customer', 'pct'] },
  new_customer: { label: '🆕 New customer', fields: ['name', 'qty', 'split', 'oee'] },
};
async function cpmScenarios(body) {
  const [list, ov, cs] = await Promise.all([api.get('/cpm/scenarios'), api.get(`/cpm/overview?year=${new Date().getFullYear()}&period=month&flex=0`), api.get('/cpm/customers')]);
  const openId = Number(store.get('cpmScenario', 0)) || null; const sc = list.find((s) => s.id === openId) || null;
  const machines = ov.machines.filter((m) => !m.added).map((m) => m.name); const T = ov.techs; const custs = cs.customers.map((c) => c.trigram);
  const sel = (name, val, opts, all = 'all') => `<select name="${name}"><option value="">${all}</option>${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const field = (c, f) => {
    if (f === 'machine') return `<label class="f">Machine${sel('machine', c.machine, machines, c.type === 'speed' ? 'all machines' : '— choose —')}</label>`;
    if (f === 'tech') return `<label class="f">Technology${sel('tech', c.tech, T, 'all')}</label>`;
    if (f === 'customer') return `<label class="f">Customer${sel('customer', c.customer, custs, 'all customers')}</label>`;
    if (f === 'techs') return `<div class="f"><span>Runs</span><div class="row">${T.map((t) => `<label class="row small"><input type="checkbox" name="techs" value="${t}" ${(c.techs || []).includes(t) ? 'checked' : ''}> ${t}</label>`).join(' ')}</div></div>`;
    if (f === 'split') return `<div class="f"><span>Split %</span><div class="row">${T.map((t) => `<label class="row small">${t} <input type="number" name="split_${t}" min="0" max="100" style="width:70px" value="${c.split?.[t] ? Math.round(c.split[t] * 100) : ''}"></label>`).join(' ')}</div></div>`;
    const L = { pct: ['Change %', '+10 or −15'], points: ['OEE change (points)', '+5'], shifts: ['Shifts a day', ''], hours: ['Productive hours a shift', ''], name: ['Name', ''], qty: ['Cards a month', ''], oee: ['OEE %', '35'] }[f];
    return `<label class="f">${L[0]}<input type="${f === 'name' ? 'text' : 'number'}" name="${f}" value="${esc(c[f] ?? (f === 'oee' && c.oee ? Math.round(c.oee * 100) : ''))}" placeholder="${L[1]}"></label>`;
  };
  const changeHtml = (c, i) => `<div class="card cpm-change" data-i="${i}"><div class="row" style="justify-content:space-between"><b>${CPM_CHANGES[c.type].label}</b><button class="link small" data-cpm-rm="${i}">✕ remove</button></div>
      <div class="form-grid">${CPM_CHANGES[c.type].fields.map((f) => field(c, f)).join('')}
        <label class="f">From month<input type="month" name="from" value="${esc(c.from || '')}"></label><label class="f" title="Leave blank to keep the change from then on">Until (blank: from then on)<input type="month" name="to" value="${esc(c.to || '')}"></label></div></div>`;
  body.innerHTML = `<div class="cpm-scen"><div class="card cpm-scen-list"><h3 class="pl-h">Scenarios</h3>
      ${list.map((s) => `<div class="cpm-scen-item ${s.id === openId ? 'on' : ''}" data-cpm-open="${s.id}"><b>${esc(s.name)}</b><div class="small muted">${s.changes.length} change${s.changes.length === 1 ? '' : 's'} · ${s.mine ? (s.shared ? 'yours, shared' : 'yours') : `${esc(s.owner_name || 'someone')}'s`}</div></div>`).join('') || '<p class="small muted">None yet.</p>'}
      <div class="row" style="gap:6px;margin-top:8px"><input type="text" id="cpm-sc-name" placeholder="Name, e.g. MX1 to DOD"><button class="small primary" id="cpm-sc-new">+ New</button></div>
      <p class="small muted">Your scenarios are yours; tick “share” to let the rest of Prod Management see one (they can copy it, not change it).</p></div>
    <div class="cpm-scen-edit">${sc ? `<div class="card"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="cpm-sc-title" value="${esc(sc.name)}" ${sc.mine ? '' : 'disabled'} style="font-weight:700;flex:1;min-width:220px">
        ${sc.mine ? `<label class="row small"><input type="checkbox" id="cpm-sc-share" ${sc.shared ? 'checked' : ''}> share with Prod Management</label>` : `<span class="small muted">${esc(sc.owner_name || 'Someone')}'s — read only</span>`}
        <button class="small" id="cpm-sc-compare">📊 Compare on Overview</button><button class="small" id="cpm-sc-copy">⧉ Copy</button>${sc.mine ? '<button class="small" id="cpm-sc-del">🗑</button>' : ''}</div>
        <textarea id="cpm-sc-notes" rows="2" placeholder="Notes — what it's for" ${sc.mine ? '' : 'disabled'} style="margin-top:6px">${esc(sc.notes || '')}</textarea></div>
      <div id="cpm-changes">${sc.changes.map(changeHtml).join('') || '<p class="muted">No changes yet — add one below.</p>'}</div>
      ${sc.mine ? `<div class="row" style="gap:6px;flex-wrap:wrap"><select id="cpm-add-type">${Object.entries(CPM_CHANGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select><button class="small" id="cpm-add-change">+ Add change</button><div class="spacer"></div><button class="primary" id="cpm-sc-save">💾 Save</button></div>` : ''}`
      : '<div class="card lib-empty"><p>Pick a scenario on the left, or make a new one.</p><p class="small muted">A scenario is a list of changes laid over the base plan — machines added, removed or changed, speeds, shifts, OEE, customer volumes — each from a month (and until one). The base forecast keeps updating underneath.</p></div>'}</div></div>`;
  const read = () => $$('.cpm-change').map((el) => {
    const c = { type: sc.changes[Number(el.dataset.i)].type };
    for (const inp of el.querySelectorAll('[name]')) {
      if (inp.name === 'techs') { if (inp.checked) (c.techs = c.techs || []).push(inp.value); continue; }
      if (inp.name.startsWith('split_')) { if (inp.value) (c.split = c.split || {})[inp.name.slice(6)] = Number(inp.value) / 100; continue; }
      if (inp.value === '') continue;
      c[inp.name] = inp.type === 'number' ? (inp.name === 'oee' ? Number(inp.value) / 100 : Number(inp.value)) : inp.value;
    }
    if (CPM_CHANGES[c.type].fields.includes('techs') && !c.techs) c.techs = [];
    return c;
  });
  $$('[data-cpm-open]').forEach((el) => { el.onclick = () => { store.set('cpmScenario', Number(el.dataset.cpmOpen)); renderCpm('scenarios'); }; });
  $('#cpm-sc-new').onclick = async () => { const name = $('#cpm-sc-name').value.trim() || 'New scenario'; const s = await api.post('/cpm/scenarios', { name, changes: [] }); store.set('cpmScenario', s.id); renderCpm('scenarios'); };
  if (!sc) return;
  $('#cpm-sc-compare').onclick = () => { store.set('cpmCompare', [sc.id]); location.hash = '#/cpm/overview'; };
  $('#cpm-sc-copy').onclick = async () => { const s = await api.post('/cpm/scenarios', { name: `${sc.name} (copy)`, notes: sc.notes, changes: sc.mine ? read() : sc.changes }); store.set('cpmScenario', s.id); toast('Copied — it\'s yours to change'); renderCpm('scenarios'); };
  if (!sc.mine) return;
  $('#cpm-sc-del').onclick = async () => { if (!confirm(`Delete “${sc.name}”?`)) return; await api.del(`/cpm/scenarios/${sc.id}`); store.set('cpmScenario', 0); renderCpm('scenarios'); };
  $('#cpm-add-change').onclick = () => { sc.changes = [...read(), { type: $('#cpm-add-type').value }]; $('#cpm-changes').innerHTML = sc.changes.map(changeHtml).join(''); wireRm(); };
  const wireRm = () => $$('[data-cpm-rm]').forEach((b) => { b.onclick = () => { const l = read(); l.splice(Number(b.dataset.cpmRm), 1); sc.changes = l; $('#cpm-changes').innerHTML = l.map(changeHtml).join('') || '<p class="muted">No changes yet — add one below.</p>'; wireRm(); }; });
  wireRm();
  $('#cpm-sc-save').onclick = async () => {
    try { await api.put(`/cpm/scenarios/${sc.id}`, { name: $('#cpm-sc-title').value, notes: $('#cpm-sc-notes').value, shared: $('#cpm-sc-share').checked, changes: read() }); toast('Scenario saved'); renderCpm('scenarios'); } catch (err) { toast(err.message, 'error'); }
  };
}

// The forecast's total per month, as Reporting's Database adds it up (BeNeLux + Amex), against what the
// technology charts count — so the two can be checked against each other
function cpmFcTotals(d) {
  const src = d.forecast_sources || {}; if (!Object.keys(src).length) return '';
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const bn = src.benelux || Array(12).fill(0); const ax = src.amex || Array(12).fill(0);
  const tot = bn.map((q, i) => q + ax[i]);
  const counted = M.map((_, i) => d.forecast_counted?.[`${d.year}-${String(i + 1).padStart(2, '0')}`] || 0);
  const sit = bn.map((q) => q + ax[0]); // SITHUB looks every month's Amex up against January
  const sum = (a) => a.reduce((t, x) => t + x, 0);
  const tr = (label, a, cls = '', title = '') => `<tr class="${cls}"><th title="${esc(title)}">${label}</th>${a.map((x) => `<td class="num">${cpmN(Math.round(x))}</td>`).join('')}<td class="num"><b>${cpmN(Math.round(sum(a)))}</b></td></tr>`;
  const off = counted.map((x, i) => x - tot[i]);
  return `<div class="card"><h3 class="pl-h">Forecast ${d.year} <span class="muted small">— the files linked in Reporting › Sources, by SITHUB's rules (BeNeLux: Benelux + “basic” lines; Amex: TOTAL BAU)</span></h3>
    <div class="kdb-scroll"><table class="log small cpm-tbl"><thead><tr><th></th>${M.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Year</th></tr></thead><tbody>
      ${tr('BeNeLux', bn)}${tr('Amex', ax)}${tr('<b>Total</b>', tot)}
      ${tr('Counted in the charts', counted, '', 'The forecast split over DOD / Emboss / Laser below — less than the total when a customer has no split to go by (see the notes above)')}
      ${off.some((x) => Math.abs(x) >= 1) ? tr('Not counted', off.map((x) => -x), 'pl-late') : ''}
      ${ax[0] && ax.some((x) => x !== ax[0]) ? tr('SITHUB Database', sit, 'muted', 'SITHUB\'s Database row adds January\'s Amex figure to every month (its lookup is fixed to 01/01/2026) — the total above takes each month\'s own') : ''}
    </tbody></table></div>
    ${ax[0] && ax.some((x) => x !== ax[0]) ? '<p class="small muted">SITHUB\'s Database adds January\'s Amex to every month (its lookup is fixed on 01/01/2026); the total here takes each month\'s own Amex figure, so February on differs by that.</p>' : ''}</div>`;
}
