// CPM — capacity planning (Prod Management): the forecasts against the machines' capacity per
// technology by month or week, the forecasts against what was done (flex), the customers' split and
// OEE, the capacity settings, and each person's scenarios (src/cpm.js does the sums).
const CPM_TABS = [['overview', 'CPM Monthly'], ['day', 'CPM Daily'], ['site', 'Site Capacity'], ['headcount', 'Headcount'], ['flex', 'Flex'], ['config', 'Configuration']];
// Configuration holds the set-up, each its own sub-tab (their addresses, #/cpm/customers…, still open them)
const CPM_CONFIG = [['customers', 'Customers'], ['capacity', 'Capacity'], ['scenarios', 'Scenarios'], ['dayset', 'CPM Daily'], ['check', 'Forecast check']];
const cpmN = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: d }));
// each machine's colour, the same on every chart (by its place among the machines)
const CPM_MACH_COL = ['#e4572e', '#f3a712', '#3fa34d', '#2e86ab', '#9b5de5', '#f15bb5', '#00a6a6', '#8d6a9f', '#c0843b', '#5c8001'];
const cpmMachCol = (name, names) => CPM_MACH_COL[Math.max(0, names.indexOf(name)) % CPM_MACH_COL.length];
// each machine's part of a technology's capacity, stacked: a band per machine between the line of the ones
// before it and its own; parts: [{ name, per: [period] }] in the machines' order; xs(i) the x of a period,
// y the scale; step: drawn as steps (hours) or through the points (months, weeks)
function cpmMachStack(parts, names, xs, y, { step = false, slot = 0, labelAt = null } = {}) {
  const n = parts[0]?.per.length || 0; let below = Array(n).fill(0); let out = '';
  for (const m of parts) {
    if (!m.per.some((v) => v > 0.5)) continue;
    const top = below.map((b, i) => b + (m.per[i] || 0)); const col = cpmMachCol(m.name, names);
    const pts = (a) => (step ? a.flatMap((v, i) => [[xs(i) - slot / 2, v], [xs(i) + slot / 2, v]]) : a.map((v, i) => [xs(i), v]));
    const up = pts(top); const down = pts(below).reverse();
    out += `<g><title>${esc(m.name)}</title><polygon points="${[...up, ...down].map(([a, v]) => `${a},${y(v)}`).join(' ')}" style="fill:${col}" class="cpm-mband"/>
      <polyline points="${up.map(([a, v]) => `${a},${y(v)}`).join(' ')}" fill="none" style="stroke:${col}" class="cpm-mline"/>
      ${up.map(([a, v], k) => (k % (step ? 2 : 1) === 0 ? `<rect x="${a - 3}" y="${y(v) - 3}" width="${step ? slot : 6}" height="6" fill="transparent"><title>${esc(`${m.name}: ${cpmN(m.per[step ? k / 2 : k])}`)}</title></rect>` : '')).join('')}`;
    const li = labelAt ?? n - 1; const mid = (below[li] + top[li]) / 2;
    if (y(below[li]) - y(top[li]) > 11) out += `<text x="${xs(li) + (step ? slot / 2 : 0) - 4}" y="${y(mid) + 4}" text-anchor="end" class="cpm-mlabel" style="fill:${col}">${esc(m.name)}</text>`;
    out += '</g>'; below = top;
  }
  return out;
}
const cpmMachLegend = (parts, names) => parts.filter((m) => m.per.some((v) => v > 0.5)).map((m) => `<span><i class="sw" style="background:${cpmMachCol(m.name, names)}"></i>${esc(m.name)}</span>`).join('');
// a volume axis in even steps: 0.1M for small figures, else 0.25M, else 0.5M (1M past 6M)
function cpmScale(top) {
  // below 0.6M (an hour, a small technology) round steps of 1 / 2 / 2.5 / 5 × 10ⁿ, about six of them
  const small = () => { const raw = top / 6; const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1))); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw) || 10 * p; };
  const step = top <= 600000 ? Math.max(small(), top <= 1 ? 1 : 0) || 100000 : top <= 2500000 ? 250000 : top <= 6000000 ? 500000 : 1000000;
  const max = Math.max(step, Math.ceil(top / step) * step);
  return { max, ticks: Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step) };
}
const cpmAxis = (v) => (v === 0 ? '0' : v < 100000 ? `${(v / 1000).toLocaleString('en-GB', { maximumFractionDigits: 1 })}k` : `${(v / 1e6).toLocaleString('en-GB', { minimumFractionDigits: v % 500000 ? 2 : 1, maximumFractionDigits: 2 })}M`);
const cpmK = (v) => (v === null || v === undefined ? '—' : Math.abs(v) >= 1e6 ? `${(v / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 2 })}M` : Math.abs(v) >= 1e3 ? `${Math.round(v / 1e3).toLocaleString('en-GB')}k` : cpmN(v));
const cpmPct = (v, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: d })}%`);
const cpmUtilCls = (u) => (u === null || u === undefined ? '' : u > 1 ? 'bad' : u > 0.85 ? 'warn' : 'ok');
const CPM_TECH_ICON = { DOD: '', Emboss: '', Laser: '' }; // (names without emoji; kept so the places that use it stay simple)
// each technology's colour, as the CPM workbook colours its rows (DOD teal, Laser purple, Emboss dark)
const cpmTc = (t) => (t === 'Matching' ? '#2563EB' : `var(--tech-${String(t).toLowerCase()}, var(--accent))`); // Matching: CPM_MATCH_COL

// 📐 the report tabs keep what was last generated (on the server) until ⟳ Regenerate, as the weekly report does;
// the editing tabs (Customers, Capacity, Scenarios) are always live. A change saved on a report tab (its own settings)
// regenerates that tab when it's drawn again; anywhere else, the kept views show they're out of date.
const CPM_KEPT = ['overview', 'site', 'headcount', 'day', 'flex'];
let cpmRegenNext = false; // the tab being drawn is to be generated again
let cpmRegenTab = null; // a change was saved on this tab: generate it again when it's next drawn
async function cpmGet(u) {
  const d = await api.get(cpmRegenNext ? `${u}${u.includes('?') ? '&' : '?'}regen=1` : u);
  if (d?.generated) cpmShowGen(d.generated);
  return d;
}
function cpmShowGen(g) {
  const el = $('#cpm-gen'); if (!el || !g) return;
  const when = new Date(g.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `${g.stale ? '<span class="pl-warn" title="A setting, customer, scenario or forecast it\'s worked out from has changed since: ⟳ Regenerate to bring it up to date">⚠ Out of date</span> · ' : ''}<span class="muted">Generated ${esc(when)}</span>`;
  $('#cpm-regen')?.classList.toggle('primary', !!g.stale);
}
// a change saved from Capacity planning: its tab is generated again when it's next drawn
function cpmHookWrites() { // (installed when Capacity planning first opens: app.js, which makes api, loads after this file)
  if (api.__cpmHooked) return;
  api.__cpmHooked = true;
  for (const m of ['put', 'post', 'patch', 'del']) {
    const f = api[m]; if (typeof f !== 'function') continue;
    api[m] = async (u, ...rest) => { const out = await f.call(api, u, ...rest); if (/^\/cpm\//.test(String(u))) cpmRegenTab = store.get('cpmTab', 'overview'); return out; };
  }
}

async function renderCpm(tab) {
  cpmHookWrites();
  const isCfg = (k) => CPM_CONFIG.some(([c]) => c === k);
  if (tab === 'config') tab = store.get('cpmConfigTab', 'customers');
  if (tab === 'match') { store.set('cpmLine', 'match'); tab = 'customers'; } // (the old Configuration › Matching: its parts are on Customers, Capacity and CPM Daily, with Matching picked)
  tab = CPM_TABS.some(([k]) => k === tab) || isCfg(tab) ? tab : store.get('cpmTab', 'overview');
  if (!CPM_TABS.some(([k]) => k === tab) && !isCfg(tab)) tab = 'overview';
  store.set('cpmTab', tab); if (isCfg(tab)) store.set('cpmConfigTab', tab);
  const top = isCfg(tab) ? 'config' : tab;
  if (cpmRegenTab === tab) cpmRegenNext = true; cpmRegenTab = null;
  const kept = CPM_KEPT.includes(tab);
  const head = `<div class="kanban-tools"><h1 style="margin:0">Capacity planning</h1>
      <div class="pl-halves cpm-tabs">${CPM_TABS.map(([k, l]) => `<div class="pl-half ${k === top ? 'on' : ''}"><a href="#/cpm/${k}" class="button">${l}</a></div>`).join('')}</div>
      <div class="spacer"></div>${kept ? `<span class="small cpm-gen" id="cpm-gen">${cpmRegenNext ? '<span class="muted">Generating…</span>' : ''}</span><button type="button" class="small" id="cpm-regen" title="Work this tab out again from the forecast, the production data and the settings as they are now (it's kept as it was last generated until then)">⟳ Regenerate</button>` : ''}<span class="cpm-foldall"><button type="button" class="icon" data-fold-all="1" title="Fold every section">⊟</button><button type="button" class="icon" data-fold-all="0" title="Open every section">⊞</button></span></div>`;
  const sub = top === 'config' ? `<div class="seg cpm-subtabs" role="tablist" aria-label="Configuration">${CPM_CONFIG.map(([k, l]) => `<a href="#/cpm/${k}" class="button ${k === tab ? 'on' : ''}" role="tab" aria-selected="${k === tab}">${l}</a>`).join('')}</div><span class="cpm-cfg-line" title="Whose settings: perso's or Matching's — as the switch on CPM Monthly and CPM Daily">${cpmLineSeg()}</span>` : '';
  main().innerHTML = `${head}${sub}<div id="cpm-body"><p class="muted">Loading…</p></div>`;
  const body = $('#cpm-body'); cpmFoldable(body, tab);
  $('.cpm-cfg-line')?.addEventListener('click', (e) => { const b = e.target.closest('[data-cpm-line]'); if (!b || b.dataset.cpmLine === cpmLine()) return; store.set('cpmLine', b.dataset.cpmLine); renderCpm(tab); });
  const mCfg = top === 'config' && cpmLine() === 'match' && ['customers', 'capacity', 'dayset'].includes(tab);
  body.addEventListener('click', (e) => { const b = e.target.closest('[data-cpm-line]'); if (!b || b.dataset.cpmLine === cpmLine()) return; store.set('cpmLine', b.dataset.cpmLine); renderCpm(tab); });
  const rg = $('#cpm-regen'); if (rg) rg.onclick = () => { cpmRegenNext = true; rg.disabled = true; rg.textContent = '⏳ Generating…'; renderCpm(tab); };
  try {
    if (tab === 'overview') await cpmOverview(body);
    else if (tab === 'site') await cpmSite(body);
    else if (tab === 'headcount') await cpmHeadcount(body);
    else if (tab === 'day') await cpmDay(body);
    else if (mCfg) await cpmMatchConfig(body, tab);
    else if (tab === 'dayset') await cpmDay(body, true);
    else if (tab === 'check') await cpmCheck(body);
    else if (tab === 'flex') await cpmFlex(body);
    else if (tab === 'customers') await cpmCustomers(body);
    else if (tab === 'capacity') await cpmCapacity(body);
    else await cpmScenarios(body);
  } catch (err) { body.innerHTML = `<div class="card"><h3>Something went wrong</h3><p class="pre">${esc(err.message)}</p></div>`; }
  cpmRegenNext = false;
}

// every section (a card with a heading) folds away from its heading, and stays folded (per tab, per section)
// until opened again; sections drawn later (a part of the page redrawn) pick it up as they appear
function cpmFoldable(body, tab) {
  const folded = () => store.get('cpmFold', {}) || {};
  const keyOf = (card, h) => { if (card.dataset.techCard) return `${tab}:tech:${card.dataset.techCard}`; const c = h.cloneNode(true); c.querySelectorAll('.muted, .small, .cpm-fold-btn').forEach((x) => x.remove()); return `${tab}:${c.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)}`; };
  const set = (card, on) => { card.classList.toggle('cpm-folded', on); const o = folded(); if (on) o[card.dataset.foldKey] = 1; else delete o[card.dataset.foldKey]; store.set('cpmFold', o); };
  const prep = () => {
    for (const card of body.querySelectorAll('.card:not([data-fold-key])')) {
      const head = card.firstElementChild; const h = head && (head.matches('h3') ? head : head.querySelector('h3')); if (!h || head === card.lastElementChild) continue;
      card.dataset.foldKey = keyOf(card, h); h.classList.add('cpm-fold-h');
      h.insertAdjacentHTML('afterbegin', '<button type="button" class="cpm-fold-btn" title="Fold or open this section">▾</button>');
      if (folded()[card.dataset.foldKey]) card.classList.add('cpm-folded');
      h.addEventListener('click', (e) => { if (e.target.closest('input, select, a, label, details.hint, button:not(.cpm-fold-btn)')) return; set(card, !card.classList.contains('cpm-folded')); });
    }
  };
  new MutationObserver(prep).observe(body, { childList: true, subtree: true }); prep();
  for (const b of document.querySelectorAll('[data-fold-all]')) b.onclick = () => { for (const card of body.querySelectorAll('.card[data-fold-key]')) set(card, b.dataset.foldAll === '1'); };
}

// ---- Overview: demand against capacity, per technology --------------------------------------------
let cpmReread = false; // the next Overview reads the forecast files again
async function cpmOverview(body) {
  if (cpmLine() === 'match') return cpmMatchMonthly(body);
  const year = Number(store.get('cpmYear', new Date().getFullYear()));
  const period = store.get('cpmPeriod', 'month');
  const flex = store.get('cpmFlex', true);
  const scen = (store.get('cpmCompare', []) || []).slice(0, 2);
  const [d, all] = await Promise.all([cpmGet(`/cpm/overview?year=${year}&period=${period}&flex=${flex ? 1 : 0}&scenarios=${scen.join(',')}${cpmReread ? '&reread=1' : ''}`), api.get('/cpm/scenarios')]);
  const now = new Date().toISOString().slice(0, 10);
  const SC_COL = ['#7a5cff', '#e0861a'];
  const labels = period === 'month'; // data labels on the monthly charts; by week, hover for the figures
  const chart = (t) => {
    const P = d.periods; const W = Math.max(640, P.length * (period === 'week' ? 18 : 78)); const H = labels ? 270 : 230; const L = 50; const B = 26; const T = 18;
    const top = Math.max(1, ...P.map((p) => Math.max(p.techs[t].need, p.techs[t].capacity)), ...d.scenarios.flatMap((s) => s.periods.map((p) => Math.max(p.techs[t].capacity, p.techs[t].need))));
    const { max, ticks } = cpmScale(top * (labels ? 1.08 : 1));
    const slot = (W - L - 6) / P.length; const x = (i) => L + (i + 0.5) * slot; const bw = Math.max(4, slot * 0.62); const y = (v) => T + (H - T - B) * (1 - v / max);
    const line = (pts, col, dash = '') => `<polyline fill="none" stroke="${col}" stroke-width="2.2" ${dash ? `stroke-dasharray="${dash}"` : ''} points="${pts.map(([i, v]) => `${x(i)},${y(v)}`).join(' ')}"/>`;
    const lbl = (cx, cy, text, cls = '') => (labels ? `<text x="${cx}" y="${cy}" text-anchor="middle" class="cpm-lbl ${cls}">${esc(text)}</text>` : '');
    return `<svg class="cpm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
      ${P.map((p, i) => { const k = p.techs[t]; const u = k.util; return `<g><title>${esc(`${p.label}: needed ${cpmN(k.need)} (forecast ${cpmN(k.fc)}${flex ? `, flexed ${cpmN(k.demand)}` : ''}) · capacity ${cpmN(k.capacity)} · ${u === null ? '' : cpmPct(u)}`)}</title>
        <rect x="${x(i) - bw / 2}" y="${y(k.need)}" width="${bw}" height="${Math.max(0, y(0) - y(k.need))}" class="cpm-bar ${cpmUtilCls(u)}"/>
        <rect x="${x(i) - bw / 4}" y="${y(k.fc)}" width="${bw / 2}" height="${Math.max(0, y(0) - y(k.fc))}" class="cpm-bar-fc"/>
        ${k.need ? (y(0) - y(k.need) > 34 && !(k.capacity < k.need && y(k.capacity) - y(k.need) < 30) ? lbl(x(i), y(k.need) + 13, cpmK(k.need), 'need-in') : lbl(x(i), y(k.need) - 4, cpmK(k.need), 'need')) : ''}${k.fc && y(0) - y(k.fc) > 14 ? lbl(x(i), y(k.fc) + 11, cpmK(k.fc), 'in') : ''}</g>`; }).join('')}
      ${machOn ? cpmMachStack(mParts(t), mNames, x, y) : ''}
      ${line(P.map((p, i) => [i, p.techs[t].capacity]), 'var(--text)')}
      ${P.map((p, i) => { const c = p.techs[t].capacity; const n = p.techs[t].need; const near = c < n && y(c) - y(n) < 30; // the point inside the bar, near its label: below the point
        return `<circle cx="${x(i)}" cy="${y(c)}" r="2.6" class="cpm-cap"/>${c ? lbl(x(i), near ? y(c) + 14 : y(c) - 6, cpmK(c), near ? 'cap cap-in' : 'cap') : ''}`; }).join('')}
      ${d.scenarios.map((s, j) => line(s.periods.map((p, i) => [i, p.techs[t].capacity]), SC_COL[j], '6 4')).join('')}
      ${d.scenarios.map((s, j) => s.periods.map((p, i) => { const sn = p.techs[t].need; const bn = P[i].techs[t].need; const off = (j - (d.scenarios.length - 1) / 2) * 5; // the scenario's capacity needed: a bar-wide mark
        return `<g><title>${esc(`${s.name} · ${p.label}: needed ${cpmN(sn)} (base ${cpmN(bn)}${bn ? `, ${sn >= bn ? '+' : ''}${cpmPct(sn / bn - 1)}` : ''}) ${p.techs[t].added_need > 0.5 ? ` · of which added by its customer volumes ${cpmN(p.techs[t].added_need)}` : ''} · capacity ${cpmN(p.techs[t].capacity)} · load ${cpmPct(p.techs[t].util)}`)}</title>
          <line x1="${x(i) - bw / 2 - 4}" x2="${x(i) + bw / 2 + 4}" y1="${y(sn) + off}" y2="${y(sn) + off}" stroke="${SC_COL[j]}" class="cpm-scneed"/></g>`; }).join('')).join('')}
      ${P.map((p, i) => (period === 'month' || i % 4 === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="cpm-ax">${esc(period === 'week' ? p.key.slice(5) : p.label)}</text>` : '')).join('')}
    </svg>`;
  };
  // each machine's part of the capacity, per period: its hours on the technology × its speed
  let curT = null; const machOn = store.get('cpmMachLines', false) === true; const mNames = d.machines.map((m) => m.name);
  const mParts = (t) => mNames.map((name) => ({ name, per: d.periods.map((p) => { const m = p.machines.find((x) => x.name === name); return m ? (m.alloc?.[t] || 0) * (m.speed?.[t] || 0) : 0; }) }));
  const legend = () => `<div class="cpm-legend">
    <span><i class="sw cpm-sw-need"></i>Capacity needed (forecast${flex ? ' × flex' : ''} ÷ OEE) — <b class="pl-ok">under 85%</b> · <b class="pl-warn">85–100%</b> · <b class="pl-late">over</b> of capacity</span>
    <span><i class="sw cpm-sw-fc"></i>Forecast (cards)</span>
    <span><i class="ln"></i>Capacity</span>
    ${d.scenarios.map((s, j) => `<span><i class="ln dash" style="border-color:${SC_COL[j]}"></i><i class="cpm-scneed-sw" style="background:${SC_COL[j]}"></i>${esc(s.name)}: capacity (dashed) · needed (mark across the bar)</span>`).join('')}
    ${labels ? '' : '<span class="muted">hover a bar for its figures</span>'}</div>${machOn ? `<div class="cpm-legend"><span class="muted">Capacity per machine, stacked:</span>${cpmMachLegend(mParts(curT), mNames)}</div>` : ''}`;
  // all three technologies on one chart: capacity needed as bars in each technology's colour with a tick
  // at its capacity, or each technology's load as a line against 100%
  const allChart = (mode) => {
    const P = d.periods; const T = d.techs; const W = Math.max(640, P.length * (period === 'week' ? 22 : 84)); const L = 50; const B = 26; const T0 = 18;
    const slot = (W - L - 6) / P.length; const x = (i) => L + (i + 0.5) * slot;
    const lbl = (cx, cy, text, style = '', rot = false) => (labels ? `<text x="${cx}" y="${cy}" ${rot ? `transform="rotate(-90 ${cx} ${cy})" text-anchor="start"` : 'text-anchor="middle"'} class="cpm-lbl" style="${style}">${esc(text)}</text>` : '');
    const axisX = (H) => P.map((p, i) => (period === 'month' || i % 4 === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="cpm-ax">${esc(period === 'week' ? p.key.slice(5) : p.label)}</text>` : '')).join('');
    if (mode === 'load') {
      const H = labels ? 270 : 230; const top = Math.max(1.2, ...P.flatMap((p) => T.map((t) => p.techs[t].util || 0))) * (labels ? 1.06 : 1);
      const step = top > 2.5 ? 0.5 : 0.25; const max = Math.ceil(top / step) * step; const y = (v) => T0 + (H - T0 - B) * (1 - v / max);
      const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
      return `<svg class="cpm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
        ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${Math.round(v * 100)}%</text>`).join('')}
        <line x1="${L}" x2="${W - 4}" y1="${y(1)}" y2="${y(1)}" class="cpm-100"/><text x="${W - 6}" y="${y(1) - 4}" text-anchor="end" class="cpm-ax cpm-100-l">100% of capacity</text>
        ${T.map((t) => { const pts = P.map((p, i) => [x(i), y(p.techs[t].util || 0), p.techs[t].util]);
          return `<polyline fill="none" stroke="${cpmTc(t)}" stroke-width="2.6" points="${pts.map(([a, b]) => `${a},${b}`).join(' ')}"/>${pts.map(([a, b, u], i) => `<circle cx="${a}" cy="${b}" r="3.2" style="fill:${cpmTc(t)}"><title>${esc(`${t} · ${P[i].label}: load ${cpmPct(u)}`)}</title></circle>`).join('')}`; }).join('')}
        ${labels ? P.map((p, i) => { // labels kept apart: the top line's above its point, the bottom one's below, the middle where there's room
          const at = T.map((t) => ({ t, py: y(p.techs[t].util || 0), u: p.techs[t].util })).sort((a, b) => a.py - b.py);
          const out = []; let prev = -Infinity;
          at.forEach((q, k) => { let ly = k === at.length - 1 && at.length > 1 ? q.py + 15 : q.py - 7; let lx = x(i); let anchor = 'middle';
            if (ly - prev < 11) { if (k < at.length - 1 && q.py + 15 < at[k + 1].py - 7 - 11) ly = q.py + 15; else { lx = x(i) + 7; ly = q.py + 4; anchor = 'start'; } }
            if (k === at.length - 1 && ly - prev < 11) ly = prev + 11;
            prev = anchor === 'start' ? prev : ly;
            out.push(`<text x="${lx}" y="${ly}" text-anchor="${anchor}" class="cpm-lbl" style="fill:${cpmTc(q.t)}">${esc(cpmPct(q.u))}</text>`); });
          return out.join(''); }).join('') : ''}
        ${axisX(H)}</svg>`;
    }
    const H = labels ? 290 : 230;
    const top = Math.max(1, ...P.flatMap((p) => T.map((t) => Math.max(p.techs[t].need, p.techs[t].capacity))));
    const { max, ticks } = cpmScale(top * (labels ? 1.16 : 1)); const y = (v) => T0 + (H - T0 - B) * (1 - v / max);
    const bw = Math.max(3, (slot * 0.8) / T.length);
    return `<svg class="cpm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
      ${P.map((p, i) => T.map((t, k) => { const q = p.techs[t]; const bx = x(i) - (bw * T.length) / 2 + k * bw; const over = q.util > 1;
        return `<g><title>${esc(`${t} · ${p.label}: needed ${cpmN(q.need)} · capacity ${cpmN(q.capacity)} · ${cpmPct(q.util)}`)}</title>
          <rect x="${bx + 0.5}" y="${y(q.need)}" width="${bw - 1}" height="${Math.max(0, y(0) - y(q.need))}" style="fill:${cpmTc(t)}" class="cpm-allbar"/>
          <line x1="${bx - 1}" x2="${bx + bw + 1}" y1="${y(q.capacity)}" y2="${y(q.capacity)}" class="cpm-captick ${over ? 'over' : ''}"/>
          ${q.need ? lbl(bx + bw / 2 + 3, Math.min(y(q.need), y(q.capacity)) - 4, cpmK(q.need), `fill:${cpmTc(t)}`, true) : ''}</g>`; }).join('')).join('')}
      ${axisX(H)}</svg>`;
  };
  const allLegend = (mode) => `<div class="cpm-legend">${d.techs.map((t) => `<span><i class="sw" style="background:${cpmTc(t)}"></i>${esc(t)}</span>`).join('')}
    ${mode === 'load' ? '<span><i class="ln dash cpm-100-sw"></i>100% of capacity — above it, more is needed than there is</span><span class="muted">load = capacity needed (forecast' + (flex ? ' × flex' : '') + ' ÷ OEE) ÷ capacity</span>'
    : `<span><i class="ln"></i>tick: the technology's capacity (red where it's short)</span><span class="muted">bars: capacity needed (forecast${flex ? ' × flex' : ''} ÷ OEE)</span>`}</div>`;
  // forecast against actual: cards forecast and persoed side by side, the difference on each
  const fva = (sel) => {
    const P = d.periods; const pick = (p, k) => (sel === 'all' ? d.techs.reduce((a, t) => a + p.techs[t][k], 0) : p.techs[sel][k]);
    const started = (p) => p.start <= now; const closed = (p) => p.end < now;
    const W = Math.max(640, P.length * (period === 'week' ? 18 : 78)); const H = labels ? 250 : 210; const L = 50; const B = 26; const T = 18;
    const { max, ticks } = cpmScale(Math.max(1, ...P.map((p) => Math.max(pick(p, 'fc'), pick(p, 'actual')))) * (labels ? 1.1 : 1));
    const slot = (W - L - 6) / P.length; const x = (i) => L + (i + 0.5) * slot; const bw = Math.max(3, slot * 0.36); const y = (v) => T + (H - T - B) * (1 - v / max);
    const dev = (p) => { const f = pick(p, 'fc'); const a = pick(p, 'actual'); return f && started(p) ? a / f - 1 : null; };
    const devCls = (v) => (v === null ? '' : Math.abs(v) <= 0.1 ? 'ok' : Math.abs(v) <= 0.2 ? 'warn' : 'bad');
    const lbl = (cx, cy, text, cls = '') => (labels ? `<text x="${cx}" y="${cy}" text-anchor="middle" class="cpm-lbl ${cls}">${esc(text)}</text>` : '');
    const ytd = P.filter(started); const fT = ytd.reduce((a, p) => a + pick(p, 'fc'), 0); const aT = ytd.reduce((a, p) => a + pick(p, 'actual'), 0);
    const fCl = P.filter(closed).reduce((a, p) => a + pick(p, 'fc'), 0); const aCl = P.filter(closed).reduce((a, p) => a + pick(p, 'actual'), 0);
    const svg = `<svg class="cpm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
      ${P.map((p, i) => { const f = pick(p, 'fc'); const a = pick(p, 'actual'); const v = dev(p); const open = started(p) && !closed(p);
        return `<g><title>${esc(`${p.label}: forecast ${cpmN(f)}${started(p) ? ` · actual ${cpmN(a)}${open ? ' so far' : ''}${v === null ? '' : ` · ${v >= 0 ? '+' : ''}${cpmPct(v)}`}` : ''}`)}</title>
        <rect x="${x(i) - bw}" y="${y(f)}" width="${bw}" height="${Math.max(0, y(0) - y(f))}" class="cpm-fva-fc ${started(p) ? '' : 'future'}"/>
        ${started(p) ? `<rect x="${x(i)}" y="${y(a)}" width="${bw}" height="${Math.max(0, y(0) - y(a))}" class="cpm-fva-act ${open ? 'open' : ''}" ${sel === 'all' ? '' : `style="fill:${cpmTc(sel)}"`}/>` : ''}
        ${f ? lbl(x(i) - bw / 2, y(f) - 4, cpmK(f), 'fc') : ''}${started(p) && a ? lbl(x(i) + bw / 2, y(a) - 4, cpmK(a), 'act') : ''}
        ${v !== null && labels ? `<text x="${x(i)}" y="${T - 4}" text-anchor="middle" class="cpm-lbl dev ${devCls(v)}">${v >= 0 ? '+' : ''}${cpmPct(v)}${open ? '*' : ''}</text>` : ''}</g>`; }).join('')}
      ${P.map((p, i) => (period === 'month' || i % 4 === 0 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="cpm-ax">${esc(period === 'week' ? p.key.slice(5) : p.label)}</text>` : '')).join('')}
    </svg>`;
    const kpi = (lab, v, sub = '') => `<div class="kdb-tile"><div class="kdb-tile-l">${lab}</div><div class="kdb-tile-v">${v}</div><div class="kdb-tile-s">${sub}</div></div>`;
    const dv = fCl ? aCl / fCl - 1 : null;
    return `<div class="kdb-tiles pl-tiles">${kpi('Forecast to date', cpmN(Math.round(fT)), `${ytd.length} ${period === 'week' ? 'week' : 'month'}${ytd.length === 1 ? '' : 's'} so far this year`)}${kpi('Persoed to date', cpmN(Math.round(aT)), fT ? `${cpmPct(aT / fT)} of the forecast` : '')}
      ${kpi(`Closed ${period === 'week' ? 'weeks' : 'months'}`, dv === null ? '—' : `<span class="cpm-u ${devCls(dv)}">${dv >= 0 ? '+' : ''}${cpmPct(dv)}</span>`, `actual ${cpmK(aCl)} against ${cpmK(fCl)} forecast`)}</div>
      <div class="cpm-legend"><span><i class="sw cpm-sw-fcb"></i>Forecast</span><span><i class="sw cpm-sw-act" ${sel === 'all' ? '' : `style="background:${cpmTc(sel)}"`}></i>Persoed (DailyPersoData, else the timing report)</span><span><i class="sw cpm-sw-act open" ${sel === 'all' ? '' : `style="background:${cpmTc(sel)}"`}></i>this ${period === 'week' ? 'week' : 'month'} so far (*)</span>
        <span>Difference: <b class="pl-ok">within 10%</b> · <b class="pl-warn">10–20%</b> · <b class="pl-late">more</b></span>${sel === 'all' ? '' : '<span class="muted">by technology the forecast is split by each customer\'s split, the actual by card type</span>'}</div>${svg}`;
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
      ${row('Actual', (p) => (p ? (p.start <= now ? cpmK(p.techs[t].actual) : '') : cpmK(tot.actual)))}
      ${row('Actual vs forecast', (p) => { if (p && p.start > now) return ''; const f = p ? p.techs[t].fc : P.filter((q) => q.start <= now).reduce((a, q) => a + q.techs[t].fc, 0); const a = p ? p.techs[t].actual : tot.actual; if (!f) return '—'; const v = a / f - 1; return `<span class="cpm-u ${Math.abs(v) <= 0.1 ? 'ok' : Math.abs(v) <= 0.2 ? 'warn' : 'bad'}">${v >= 0 ? '+' : ''}${cpmPct(v)}</span>`; })}
      ${d.scenarios.map((s, j) => (s.periods.some((p) => p.techs[t].unplaced > 0.005 * p.techs[t].need) ? row(`<span style="color:${SC_COL[j]}">${esc(s.name)}</span>: can't be placed`, (p, i) => { const u = p ? s.periods[i].techs[t].unplaced || 0 : s.periods.reduce((a, q) => a + (q.techs[t].unplaced || 0), 0); return u > 0.5 ? `<span class="pl-late" title="Needed, but no machine that runs ${esc(t)} is allowed this customer / card">${cpmK(u)}</span>` : ''; }) : '')).join('')}
      ${d.scenarios.map((s, j) => { const dif = (a, b, upBad = true) => (Math.abs(a - b) > 0.5 ? ` <span class="small ${(a > b) === upBad ? 'pl-late' : 'pl-ok'}" title="against the base plan">${a > b ? '+' : '−'}${cpmK(Math.abs(a - b))}</span>` : '');
        const sum = (k) => s.periods.reduce((a, q) => a + (q.techs[t][k] || 0), 0); const base = (k) => P.reduce((a, q) => a + (q.techs[t][k] || 0), 0);
        return row(`<span style="color:${SC_COL[j]}">${esc(s.name)}</span>: needed`, (p, i) => (p ? `${cpmK(s.periods[i].techs[t].need)}` : `${cpmK(sum('need'))}${dif(sum('need'), base('need'))}`))
          + row(`<span style="color:${SC_COL[j]}">${esc(s.name)}</span>: capacity`, (p, i) => (p ? `${cpmK(s.periods[i].techs[t].capacity)}` : `${cpmK(sum('capacity'))}${dif(sum('capacity'), base('capacity'), false)}`)); }).join('')}
      ${d.scenarios.map((s, j) => (s.periods.some((p) => p.techs[t].reserved > 0.5) ? row(`<span style="color:${SC_COL[j]}">${esc(s.name)}</span>: idle on restricted machines`, (p, i) => { const v = p ? s.periods[i].techs[t].reserved || 0 : s.periods.reduce((a, q) => a + (q.techs[t].reserved || 0), 0); return v > 0.5 ? `<span class="muted" title="Hours a restricted machine has left after its customers / cards — no one else may use them, so they're not counted as capacity">${cpmK(v)}</span>` : ''; }) : '')).join('')}
      ${d.scenarios.map((s, j) => row(`<span style="color:${SC_COL[j]}">${esc(s.name)}</span>: load`, (p, i) => { const sp = p ? s.periods[i].techs[t] : null; return cpmPct(sp ? sp.util : null); }, (p, i) => (p ? `cpm-u ${cpmUtilCls(s.periods[i].techs[t].util)}` : ''))).join('')}
      </tbody></table></div>`;
  };
  const short = (res, t) => res.periods.filter((p) => p.techs[t].util > 1).length;
  const tiles = d.techs.map((t) => { const P = d.periods; const need = P.reduce((a, p) => a + p.techs[t].need, 0); const cap = P.reduce((a, p) => a + p.techs[t].capacity, 0); const s = short(d, t);
    return `<div class="kdb-tile cpm-tile" style="border-top-color:${cpmTc(t)}"><div class="kdb-tile-l">${CPM_TECH_ICON[t] || ''} <b style="color:${cpmTc(t)}">${esc(t)}</b> — year</div><div class="kdb-tile-v ${cpmUtilCls(cap ? need / cap : null) === 'bad' ? 'kdb-bad' : ''}">${cpmPct(cap ? need / cap : null)}</div>
      <div class="kdb-tile-s">of capacity needed · <b class="${s ? 'pl-late' : 'pl-ok'}">${s} ${period === 'week' ? 'week' : 'month'}${s === 1 ? '' : 's'} over</b>${d.scenarios.map((sc, j) => ` · <span style="color:${SC_COL[j]}">${esc(sc.name)}: ${short(sc, t)}</span>`).join('')}</div></div>`; }).join('');
  const allSel = store.get('cpmAll', 'volume') === 'load' ? 'load' : 'volume';
  const fvaSel = ['all', ...d.techs].includes(store.get('cpmFva', 'all')) ? store.get('cpmFva', 'all') : 'all';
  const years = [year - 1, year, year + 1];
  body.innerHTML = `
    <div class="row pl-filters" style="gap:10px;flex-wrap:wrap">${cpmLineSeg()}
      <select id="cpm-year">${years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <div class="seg"><button type="button" data-cpm-period="month" class="${period === 'month' ? 'on' : ''}">By month</button><button type="button" data-cpm-period="week" class="${period === 'week' ? 'on' : ''}">By week</button></div>
      <label class="row small"><input type="checkbox" id="cpm-flex" ${flex ? 'checked' : ''}> apply flex${d.flex?.overall ? ` <span class="muted">(overall ${cpmPct(d.flex.overall - 1, 1)})</span>` : ''}</label>
      ${ddMenu(`🧪 Compare${scen.length ? ` (${scen.length})` : ''}`, `<div class="dd-h">Scenarios to show against the base plan</div>${all.map((s) => `<label data-dd-keep><input type="checkbox" data-cpm-cmp="${s.id}" ${scen.includes(s.id) ? 'checked' : ''}> ${esc(s.name)}${s.mine ? '' : ` <span class="muted">(${esc(s.owner_name || 'shared')})</span>`}</label>`).join('') || '<div class="dd-item muted">No scenarios yet — make one on Scenarios</div>'}`, { title: 'Scenarios compared with the base plan', right: false })}
      ${ddMenu('⚙ View', `<label data-dd-keep title="Each machine's part of the capacity, as stacked lines"><input type="checkbox" class="cpm-mach-tick" ${store.get('cpmMachLines', false) === true ? 'checked' : ''}> Capacity per machine</label><hr><a id="cpm-xlsx" href="/api/cpm/export?year=${year}&period=${period}&flex=${flex ? 1 : 0}&scenarios=${scen.join(',')}" download title="The overview as an Excel workbook like the CPM one — the base plan${scen.length ? ' and the scenarios compared' : ''}, as formulas over their inputs, with charts">⬇ Download as Excel</a>`, { title: 'Capacity per machine, Excel' })}
    </div>
    <details class="cpm-about small muted"><summary>ⓘ Forecast ${d.forecast_as_of ? `as read in ${esc(d.forecast_as_of)}` : 'not read yet'} · ${d.shifts} shifts × ${d.hours} h</summary>Forecast ${d.forecast_as_of ? `as read in ${esc(d.forecast_as_of)}` : '— none read yet: link the BeNeLux and Amex forecasts in Reporting › Sources'} · ${d.shifts} shifts × ${d.hours} productive hours · speeds from Production: ${d.techs.map((t) => `${esc(t)} ${d.speeds[t] ? `${cpmN(d.speeds[t])}/h` : '<b class="pl-late">none</b>'}`).join(' · ')}${d.cards ? '' : ' · <span class="pl-warn">card database not linked: actuals by machine only</span>'}</details>
    ${d.warnings.map((w) => `<div class="kc-note notice">${esc(w)}</div>`).join('')}
    ${d.scenarios.map((sc, j) => { const w = sc.warnings.filter((x) => !d.warnings.includes(x)); return w.length ? `<div class="kc-note notice"><b style="color:${SC_COL[j]}">${esc(sc.name)}</b>: ${w.map(esc).join(' · ')}</div>` : ''; }).join('')}
    ${d.forecast_as_of && !d.forecast_total ? `<div class="kc-note notice">The forecast read in ${esc(d.forecast_as_of)} has nothing for ${d.year} — check the files linked in Reporting › Sources.</div>` : ''}
    ${d.unmapped_count ? `<div class="kc-note notice"><b>${d.unmapped_count} forecast name${d.unmapped_count === 1 ? '' : 's'} not linked to a customer</b> (${cpmK(d.unmapped_qty)} cards this year): counted with the mix of everything persoed and the default OEE until linked — ${d.unmapped.slice(0, 5).map((u) => esc(u.name)).join(' · ')}${d.unmapped_count > 5 ? ' …' : ''}. <a href="#/cpm/customers">Link them, or import the CPM workbook's Config sheet →</a></div>` : ''}
    <div class="kdb-tiles pl-tiles">${tiles}</div>
    <div class="card"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><h3 class="pl-h" style="margin:0">All technologies <span class="muted small">— ${allSel === 'load' ? 'how full each is' : 'capacity needed against capacity'}</span></h3>
      <div class="seg"><button type="button" data-cpm-all="volume" class="${allSel === 'volume' ? 'on' : ''}">Cards</button><button type="button" data-cpm-all="load" class="${allSel === 'load' ? 'on' : ''}">Load %</button></div></div>
      <div id="cpm-all">${allLegend(allSel)}${allChart(allSel)}</div></div>
    ${cpmFcTotals(d)}
    <div class="card"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><h3 class="pl-h" style="margin:0">Forecast vs actual <span class="muted small">— cards forecast against cards persoed, ${period === 'week' ? 'by week' : 'by month'}</span></h3>
      <div class="seg">${['all', ...d.techs].map((t) => `<button type="button" data-cpm-fva="${t}" class="${fvaSel === t ? 'on' : ''}" ${t === 'all' ? '' : `style="color:${cpmTc(t)}"`}>${t === 'all' ? 'All' : esc(t)}</button>`).join('')}</div></div>
      <div id="cpm-fva">${fva(fvaSel)}</div></div>
    ${d.techs.map((t) => `<div class="card cpm-tech"><h3 class="pl-h cpm-tech-h" style="border-left-color:${cpmTc(t)}"><span style="color:${cpmTc(t)}">${esc(t)}</span> <span class="muted small">— capacity needed against capacity</span></h3>
      ${(curT = t, legend())}${chart(t)}${table(t)}</div>`).join('')}`;
  if (cpmReread) { cpmReread = false; const bad = Object.values(d.forecast_status || {}).filter((x) => x.error); toast(bad.length ? `Couldn't read: ${bad.map((x) => x.error).join(' · ')}` : 'Forecasts read again', bad.length ? 'error' : ''); }
  const rr = $('#cpm-reread'); if (rr) rr.onclick = () => { cpmReread = true; rr.disabled = true; rr.textContent = 'Reading…'; renderCpm('overview'); };
  $$('[data-cpm-all]').forEach((b) => { b.onclick = () => { store.set('cpmAll', b.dataset.cpmAll); $$('[data-cpm-all]').forEach((x) => x.classList.toggle('on', x === b)); $('#cpm-all').innerHTML = allLegend(b.dataset.cpmAll) + allChart(b.dataset.cpmAll); b.closest('.card').querySelector('h3 .muted').textContent = b.dataset.cpmAll === 'load' ? '— how full each is' : '— capacity needed against capacity'; }; });
  $$('[data-cpm-fva]').forEach((b) => { b.onclick = () => { store.set('cpmFva', b.dataset.cpmFva); $$('[data-cpm-fva]').forEach((x) => x.classList.toggle('on', x === b)); $('#cpm-fva').innerHTML = fva(b.dataset.cpmFva); }; });
  $('#cpm-year').onchange = (e) => { store.set('cpmYear', Number(e.target.value)); renderCpm('overview'); };
  $$('[data-cpm-period]').forEach((b) => { b.onclick = () => { store.set('cpmPeriod', b.dataset.cpmPeriod); renderCpm('overview'); }; });
  $('#cpm-flex').onchange = (e) => { store.set('cpmFlex', e.target.checked); renderCpm('overview'); };
  $$('.cpm-mach-tick').forEach((c) => { c.onchange = () => { store.set('cpmMachLines', c.checked); renderCpm('overview'); }; });
  $$('[data-cpm-cmp]').forEach((c) => { c.onchange = () => { const id = Number(c.dataset.cpmCmp); let l = (store.get('cpmCompare', []) || []).filter((x) => x !== id); if (c.checked) l = [...l, id].slice(-2); store.set('cpmCompare', l); renderCpm('overview'); }; });
}

// ---- Forecast vs actual: the flex -----------------------------------------------------------------
// ---- CPM Daily: a working day of a month, hour by hour (the CPM daily sheet) ----------------------
// (settings: Configuration › CPM Daily — only its renewal windows, run periods and shipment times, worked out live)
async function cpmDay(body, settings = false) {
  const MX = !settings && cpmLine() === 'match'; // Matching: the same day, its own figures (a technology 'Matching'; items for cards)
  const dayRegen = cpmRegenNext; // (its comparison, asked for later, is generated again with it)
  const year = Number(store.get('cpmYear', new Date().getFullYear()));
  const month = Number(store.get('cpmDayMonth', new Date().getMonth() + 1));
  const flex = store.get('cpmFlex', true); const scId = settings ? 0 : Number(store.get('cpmDayScenario', 0)) || 0;
  const full = null; // (capacity is always at full speed: the losses are in the OEE)
  const q = `year=${year}&month=${month}&flex=${flex ? 1 : 0}${scId ? `&scenario=${scId}` : ''}${full === null ? '' : `&full=${full ? 1 : 0}`}`;
  const [d, scs] = await Promise.all([(settings ? api.get(`/cpm/day?${q}&live=1`) : cpmGet(`/cpm/${MX ? 'match/day' : 'day'}?${q}`)).catch((err) => { if (scId) store.set('cpmDayScenario', 0); throw err; }), api.get('/cpm/scenarios')]);
  const H = d.hours; const T = d.techs; const hl = (h) => `${String(h).padStart(2, '0')}:00`; const U = MX ? 'items' : 'cards'; const Ucap = MX ? 'Items' : 'Cards';
  // run periods: an entry per customer (and technology) — periods, or hourly values pasted
  const manShares = (v) => { const out = Array(24).fill(0); const hmm = (x) => { const m = String(x || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
    if (Array.isArray(v?.hours)) v.hours.forEach((x, h) => { out[h] = Math.max(0, Number(x) || 0); });
    else for (const p of v?.periods || []) { const a = hmm(p.from); let b = hmm(p.to); const w = Math.max(0, Number(p.share) || 0); if (a === null || b === null || !w) continue; if (b <= a) b += 1440; for (let t = a; t < b;) { const h = Math.floor(t / 60); const e = Math.min(b, (h + 1) * 60); out[h % 24] += (w * (e - t)) / (b - a); t = e; } }
    const tot = out.reduce((x, y) => x + y, 0); return tot ? out.map((x) => x / tot) : out; };
  // the run-periods grid: a row per customer (biggest first) and one for everyone else; each cell the % of its
  // daily work in that hour. A row set by hand shows its values; one that isn't, what's learned (greyed)
  const gridCusts = (() => { const by = new Map(); for (const r of d.rows) if (r.trigram) { const x = by.get(r.trigram) || by.set(r.trigram, { tri: r.trigram, name: r.name, need: 0, learned: Array(24).fill(0) }).get(r.trigram); x.need += r.need_daily; (r.produced_shares || r.learned_shares).forEach((v, i) => { x.learned[i] += v * r.need_daily; }); }
    const list = [...by.values()].sort((p2, q) => q.need - p2.need); for (const x of list) x.learned = x.learned.map((v) => (x.need ? v / x.need : 0));
    const all = Array(24).fill(0); const tot = list.reduce((p2, x) => p2 + x.need, 0); for (const x of list) x.learned.forEach((v, i) => { all[i] += (v * x.need) / (tot || 1); });
    return [{ tri: '*', name: 'Everyone else', learned: all }, ...list]; })();
  const setRow = (tri) => { const v = (d.manual || {})[`${tri}|*`]; if (!v) return null; const sh = manShares(v); return H.map((h) => sh[h]); }; // by the day's hours
  const r1 = (v) => Math.round(v * 1000) / 10;
  const gridRow = (c) => { const set = setRow(c.tri); const vals = set || c.learned;
    return `<tr class="cpm-grow ${set ? 'set' : ''}" data-tri="${esc(c.tri)}"><th title="${esc(c.name)}">${c.tri === '*' ? '<i>Everyone else</i>' : `<b>${esc(c.tri)}</b> ${c.name && c.name !== c.tri ? `<span class="muted small">${esc(String(c.name).slice(0, 18))}</span>` : ''}`}</th>
      ${vals.map((v, i) => `<td><input type="text" inputmode="decimal" class="cpm-gc" data-i="${i}" value="${set ? r1(v) : ''}" placeholder="${r1(v) || ''}"></td>`).join('')}
      <td class="num cpm-gsum">${set ? '100%' : '<span class="muted">learned</span>'}</td><td><button class="link small cpm-greset" title="Back to what's learned" ${set ? '' : 'hidden'}>↺</button></td></tr>`; };
  const shipRow = (x, k) => `<div class="row cpm-ship-row" style="gap:6px;margin-bottom:4px;align-items:center" data-k="${k}"><input type="time" class="cpm-ship-t" value="${esc(x.time)}" style="width:120px"><input type="text" class="cpm-ship-l" value="${esc(x.label || '')}" placeholder="Label, e.g. PostNL" style="width:200px"><button class="link small cpm-ship-rm" title="Remove">✕</button></div>`;
  const hhmm = (v) => (v === null || v === undefined ? '' : `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const cut = d.cutoffs.map((c) => Number(c.slice(0, 2)) + Number(c.slice(3)) / 60);
  // where a cut-off falls on the chart (between the hour columns)
  // a shipment time's label, all alike on one level: the time — with its name on all of them if none are close
  // together, else the names in the tooltips (the 🚚 is in the legend)
  const roomy = cut.every((c, k) => !k || c - cut[k - 1] >= 2.5);
  const cutLabel = (k) => `${d.cutoffs[k]}${roomy && d.cutoff_labels?.[k] ? ` ${d.cutoff_labels[k]}` : ''}`;
  const cutTitle = (k) => `Shipment ${d.cutoffs[k]}${d.cutoff_labels?.[k] ? ` · ${d.cutoff_labels[k]}` : ''}`;
  const cutX = (x0, slot) => cut.map((c) => { const i = H.indexOf(Math.floor(c)); return i < 0 ? null : x0 + (i + (c % 1)) * slot; });
  const view = store.get('cpmDayView2', 'need') === 'cards' ? 'cards' : 'need';
  const showPrio = !!store.get('cpmShowPrio', false); // the daily work by priority (Urgent / High / Normal) — off: daily and renewals, as the CPM sheet // capacity needed by default, as the CPM daily sheet
  // the figures shown: cards (bars cards, line capacity × the hour's OEE, dots what was really persoed) or
  // capacity needed (bars ÷ OEE against capacity at speed, as the CPM daily sheet)
  // each chart's mini-tab: the day as it comes in, or smoothed — the daily work moved within its hours before
  // the shipping cut-off to stay under capacity
  const modeOf = (t) => { const m = store.get(`cpmDayMode_${t}`, null) || (store.get(`cpmDaySm_${t}`, false) === true ? 'smooth' : 'arrive'); return m === 'blocks' && !d.blocks ? 'arrive' : m; };
  const smoothed = (t) => modeOf(t) === 'smooth';
  const V = (t, mo = modeOf(t)) => { const X = d.tech[t]; const c = X.cards; const S = X.smooth; const sm = mo === 'smooth' && S;
    if (mo === 'blocks') { // the work orders as run: what's on the machines each hour, what's waiting
      const B = d.blocks.per[t]; const cardsV = view === 'cards'; const ratio = (i) => (B.need[i] > 0.5 ? B.cards[i] / B.need[i] : c.oee);
      const v = { daily: (cardsV ? B.cards : B.need).map((x, i) => x - (cardsV ? B.cards_rnw[i] : B.need_rnw[i])), rnw: cardsV ? B.cards_rnw : B.need_rnw, need: cardsV ? B.cards : B.need,
        cap: cardsV ? X.capacity.map((x, i) => x * ratio(i)) : X.capacity, act: cardsV ? c.actual : null, ghost: cardsV ? c.total : X.need, blocks: true };
      v.load = B.need.map((x, i) => (X.capacity[i] ? x / X.capacity[i] : 0)); v.backlog = cardsV ? B.waiting.map((x, i) => x * ratio(i)) : B.waiting;
      const P0 = cardsV ? c.prio : X.prio; // as work orders: each hour's daily work in the day's priority mix
      if (P0 && showPrio) { const tot = ['urgent', 'high', 'normal'].reduce((a, k) => a + sumA(P0[k] || []), 0); v.prio = tot > 1e-9 ? Object.fromEntries(['urgent', 'high', 'normal'].map((k) => [k, v.daily.map((x) => (x * sumA(P0[k] || [])) / tot)])) : null; }
      return v; }
    const v = view === 'cards'
      ? { daily: sm ? S.cards.daily : c.daily, rnw: sm ? S.cards.renewals : c.renewals, need: sm ? S.cards.total : c.total, cap: sm ? S.cards.capacity : c.capacity, act: c.actual, ghost: sm ? c.total : null }
      : { daily: sm ? S.daily : X.daily, rnw: sm ? S.renewals : X.renewals, need: sm ? S.need : X.need, cap: X.capacity, act: null, ghost: sm ? X.need : null };
    v.load = sm ? S.load : X.load; v.smoothed = !!sm;
    v.prio = showPrio ? (view === 'cards' ? (sm ? S.cards.prio : c.prio) : (sm ? S.prio : X.prio)) || null : null;
    let carry = 0; v.backlog = v.need.map((x, i) => { carry = Math.max(0, carry + x - v.cap[i]); return carry; }); return v; };
  // done after its cut-off (the day worked in the order it comes in, each piece in the next hour with spare
  // capacity): by the hour it's done, in what the view counts
  const lateOf = (t) => (view === 'cards' ? H.map((_, i) => d.rows.filter((r) => r.tech === t && r.late_hours).reduce((a, r) => a + r.late_hours[i] * r.oee, 0)) : d.tech[t].smooth.late_at || Array(24).fill(0));
  const lateCust = (t) => d.rows.filter((r) => r.tech === t && r.late_cards > 0.5).sort((a, b) => b.late_cards - a.late_cards);
  // each machine's part of the capacity, hour by hour (in cards: × the hour's OEE, as the line)
  const addedOf = (t, i) => (view === 'cards' ? d.tech[t].cards_added?.[i] : d.tech[t].added?.[i]) || 0;
  const addedRnwOf = (t, i) => (view === 'cards' ? d.tech[t].cards_added_rnw?.[i] : d.tech[t].added_rnw?.[i]) || 0;
  const anyAdded = T.some((t) => H.some((_, i) => addedOf(t, i) > 0.5 || addedRnwOf(t, i) > 0.5));
  // what's added, in the view shown (X = V(t, mode)): as it comes in, hour by hour; smoothed or as work orders (where the
  // work moves to spare capacity), its share of the day's daily work / renewals in each hour — work is interchangeable there
  const sumA = (a) => a.reduce((p2, q2) => p2 + (q2 || 0), 0);
  // the daily work by priority (Urgent / High / Normal — Low is the renewals), stacked most urgent at the bottom
  const DP = CPM_PRIOS.slice(0, 3);
  const prioAt = (X, i) => { if (!X.prio) return null; const a = X.daily[i] || 0; const tot = DP.reduce((s, [k]) => s + (X.prio[k]?.[i] || 0), 0); const f = tot > 1e-9 ? a / tot : 0; return Object.fromEntries(DP.map(([k]) => [k, (X.prio[k]?.[i] || 0) * f])); };
  const prioTxt = (X, i) => { const p = prioAt(X, i); return p ? ` (${DP.filter(([k]) => p[k] > 0.5).map(([k, l]) => `${l} ${cpmN(p[k])}`).join(' · ')})` : ''; };
  const dailyRects = (x0, w, t, X, i, y, over) => { const a = X.daily[i] || 0; const p = prioAt(X, i);
    if (!p) return `<rect x="${x0}" y="${y(a)}" width="${w}" height="${Math.max(0, y(0) - y(a))}" style="fill:${cpmTc(t)}" class="cpm-allbar ${over ? 'cpm-over' : ''}"/>`;
    let b0 = 0; return DP.map(([k]) => { const v = p[k]; const r = v > 1e-9 ? cpmPrioRect(x0, y(b0 + v), w, Math.max(0, y(b0) - y(b0 + v)), cpmTc(t), k) : ''; b0 += v; return r; }).join('')
      + (over ? `<rect x="${x0}" y="${y(a)}" width="${w}" height="${Math.max(0, y(0) - y(a))}" class="cpm-over" style="fill:none"/>` : ''); };
  const addedIn = (t, X, i) => {
    if (!X.smoothed && !X.blocks) return { d: addedOf(t, i), r: addedRnwOf(t, i) };
    const base = view === 'cards' ? d.tech[t].cards : d.tech[t]; const dAll = sumA(view === 'cards' ? base.daily : base.daily); const rAll = sumA(view === 'cards' ? base.renewals : base.renewals);
    const dAdd = sumA(H.map((_, k) => addedOf(t, k))); const rAdd = sumA(H.map((_, k) => addedRnwOf(t, k)));
    return { d: dAll ? (X.daily[i] || 0) * Math.min(1, dAdd / dAll) : 0, r: rAll ? (X.rnw[i] || 0) * Math.min(1, rAdd / rAll) : 0 };
  };
  // what's added to the renewals: on top of the renewals part, lighter
  const addedRnwRect = (x0, w, a, r, ad, y, t, h) => (ad > 0.5 && r > 0 ? `<rect x="${x0}" y="${y(a + r)}" width="${w}" height="${Math.max(0, y(a + r - Math.min(ad, r)) - y(a + r))}" class="cpm-added cpm-added-rnw"><title>${esc(`${t} ${hl(h)}: ${cpmN(Math.min(ad, r))} renewals added — scenario volume / campaigns`)}</title></rect>` : '');
  const addedRect = (x0, w, a, ad, y, t, h) => (ad > 0.5 ? `<rect x="${x0}" y="${y(a)}" width="${w}" height="${Math.max(0, y(Math.max(0, a - Math.min(ad, a))) - y(a))}" class="cpm-added"><title>${esc(`${t} ${hl(h)}: ${cpmN(Math.min(ad, a))} added — scenario volume / campaigns`)}</title></rect>` : '');
  const chart = (t) => {
    const X = V(t); const W = 1100; const Hh = 290; const L = 50; const B = 28; const T0 = 26;
    const { max, ticks } = cpmScale(Math.max(1, ...X.need, ...X.cap, ...X.backlog, ...(X.act || []), ...(X.ghost || [])) * 1.12);
    const slot = (W - L - 6) / 24; const x = (i) => L + (i + 0.5) * slot; const bw = slot * 0.66; const y = (v) => T0 + (Hh - T0 - B) * (1 - v / max);
    const step = X.cap.map((c, i) => `${i ? 'L' : 'M'}${L + i * slot},${y(c)} L${L + (i + 1) * slot},${y(c)}`).join(' ');
    return `<svg class="cpm-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="xMinYMin meet">${CPM_PRIO_DEFS}
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
      ${H.map((h, i) => (d.worked[i] ? '' : `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${Hh - T0 - B}" class="cpm-off"/>`)).join('')}
      ${cutX(L, slot).map((cx, k) => (cx === null ? '' : `<line x1="${cx}" x2="${cx}" y1="${T0 - 14}" y2="${Hh - B}" class="cpm-cut"/><text x="${cx}" y="${T0 - 16}" text-anchor="middle" class="cpm-ax cpm-cut-l"><title>${esc(cutTitle(k))}</title>${esc(cutLabel(k))}</text>`)).join('')}
      ${H.map((h, i) => { const a = X.daily[i]; const r = X.rnw[i]; const over = X.need[i] > X.cap[i] + 0.5;
        return `<g><title>${esc(`${t} ${hl(h)}: daily ${cpmN(a)}${prioTxt(X, i)} + renewals (Low) ${cpmN(r)} = ${cpmN(X.need[i])} ${view === 'cards' ? 'cards' : 'needed'} · capacity ${cpmN(X.cap[i])}${X.act ? ` · really persoed ${cpmN(X.act[i])} on average` : ''}${X.backlog[i] > 0.5 ? ` · ${cpmN(X.backlog[i])} carried over` : ''}`)}</title>
          ${dailyRects(x(i) - bw / 2, bw, t, X, i, y, over)}
          ${addedRect(x(i) - bw / 2, bw, a, addedIn(t, X, i).d, y, t, h)}
          <rect x="${x(i) - bw / 2}" y="${y(a + r)}" width="${bw}" height="${Math.max(0, y(a) - y(a + r))}" style="fill:${cpmTc(t)}" class="cpm-rnw"/>
          ${addedRnwRect(x(i) - bw / 2, bw, a, r, addedIn(t, X, i).r, y, t, h)}
          ${X.need[i] >= 0.5 ? `<text x="${x(i)}" y="${y(X.need[i]) - 4}" text-anchor="middle" class="cpm-lbl ${over ? 'over' : ''}">${esc(cpmK(X.need[i]))}</text>` : ''}</g>`; }).join('')}
      ${X.ghost ? H.map((h, i) => (X.ghost[i] > 0.5 ? `<rect x="${x(i) - bw / 2}" y="${y(X.ghost[i])}" width="${bw}" height="${Math.max(0, y(0) - y(X.ghost[i]))}" class="cpm-ghost"><title>${esc(`${t} ${hl(h)}: ${cpmN(X.ghost[i])} as it comes in`)}</title></rect>` : '')).join('') : ''}
      ${(() => { if (X.blocks) return ''; const lt = lateOf(t); return H.map((h, i) => (lt[i] > 0.5 ? `${X.smoothed ? `<rect x="${x(i) - bw / 2}" y="${y(Math.min(lt[i], X.need[i]))}" width="${bw}" height="${Math.max(0, y(0) - y(Math.min(lt[i], X.need[i])))}" class="cpm-late-bar"/>` : ''}<g class="cpm-late-pill"><title>${esc(`${t} ${hl(h)}: ${cpmN(lt[i])} ${view === 'cards' ? 'cards' : 'needed'} done after its cut-off`)}</title><rect x="${x(i) - slot * 0.46}" y="${Hh - B - 15}" width="${slot * 0.92}" height="13" rx="3"/><text x="${x(i)}" y="${Hh - B - 5}" text-anchor="middle">⚠ ${esc(cpmK(lt[i]))}</text></g>` : '')).join(''); })()}
      <path d="${step}" fill="none" class="cpm-capstep"/>
      ${X.backlog.some((v) => v > 0.5) ? `<polyline fill="none" class="cpm-backlog" points="${X.backlog.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>` : ''}
      ${X.act ? X.act.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="4" class="cpm-actdot"><title>${esc(`${t} ${hl(H[i])}: ${cpmN(v)} cards really persoed on an average working day (${d.actual.which})`)}</title></circle>`).join('') : ''}
      ${H.map((h, i) => `<text x="${x(i)}" y="${Hh - 9}" text-anchor="middle" class="cpm-ax">${String(h).padStart(2, '0')}</text>`).join('')}
      ${H.map((h, i) => `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${Hh - T0}" class="cpmdr-hit" data-drill-i="${i}" data-drill-t="${esc(t)}"><title>${esc(`${hl(h)} — click to see who feeds it`)}</title></rect>`).join('')}
    </svg>`;
  };
  // a technology's hours, with the day in the last column: summed, or (tot) the load / what's left / the difference for the day
  const table = (t) => { const X0 = d.tech[t]; const X = V(t); const sum = (a) => a.reduce((p, q) => p + (q || 0), 0);
    const r = (label, a, f = cpmK, cls = () => '', tot = sum(a)) => `<tr><th>${label}</th>${a.map((v, i) => `<td class="num ${cls(v, i)}">${v === null ? '—' : f(v)}</td>`).join('')}<td class="num cpm-daytot ${tot === null ? '' : cls(tot, -1)}">${tot === null || tot === undefined ? '—' : f(tot)}</td></tr>`;
    const cards = view === 'cards'; const dev = X.act ? X.need.map((v, i) => (v > 0.5 ? X.act[i] / v - 1 : null)) : null;
    const dayLoad = sum(X.cap) ? sum(X.need) / sum(X.cap) : null; const devCls = (v) => (v === null ? '' : `cpm-u ${Math.abs(v) <= 0.15 ? 'ok' : Math.abs(v) <= 0.35 ? 'warn' : 'bad'}`);
    return `<div class="kdb-scroll"><table class="log small cpm-t"><thead><tr><th></th>${H.map((h) => `<th class="num">${String(h).padStart(2, '0')}</th>`).join('')}<th class="num cpm-daytot">Day</th></tr></thead><tbody>
      ${r(cards ? `Daily ${U}` : 'Daily (÷ OEE)', X.daily)}${X.prio ? DP.slice(0, 2).map(([k, l]) => { const a = H.map((_, i) => prioAt(X, i)[k]); return a.some((v) => v > 0.5) ? r(`<span class="muted">of which ${l}</span>`, a) : ''; }).join('') : ''}${H.some((_, i) => addedIn(t, X, i).d > 0.5) ? r('<span class="cpm-added-t">of which added</span>', H.map((_, i) => addedIn(t, X, i).d)) : ''}${r(cards ? `Renewal ${U} (Low)` : 'Renewals: Low (÷ OEE)', X.rnw)}${H.some((_, i) => addedIn(t, X, i).r > 0.5) ? r('<span class="cpm-added-t">of which added</span>', H.map((_, i) => addedIn(t, X, i).r)) : ''}${r(cards ? Ucap : 'Needed', X.need)}${r(cards ? 'Capacity × OEE' : 'Capacity', X.cap)}
      ${X.ghost ? r(view === 'cards' ? 'As it comes in' : 'As it comes in (÷ OEE)', X.ghost, cpmK, () => 'muted') : ''}
      ${r('Load', X.load, cpmPct, (v) => `cpm-u ${cpmUtilCls(v)}`, dayLoad)}${X.backlog.some((v) => v > 0.5) ? r(X.blocks ? '<span title="Day: what\'s left at the end of the day">Waiting (or running) at the hour\'s end</span>' : '<span title="Day: what\'s left at the end of the day">Carried over</span>', X.backlog, cpmK, (v) => (v > 0.5 ? 'pl-late' : ''), X.backlog[23]) : ''}
      ${!X.blocks && lateOf(t).some((v) => v > 0.5) ? r('<span title="Done after its customer\'s cut-off, the day worked in the order it comes in (each piece in the next hour with spare capacity) — by the hour it\'s done">⚠ After its cut-off</span>', lateOf(t), (v) => (v > 0.5 ? cpmK(v) : ''), (v) => (v > 0.5 ? 'pl-late' : '')) : ''}
      ${X.act ? r(`<span title="${esc(`An average working day's cards from the timing report (${d.actual.which}: ${d.actual.days} days)`)}">Really persoed</span>`, X.act) + r('Real vs model', dev, (v) => `${v >= 0 ? '+' : ''}${cpmPct(v)}`, devCls, sum(X.need) ? sum(X.act) / sum(X.need) - 1 : null) : ''}
      ${!cards && X0.idle?.some((v) => v > 0.5) ? r('<span title="Hours a restricted machine has left after the work it may run — no one else may use them, so they\'re not capacity">Idle on restricted machines</span>', X0.idle, (v) => (v > 0.5 ? cpmK(v) : ''), () => 'muted') : ''}</tbody></table></div>`; };
  // each technology's day as a sum: the month's forecast ÷ its working days → cards a day → ÷ OEE
  const sumUp = (t) => { const rs = d.rows.filter((r) => r.tech === t); const month = rs.reduce((a, r) => a + r.month_volume, 0); const cardsDay = rs.reduce((a, r) => a + r.daily + r.renew, 0);
    return `<div class="small cpm-sum" title="Each customer's month (forecast × split${d.flex ? ' × flex' : ''}${d.scenario ? ', with the scenario' : ''}), ÷ ${d.workdays} working days; daily work ÷ its OEE, renewals ÷ (OEE + ${Math.round(d.bonus * 100)} points)">${cpmK(month)} a month ÷ ${d.workdays} days = <b>${cpmK(cardsDay)}</b> ${U} a day → <b>${cpmK(d.tech[t].total.need)}</b> needed (÷ OEE)</div>`; };
  const tiles = T.map((t) => { const x = d.tech[t].total;
    return `<div class="kdb-tile cpm-tile" style="border-top-color:${cpmTc(t)}"><div class="kdb-tile-l">${CPM_TECH_ICON[t] || ''} <b style="color:${cpmTc(t)}">${esc(t)}</b> — a day</div><div class="kdb-tile-v ${cpmUtilCls(x.load) === 'bad' ? 'kdb-bad' : ''}">${cpmPct(x.load)}</div>
      <div class="kdb-tile-s">${view === 'cards' ? (() => { const v = V(t); const a = d.tech[t].cards.actual; return `${cpmK(v.need.reduce((p, q) => p + q, 0))} ${U} of ${cpmK(v.cap.reduce((p, q) => p + q, 0))} it can do${a ? ` · <span title="An average working day (${esc(d.actual.which)})">really ${cpmK(a.reduce((p, q) => p + q, 0))}</span>` : ''}`; })() : `${cpmK(x.need)} needed of ${cpmK(x.capacity)}`} · <b class="${x.hours_over ? 'pl-late' : 'pl-ok'}">${x.hours_over} hour${x.hours_over === 1 ? '' : 's'} over</b>${x.end_backlog > 0.5 ? ` · <b class="pl-late">${cpmK(x.end_backlog)} left at the end of the day</b>` : ''}${(() => { const lc = d.tech[t].smooth.late_cards || 0; return lc > 0.5 ? ` · <b class="pl-late" title="${esc(lateCust(t).map((r) => `${r.trigram || r.name}: ${cpmN(r.late_cards)}`).join(' · '))}">⚠ ${cpmK(lc)} ${U} after their cut-off</b>` : ' · <span class="pl-ok">all before its cut-off</span>'; })()}${x.idle > 0.5 ? ` · <span class="muted">${cpmK(x.idle)} idle on restricted machines</span>` : ''}</div>${sumUp(t)}</div>`; }).join('');
  // the Gantt: where each customer's day lands
  const rowsShown = store.get('cpmDayAll', false) ? d.rows : d.rows.slice(0, 40); const hrs = (r) => (view === 'cards' ? r.cards_hours : r.hours); const top = Math.max(1, ...d.rows.flatMap(hrs));
  const gantt = `<div class="kdb-scroll"><table class="log small cpm-gantt"><thead><tr><th>Customer</th><th>Tech</th><th class="num" title="The month's forecast for this technology (× split${flex ? ' × flex' : ''})">Month</th><th class="num" title="Renewals: Low priority work orders — learned on an average day, or set in Configuration › CPM Daily (bold)">Renewals %</th>${showPrio ? '<th class="num" title="Its daily work by priority: Urgent · High · Normal — learned from its work orders on an average day, or set in Configuration › CPM Daily (bold)">Priority</th>' : ''}<th class="num">OEE</th><th class="num" title="Daily cards a day ÷ OEE">Daily /day</th><th class="num" title="Renewal cards a day ÷ (OEE + ${Math.round(d.bonus * 100)} points)">RNW /day</th><th class="num" title="Its usual work order (median, lately) — Work orders cuts its day into blocks of this size">Order</th><th class="num" title="When its daily work typically comes in (its work orders' arrival in the hourly export, a weighted average) — and how many of its orders were timed; else when it was produced">Arrives</th><th class="num" title="Its commonest shipping cut-off lately — work done after it counts as late">Cut-off</th><th class="num" title="Its cards done after its cut-off, the day worked in the order it comes in (each piece in the next hour with spare capacity)">Late</th>${H.map((h) => `<th class="num">${String(h).padStart(2, '0')}</th>`).join('')}</tr></thead><tbody>
    ${rowsShown.map((r) => `<tr class="${r.late_cards > 0.5 ? 'cpm-g-late' : ''} ${r.added ? 'cpm-g-added' : ''}"><td class="cpm-g-name" title="${esc(r.name)}"><b>${esc(r.trigram || '—')}</b> <span class="muted">${esc(r.name)}</span></td><td style="color:${cpmTc(r.tech)}"><b>${esc(r.tech)}</b></td><td class="num">${cpmK(r.month_volume)}</td>
      <td class="num ${r.rnw_typed !== null && r.rnw_typed !== undefined ? 'cpm-manual' : 'muted'}" title="${r.rnw_typed !== null && r.rnw_typed !== undefined ? 'Set in Configuration › CPM Daily' : `Learned: an average day's renewals${r.rnw_learned_days ? ` (${r.rnw_learned_days} days)` : ''} — set it in Configuration › CPM Daily`}">${cpmPct(r.rnw_pct)}</td>
      ${showPrio ? `<td class="num small ${r.prio_from === 'typed' ? 'cpm-manual' : 'muted'}" title="${esc({ typed: 'Set in Configuration › CPM Daily', learned: `Learned from its work orders (${r.prio_days} days)`, everyone: 'Too few of its own work orders: everyone\'s', none: 'No work orders seen: all Normal' }[r.prio_from] || '')}">${r.prio ? cpmPrioMix(r.prio, ['urgent', 'high', 'normal']) : '—'}</td>` : ''}
      <td class="num" ${r.oee_match !== undefined ? `title="${esc(`Its Matching OEE${r.oee_from && r.oee_from !== 'default' ? ` (${r.oee_from})` : ''}${r.speed_factor && Math.abs(r.speed_factor - 1) > 0.005 ? ` · its own speed: × ${r.speed_factor.toFixed(2)} machine time` : ''} · ${cpmPct(r.ratio)} of its cards through Matching (${r.ratio_from})`)}"` : ''}>${cpmPct(r.oee_match ?? r.oee)}${r.oee_from && r.oee_from !== 'default' ? ` <span class="muted small">${esc(r.oee_from)}</span>` : ''}</td><td class="num" ${r.peak ? `title="${esc(`Worst case: × ${r.peak.factor.toFixed(2)} — ${r.peak.own ? 'its' : 'everyone\'s'} busiest day lately (${r.peak.day}, ${cpmN(r.peak.peak)} cards) ÷ the average day (${cpmN(r.peak.avg)})`)}"` : ''}>${cpmK(r.need_daily)}${r.peak && r.peak.factor > 1.005 ? ` <span class="small pl-warn">×${r.peak.factor.toFixed(1)}</span>` : ''}</td><td class="num">${r.need_rnw ? cpmK(r.need_rnw) : ''}</td><td class="num">${d.blocks?.sizes?.[`${r.trigram || r.name}|${r.tech}`] ? cpmK(d.blocks.sizes[`${r.trigram || r.name}|${r.tech}`]) : '—'}</td><td class="num" title="${esc({ manual: 'set by hand in Run periods', 'manual-default': 'set by hand in Run periods (everyone else)', 'arrivals-own': `its own work orders' arrival${r.arrive_seen ? ` (${r.arrive_seen} timed)` : ''}`, 'arrivals-technology': `not enough of its own orders timed — all ${r.tech} arrivals`, own: 'when its cards were produced', technology: `when ${r.tech} cards were produced`, even: 'no data — spread evenly' }[r.profile] || '')}">${r.arrive_avg === null || r.arrive_avg === undefined ? '—' : `${String(Math.floor(r.arrive_avg)).padStart(2, '0')}:${String(Math.floor((r.arrive_avg % 1) * 60)).padStart(2, '0')}`}<span class="muted small">${r.profile === 'manual' || r.profile === 'manual-default' ? ' · manual' : r.profile === 'arrivals-own' ? (r.arrive_seen ? ` · ${r.arrive_seen}` : '') : r.profile === 'arrivals-technology' ? ' · tech' : r.profile === 'even' ? '' : ' · prod.'}</span></td><td class="num">${r.trigram ? `<input type="time" class="cpm-cut-in ${r.cutoff_typed ? 'cpm-manual' : r.cutoff_default ? 'cpm-cut-def' : ''}" data-tri="${esc(r.trigram)}" value="${esc(r.cutoff_typed || hhmm(r.cutoff_learned) || d.cutoff_default)}" title="${r.cutoff_typed ? `Set here — ${r.cutoff_learned === null ? `none learned, the default is ${d.cutoff_default}` : `learned: ${hhmm(r.cutoff_learned)}`} (clear to go back)` : r.cutoff_default ? `None registered — the default shipment time (${d.cutoff_default}, set in Shipment times); type a time to set its own` : 'Learned from its work orders — type a time to set it'}">` : hhmm(r.cutoff) || '—'}</td><td class="num" style="white-space:nowrap">${r.late_cards > 0.5 ? `<b class="pl-late" title="${esc(`${cpmN(r.late_cards)} cards (${cpmPct(r.late_cards / (r.daily || 1))} of its daily work) done after ${hhmm(r.cutoff) || 'its cut-off'}`)}">⚠ ${cpmK(r.late_cards)}</b>` : ''}</td>
      ${hrs(r).map((v, i) => `<td class="cpm-heat" data-drill-i="${i}" data-drill-t="${esc(r.tech)}" data-drill-c="${esc(r.trigram || r.name)}" style="--a:${Math.min(1, v / top).toFixed(3)};--c:${cpmTc(r.tech)}" title="${esc(`${r.trigram || r.name} ${r.tech} ${hl(H[i])}: ${cpmN(v)} (${cpmPct(r.shares[i])} of its day — ${{ manual: 'its run periods, set by hand', 'manual-default': 'the run periods set for everyone else', 'arrivals-own': 'when its work orders arrive', 'arrivals-technology': `when ${r.tech} work orders arrive`, own: 'its own runs', technology: `all ${r.tech} runs` }[r.profile] || 'spread evenly'})`)}">${v >= 0.5 && v / top > 0.08 ? esc(cpmK(v)) : ''}</td>`).join('')}</tr>`).join('')}
    </tbody><tfoot>${[...T.filter((t) => d.rows.some((r) => r.tech === t)).map((t) => [t, d.rows.filter((r) => r.tech === t)]), ...(T.filter((t) => d.rows.some((r) => r.tech === t)).length > 1 ? [['', d.rows]] : [])].map(([t, rs]) => {
      const sum = (f) => rs.reduce((a, r) => a + (f(r) || 0), 0); const month = sum((r) => r.month_volume); const rnwM = sum((r) => r.month_volume * r.rnw_pct);
      const cardsDay = sum((r) => r.daily); const needDay = sum((r) => r.need_daily); const hs = H.map((_, i) => sum((r) => hrs(r)[i]));
      return `<tr class="cpm-gtot ${t ? '' : 'cpm-gtot-all'}"><th>${t ? `${esc(t)} total` : 'All technologies'} <span class="muted small">(${rs.length} line${rs.length === 1 ? '' : 's'})</span></th><td>${t ? `<b style="color:${cpmTc(t)}">${esc(t)}</b>` : ''}</td><td class="num">${cpmK(month)}</td>
        <td class="num" title="Of the month's cards">${month ? cpmPct(rnwM / month) : '—'}</td>${showPrio ? '<td></td>' : ''}<td class="num" title="The daily cards ÷ the capacity they need">${needDay ? cpmPct(cardsDay / needDay) : '—'}</td><td class="num">${cpmK(needDay)}</td><td class="num">${cpmK(sum((r) => r.need_rnw))}</td><td></td><td></td><td></td><td class="num">${sum((r) => r.late_cards) > 0.5 ? `<b class="pl-late">${cpmK(sum((r) => r.late_cards))}</b>` : ''}</td>
        ${hs.map((v) => `<td class="num">${v >= 0.5 ? cpmK(v) : ''}</td>`).join('')}</tr>`; }).join('')}</tfoot></table></div>${d.rows.length > 40 ? `<button class="small" id="cpm-day-all">${store.get('cpmDayAll', false) ? 'Show the 40 biggest' : `Show all ${d.rows.length}`}</button>` : ''}`;
  // renewal windows
  const win = `<div class="cpm-win">${T.map((t) => `<div class="row" style="gap:6px;align-items:center;flex-wrap:wrap"><b style="color:${cpmTc(t)};min-width:64px">${esc(t)}</b>
      ${H.map((h, i) => `<button type="button" class="cpm-hr ${(d.windows[t] || []).includes(h) ? 'on' : ''} ${d.worked[i] ? '' : 'off'}" data-win="${t}" data-h="${h}" style="--c:${cpmTc(t)}">${String(h).padStart(2, '0')}</button>`).join('')}
      <span class="small muted" data-win-note="${t}">${(d.windows[t] || []).length ? `${cpmK(d.renewals[t].need)} a day over ${d.windows[t].length} h` : `none set — renewals (${cpmK(d.renewals[t].need)} a day) spread over every hour worked`}</span></div>`).join('')}</div>`;
  const techCard = (t) => { const S = d.tech[t].smooth; const X0 = d.tech[t]; const sm = smoothed(t);
    const peak0 = Math.max(...X0.load.map((v) => v || 0));
    return `<div class="cpm-tech" data-tech-card="${t}"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><h4 class="cpm-tech-h" style="margin:0;border-left-color:${cpmTc(t)}"><span style="color:${cpmTc(t)}">${esc(t)}</span></h4>
      <div class="seg cpm-mini"><button type="button" data-cpm-sm="${t}" data-v="arrive" class="${modeOf(t) === 'arrive' ? 'on' : ''}">As it comes in</button><button type="button" data-cpm-sm="${t}" data-v="smooth" class="${modeOf(t) === 'smooth' ? 'on' : ''}" title="The daily work done in the order it comes in, what doesn't fit moved to the next hour with spare capacity">Smoothed capacity</button>${d.blocks ? `<button type="button" data-cpm-sm="${t}" data-v="blocks" class="${modeOf(t) === 'blocks' ? 'on' : ''}" title="Each customer's day as work orders of its usual size, run start to finish on the first free machine, first come first served">Work orders</button>` : ''}</div></div>
      ${modeOf(t) === 'blocks' ? blockNote(t) : ''}
      ${sm ? `<div class="small cpm-sm-note">Daily work done Urgent first, then High, then Normal — each in the order it comes in, each piece in the next hour with spare capacity — ahead of the renewals, which take what's left from their window on (Low priority, they can be rescheduled): peak load <b>${cpmPct(peak0)}</b> → <b class="${S.peak > 1.005 ? 'pl-late' : 'pl-ok'}">${cpmPct(S.peak)}</b> · hours over ${X0.total.hours_over} → <b class="${S.hours_over ? 'pl-late' : 'pl-ok'}">${S.hours_over}</b>${S.late > 0.5 ? ` · <span class="pl-late">${cpmK(S.late)} needed done after its cut-off</span>${S.late_prio && showPrio ? ` <span class="muted">(cards: ${DP.map(([k, l]) => `${l} ${cpmK(S.late_prio[k] || 0)}`).join(' · ')})</span>` : ''}` : ' · <span class="pl-ok">everything done before its cut-off</span>'}${S.unplaced > 0.5 ? ` · <span class="pl-late">${cpmK(S.unplaced)} fits nowhere in the day</span>` : ''}${S.rnw_deferred > 0.5 ? ` · <span class="pl-warn" title="Renewals left for another day: the daily work took their capacity">${cpmK(view === 'cards' ? S.rnw_deferred_cards : S.rnw_deferred)} renewals put off to another day</span>` : ''}</div>` : ''}
      <div class="cpm-legend">${d.tech[t].prio && showPrio ? `${cpmPrioLegend(cpmTc(t), ['urgent', 'high', 'normal'])}<span class="muted">daily ${view === 'cards' ? U : '(÷ OEE)'}</span>` : `<span><i class="sw" style="background:${cpmTc(t)}"></i>Daily ${view === 'cards' ? 'cards' : '(÷ OEE)'}</span>`}<span><i class="sw cpm-rnw-sw" style="background:${cpmTc(t)}"></i>Renewals (Low)</span>${H.some((_, i) => addedOf(t, i) > 0.5 || addedRnwOf(t, i) > 0.5) ? '<span><i class="sw cpm-added-sw"></i>Added: scenario volume / campaigns (lighter on renewals)</span>' : ''}<span><i class="ln"></i>${view === 'cards' ? 'Capacity × OEE (cards it can do)' : 'Capacity'}</span>${view === 'cards' && d.tech[t].cards.actual ? '<span><i class="cpm-actdot-sw"></i>Really persoed, an average working day</span>' : ''}<span><i class="ln dash cpm-bl-sw"></i>${modeOf(t) === 'blocks' ? 'Waiting (or running) at the hour\'s end' : 'Carried over to the next hour'}</span>${modeOf(t) !== 'arrive' ? '<span><i class="sw cpm-ghost-sw"></i>as it comes in</span>' : ''}${modeOf(t) === 'blocks' ? '<span><i class="sw cpm-blk-late-sw"></i>finishes after its cut-off</span>' : ''}${d.cutoffs.length ? '<span><i class="ln cpm-cut-sw"></i>shipment times</span>' : ''}<span class="muted">red outline: more needed than the hour has</span></div>
      ${chart(t)}${modeOf(t) === 'blocks' ? sub(`gantt_${t}`, 'Machines', machineGantt(t)) : ''}${sub(`tbl_${t}`, 'Hour by hour table', table(t))}</div>`; };
  // campaigns: a customer's flat number of cards over some days, laid on top of the forecast (all months they touch)
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(new Date(year, month, 0).getDate()).padStart(2, '0')}`; const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const campTris = [...new Set(d.rows.filter((r) => r.trigram && !r.added).map((r) => r.trigram))].sort();
  const campRow = (c, i) => `<tr class="cpm-camp" data-i="${i}"><td><input type="checkbox" class="cpm-camp-on" ${c.off ? '' : 'checked'} title="On: counted in the day"></td>
      <td><input type="text" class="cpm-camp-name" value="${esc(c.name || '')}" placeholder="e.g. Spring reissue" style="width:170px"></td>
      <td><input type="text" class="cpm-camp-cust" list="cpm-camp-dl" value="${esc(c.customer || '')}" placeholder="Trigram" style="width:80px;text-transform:uppercase"></td>
      <td><input type="number" class="cpm-camp-qty" min="0" step="1" value="${esc(c.qty ?? '')}" placeholder="Cards" style="width:110px"></td>
      <td><select class="cpm-camp-kind" title="Daily: timed as the customer's own day (its run periods). Renewals: spread over its technologies' renewal windows, at the renewal OEE"><option value="daily" ${c.kind === 'renewal' ? '' : 'selected'}>Daily</option><option value="renewal" ${c.kind === 'renewal' ? 'selected' : ''}>Renewal</option></select></td>
      <td><input type="date" class="cpm-camp-from" value="${esc(c.from || monthStart)}"></td><td><input type="date" class="cpm-camp-to" value="${esc(c.to || monthEnd)}"></td>
      <td class="small muted cpm-camp-per"></td><td><input type="checkbox" class="cpm-camp-match" ${c.match === false ? '' : 'checked'} title="Through Matching too: its cards × the customer's share through Matching, on CPM Daily's Matching view"></td><td><button class="link small cpm-camp-rm" title="Remove">✕</button></td></tr>`;
  const campCard = () => `<div class="card" id="cpm-camps"><h3 class="pl-h">Campaigns <span class="muted small">— a customer's flat number of cards over some days, on top of its forecast: spread over the working days between the dates, on the customer's technology split; daily work is timed as the customer's own day, renewals go in its technologies' renewal windows; drawn in <b class="cpm-added-t">orange</b> on its technologies</span></h3>
      <datalist id="cpm-camp-dl">${campTris.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <div class="kdb-scroll"><table class="log small"><thead><tr><th title="Counted">On</th><th>Campaign</th><th>Customer</th><th>Cards in all</th><th>As</th><th>From</th><th>Until</th><th>A working day</th><th title="Through Matching too">Matching</th><th></th></tr></thead><tbody id="cpm-camp-body">${(d.campaigns || []).map(campRow).join('')}</tbody></table></div>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center"><button class="small" id="cpm-camp-add">+ Add a campaign</button>
        <div class="spacer"></div><span class="small pl-warn" id="cpm-camp-dirty" hidden>Not saved yet</span><button class="small" id="cpm-camp-undo" disabled>Undo changes</button><button class="small primary" id="cpm-camp-save" disabled>💾 Save</button></div></div>`;
  // the technologies' day charts in one card: All, or one picked with the small tab (remembered)
  const techSel = () => { if (T.length === 1) return T[0]; const v = store.get('cpmDayTech', 'all'); return T.includes(v) ? v : 'all'; };
  const allMode = () => { const m = store.get('cpmDayModeAll', 'arrive'); return m === 'smooth' || (m === 'blocks' && d.blocks) ? m : 'arrive'; };
  const allChart = () => {
    const mo = allMode(); const XS = Object.fromEntries(T.map((t) => [t, V(t, mo)]));
    const W = 1100; const Hh = 300; const L = 50; const B = 28; const T0 = 26;
    const { max, ticks } = cpmScale(Math.max(1, ...T.flatMap((t) => [...XS[t].need, ...XS[t].cap])) * 1.1);
    const slot = (W - L - 6) / 24; const gw = slot * 0.84; const bw = gw / T.length; const y = (v) => T0 + (Hh - T0 - B) * (1 - v / max);
    const step = (a) => a.map((c, i) => `${i ? 'L' : 'M'}${L + i * slot},${y(c)} L${L + (i + 1) * slot},${y(c)}`).join(' ');
    return `<svg class="cpm-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="xMinYMin meet">${CPM_PRIO_DEFS}
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
      ${H.map((h, i) => (d.worked[i] ? '' : `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${Hh - T0 - B}" class="cpm-off"/>`)).join('')}
      ${cutX(L, slot).map((cx, k) => (cx === null ? '' : `<line x1="${cx}" x2="${cx}" y1="${T0 - 14}" y2="${Hh - B}" class="cpm-cut"/><text x="${cx}" y="${T0 - 16}" text-anchor="middle" class="cpm-ax cpm-cut-l"><title>${esc(cutTitle(k))}</title>${esc(cutLabel(k))}</text>`)).join('')}
      ${H.map((h, i) => T.map((t, k) => { const X = XS[t]; const a = X.daily[i] || 0; const r = X.rnw[i] || 0; const over = X.need[i] > X.cap[i] + 0.5; const x0 = L + i * slot + (slot - gw) / 2 + k * bw;
        return `<g><title>${esc(`${t} ${hl(h)}: daily ${cpmN(a)}${prioTxt(X, i)} + renewals (Low) ${cpmN(r)} = ${cpmN(X.need[i])} ${view === 'cards' ? 'cards' : 'needed'} · capacity ${cpmN(X.cap[i])}${X.cap[i] ? ` (${cpmPct(X.need[i] / X.cap[i])})` : ''}`)}</title>
          ${dailyRects(x0, bw * 0.92, t, X, i, y, over)}
          ${addedRect(x0, bw * 0.92, a, addedIn(t, X, i).d, y, t, h)}
          <rect x="${x0}" y="${y(a + r)}" width="${bw * 0.92}" height="${Math.max(0, y(a) - y(a + r))}" style="fill:${cpmTc(t)}" class="cpm-rnw"/>
          ${addedRnwRect(x0, bw * 0.92, a, r, addedIn(t, X, i).r, y, t, h)}</g>`; }).join('')).join('')}
      ${T.map((t) => `<path d="${step(XS[t].cap)}" fill="none" class="cpm-capt" style="stroke:${cpmTc(t)}"><title>${esc(`${t} capacity`)}</title></path>`).join('')}
      ${H.map((h, i) => `<text x="${L + (i + 0.5) * slot}" y="${Hh - 9}" text-anchor="middle" class="cpm-ax">${String(h).padStart(2, '0')}</text>`).join('')}
      ${H.map((h, i) => `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${Hh - T0}" class="cpmdr-hit" data-drill-i="${i}" data-drill-t="all"><title>${esc(`${hl(h)} — click to see who feeds it`)}</title></rect>`).join('')}
    </svg>`;
  };
  // All's table: each technology's needed, capacity and load by the hour, with the day
  const allTable = () => { const mo = allMode(); const sum = (a) => a.reduce((p2, q2) => p2 + (q2 || 0), 0);
    const rowsA = T.map((t) => { const X = V(t, mo); const dayL = sum(X.cap) ? sum(X.need) / sum(X.cap) : null;
      return `<tr><th style="color:${cpmTc(t)}">${esc(t)} needed</th>${X.need.map((v) => `<td class="num">${cpmK(v)}</td>`).join('')}<td class="num"><b>${cpmK(sum(X.need))}</b></td></tr>
        <tr><th>${esc(t)} capacity</th>${X.cap.map((v) => `<td class="num muted">${cpmK(v)}</td>`).join('')}<td class="num">${cpmK(sum(X.cap))}</td></tr>
        <tr class="cpm-all-load"><th>${esc(t)} load</th>${X.need.map((v, i) => `<td class="num cpm-u ${cpmUtilCls(X.cap[i] ? v / X.cap[i] : v > 0.5 ? 9 : 0)}">${X.cap[i] ? cpmPct(v / X.cap[i]) : v > 0.5 ? '—' : ''}</td>`).join('')}<td class="num cpm-u ${cpmUtilCls(dayL || 0)}">${cpmPct(dayL)}</td></tr>`; }).join('');
    return `<div class="kdb-scroll"><table class="log small cpm-t"><thead><tr><th></th>${H.map((h) => `<th class="num">${String(h).padStart(2, '0')}</th>`).join('')}<th class="num">Day</th></tr></thead><tbody>${rowsA}</tbody></table></div>`; };
  const allSection = () => { const mo = allMode();
    return `<div class="cpm-tech" data-tech-all><div class="row" style="justify-content:flex-end;gap:8px;flex-wrap:wrap">
      <div class="seg cpm-mini"><button type="button" data-cpm-allm="arrive" class="${mo === 'arrive' ? 'on' : ''}">As it comes in</button><button type="button" data-cpm-allm="smooth" class="${mo === 'smooth' ? 'on' : ''}" title="The daily work done in the order it comes in, what doesn't fit moved to the next hour with spare capacity">Smoothed capacity</button>${d.blocks ? `<button type="button" data-cpm-allm="blocks" class="${mo === 'blocks' ? 'on' : ''}" title="Each customer's day as work orders of its usual size, run start to finish on the first free machine">Work orders</button>` : ''}</div></div>
      <div class="cpm-legend">${T.map((t) => `<span><i class="sw" style="background:${cpmTc(t)}"></i>${esc(t)}</span>`).join('')}${showPrio ? `<span><i class="sw" style="${cpmPrioSw('var(--muted)', 'urgent')}"></i>Urgent</span><span><i class="sw" style="${cpmPrioSw('var(--muted)', 'high')}"></i>High (from the bottom; then Normal)</span>` : ''}<span><i class="sw cpm-rnw-sw" style="background:var(--muted)"></i>renewals: Low (lighter)</span>${anyAdded ? '<span><i class="sw cpm-added-sw"></i>added: scenario volume / campaigns</span>' : ''}${T.map((t) => `<span><i class="ln" style="border-top-color:${cpmTc(t)}"></i>${esc(t)} capacity</span>`).join('')}<span><i class="sw cpm-sw-off"></i>not worked</span>${d.cutoffs.length ? '<span><i class="ln cpm-cut-sw"></i>shipment times</span>' : ''}<span class="muted">· click an hour to see who feeds it</span></div>
      ${allChart()}${sub('tbl_all', 'Hour by hour table', allTable())}</div>`; };
  const techsBody = () => (techSel() === 'all' ? allSection() : techCard(techSel()));
  const techsCard = () => `<div class="card" id="cpm-techs"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><h3 class="pl-h" style="margin:0">The day hour by hour</h3>
      <div class="seg cpm-mini" role="tablist" aria-label="Technology" ${T.length === 1 ? 'hidden' : ''}>${[['all', 'All'], ...T.map((t) => [t, t])].map(([k, l]) => `<button type="button" data-cpm-tsel="${esc(k)}" class="${techSel() === k ? 'on' : ''}" ${k === 'all' ? '' : `style="--c:${cpmTc(k)}"`}>${k === 'all' ? '' : CPM_TECH_ICON[k] || ''} ${esc(l)}</button>`).join('')}</div></div>
      <div id="cpm-techs-body">${techsBody()}</div></div>`;
  // a part of a section that folds on its own (remembered)
  const sub = (k, label, html) => `<details class="cpm-sub" data-sub="${k}" ${(store.get('cpmSubFold', {}) || {})[k] ? '' : 'open'}><summary>${label}</summary>${html}</details>`;
  // the work-order run on the machines that run this technology: a block per work order
  const machineGantt = (t) => {
    const ms = d.blocks.blocks.filter((m) => m.techs.includes(t)); if (!ms.length) return '';
    const W = 1100; const L = 70; const R = 6; const rowH = 22; const Hh = ms.length * rowH + 26; const x = (v) => L + (Math.max(0, Math.min(24, v)) / 24) * (W - L - R);
    const tris = [...new Set(ms.flatMap((m) => m.blocks.map((b) => b.customer)))]; const shade = (c) => 0.55 + 0.45 * ((tris.indexOf(c) % 4) / 3);
    return `<div class="cpm-gantt-wrap"><svg class="cpm-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="xMinYMin meet">
      ${H.map((h, i) => `<line x1="${x(i)}" x2="${x(i)}" y1="0" y2="${Hh - 18}" class="cpm-grid"/><text x="${x(i + 0.5)}" y="${Hh - 4}" text-anchor="middle" class="cpm-ax">${String(h).padStart(2, '0')}</text>`).join('')}
      ${cutX(L, (W - L - R) / 24).map((cx, k) => (cx === null ? '' : `<line x1="${cx}" x2="${cx}" y1="0" y2="${Hh - 18}" class="cpm-cut"/>`)).join('')}
      ${ms.map((m, k) => `<text x="${L - 6}" y="${k * rowH + 15}" text-anchor="end" class="cpm-ax"><tspan font-weight="600">${esc(m.name)}</tspan></text>
        ${m.blocks.map((b) => { const bx = x(b.start); const bw = Math.max(1, x(b.end) - x(b.start)); const col = cpmTc(b.tech);
          return `<g><title>${esc(`${b.name} · ${b.tech}${b.kind === 'renewal' ? ' renewals' : ''} · ${cpmN(b.cards)} cards · in ${hl2(b.arrived)} · run ${hl2(b.start)}–${hl2(b.end)}${b.deadline !== null ? ` · cut-off ${hl2(b.deadline)}` : ''}${b.late ? ' · LATE' : ''}${b.from_yesterday ? ' · came in the day before' : ''}`)}</title>
            <rect x="${bx}" y="${k * rowH + 3}" width="${bw}" height="${rowH - 6}" rx="2" style="fill:${col};opacity:${b.kind === 'renewal' ? 0.45 : shade(b.customer)}" class="${b.late ? 'cpm-blk-late' : 'cpm-blk'}"/>
            ${bw > 34 ? `<text x="${bx + bw / 2}" y="${k * rowH + 15}" text-anchor="middle" class="cpm-blk-l">${esc(String(b.customer).slice(0, 3))}</text>` : ''}</g>`; }).join('')}`).join('')}
    </svg></div>`;
  };
  const hl2 = (v) => { const c = ((H[0] + v) % 24 + 24) % 24; const day = v < 0 ? ' (the day before)' : v >= 24 ? ' (next day)' : ''; return `${String(Math.floor(c)).padStart(2, '0')}:${String(Math.floor((c % 1) * 60)).padStart(2, '0')}${day}`; };
  const blockNote = (t) => { const late = d.blocks.late.filter((o) => o.tech === t); const by = new Map(); for (const o of late) by.set(o.customer, (by.get(o.customer) || 0) + o.cards);
    return `<div class="small cpm-sm-note">Each customer's day as work orders of its usual size, coming in at its usual times, run start to finish on the first free ${esc(t)} machine, first come first served — daily work ahead of the renewals, which run in their window when nothing daily is waiting (stepping aside for it). ${late.length ? `<b class="pl-late">${late.length} work order${late.length === 1 ? '' : 's'} (${cpmK(late.reduce((a, o) => a + o.cards, 0))} ${U}) finish after their cut-off</b>: ${[...by].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, q]) => `${esc(c)} ${cpmK(q)}`).join(' · ')}` : '<b class="pl-ok">every work order finishes before its cut-off</b>'}</div>`; };
  // renewals vs daily, per customer and technology: learned (an average day) unless a % is typed
  const rnwRows = d.rows.filter((r) => r.trigram).sort((a, b) => String(a.trigram).localeCompare(String(b.trigram)) || T.indexOf(a.tech) - T.indexOf(b.tech));
  const rnwCard = `<div class="card"><h3 class="pl-h">Renewals and daily work <span class="muted small">— each customer's split of its forecast between daily work and renewals (Low priority work orders). Blank: learned — an average day's renewals ÷ its cards over the last 4 months, each day counting the same, so a bulk renewal run doesn't swamp the ordinary days. Type a % to set it.</span></h3>
      <div class="kdb-scroll"><table class="log small cpm-rnwt"><thead><tr><th>Customer</th><th>Tech</th><th class="num">Month</th><th class="num" title="Each day's renewals ÷ its cards, averaged over the days it had work">Learned (average day)</th><th class="num" title="All renewals ÷ all cards over the 4 months — the old way, skewed by bulk renewal runs">Over the whole period</th><th class="num">Renewals %</th><th class="num">Daily %</th></tr></thead><tbody>
      ${rnwRows.map((r) => { const typed = r.rnw_typed !== null && r.rnw_typed !== undefined;
        return `<tr><td><b>${esc(r.trigram)}</b> <span class="muted">${esc(r.name && r.name !== r.trigram ? r.name : '')}</span></td><td style="color:${cpmTc(r.tech)}"><b>${esc(r.tech)}</b></td><td class="num">${cpmK(r.month_volume)}</td>
          <td class="num">${r.rnw_learned === null || r.rnw_learned === undefined ? '<span class="muted">none seen</span>' : `${cpmPct(r.rnw_learned, 1)} <span class="muted small">${r.rnw_learned_days || 0} d</span>`}</td><td class="num muted">${r.rnw_learned_whole === null || r.rnw_learned_whole === undefined ? '' : cpmPct(r.rnw_learned_whole, 1)}</td>
          <td class="num"><input type="number" min="0" max="100" step="0.1" class="cpm-rnwc" data-k="${esc(`${r.trigram}|${r.tech}`)}" value="${typed ? Math.round(r.rnw_typed * 1000) / 10 : ''}" placeholder="${Math.round((r.rnw_learned || 0) * 1000) / 10}" style="width:80px"></td>
          <td class="num cpm-rnwc-daily">${cpmPct(1 - r.rnw_pct, 1)}</td></tr>`; }).join('') || '<tr><td colspan="7" class="muted">No customers in this month\'s forecast.</td></tr>'}</tbody></table></div>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center"><span class="small muted">Shown for the customers in the month picked above; a % set holds for every month.</span>
        <div class="spacer"></div><span class="small pl-warn" id="cpm-rnwc-dirty" hidden>Not saved yet</span><button class="small" id="cpm-rnwc-undo" disabled>Undo changes</button><button class="small primary" id="cpm-rnwc-save" disabled>💾 Save</button></div></div>`;
  // the daily work by priority, per customer: learned (an average day) unless typed (% of its daily work)
  const prioRows = [...new Map(d.rows.filter((r) => r.trigram && !r.added).map((r) => [r.trigram, r])).values()].sort((a, b) => String(a.trigram).localeCompare(String(b.trigram)));
  const prioIn = (r, k) => { const tv = (d.prio_typed || {})[r.trigram]; const v = tv && tv[k] !== undefined && tv[k] !== null ? Math.round(tv[k] * 1000) / 10 : ''; const ph = r.prio_learned ? Math.round(r.prio_learned[k] * 1000) / 10 : d.prio_all?.daily ? Math.round(d.prio_all.daily[k] * 1000) / 10 : 0;
    return `<input type="number" min="0" max="100" step="0.1" class="cpm-prc" data-tri="${esc(r.trigram)}" data-k="${k}" value="${v}" placeholder="${ph}" style="width:70px">`; };
  const prioCard = `<div class="card"><h3 class="pl-h">Priority of the daily work <span class="muted small">— each customer's daily work split into Urgent, High and Normal (Low is the renewals, above). CPM Daily's smoothing fits the Urgent work first, then High, then Normal, so Normal is what waits when the hours are full. Blank: learned from its work orders, an average day over the last 4 months${d.prio_all?.daily ? ` (everyone: ${cpmPrioMix(d.prio_all.daily, ['urgent', 'high', 'normal'])})` : ''}; type % of its daily work to set it — Normal is the rest.</span></h3>
      <div class="kdb-scroll"><table class="log small"><thead><tr><th>Customer</th><th class="num">Learned (average day)</th><th class="num">Urgent %</th><th class="num">High %</th><th class="num">Normal %</th></tr></thead><tbody>
      ${prioRows.map((r) => `<tr><td><b>${esc(r.trigram)}</b> <span class="muted">${esc(r.name && r.name !== r.trigram ? r.name : '')}</span></td><td class="num">${r.prio_learned ? `${cpmPrioMix(r.prio_learned, ['urgent', 'high', 'normal'])} <span class="muted small">${r.prio_days} d</span>` : '<span class="muted">too few — everyone\'s</span>'}</td>
        <td class="num">${prioIn(r, 'urgent')}</td><td class="num">${prioIn(r, 'high')}</td><td class="num cpm-prc-n" data-tri="${esc(r.trigram)}"></td></tr>`).join('') || '<tr><td colspan="5" class="muted">No customers in this month\'s forecast.</td></tr>'}</tbody></table></div>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center"><span class="small muted">Set both or either; one left blank counts as 0 once the other is set. Clear both to go back to learned.</span>
        <div class="spacer"></div><span class="small pl-warn" id="cpm-prc-dirty" hidden>Not saved yet</span><button class="small" id="cpm-prc-undo" disabled>Undo changes</button><button class="small primary" id="cpm-prc-save" disabled>💾 Save</button></div></div>`;
  const editCards = `${rnwCard}${prioCard}
    <div class="card"><h3 class="pl-h">Renewal windows <span class="muted small">— the hours each technology runs renewals (click to toggle); ${d.scenario?.changes?.some((c) => c.type === 'rnw_window') ? 'the scenario sets some — change them in Scenarios' : 'a scenario can set its own'}</span></h3>${win}
      <div class="row" style="gap:10px;margin-top:8px;align-items:center;flex-wrap:wrap"><label class="row small">Renewal OEE: the customer's + <input type="number" id="cpm-rnw-bonus" min="0" max="50" step="1" value="${Math.round(d.bonus * 100)}" style="width:60px"> points</label>
        <div class="spacer"></div><span class="small pl-warn" id="cpm-win-dirty" hidden>Not saved yet</span><button class="small" id="cpm-win-undo" disabled>Undo changes</button><button class="small primary" id="cpm-win-save" disabled>💾 Save</button></div></div>
    <div class="card"><h3 class="pl-h">Run periods <span class="muted small">— the % of each customer's daily work typically produced in each hour, as the Daily split sheet. Greyed: <b>when its cards were produced</b> (timing report, last 4 months); click into a row to set it (it starts from those figures), or <b>Set every row from when produced</b>. Paste from Excel into any cell to fill right and down. A customer's own row beats “Everyone else”, which beats what's learned.</span></h3>
      <div class="kdb-scroll"><table class="log small cpm-rp"><thead><tr><th>Customer</th>${H.map((h) => `<th class="num">${String(h).padStart(2, '0')}</th>`).join('')}<th class="num">Total</th><th></th></tr></thead><tbody>${gridCusts.map(gridRow).join('')}</tbody></table></div>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center"><button class="small" id="cpm-man-prod" title="Fill every row not set yet with when its cards were produced (the greyed figures) — then Save">⏱ Set every row from when produced</button><span class="small muted">A row that doesn't add up to 100% is scaled to it when used. Rows for one technology only (set before) stay as they are.</span>
        <div class="spacer"></div><span class="small pl-warn" id="cpm-man-dirty" hidden>Not saved yet</span><button class="small" id="cpm-man-undo" disabled>Undo changes</button><button class="small primary" id="cpm-man-save" disabled>💾 Save</button></div></div>
    <div class="card"><h3 class="pl-h">Shipment times <span class="muted small">— the cut-offs drawn on the charts; ${d.ship_times.own ? 'set here' : `learned from the work orders lately (${d.ship_times.learned.map((x) => x.time).join(', ') || 'none yet'})`}</span></h3>
      <div id="cpm-ship">${(d.ship_times.times || []).map((x, k) => shipRow(x, k)).join('')}</div>
      <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center"><button class="small" id="cpm-ship-add">+ Add a time</button>${d.ship_times.own ? `<button class="small" id="cpm-ship-learned" title="Drop the times set here and show the learned ones (${esc(d.ship_times.learned.map((x) => x.time).join(', ') || 'none')})">↺ Use the learned times</button>` : ''}
        <div class="spacer"></div><span class="small pl-warn" id="cpm-ship-dirty" hidden>Not saved yet</span><button class="small" id="cpm-ship-undo" disabled>Undo changes</button><button class="small primary" id="cpm-ship-save" disabled>💾 Save</button></div>
      <div class="row small" style="gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap"><label class="row" style="gap:6px;align-items:center">Default shipment time <input type="time" id="cpm-cut-def" value="${esc(d.cutoff_default)}" style="width:110px"></label><span class="muted">— for customers with none registered (none typed below, none learned from their work orders)</span></div>
      <p class="small muted" style="margin:6px 0 0">Each customer's own cut-off (what counts as late) is in CPM Daily's customer table — learned from its work orders, or typed there; greyed: the default. A deadline at 23:59 or 00:00 (a date with no time) doesn't count as a shipment time.</p></div>
`;
  if (settings) {
    body.innerHTML = `<div class="row pl-filters" style="gap:10px;flex-wrap:wrap;align-items:center">
      <select id="cpm-dayset-month" title="The month whose customers and renewals are shown">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === month ? 'selected' : ''}>${m} ${year}</option>`).join('')}</select>
      <span class="small muted">The hours renewals run, when each customer's day is produced and the shipment cut-offs used by CPM Daily. Saving here marks it out of date — ⟳ Regenerate it there.</span></div>${editCards}`;
    $('#cpm-dayset-month').onchange = (e) => { store.set('cpmDayMonth', Number(e.target.value)); renderCpm('dayset'); };
  } else {
  body.innerHTML = `
    <div class="row pl-filters" style="gap:10px;flex-wrap:wrap">${cpmLineSeg()}
      <select id="cpm-day-month">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === month ? 'selected' : ''}>${m} ${year}</option>`).join('')}</select>
      <label class="row small"><input type="checkbox" id="cpm-day-flex" ${flex ? 'checked' : ''}> apply flex</label>
      <select id="cpm-day-sc"><option value="0">Base plan</option>${scs.map((s) => `<option value="${s.id}" ${s.id === scId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <div class="seg" title="What the bars count"><button type="button" data-cpm-view="cards" class="${view === 'cards' ? 'on' : ''}">${Ucap}</button><button type="button" data-cpm-view="need" class="${view === 'need' ? 'on' : ''}">Capacity needed (÷ OEE)</button></div>
      <label class="row small" title="Split the daily work by priority — Urgent, High, Normal — from the work orders (Low being the renewals). Off: daily work and renewals, as the CPM sheet"><input type="checkbox" id="cpm-day-prio" ${showPrio ? 'checked' : ''}> by priority</label>
      ${MX ? '' : ddMenu('⚙ View', `<div class="dd-h">Daily work</div>
      <select id="cpm-day-prof" title="How each customer's daily work is spread over the day"><option value="arrival" ${d.profile_source === 'arrival' ? 'selected' : ''}>Daily work: when it arrives</option><option value="produced" ${d.profile_source === 'produced' ? 'selected' : ''}>Daily work: when it was produced</option></select>
      <select id="cpm-day-shape" title="How the days learned from are put together: lined up on the customer's usual time (keeps each day's clump), or simply added up (spread wide, as each day comes in at slightly different times)"><option value="typical" ${d.day_shape === 'typical' ? 'selected' : ''}>Learned: a typical day (clumped)</option><option value="worst" ${d.day_shape === 'worst' ? 'selected' : ''}>Worst case: busiest day, most clumped</option><option value="average" ${d.day_shape === 'average' ? 'selected' : ''}>Learned: all days averaged (wide)</option></select>
        <hr><a href="/api/cpm/day/export?${q}" download>⬇ Download as Excel</a>`, { title: 'How the day is learned, capacity, Excel', cls: 'dd-wide' })}
    </div>
    ${MX ? `${cpmMatchAbout(d)}` : `<details class="cpm-about small muted"><summary>ⓘ ${esc(d.label)} · ${d.workdays} working days · ${d.shifts} shift${d.shifts === 1 ? '' : 's'}${d.scenario ? ` · scenario <b>${esc(d.scenario.name)}</b>` : ''} · ${d.day_shape === 'worst' ? 'worst case' : d.day_shape === 'average' ? 'all days averaged' : 'a typical day'}</summary> ${d.profile_source === 'arrival' ? `each customer's daily work spread by when its work orders arrive (${cpmN(d.arrivals_seen || 0)} seen arriving in the hourly export, last 4 months)` : `each customer's day spread as its cards were produced (timing report, ${cpmN(d.learned.runs)} runs, last 4 months)`} · ${d.day_shape === 'worst' ? `<b>worst case</b>: each customer's daily work × its busiest day ÷ its average day lately (${d.peak_source === 'produced' ? 'cards produced a day' : 'work orders submitted a day'}), in its most clumped day` : d.day_shape === 'average' ? 'all days learned from averaged' : 'a typical day'} · real cards: ${d.actual.days ? `${esc(d.actual.which)}, ${d.actual.days} working days` : 'no runs'} · renewals = Low priority work orders (${cpmK(d.learned.renewals)} cards seen) · renewal OEE + ${Math.round(d.bonus * 100)} points</details>`}
    ${d.warnings.map((w) => `<div class="kc-note notice">${esc(w)}</div>`).join('')}
    ${(() => { const lt = T.filter((t) => (d.tech[t].smooth.late_cards || 0) > 0.5); if (!lt.length) return `<div class="cpm-late-ok small">Everything is done before its cut-off (the day worked in the order it comes in).</div>`;
      return `<div class="card cpm-late-note"><h3 class="cpm-late-h">Work pushed past its cut-off <span class="small muted">— the day worked in the order it comes in, each piece in the next hour with spare capacity; what's done after the customer's cut-off ships a day late</span></h3>${lt.map((t) => { const cs = lateCust(t);
        return `<div class="small"><b style="color:${cpmTc(t)}">${esc(t)}</b>: <b>${cpmK(d.tech[t].smooth.late_cards)} cards</b> — ${cs.slice(0, 8).map((r) => `<span title="${esc(r.name)}">${esc(r.trigram || r.name)} ${cpmK(r.late_cards)} <span class="muted">(after ${hhmm(r.cutoff) || '—'})</span></span>`).join(' · ')}${cs.length > 8 ? ` · and ${cs.length - 8} more` : ''}</div>`; }).join('')}</div>`; })()}
    <div class="kdb-tiles pl-tiles">${tiles}</div>
    ${campCard()}
    ${techsCard()}
    ${MX ? '' : `<div class="card" id="cpm-cmp"><h3 class="pl-h">Typical day · worst case · all days averaged <span class="muted small">— the same day with each way of learning when the work comes in: a typical day (each day's clump, at its usual time), the worst case (each customer's busiest day lately — its peak ÷ average day applied to the forecast — the most clumped day seen, at its usual time) and all days averaged (wide). Customers whose run periods are set by hand are the same in all three.</span></h3><p class="small muted">Working it out…</p></div>`}
    <div class="small muted cpm-set-link">${MX ? 'Matching\'s renewal window, OEE and share through Matching are set in <a href="#/cpm/match" title="Configuration, with Matching picked">Configuration › Matching</a>; shipment times in <a href="#/cpm/dayset">Configuration › CPM Daily</a>.' : 'Renewal windows, run periods and shipment times are set in <a href="#/cpm/dayset">Configuration › CPM Daily</a>.'}</div>
    <div class="card"><div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><h3 class="pl-h" style="margin:0">Customers hour by hour <span class="muted small">— ${view === 'cards' ? 'cards' : 'capacity needed (÷ OEE)'} per hour of daily work; renewals go in their windows (set in Configuration)</span></h3><span class="row" style="gap:6px"><button type="button" class="small primary" data-cpm-drill title="Open the day up: click an hour to see who and what feeds it, a customer for its day">🔎 Drill down</button><a class="button small" ${MX ? 'hidden' : ''} href="/api/cpm/day/customers.xlsx?${q}&view=${view}" download title="This table as an Excel workbook: every customer and technology (not only those shown), its hours as shown here, and the totals">⬇ Excel</a></span></div>${gantt}</div>`;
  $('#cpm-day-month').onchange = (e) => { store.set('cpmDayMonth', Number(e.target.value)); renderCpm('day'); };
  $('#cpm-day-flex').onchange = (e) => { store.set('cpmFlex', e.target.checked); renderCpm('day'); };
  $('#cpm-day-prio').onchange = (e) => { store.set('cpmShowPrio', e.target.checked); renderCpm('day'); };
  $('#cpm-day-sc').onchange = (e) => { store.set('cpmDayScenario', Number(e.target.value)); renderCpm('day'); };
  const wireSm = () => $$('[data-cpm-sm]').forEach((b) => { b.onclick = () => { const t = b.dataset.cpmSm; store.set(`cpmDayMode_${t}`, b.dataset.v); const el = $(`[data-tech-card="${t}"]`); el.outerHTML = techCard(t); wireSm(); }; });
  wireSm();
  $$('[data-cpm-tsel]').forEach((b) => { b.onclick = () => { store.set('cpmDayTech', b.dataset.cpmTsel); $$('[data-cpm-tsel]').forEach((x) => x.classList.toggle('on', x === b)); $('#cpm-techs-body').innerHTML = techsBody(); wireSm(); wireSub(); wireAll(); }; });
  const wireAll = () => $$('[data-cpm-allm]').forEach((b) => { b.onclick = () => { store.set('cpmDayModeAll', b.dataset.cpmAllm); $('#cpm-techs-body').innerHTML = techsBody(); wireSub(); wireAll(); }; });
  wireAll();
  $$('[data-cpm-view]').forEach((b) => { b.onclick = () => { store.set('cpmDayView2', b.dataset.cpmView); renderCpm('day'); }; });
  // the three ways of learning the day, side by side (worked out after the page is up)
  (async () => {
    const box = $('#cpm-cmp'); if (!box) return;
    let c; try { c = await api.get(`/cpm/day/compare?${q}${dayRegen ? '&regen=1' : ''}`); } catch (err) { box.querySelector('p').textContent = err.message; return; }
    if (!document.body.contains(box)) return;
    const SH = [['typical', 'Typical day', ''], ['worst', 'Worst case', 'cpm-cmp-worst'], ['average', 'All days averaged', 'cpm-cmp-avg']];
    const chart = (t) => { const W = 760; const Hh = 190; const L = 50; const B = 22; const T0 = 10; const n = c.hours.length; const x = (i) => L + ((i + 0.5) * (W - L - 6)) / n;
      const top = Math.max(1, ...c.capacity[t], ...SH.flatMap(([k]) => c.shapes[k][t].need)); const { max, ticks } = cpmScale(top * 1.05); const y = (v) => T0 + (Hh - T0 - B) * (1 - v / max);
      const line = (a) => a.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      return `<svg class="cpm-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="xMinYMin meet">
        ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
        <polyline fill="none" class="cpm-cmp-cap" points="${line(c.capacity[t])}"/>
        ${SH.slice().reverse().map(([k, label, cls]) => `<polyline fill="none" class="${cls}" stroke="${cpmTc(t)}" stroke-width="2.4" points="${line(c.shapes[k][t].need)}"><title>${esc(`${t} · ${label}`)}</title></polyline>`).join('')}
        ${c.hours.map((h, i) => `<text x="${x(i)}" y="${Hh - 6}" text-anchor="middle" class="cpm-ax">${String(h).padStart(2, '0')}</text>`).join('')}</svg>`; };
    const row = (t, [k, label]) => { const v = c.shapes[k][t];
      return `<tr><th>${label}</th><td class="num ${v.peak > 1 ? 'pl-late' : ''}">${cpmPct(v.peak)}</td><td class="num">${v.hours_over}</td><td class="num">${cpmK(v.over)}</td><td class="num">${cpmK(v.end_backlog)}</td><td class="num ${v.smooth.peak > 1 ? 'pl-late' : ''}">${cpmPct(v.smooth.peak)}</td><td class="num">${cpmK(v.smooth.late)}</td><td class="num">${v.blocks_late === null ? '—' : cpmK(v.blocks_late)}</td></tr>`; };
    box.querySelector('p').outerHTML = `<div class="cpm-legend"><span><i class="ln" style="border-top-color:var(--text)"></i>Typical day</span><span><i class="ln cpm-cmp-worst-sw"></i>Worst case</span><span><i class="ln dash"></i>All days averaged</span><span><i class="ln cpm-cmp-cap-sw"></i>capacity</span></div>
      ${c.techs.map((t) => `<h4 class="cpm-cmp-h" style="color:${cpmTc(t)}">${esc(t)} — capacity needed</h4>${chart(t)}
        <div class="kdb-scroll"><table class="log small"><thead><tr><th></th><th class="num">Peak load</th><th class="num">Hours over capacity</th><th class="num">Over capacity</th><th class="num">Left at the day's end</th><th class="num">Smoothed: peak</th><th class="num">Smoothed: late</th><th class="num">Work orders: late cards</th></tr></thead><tbody>${SH.map((sh) => row(t, sh)).join('')}</tbody></table></div>`).join('')}`;
  })();
  const wireSub = () => $$('.cpm-sub').forEach((el) => { el.ontoggle = () => { const o = store.get('cpmSubFold', {}) || {}; if (el.open) delete o[el.dataset.sub]; else o[el.dataset.sub] = 1; store.set('cpmSubFold', o); }; });
  wireSub();
  if (!MX) $('#cpm-day-shape').onchange = async (e) => { try { await api.put('/cpm/settings', { cpm_day_shape: e.target.value }); renderCpm('day'); } catch (err) { toast(err.message, 'error'); } };
  if (!MX) $('#cpm-day-prof').onchange = async (e) => { try { await api.put('/cpm/settings', { cpm_day_profile: e.target.value }); renderCpm('day'); } catch (err) { toast(err.message, 'error'); } };
  // 🔎 the drill-down: from the button, an hour cell of the table or an hour of a technology's chart
  body.onclick = (e) => {
    if (e.target.closest('[data-cpm-drill]')) { cpmDrill(d, { view, tech: techSel() }); return; }
    const h = e.target.closest('[data-drill-i]'); if (!h) return;
    cpmDrill(d, { view, tech: h.dataset.drillT, hour: Number(h.dataset.drillI), mark: h.dataset.drillC || null });
  };
  // campaigns: edited here, saved together
  const camp0 = JSON.stringify(d.campaigns || []);
  const campNow = () => $$('.cpm-camp').map((tr) => { const v = (c) => tr.querySelector(c).value.trim(); const o = { name: v('.cpm-camp-name'), customer: v('.cpm-camp-cust').toUpperCase(), qty: Number(v('.cpm-camp-qty')) || 0, from: v('.cpm-camp-from'), to: v('.cpm-camp-to') };
    if (tr.querySelector('.cpm-camp-kind').value === 'renewal') o.kind = 'renewal';
    if (!tr.querySelector('.cpm-camp-on').checked) o.off = true; if (!tr.querySelector('.cpm-camp-match').checked) o.match = false; return o; }).filter((c) => c.customer || c.qty || c.name);
  const workdaysBetween = (a, b) => { let n = 0; const wd = new Set(d.work_days || [1, 2, 3, 4, 5]); for (let x = new Date(`${a}T12:00`); x <= new Date(`${b}T12:00`); x.setDate(x.getDate() + 1)) if (wd.has(x.getDay())) n++; return n; };
  const campDirty = () => { const ch = JSON.stringify(campNow()) !== camp0; $('#cpm-camp-save').disabled = !ch; $('#cpm-camp-undo').disabled = !ch; $('#cpm-camp-dirty').hidden = !ch;
    for (const tr of $$('.cpm-camp')) { const q = Number(tr.querySelector('.cpm-camp-qty').value) || 0; const a = tr.querySelector('.cpm-camp-from').value; const b = tr.querySelector('.cpm-camp-to').value; const n = a && b && a <= b ? workdaysBetween(a, b) : 0;
      tr.querySelector('.cpm-camp-per').textContent = q && n ? `≈ ${cpmK(q / n)} (${n} days)` : ''; } };
  const wireCamp = () => { $$('.cpm-camp input, .cpm-camp select').forEach((i) => { i.oninput = campDirty; i.onchange = campDirty; }); $$('.cpm-camp-rm').forEach((b) => { b.onclick = () => { b.closest('tr').remove(); campDirty(); }; }); };
  wireCamp(); campDirty();
  $('#cpm-camp-add').onclick = () => { $('#cpm-camp-body').insertAdjacentHTML('beforeend', campRow({}, $$('.cpm-camp').length)); wireCamp(); $$('.cpm-camp-name').pop().focus(); campDirty(); };
  $('#cpm-camp-undo').onclick = () => { $('#cpm-camp-body').innerHTML = (d.campaigns || []).map(campRow).join(''); wireCamp(); campDirty(); };
  $('#cpm-camp-save').onclick = async () => { const list = campNow();
    const bad = list.find((c) => !c.customer || !c.qty || !c.from || !c.to || c.from > c.to); if (bad) { toast(`${bad.name || 'A campaign'}: give it a customer, a number of cards and its dates`, 'error'); return; }
    try { await api.put('/cpm/settings', { cpm_campaigns: JSON.stringify(list) }); toast('Campaigns saved'); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  const dayAll = $('#cpm-day-all'); if (dayAll) dayAll.onclick = () => { store.set('cpmDayAll', !store.get('cpmDayAll', false)); renderCpm('day'); };
  }
  // redraw the tab where it was (not back at the top)
  const redraw = async () => { const sc = document.scrollingElement; const m = main(); const y = [sc?.scrollTop || 0, m?.scrollTop || 0]; await renderCpm(settings ? 'dayset' : 'day'); if (sc) sc.scrollTop = y[0]; if (m) m.scrollTop = y[1]; };
  if (settings) { // the editors (Configuration › CPM Daily)
  // renewals vs daily: typed here, saved together; blank goes back to learned
  const rnw0 = JSON.stringify(d.rnw_share_typed || {});
  const rnwNow = () => { const o = { ...(d.rnw_share_typed || {}) };
    for (const el of $$('.cpm-rnwc')) { const v = String(el.value).trim().replace(',', '.'); if (v === '') delete o[el.dataset.k]; else o[el.dataset.k] = Math.max(0, Math.min(1, Number(v) / 100 || 0)); }
    return o; };
  const rnwDirty = () => { const ch = JSON.stringify(rnwNow()) !== rnw0; $('#cpm-rnwc-save').disabled = !ch; $('#cpm-rnwc-undo').disabled = !ch; $('#cpm-rnwc-dirty').hidden = !ch;
    for (const el of $$('.cpm-rnwc')) { const v = String(el.value).trim(); const sh = v === '' ? Number(el.placeholder) / 100 : Math.max(0, Math.min(1, Number(v.replace(',', '.')) / 100 || 0)); el.closest('tr').querySelector('.cpm-rnwc-daily').textContent = cpmPct(1 - sh, 1); el.classList.toggle('cpm-manual', v !== ''); } };
  $$('.cpm-rnwc').forEach((el) => { el.oninput = rnwDirty; });
  rnwDirty();
  $('#cpm-rnwc-undo').onclick = () => { for (const el of $$('.cpm-rnwc')) { const v = (d.rnw_share_typed || {})[el.dataset.k]; el.value = v === undefined || v === null ? '' : Math.round(v * 1000) / 10; } rnwDirty(); };
  $('#cpm-rnwc-save').onclick = async () => { try { await api.put('/cpm/settings', { cpm_rnw_share: JSON.stringify(rnwNow()) }); toast('Renewal splits saved'); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  // the priority of the daily work: typed here, saved together; both blank goes back to learned
  const prc0 = JSON.stringify(d.prio_typed || {});
  const prcNow = () => { const o = { ...(d.prio_typed || {}) }; const by = new Map();
    for (const el of $$('.cpm-prc')) { const v = String(el.value).trim().replace(',', '.'); (by.get(el.dataset.tri) || by.set(el.dataset.tri, {}).get(el.dataset.tri))[el.dataset.k] = v; }
    for (const [tri, x] of by) { if ((x.urgent ?? '') === '' && (x.high ?? '') === '') { delete o[tri]; continue; } const u = Math.max(0, Math.min(1, Number(x.urgent) / 100 || 0)); o[tri] = { urgent: u, high: Math.max(0, Math.min(1 - u, Number(x.high) / 100 || 0)) }; }
    return o; };
  const prcDirty = () => { const now = prcNow(); const ch = JSON.stringify(now) !== prc0; $('#cpm-prc-save').disabled = !ch; $('#cpm-prc-undo').disabled = !ch; $('#cpm-prc-dirty').hidden = !ch;
    for (const el of $$('.cpm-prc-n')) { const tri = el.dataset.tri; const x = now[tri]; const r = prioRows.find((q) => q.trigram === tri); const m = x ? { normal: 1 - x.urgent - x.high } : r?.prio || null; el.textContent = m ? cpmPct(m.normal, 1) : ''; el.classList.toggle('cpm-manual', !!x); }
    for (const el of $$('.cpm-prc')) el.classList.toggle('cpm-manual', String(el.value).trim() !== ''); };
  $$('.cpm-prc').forEach((el) => { el.oninput = prcDirty; }); prcDirty();
  $('#cpm-prc-undo').onclick = () => { for (const el of $$('.cpm-prc')) { const x = (d.prio_typed || {})[el.dataset.tri]; el.value = x && x[el.dataset.k] !== undefined ? Math.round(x[el.dataset.k] * 1000) / 10 : ''; } prcDirty(); };
  $('#cpm-prc-save').onclick = async () => { try { await api.put('/cpm/settings', { cpm_prio_mix: JSON.stringify(prcNow()) }); toast('Priorities saved'); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  // renewal windows: ticked here, saved together (no redraw on every click)
  const pend = JSON.parse(JSON.stringify(d.windows || {})); const bonus0 = String(Math.round(d.bonus * 100));
  const dirty = () => { const changed = JSON.stringify(T.map((t) => [...(pend[t] || [])].sort((a, c) => a - c))) !== JSON.stringify(T.map((t) => [...(d.windows[t] || [])].sort((a, c) => a - c))) || $('#cpm-rnw-bonus').value !== bonus0;
    $('#cpm-win-save').disabled = !changed; $('#cpm-win-undo').disabled = !changed; $('#cpm-win-dirty').hidden = !changed; };
  const note = (t) => { const el = $(`[data-win-note="${t}"]`); const n = (pend[t] || []).length; const same = JSON.stringify([...(pend[t] || [])].sort((a, c) => a - c)) === JSON.stringify([...(d.windows[t] || [])].sort((a, c) => a - c));
    if (!same) el.textContent = n ? `${cpmK(d.renewals[t].need)} a day over ${n} h — not saved yet` : `none — renewals (${cpmK(d.renewals[t].need)} a day) over every hour worked — not saved yet`; else el.textContent = n ? `${cpmK(d.renewals[t].need)} a day over ${n} h` : `none set — renewals (${cpmK(d.renewals[t].need)} a day) spread over every hour worked`; };
  $$('[data-win]').forEach((b) => { b.onclick = () => {
    const t = b.dataset.win; const h = Number(b.dataset.h); const l = new Set(pend[t] || []); if (l.has(h)) l.delete(h); else l.add(h); pend[t] = [...l].sort((a, c) => a - c);
    b.classList.toggle('on', l.has(h)); note(t); dirty(); }; });
  $('#cpm-rnw-bonus').oninput = dirty;
  $('#cpm-win-undo').onclick = () => { for (const t of T) pend[t] = [...(d.windows[t] || [])]; $$('[data-win]').forEach((b) => b.classList.toggle('on', (pend[b.dataset.win] || []).includes(Number(b.dataset.h)))); T.forEach(note); $('#cpm-rnw-bonus').value = bonus0; dirty(); };
  $('#cpm-win-save').onclick = async () => { const btn = $('#cpm-win-save'); btn.disabled = true; btn.textContent = 'Saving…';
    try { await api.put('/cpm/settings', { cpm_rnw_hours: JSON.stringify(pend), cpm_rnw_bonus: String((Number($('#cpm-rnw-bonus').value) || 0) / 100) }); toast('Renewal windows saved'); await redraw(); } catch (err) { toast(err.message, 'error'); btn.disabled = false; btn.textContent = '💾 Save'; } };
  // run periods grid: edited here, saved together
  const gridNow = () => { const o = {}; for (const [k, v] of Object.entries(d.manual || {})) if (!k.endsWith('|*')) o[k] = v; // a technology's own rows stay
    for (const tr of $$('.cpm-grow.set')) { const byDay = [...tr.querySelectorAll('.cpm-gc')].map((i) => Math.max(0, Number(String(i.value).replace('%', '').replace(',', '.')) || 0));
      if (byDay.some((x) => x > 0)) { const byClock = Array(24).fill(0); H.forEach((h, i) => { byClock[h] = byDay[i]; }); o[`${tr.dataset.tri}|*`] = { hours: byClock }; } }
    return o; };
  const man0 = JSON.stringify(gridNow());
  const rowSum = (tr) => { const t = [...tr.querySelectorAll('.cpm-gc')].reduce((p2, i) => p2 + (Number(String(i.value).replace('%', '').replace(',', '.')) || 0), 0); const c = tr.querySelector('.cpm-gsum');
    c.innerHTML = tr.classList.contains('set') ? `<span class="${Math.abs(t - 100) > 0.5 ? 'pl-late' : 'pl-ok'}">${Math.round(t * 10) / 10}%</span>` : '<span class="muted">learned</span>'; };
  const manDirty = () => { const ch = JSON.stringify(gridNow()) !== man0; $('#cpm-man-save').disabled = !ch; $('#cpm-man-undo').disabled = !ch; $('#cpm-man-dirty').hidden = !ch; };
  const startRow = (tr, blank) => { if (tr.classList.contains('set')) return; tr.classList.add('set'); tr.querySelectorAll('.cpm-gc').forEach((i) => { i.value = blank ? '0' : i.placeholder || '0'; }); tr.querySelector('.cpm-greset').hidden = false; rowSum(tr); manDirty(); }; // pasted into: starts from nothing
  const wireGrid = () => {
    $$('.cpm-gc').forEach((i) => { const tr = i.closest('tr');
      i.onfocus = () => { startRow(tr); i.select(); }; i.oninput = () => { rowSum(tr); manDirty(); };
      i.onpaste = (e) => { const txt = (e.clipboardData || window.clipboardData).getData('text'); if (!/[\t\n]/.test(txt)) return; e.preventDefault(); // a block from Excel: right and down from here
        const rowsT = txt.replace(/\r/g, '').replace(/\n$/, '').split('\n').map((l) => l.split('\t')); const trs = $$('.cpm-grow'); const r0 = trs.indexOf(tr); const c0 = Number(i.dataset.i);
        rowsT.forEach((cells, dr) => { const t2 = trs[r0 + dr]; if (!t2) return; startRow(t2, true); const ins = t2.querySelectorAll('.cpm-gc'); cells.forEach((v, dc) => { const inp = ins[c0 + dc]; if (inp) inp.value = String(v).trim().replace('%', '').replace(',', '.'); }); rowSum(t2); });
        manDirty(); }; });
    $$('.cpm-greset').forEach((b) => { b.onclick = () => { const tr = b.closest('tr'); tr.classList.remove('set'); tr.querySelectorAll('.cpm-gc').forEach((i) => { i.value = ''; }); b.hidden = true; rowSum(tr); manDirty(); }; });
  };
  wireGrid();
  $('#cpm-man-prod').onclick = () => { $$('.cpm-grow').forEach((tr) => startRow(tr)); };
  $('#cpm-man-undo').onclick = () => { $('.cpm-rp tbody').innerHTML = gridCusts.map(gridRow).join(''); wireGrid(); manDirty(); };
  $('#cpm-man-save').onclick = async () => { try { await api.put('/cpm/settings', { cpm_day_manual: JSON.stringify(gridNow()) }); toast('Run periods saved'); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  // shipment times: edited here, saved together
  const ship0 = JSON.stringify((d.ship_times.times || []).map((x) => ({ time: x.time, label: x.label || '' })));
  const shipNow = () => $$('.cpm-ship-row').map((r) => ({ time: r.querySelector('.cpm-ship-t').value, label: r.querySelector('.cpm-ship-l').value.trim() })).filter((x) => /^\d{2}:\d{2}$/.test(x.time));
  const shipDirty = () => { const ch = JSON.stringify(shipNow()) !== ship0; $('#cpm-ship-save').disabled = !ch; $('#cpm-ship-undo').disabled = !ch; $('#cpm-ship-dirty').hidden = !ch; };
  const wireShip = () => { $$('.cpm-ship-row input').forEach((i) => { i.oninput = shipDirty; }); $$('.cpm-ship-rm').forEach((b) => { b.onclick = () => { b.closest('.cpm-ship-row').remove(); shipDirty(); }; }); };
  wireShip();
  $('#cpm-ship-add').onclick = () => { $('#cpm-ship').insertAdjacentHTML('beforeend', shipRow({ time: '', label: '' }, $$('.cpm-ship-row').length)); wireShip(); $$('.cpm-ship-t').pop().focus(); shipDirty(); };
  $('#cpm-ship-undo').onclick = () => { $('#cpm-ship').innerHTML = (d.ship_times.times || []).map((x, k) => shipRow(x, k)).join(''); wireShip(); shipDirty(); };
  $('#cpm-ship-save').onclick = async () => { try { await api.put('/cpm/settings', { cpm_cutoffs: JSON.stringify(shipNow()) }); toast('Shipment times saved'); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  const shipL = $('#cpm-ship-learned'); if (shipL) shipL.onclick = async () => { try { await api.put('/cpm/settings', { cpm_cutoffs: '' }); toast('Showing the learned shipment times'); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  $('#cpm-cut-def').onchange = async (e) => { if (!e.target.value) return; try { await api.put('/cpm/settings', { cpm_cutoff_default: e.target.value }); toast(`Customers with no shipment time ship at ${e.target.value}`); await redraw(); } catch (err) { toast(err.message, 'error'); } };
  }
  // a customer's own cut-off, typed in the table (blank: learned)
  $$('.cpm-cut-in').forEach((el) => { el.onchange = async () => {
    const o = { ...(d.cutoff_typed || {}) }; const r = d.rows.find((x) => x.trigram === el.dataset.tri); const learned = hhmm(r?.cutoff_learned) || d.cutoff_default;
    if (!el.value || el.value === learned) delete o[el.dataset.tri]; else o[el.dataset.tri] = el.value;
    try { await api.put('/cpm/settings', { cpm_cutoff_cust: JSON.stringify(o) }); await redraw(); } catch (err) { toast(err.message, 'error'); } }; });
}

// ---- CPM Daily drill-down: who and what feeds each hour --------------------------------------------
// A window over the day as it comes in (the CPM Daily figures, before smoothing): the day by the hour →
// an hour (who feeds it: each customer's daily work and renewals, the machines that give its capacity, what's
// carried in from earlier hours) → a customer (its day by the hour). ← Back steps back through what was opened.
let cpmDr = null;
function cpmDrill(d, { view = 'need', tech = 'all', hour = null, cust = null, mark = null } = {}) {
  cpmDr = { d, s: { view, tech: d.techs.includes(tech) ? tech : 'all', hour, cust, mark }, hist: [] };
  openModal('<div id="cpmdr" class="cpmdr"></div>', { wide: true });
  $('#cpmdr').addEventListener('click', cpmDrClick);
  cpmDrDraw();
}
function cpmDrGo(change) { cpmDr.hist.push({ ...cpmDr.s }); Object.assign(cpmDr.s, change); cpmDrDraw(); }
function cpmDrClick(e) {
  const el = e.target.closest('[data-dr]'); if (!el) return;
  const [k, v] = [el.dataset.dr, el.dataset.v];
  if (k === 'back') { const p = cpmDr.hist.pop(); if (p) { cpmDr.s = p; cpmDrDraw(); } return; }
  if (k === 'tech') { cpmDr.s.tech = v; cpmDrDraw(); return; }
  if (k === 'view') { cpmDr.s.view = v; cpmDrDraw(); return; }
  if (k === 'hour') { const i = Number(v); if (cpmDr.s.cust && cpmDr.s.hour === null) { cpmDrGo({ hour: i, cust: null, mark: cpmDr.s.cust }); return; } if (cpmDr.s.hour !== null && !cpmDr.s.cust) { cpmDr.s.hour = i; cpmDrDraw(); return; } cpmDrGo({ hour: i, cust: null, mark: cpmDr.s.cust || null }); return; }
  if (k === 'step') { const n = cpmDr.d.hours.length; cpmDr.s.hour = (cpmDr.s.hour + Number(v) + n) % n; cpmDrDraw(); return; }
  if (k === 'cust') { cpmDrGo({ cust: v, hour: null, mark: null }); return; }
  if (k === 'day') { cpmDrGo({ hour: null, cust: null, mark: null }); }
}
function cpmDrDraw() {
  const { d, s } = cpmDr; const H = d.hours; const cards = s.view === 'cards';
  const techs = s.tech === 'all' ? d.techs : [s.tech];
  const hl = (i) => `${String(H[i % H.length] ?? (H[0] + i) % 24).padStart(2, '0')}:00`;
  const keyOf = (r) => r.trigram || r.name;
  const nRnw = (t) => d.renewals[t]?.hours?.length || 0;
  const inWin = (t, i) => (d.renewals[t]?.hours || []).includes(H[i]);
  const dly = (r, i) => (cards ? r.cards_hours[i] : r.hours[i]) || 0;
  const rnw = (r, i) => (inWin(r.tech, i) && nRnw(r.tech) ? (cards ? r.renew : r.need_rnw) / nRnw(r.tech) : 0);
  const tot = (r, i) => dly(r, i) + rnw(r, i);
  const dayOf = (r) => (cards ? r.daily + r.renew : r.need_daily + r.need_rnw);
  const capOf = (t, i) => (cards ? d.tech[t].cards.capacity[i] : d.tech[t].capacity[i]) || 0;
  const needOf = (t, i) => d.rows.filter((r) => r.tech === t).reduce((a, r) => a + tot(r, i), 0);
  const carry = Object.fromEntries(techs.map((t) => { let c = 0; return [t, H.map((_, i) => { c = Math.max(0, c + needOf(t, i) - capOf(t, i)); return c; })]; }));
  const unit = cards ? (d.unit || 'cards') : 'capacity needed (÷ OEE)';
  const cutIdx = (r) => { if (r.cutoff === null || r.cutoff === undefined) return null; const i = H.indexOf(Math.floor(r.cutoff)); return i < 0 ? null : i + (r.cutoff % 1); };
  const hhmm = (v) => (v === null || v === undefined ? '—' : `${String(Math.floor(v)).padStart(2, '0')}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`);
  const FROM = { manual: 'run periods set by hand', 'manual-default': 'run periods set for everyone else', 'arrivals-own': 'when its work orders arrive', 'arrivals-technology': 'when the technology\'s work orders arrive', own: 'when its cards were produced', technology: 'when the technology\'s cards were produced', even: 'spread evenly (no data)',
    ...(d.unit === 'items' ? { own: 'when its Matching runs ended', technology: 'when all Matching runs ended' } : {}) };
  const bar = (p, col) => `<div class="pllx-share"><div class="pll-track"><div style="height:100%;width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%;background:${col}"></div></div><span>${cpmPct(p)}</span></div>`;
  const tile = (l, v, sub = '') => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${v}</div>${sub ? `<div class="kdb-tile-s">${sub}</div>` : ''}</div>`;
  // the day by the hour as bars: a stack per series (daily solid, renewals lighter), capacity as a step line;
  // each hour column clickable
  const chart = (series, cap, sel, H0 = 210) => {
    const W = 1000; const L = 46; const B = 22; const T0 = 10; const n = H.length; const slot = (W - L - 6) / n; const bw = slot * 0.7;
    const stack = H.map((_, i) => series.reduce((a, x) => a + (x.vals[i] || 0), 0));
    const { max, ticks } = cpmScale(Math.max(1, ...stack, ...(cap || [])) * 1.08); const y = (v) => T0 + (H0 - T0 - B) * (1 - v / max);
    const bars = H.map((_, i) => { let base = 0; return series.map((x) => { const v = x.vals[i] || 0; if (v <= 0) return ''; const r = `<rect x="${L + i * slot + (slot - bw) / 2}" y="${y(base + v)}" width="${bw}" height="${Math.max(0, y(base) - y(base + v))}" style="fill:${x.color};opacity:${x.light ? 0.45 : 0.9}"/>`; base += v; return r; }).join(''); }).join('');
    const step = cap ? cap.map((c, i) => `${i ? 'L' : 'M'}${L + i * slot},${y(c)} L${L + (i + 1) * slot},${y(c)}`).join(' ') : '';
    return `<svg class="cpm-chart cpmdr-chart" viewBox="0 0 ${W} ${H0}" preserveAspectRatio="xMinYMin meet">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
      ${H.map((_, i) => (d.worked[i] ? '' : `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${H0 - T0 - B}" class="cpm-off"/>`)).join('')}
      ${sel !== null && sel !== undefined ? `<rect x="${L + sel * slot}" y="${T0}" width="${slot}" height="${H0 - T0 - B}" class="cpmdr-sel"/>` : ''}
      ${bars}${cap ? `<path d="${step}" fill="none" class="cpm-capstep"/>` : ''}
      ${H.map((h, i) => `<text x="${L + (i + 0.5) * slot}" y="${H0 - 6}" text-anchor="middle" class="cpm-ax">${String(h).padStart(2, '0')}</text>`).join('')}
      ${H.map((_, i) => `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${H0 - T0}" class="cpmdr-hit" data-dr="hour" data-v="${i}"><title>${esc(`${hl(i)} — ${cpmN(Math.round(stack[i]))}${cap ? ` of ${cpmN(Math.round(cap[i]))} (${cap[i] ? cpmPct(stack[i] / cap[i]) : '—'})` : ''} · click to see who feeds it`)}</title></rect>`).join('')}
    </svg>`;
  };
  const techSeries = (fn) => techs.flatMap((t) => [{ color: cpmTc(t), vals: H.map((_, i) => fn(t, i, 'daily')) }, { color: cpmTc(t), light: true, vals: H.map((_, i) => fn(t, i, 'rnw')) }]);
  const part = (t, i, k) => d.rows.filter((r) => r.tech === t).reduce((a, r) => a + (k === 'daily' ? dly(r, i) : rnw(r, i)), 0);
  const capSum = H.map((_, i) => techs.reduce((a, t) => a + capOf(t, i), 0));
  const legend = `<div class="cpm-legend">${techs.map((t) => `<span><i class="sw" style="background:${cpmTc(t)}"></i>${esc(t)} daily</span><span><i class="sw" style="background:${cpmTc(t)};opacity:.45"></i>renewals</span>`).join('')}<span><i class="ln"></i>capacity</span><span><i class="sw cpm-sw-off"></i>not worked</span></div>`;
  let title; let html;
  if (s.cust) {
    // a customer: its lines, its day by the hour
    const rs = d.rows.filter((r) => keyOf(r) === s.cust); const r0 = rs[0] || {};
    title = `${esc(s.cust)} <span class="muted">${esc(r0.name && r0.name !== s.cust ? r0.name : '')}</span>`;
    const dayT = rs.reduce((a, r) => a + dayOf(r), 0);
    const late = rs.reduce((a, r) => a + (r.late_cards || 0), 0);
    const ser = rs.flatMap((r) => [{ color: cpmTc(r.tech), vals: H.map((_, i) => dly(r, i)) }, { color: cpmTc(r.tech), light: true, vals: H.map((_, i) => rnw(r, i)) }]);
    html = `<div class="kdb-tiles pl-tiles">${tile('Month', cpmK(rs.reduce((a, r) => a + r.month_volume, 0)), `${d.unit || 'cards'} forecast`)}${tile('A day', cpmK(dayT), unit)}${tile('Technologies', rs.map((r) => `<span style="color:${cpmTc(r.tech)}">${esc(r.tech)}</span>`).join(' · ') || '—')}
        ${tile('Timing', esc(FROM[r0.profile] || '—'), r0.arrive_avg !== null && r0.arrive_avg !== undefined ? `comes in around ${hhmm(r0.arrive_avg)}` : '')}${tile('Cut-off', hhmm(r0.cutoff), r0.cutoff_typed ? 'set by hand' : r0.cutoff_default ? 'the default' : 'learned')}${tile('After its cut-off', late > 0.5 ? `<span class="pl-late">${cpmK(late)}</span>` : '<span class="pl-ok">none</span>', 'cards a day, worked in the order it comes in')}</div>
      <h4 class="cpmdr-h">Its day by the hour <span class="muted small">— click an hour to see everyone feeding it</span></h4>
      <div class="cpm-legend">${rs.map((r) => `<span><i class="sw" style="background:${cpmTc(r.tech)}"></i>${esc(r.tech)} daily</span><span><i class="sw" style="background:${cpmTc(r.tech)};opacity:.45"></i>renewals</span>`).join('')}</div>${chart(ser, null, null)}
      <div class="kdb-scroll"><table class="log small cpmdr-t"><thead><tr><th>Hour</th>${rs.map((r) => `<th class="num" style="color:${cpmTc(r.tech)}">${esc(r.tech)} daily</th><th class="num" style="color:${cpmTc(r.tech)}">${esc(r.tech)} renewals</th>`).join('')}<th class="num">Total</th><th>Of its day</th><th class="num" title="Its part of everything its technologies need in that hour">Of the hour</th></tr></thead><tbody>
      ${H.map((_, i) => { const t = rs.reduce((a, r) => a + tot(r, i), 0); if (t < 0.05) return ''; const all = rs.reduce((a, r) => a + needOf(r.tech, i), 0);
        const past = rs.some((r) => cutIdx(r) !== null && i >= cutIdx(r));
        return `<tr class="cpmdr-row" data-dr="hour" data-v="${i}"><th>${hl(i)}${past ? ' <span class="pl-late small" title="After its cut-off">⚠</span>' : ''}</th>${rs.map((r) => `<td class="num">${cpmK(dly(r, i))}</td><td class="num">${rnw(r, i) ? cpmK(rnw(r, i)) : ''}</td>`).join('')}<td class="num"><b>${cpmK(t)}</b></td><td>${bar(dayT ? t / dayT : 0, cpmTc(r0.tech))}</td><td class="num">${all ? cpmPct(t / all) : '—'}</td></tr>`; }).join('')}</tbody></table></div>`;
  } else if (s.hour !== null) {
    // an hour: who feeds it, and what gives its capacity
    const i = s.hour; title = `${hl(i)}–${hl(i + 1)} <span class="muted small">${d.worked[i] ? '' : '(not worked)'}</span>`;
    const rs = d.rows.filter((r) => techs.includes(r.tech) && tot(r, i) > 0.05).sort((a, b) => tot(b, i) - tot(a, i));
    const need = techs.reduce((a, t) => a + needOf(t, i), 0); const cap = capSum[i]; const daily = rs.reduce((a, r) => a + dly(r, i), 0); const rn = Math.max(0, need - daily);
    const cin = techs.reduce((a, t) => a + (i ? carry[t][i - 1] : 0), 0); const after = rs.filter((r) => cutIdx(r) !== null && i >= cutIdx(r));
    const machines = techs.flatMap((t) => (d.capacity_by_machine?.[t] || []).map((m) => ({ t, name: m.name, v: (d.tech[t].capacity[i] ? m.per[i] * (capOf(t, i) / d.tech[t].capacity[i]) : 0) })).filter((m) => m.v > 0.5)).sort((a, b) => b.v - a.v);
    html = `<div class="row" style="gap:6px;margin-bottom:6px"><button type="button" class="small" data-dr="step" data-v="-1">‹ ${hl(i - 1 + H.length)}</button><button type="button" class="small" data-dr="step" data-v="1">${hl(i + 1)} ›</button></div>
      <div class="kdb-tiles pl-tiles">${tile('Needed', cpmK(need), unit)}${tile('Capacity', cpmK(cap), machines.length ? `${machines.length} machine${machines.length === 1 ? '' : 's'}` : 'no machines')}${tile('Load', cap ? `<span class="${need > cap + 0.5 ? 'pl-late' : 'pl-ok'}">${cpmPct(need / cap)}</span>` : need ? '<span class="pl-late">no capacity</span>' : '—')}
        ${tile('Daily · renewals', `${cpmK(daily)} · ${cpmK(rn)}`, need ? `${cpmPct(daily / need)} daily` : '')}${tile('Carried in', cin > 0.5 ? `<span class="pl-late">${cpmK(cin)}</span>` : '0', 'left over from earlier hours')}${tile('Customers', rs.length, after.length ? `<span class="pl-late">${after.length} after their cut-off</span>` : 'all before their cut-off')}</div>
      <h4 class="cpmdr-h">The day <span class="muted small">— click another hour</span></h4>${legend}${chart(techSeries(part), capSum, i, 170)}
      <h4 class="cpmdr-h">Who feeds ${hl(i)} <span class="muted small">— click a customer for its whole day</span></h4>
      <div class="kdb-scroll"><table class="log small cpmdr-t"><thead><tr><th>Customer</th><th>Tech</th><th class="num">Daily</th><th class="num">Renewals</th><th class="num">Total</th><th>Of the hour</th><th class="num" title="Of its whole day, the part that lands in this hour">Of its day</th><th>Timing from</th><th class="num">Cut-off</th></tr></thead><tbody>
      ${rs.map((r) => { const t = tot(r, i); const late = cutIdx(r) !== null && i >= cutIdx(r);
        return `<tr class="cpmdr-row ${s.mark === keyOf(r) ? 'cpmdr-mark' : ''}" data-dr="cust" data-v="${esc(keyOf(r))}"><td><b>${esc(r.trigram || '—')}</b> <span class="muted">${esc(r.name || '')}</span></td><td style="color:${cpmTc(r.tech)}"><b>${esc(r.tech)}</b></td><td class="num">${cpmK(dly(r, i))}</td><td class="num">${rnw(r, i) ? cpmK(rnw(r, i)) : ''}</td><td class="num"><b>${cpmK(t)}</b></td>
          <td>${bar(need ? t / need : 0, cpmTc(r.tech))}</td><td class="num">${dayOf(r) ? cpmPct(t / dayOf(r)) : '—'}</td><td class="small">${esc(FROM[r.profile] || '—')}</td><td class="num ${late ? 'pl-late' : ''}" title="${late ? 'This hour is after its cut-off: what lands here ships a day late unless done earlier' : ''}">${hhmm(r.cutoff)}${late ? ' ⚠' : ''}</td></tr>`; }).join('') || '<tr><td colspan="9" class="muted">Nothing lands in this hour.</td></tr>'}</tbody></table></div>
      ${rn > 0.5 ? `<p class="small muted">Renewals are each technology's Low priority work, spread evenly over its renewal window (${techs.filter((t) => nRnw(t)).map((t) => `${esc(t)}: ${d.renewals[t].window ? `${nRnw(t)} h set` : 'every hour worked'}`).join(' · ')}).</p>` : ''}
      ${machines.length ? `<h4 class="cpmdr-h">What gives the capacity</h4><div class="kdb-scroll"><table class="log small cpmdr-t"><thead><tr><th>Machine</th><th>Tech</th><th class="num">In this hour</th><th>Of the capacity</th></tr></thead><tbody>${machines.map((m) => `<tr><td>${esc(m.name)}</td><td style="color:${cpmTc(m.t)}">${esc(m.t)}</td><td class="num">${cpmK(m.v)}</td><td>${bar(cap ? m.v / cap : 0, cpmTc(m.t))}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  } else {
    // the day: by the hour, and the customers over it
    title = 'The day by the hour';
    const by = new Map(); for (const r of d.rows.filter((x) => techs.includes(x.tech))) { const k = keyOf(r); const x = by.get(k) || by.set(k, { k, name: r.name, rs: [] }).get(k); x.rs.push(r); }
    const list = [...by.values()].map((x) => ({ ...x, day: x.rs.reduce((a, r) => a + dayOf(r), 0), per: H.map((_, i) => x.rs.reduce((a, r) => a + tot(r, i), 0)), late: x.rs.reduce((a, r) => a + (r.late_cards || 0), 0) })).sort((a, b) => b.day - a.day);
    const all = list.reduce((a, x) => a + x.day, 0); const need = H.map((_, i) => techs.reduce((a, t) => a + needOf(t, i), 0));
    const pk = need.indexOf(Math.max(...need)); const over = need.filter((v, i) => v > capSum[i] + 0.5).length;
    html = `<div class="kdb-tiles pl-tiles">${tile('A day', cpmK(all), unit)}${tile('Capacity', cpmK(capSum.reduce((a, b) => a + b, 0)), 'over the day')}${tile('Busiest hour', need[pk] ? hl(pk) : '—', need[pk] ? `${cpmK(need[pk])}${capSum[pk] ? ` · ${cpmPct(need[pk] / capSum[pk])}` : ''}` : '')}${tile('Hours over capacity', over ? `<span class="pl-late">${over}</span>` : '<span class="pl-ok">0</span>')}${tile('Customers', list.length)}</div>
      <h4 class="cpmdr-h">Click an hour to see who feeds it</h4>${legend}${chart(techSeries(part), capSum, null)}
      <h4 class="cpmdr-h">Customers over the day <span class="muted small">— click one for its day</span></h4>
      <div class="kdb-scroll"><table class="log small cpmdr-t"><thead><tr><th>Customer</th><th>Tech</th><th class="num">A day</th><th>Of the day</th><th class="num">Busiest hour</th><th class="num">Cut-off</th><th class="num">After its cut-off</th></tr></thead><tbody>
      ${list.map((x) => { const p = x.per.indexOf(Math.max(...x.per)); return `<tr class="cpmdr-row" data-dr="cust" data-v="${esc(x.k)}"><td><b>${esc(x.k)}</b> <span class="muted">${esc(x.name && x.name !== x.k ? x.name : '')}</span></td><td>${x.rs.map((r) => `<b style="color:${cpmTc(r.tech)}">${esc(r.tech)}</b>`).join(' ')}</td><td class="num"><b>${cpmK(x.day)}</b></td><td>${bar(all ? x.day / all : 0, cpmTc(x.rs[0].tech))}</td><td class="num">${x.per[p] > 0.05 ? `${hl(p)} <span class="muted">${cpmK(x.per[p])}</span>` : '—'}</td><td class="num">${hhmm(x.rs[0].cutoff)}</td><td class="num">${x.late > 0.5 ? `<b class="pl-late">${cpmK(x.late)}</b>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
  }
  const crumbs = [`<button type="button" class="link small" data-dr="day">${esc(d.label)}</button>`, ...(s.hour !== null ? [`<b>${hl(s.hour)}</b>`] : []), ...(s.cust ? [`<b>${esc(s.cust)}</b>`] : [])].join(' › ');
  $('#cpmdr').innerHTML = `
    <div class="modal-head"><h2 style="margin:0">${cpmDr.hist.length ? '<button type="button" class="small" data-dr="back">← Back</button> ' : ''}${title}</h2></div>
    <div class="row small" style="gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0 10px"><span class="muted">${crumbs}${d.scenario ? ` · scenario <b>${esc(d.scenario.name)}</b>` : ''} · the day as it comes in</span><div class="spacer"></div>
      ${s.cust ? '' : `<div class="seg cpm-mini">${[['all', 'All'], ...d.techs.map((t) => [t, t])].map(([k, l]) => `<button type="button" data-dr="tech" data-v="${esc(k)}" class="${s.tech === k ? 'on' : ''}">${k === 'all' ? '' : CPM_TECH_ICON[k] || ''} ${esc(l)}</button>`).join('')}</div>`}
      <div class="seg cpm-mini"><button type="button" data-dr="view" data-v="cards" class="${cards ? 'on' : ''}">${d.unit === 'items' ? 'Items' : 'Cards'}</button><button type="button" data-dr="view" data-v="need" class="${cards ? '' : 'on'}">Capacity needed (÷ OEE)</button></div></div>
    ${html}`;
}

// 🔎 Forecast check: each customer and technology, from the forecast line to the capacity a day CPM Daily counts,
// beside what really ran — the steps in a row, so a volume that's out of line shows where it went wrong
async function cpmCheck(body) {
  const year = Number(store.get('cpmYear', new Date().getFullYear())); const month = Number(store.get('cpmDayMonth', new Date().getMonth() + 1));
  const flex = store.get('cpmFlex', true); const only = store.get('cpmCheckFlagged', true) !== false;
  const d = await api.get(`/cpm/check?year=${year}&month=${month}&flex=${flex ? 1 : 0}`);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const rows = only ? d.rows.filter((r) => r.flags.length) : d.rows; const nFlag = d.rows.filter((r) => r.flags.length).length;
  const x = (v, dp = 2) => (v === null || v === undefined ? '—' : `×${v.toFixed(dp)}`);
  body.innerHTML = `<div class="row pl-filters" style="gap:10px;flex-wrap:wrap;align-items:center">
      <select id="cpm-ck-month">${MONTHS.map((m, i) => `<option value="${i + 1}" ${i + 1 === month ? 'selected' : ''}>${m} ${year}</option>`).join('')}</select>
      <label class="row small"><input type="checkbox" id="cpm-ck-flex" ${flex ? 'checked' : ''}> apply flex</label>
      <label class="row small"><input type="checkbox" id="cpm-ck-only" ${only ? 'checked' : ''}> only what's flagged (${nFlag} of ${d.rows.length})</label></div>
    <div class="card"><h3 class="pl-h">Forecast check <span class="muted small">— ${esc(d.label)}, ${d.workdays} working days${d.day_shape === 'worst' ? ', worst case day shape' : ''}: each customer and technology from its forecast line(s) to the capacity a day CPM Daily counts, beside what really ran (${esc(d.act_from)} – ${esc(d.act_to)}, a month on average). Flagged: forecast over 3× or under a third of what ran, flex outside ×0.5–2, OEE under 15%, worst case over ×3, a name not linked.</span></h3>
      <div class="kdb-scroll"><table class="log small cpm-ck"><thead><tr><th>Customer</th><th>Tech</th><th>Forecast line(s)</th><th class="num" title="The customer's forecast for the month, all technologies">Forecast</th><th class="num">Split</th><th class="num">Flex</th><th class="num" title="Forecast × split × flex">Cards this month</th>
        <th class="num" title="What ran a month on average, the last 3 full months, this customer and technology">Ran a month</th><th class="num" title="Cards this month ÷ what ran">Forecast ÷ ran</th><th class="num">A working day</th><th class="num">Renewals</th><th class="num">OEE</th><th class="num" title="Worst case: its busiest day ÷ its average day">Worst case</th><th class="num" title="Daily ÷ OEE (× worst case) + renewals ÷ renewal OEE: what CPM Daily counts">Needed a day</th><th>Flags</th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${r.flags.length ? 'cpm-ck-flag' : ''}"><td><b>${esc(r.trigram || '—')}</b> <span class="muted">${esc(r.name || '')}</span></td><td style="color:${cpmTc(r.tech)}"><b>${esc(r.tech)}</b></td>
        <td class="small">${r.names.length ? r.names.slice(0, 4).map((n) => `<div title="${esc(n.source)}">${esc(n.name)} <span class="muted">${cpmK(n.qty)}</span></div>`).join('') + (r.names.length > 4 ? `<div class="muted">and ${r.names.length - 4} more</div>` : '') : '<span class="muted">—</span>'}</td>
        <td class="num">${cpmK(r.cust_fc)}</td><td class="num">${r.split === null ? '—' : cpmPct(r.split)}</td><td class="num ${r.flex !== null && (r.flex > 2 || r.flex < 0.5) ? 'pl-late' : ''}">${x(r.flex)}</td><td class="num"><b>${cpmK(r.cards_month)}</b></td>
        <td class="num">${r.act_month ? cpmK(r.act_month) : '<span class="muted">0</span>'}</td><td class="num ${r.ratio !== null && (r.ratio > 3 || r.ratio < 1 / 3) ? 'pl-late' : ''}">${r.ratio === null ? '—' : `${r.ratio.toFixed(1)}×`}</td>
        <td class="num">${cpmK(r.per_day)}</td><td class="num">${cpmPct(r.rnw_pct)}</td><td class="num ${r.oee < 0.15 ? 'pl-late' : ''}">${cpmPct(r.oee)}</td><td class="num ${r.peak > 3 ? 'pl-late' : ''}">${r.peak > 1.005 ? x(r.peak, 1) : '—'}</td>
        <td class="num"><b>${cpmK(r.need_day)}</b></td><td class="small pl-late">${r.flags.map(esc).join('<br>')}</td></tr>`).join('') || `<tr><td colspan="15" class="muted">${only ? 'Nothing flagged this month.' : 'No customers in the forecast this month.'}</td></tr>`}</tbody></table></div>
      <p class="small muted" style="margin:6px 0 0">Fix at the step that's out: the forecast line linked to the customer and its split (Customers), the flex (Forecast vs actual), the renewal share (CPM Daily settings), the OEE (Customers), or the day shape (CPM Daily › View: a typical day instead of the worst case).</p></div>`;
  $('#cpm-ck-month').onchange = (e) => { store.set('cpmDayMonth', Number(e.target.value)); renderCpm('check'); };
  $('#cpm-ck-flex').onchange = (e) => { store.set('cpmFlex', e.target.checked); renderCpm('check'); };
  $('#cpm-ck-only').onchange = (e) => { store.set('cpmCheckFlagged', e.target.checked); renderCpm('check'); };
}

// ---- Matching: CPM Monthly and CPM Daily for the Matching machines (src/cpmmatch.js) ---------------------
// a best guess: each customer's forecast cards × its share through Matching (learned: items matched ÷ cards
// persoed; or typed), ÷ one Matching OEE, against the Matching machines' speed over the hours worked
const CPM_MATCH_COL = '#2563EB'; // blue: apart from the technologies' colours and the orange of what's added
const cpmLine = () => (store.get('cpmLine', 'perso') === 'match' ? 'match' : 'perso');
const cpmLineSeg = () => `<div class="seg" role="tablist" aria-label="Perso or Matching"><button type="button" data-cpm-line="perso" class="${cpmLine() === 'perso' ? 'on' : ''}">Perso</button><button type="button" data-cpm-line="match" class="${cpmLine() === 'match' ? 'on' : ''}" title="The Matching machines: a best guess from the history there is">Matching</button></div>`;
const cpmMatchWarn = (w) => (w.length ? `<div class="kpi-actions">${w.map((x) => `<div class="kpi-action notice"><span>⚠ ${esc(x)}</span></div>`).join('')}</div>` : '');
const cpmMatchAbout = (d) => `<details class="cpm-about small muted"><summary>ⓘ How Matching is worked out</summary> Each customer's forecast cards${d.flex ? ' (× flex)' : ''} × its share through Matching — learned from the last 4 months (items matched ÷ cards persoed), or typed on <a href="#/cpm/match" title="Configuration, with Matching picked">Configuration › Matching</a> — ÷ the customer's Matching OEE — typed for it, measured on the machines ticked there, else the one Matching OEE (${cpmPct(d.oee)}) — × the machines' usual speed ÷ the customer's own Matching speed where Production sets one; against the Matching machines' speed over the hours worked (Production › Setup). Its Low priority work orders are its renewals (over Matching's renewal window, set there; OEE + ${Math.round((d.bonus || 0) * 100)} points), the rest daily work — Urgent, High, Normal, from its Matching work orders — spread as its Matching runs ended. Campaigns ticked for Matching add their cards × the share. It's a best guess: the history behind it is thinner than perso's.</details>`;
// a bar per period / hour (needed, what's added in orange) against capacity (a step line), and what's carried over
function cpmMatchChart(cats, need, cap, { added = null, backlog = null, off = null, hint = '', prio = null } = {}) {
  const n = cats.length; const W = Math.max(640, n * 46); const Hh = 280; const L = 50; const B = 28; const T0 = 18;
  const { max, ticks } = cpmScale(Math.max(1, ...need, ...cap, ...(backlog || [])) * 1.12);
  const slot = (W - L - 6) / n; const x = (i) => L + (i + 0.5) * slot; const bw = slot * 0.62; const y = (v) => T0 + (Hh - T0 - B) * (1 - v / max);
  const step = cap.map((c, i) => `${i ? 'L' : 'M'}${L + i * slot},${y(c)} L${L + (i + 1) * slot},${y(c)}`).join(' ');
  return `<svg class="cpm-chart" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="xMinYMin meet">${CPM_PRIO_DEFS}
    ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${cpmAxis(v)}</text>`).join('')}
    ${off ? off.map((o, i) => (o ? `<rect x="${L + i * slot}" y="${T0}" width="${slot}" height="${Hh - T0 - B}" class="cpm-off"/>` : '')).join('') : ''}
    ${need.map((v, i) => { const over = v > cap[i] + 0.5; const ad = Math.min(v, added?.[i] || 0);
      return `<g><title>${esc(`${cats[i]}: needed ${cpmN(v)}${ad > 0.5 ? ` (${cpmN(ad)} added)` : ''} · capacity ${cpmN(cap[i])}${cap[i] ? ` · ${cpmPct(v / cap[i])}` : ''}${hint}`)}</title>
        ${prio ? (() => { const tot = CPM_PRIOS.reduce((a, [k]) => a + (prio[k]?.[i] || 0), 0); const f = tot > 1e-9 ? v / tot : 0; let b0 = 0;
          return CPM_PRIOS.map(([k, l]) => { const p = (prio[k]?.[i] || 0) * f; const r = p > 1e-9 ? cpmPrioRect(x(i) - bw / 2, y(b0 + p), bw, Math.max(0, y(b0) - y(b0 + p)), CPM_MATCH_COL, k, `${cats[i]}: ${l} ${cpmN(p)}`) : ''; b0 += p; return r; }).join('')
            + (over ? `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" class="cpm-over" style="fill:none"/>` : ''); })()
          : `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(0) - y(v))}" style="fill:${CPM_MATCH_COL}" class="cpm-allbar ${over ? 'cpm-over' : ''}"/>`}
        ${ad > 0.5 ? `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, y(v - ad) - y(v))}" class="cpm-added"/>` : ''}
        ${v >= 0.5 && n <= 24 ? `<text x="${x(i)}" y="${y(v) - 4}" text-anchor="middle" class="cpm-lbl ${over ? 'over' : ''}">${esc(cpmK(v))}</text>` : ''}</g>`; }).join('')}
    <path d="${step}" fill="none" class="cpm-capstep"/>
    ${backlog && backlog.some((v) => v > 0.5) ? `<polyline fill="none" class="cpm-backlog" points="${backlog.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"/>` : ''}
    ${cats.map((c, i) => `<text x="${x(i)}" y="${Hh - 9}" text-anchor="middle" class="cpm-ax">${esc(c)}</text>`).join('')}
  </svg>`;
}
// the priorities, most urgent first: the colour hatched for Urgent (dense) and High (sparse), plain for Normal,
// lighter for Low — hatching shows on any colour, dark or light
const CPM_PRIOS = [['urgent', 'Urgent'], ['high', 'High'], ['normal', 'Normal'], ['low', 'Low']];
const CPM_PRIO_DEFS = '<defs><pattern id="cpm-pu" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="2" height="5" fill="rgba(255,255,255,.7)"/></pattern><pattern id="cpm-ph" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><rect width="1.4" height="8" fill="rgba(255,255,255,.6)"/></pattern></defs>';
const cpmPrioRect = (x, y, w, h, c, k, title = '') => `<rect x="${x}" y="${y}" width="${w}" height="${h}" style="fill:${c}" class="cpm-allbar ${k === 'low' ? 'cpm-rnw' : ''}">${title ? `<title>${esc(title)}</title>` : ''}</rect>${k === 'urgent' || k === 'high' ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#cpm-p${k[0]})" pointer-events="none"/>` : ''}`;
const cpmPrioSw = (c, k) => `background:${c};${k === 'urgent' ? 'background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.7) 0 2px,transparent 2px 4px);' : k === 'high' ? 'background-image:repeating-linear-gradient(45deg,rgba(255,255,255,.6) 0 1.2px,transparent 1.2px 6px);' : k === 'low' ? 'opacity:.45;' : ''}`;
const cpmPrioMix = (m, keys = ['urgent', 'high', 'normal', 'low']) => (m ? keys.filter((k) => m[k] !== undefined).map((k) => `${k[0].toUpperCase()} ${cpmPct(m[k])}`).join(' · ') : '—');
const cpmPrioLegend = (c, keys) => CPM_PRIOS.filter(([k]) => keys.includes(k)).map(([k, l]) => `<span><i class="sw" style="${cpmPrioSw(c, k)}"></i>${l}</span>`).join('');
const cpmMatchLegend = (extra = '', added = false) => `<div class="cpm-legend"><span><i class="sw" style="background:${CPM_MATCH_COL}"></i>Needed (items ÷ OEE)</span>${added ? '<span><i class="sw cpm-added-sw"></i>added: a scenario\'s volume</span>' : ''}<span><i class="ln"></i>Capacity</span>${extra}</div>`;

async function cpmMatchMonthly(body) {
  const year = Number(store.get('cpmYear', new Date().getFullYear())); const flex = store.get('cpmFlex', true);
  const d = await cpmGet(`/cpm/match/monthly?year=${year}&flex=${flex ? 1 : 0}`);
  const Y = (f) => d.months.reduce((a, m) => a + (f(m) || 0), 0); const capY = Y((m) => m.capacity); const needY = Y((m) => m.need);
  const peak = d.months.reduce((w, m) => ((m.load || 0) > (w?.load || 0) ? m : w), null);
  const years = [year - 1, year, year + 1];
  const tile = (l, v, s = '') => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${v}</div>${s ? `<div class="kdb-tile-s">${s}</div>` : ''}</div>`;
  body.innerHTML = `<div class="row pl-filters" style="gap:10px;flex-wrap:wrap">${cpmLineSeg()}
      <select id="cpm-m-year">${years.map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <label class="row small"><input type="checkbox" id="cpm-m-flex" ${flex ? 'checked' : ''}> apply flex</label></div>
    ${cpmMatchAbout(d)}${cpmMatchWarn(d.warnings)}
    <div class="kdb-tiles pl-tiles">${tile(`${year} items matched`, cpmK(Y((m) => m.items)), `from ${cpmK(Y((m) => m.cards))} cards`)}${tile('Machine time needed', cpmK(needY), `÷ OEE ${cpmPct(d.oee)}`)}
      ${tile('Capacity', cpmK(capY), `${d.machines.length} machine${d.machines.length === 1 ? '' : 's'} · ${cpmK(d.capacity_hour)} an hour`)}${tile('Load over the year', capY ? `<span class="cpm-u ${cpmUtilCls(needY / capY)}">${cpmPct(needY / capY)}</span>` : '—')}
      ${tile('Busiest month', peak ? esc(peak.label) : '—', peak?.load ? `<span class="cpm-u ${cpmUtilCls(peak.load)}">${cpmPct(peak.load)}</span>` : '')}</div>
    <div class="card"><h3 class="pl-h">Matching — needed against capacity, by month</h3>${cpmMatchLegend(store.get('cpmShowPrio', false) && d.months.some((m) => m.prio) ? cpmPrioLegend(CPM_MATCH_COL, ['urgent', 'high', 'normal', 'low']) : '', d.months.some((m) => m.added > 0.5))}${cpmMatchChart(d.months.map((m) => m.label), d.months.map((m) => m.need), d.months.map((m) => m.capacity), { added: d.months.map((m) => m.added), prio: store.get('cpmShowPrio', false) && d.months.some((m) => m.prio) ? Object.fromEntries(['urgent', 'high', 'normal', 'low'].map((k) => [k, d.months.map((m) => m.prio?.[k] || 0)])) : null })}</div>
    <div class="card"><h3 class="pl-h">By month</h3><div class="kdb-scroll"><table class="log small"><thead><tr><th>Month</th><th class="num">Working days</th><th class="num">Cards (forecast)</th><th class="num">Items matched</th><th class="num">Needed (÷ OEE)</th><th class="num">Capacity</th><th class="num">Load</th><th>The biggest</th></tr></thead><tbody>
      ${d.months.map((m) => `<tr><th>${esc(m.label)}</th><td class="num">${m.workdays}</td><td class="num">${cpmK(m.cards)}</td><td class="num">${cpmK(m.items)}</td><td class="num"><b>${cpmK(m.need)}</b></td><td class="num">${cpmK(m.capacity)}</td>
        <td class="num cpm-u ${cpmUtilCls(m.load || 0)}">${m.load === null ? '—' : cpmPct(m.load)}</td><td class="small">${m.top.slice(0, 4).map((c) => `${esc(c.trigram || c.name)} <span class="muted">${cpmK(c.need)}</span>`).join(' · ')}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('#cpm-m-year').onchange = (e) => { store.set('cpmYear', Number(e.target.value)); renderCpm('overview'); };
  $('#cpm-m-flex').onchange = (e) => { store.set('cpmFlex', e.target.checked); renderCpm('overview'); };
}


// 🛠 Configuration › Matching: the Matching OEE, and each customer's share through Matching (learned / typed)
async function cpmMatchConfig(body, part = 'customers') {
  const d = await api.get('/cpm/match/config');
  const row = (c) => `<tr><td><b>${esc(c.trigram)}</b> <span class="muted">${esc(c.name || '')}</span></td><td class="num">${c.perso ? cpmK(c.perso) : '<span class="muted">—</span>'}</td><td class="num">${c.match ? cpmK(c.match) : '<span class="muted">—</span>'}</td>
    <td class="num">${c.learned === null ? `<span class="muted" title="Too little history: everyone's share is used">everyone's ${cpmPct(d.everyone?.ratio || 0)}</span>` : cpmPct(c.learned)}</td>
    <td class="num"><input type="number" class="cpm-mr" data-tri="${esc(c.trigram)}" min="0" max="100" step="1" value="${c.typed === null || c.typed === undefined ? '' : Math.round(c.typed * 100)}" placeholder="${Math.round((c.learned ?? d.everyone?.ratio ?? 0) * 100)}" style="width:80px"></td>
    <td class="num">${c.own_speed ? `${cpmK(c.own_speed)}/h` : ''}</td>
    <td class="num">${c.oee_measured === null ? '<span class="muted" title="Under 2 hours of jobs timed on the machines ticked (Capacity)">—</span>' : `<span title="${cpmN(c.oee_hours, 1)} h of runs${c.oee_raw > 1 ? ` — measured ${cpmPct(c.oee_raw)}, kept at 100%: its own speed may be set too low` : ''}">${cpmPct(c.oee_measured)}</span>`}</td>
    <td class="num"><input type="number" class="cpm-mo" data-tri="${esc(c.trigram)}" min="1" max="100" step="1" value="${c.oee_typed === null || c.oee_typed === undefined ? '' : Math.round(c.oee_typed * 100)}" placeholder="${Math.round((c.oee_measured ?? d.oee) * 100)}" style="width:70px"></td>
    <td class="num small ${c.prio?.from === 'learned' ? '' : 'muted'}" title="${esc(c.prio?.from === 'learned' ? `${c.prio.days} days of its work orders` : c.prio?.from === 'everyone' ? 'Too few of its own: everyone\'s' : 'No Matching work orders seen')}">${c.prio ? cpmPrioMix(c.prio.mix) : '—'}</td></tr>`;
  const mach = (m) => `<label class="row small" style="gap:4px" title="${m.speed ? '' : 'No speed set: its runs can\'t be measured'}"><input type="checkbox" class="cpm-mm" data-name="${esc(m.name)}" ${m.measure ? 'checked' : ''} ${m.speed ? '' : 'disabled'}> ${esc(m.name)} <b>${m.speed ? `${cpmK(m.speed)}/h` : 'no speed'}</b>${m.measure && m.runs !== null ? ` <span class="muted">${cpmN(m.runs)} runs</span>` : ''}</label>`;
  // each part on the sub-tab it belongs to: Capacity (the OEE, the machines to measure on), Customers (each one's
  // share, OEE, priorities), CPM Daily (the renewal window)
  const capCard = `<div class="card"><h3 class="pl-h">Matching OEE <span class="muted small">— the losses (stops, set-ups, slow running) counted once, as each customer's OEE does for perso. Used for a customer without its own (typed or measured, on Customers).</span></h3>
      <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap"><label class="row small" style="gap:6px">OEE <input type="number" id="cpm-moee" min="1" max="100" step="1" value="${Math.round(d.oee * 100)}" style="width:80px"> %</label>
        ${d.customer_speeds.length ? `<span class="small muted">Customers with their own speed: ${d.customer_speeds.map((c) => `${esc(c.customer)} ${cpmK(c.speed)}/h`).join(', ')}</span>` : ''}</div>
      <div class="small" style="margin-top:8px"><b>Measure customers' OEE on</b> <span class="muted">— tick the machines whose timing runs show a customer's real pace: items made ÷ (the time the jobs took × the machine's speed, or the customer's own speed). A job's time is from the machine's previous finish to its own — the end times are trusted, the starts aren't (often entered just before the end); gaps over 2 hours (idle, shift changes) are left out. Leave out machines whose runs would mislead — hand stations, shared or mixed lines.${d.measured_all ? ` All ticked machines together: ${cpmPct(d.measured_all.oee)} over ${cpmN(d.measured_all.hours, 0)} h.` : ''}</span></div>
      <div class="row" style="gap:14px;flex-wrap:wrap;margin-top:4px">${d.machines.length ? d.machines.map(mach).join('') : '<span class="small muted">No Matching machines set up (Production › Setup)</span>'}</div>
      <p class="small muted" style="margin:8px 0 0">The Matching machines and their speeds (and customers' own Matching speeds) are set in Production › Setup.</p></div>`;
  const custCard = `<div class="card"><h3 class="pl-h">Customers on Matching <span class="muted small">— share through Matching: each customer's items matched ÷ cards persoed, the last 4 months (the two timing reports). Blank: learned (customers with little history take everyone's: ${cpmPct(d.everyone?.ratio || 0)}); type a % to set it (0 – 100: a card is matched once at most; 0 for a customer that skips Matching). OEE: blank takes the measured one, else the Matching OEE (Capacity).</span></h3>
      <div class="kdb-scroll"><table class="log small"><thead><tr><th>Customer</th><th class="num">Persoed (4 months)</th><th class="num">Matched (4 months)</th><th class="num">Learned</th><th class="num">Share %</th><th class="num">Own speed</th><th class="num" title="On the machines ticked on Capacity, the last 4 months">Measured OEE</th><th class="num" title="Blank: measured, else the Matching OEE">OEE %</th><th class="num" title="Its Matching work orders by priority on an average day, the last 4 months: Urgent · High · Normal · Low (Low: its renewals)">Priority (learned)</th></tr></thead><tbody>${d.customers.map(row).join('')}</tbody></table></div></div>`;
  const winCard = `<div class="card"><h3 class="pl-h">Renewal window <span class="muted small">— the hours Matching runs its renewals (Low priority work orders; click to toggle). None: spread over every hour worked. Daily work goes first; the renewals take what's left from their window on.</span></h3>
      <div class="cpm-win"><div class="row" style="gap:6px;align-items:center;flex-wrap:wrap">${(d.hours || []).map((h) => `<button type="button" class="cpm-hr cpm-mwin ${(d.window || []).includes(h) ? 'on' : ''}" data-h="${h}" style="--c:${CPM_MATCH_COL}">${String(h).padStart(2, '0')}</button>`).join('')}</div></div>
      <p class="small muted" style="margin:8px 0 0">Shipment times and each customer's cut-off are shared with perso: set on Perso's CPM Daily here, and in CPM Daily's customer table. Campaigns are set on CPM Daily, each ticked for Matching or not.</p></div>`;
  const bar = '<div class="row" style="gap:8px;margin-top:6px;align-items:center"><div class="spacer"></div><span class="small pl-warn" id="cpm-m-dirty" hidden>Not saved yet</span><button class="small" id="cpm-m-undo" disabled>Undo changes</button><button class="small primary" id="cpm-m-save" disabled>💾 Save</button></div>';
  body.innerHTML = `<p class="small muted" style="margin:0 0 8px">Matching's settings — switch to Perso above for perso's. The forecast, scenarios and the forecast check are shared by both.</p>${part === 'capacity' ? capCard : part === 'dayset' ? winCard : custCard}${bar}`;
  // what's on this part, saved together
  const has = (sel) => !!$(sel);
  const now = () => { const o = { ...(Object.fromEntries(d.customers.filter((c) => c.typed !== null && c.typed !== undefined).map((c) => [c.trigram, c.typed]))) };
    for (const el of $$('.cpm-mr')) { const v = String(el.value).trim(); if (v === '') delete o[el.dataset.tri]; else o[el.dataset.tri] = Math.min(1, Math.max(0, Number(v) / 100 || 0)); } return o; };
  const oees = () => { const o = {}; for (const el of $$('.cpm-mo')) { const v = Number(String(el.value).trim()); if (String(el.value).trim() !== '' && v > 0) o[el.dataset.tri] = Math.min(100, v) / 100; } return o; };
  const elig = () => $$('.cpm-mm').filter((el) => el.checked).map((el) => el.dataset.name);
  const win = () => $$('.cpm-mwin').filter((b) => b.classList.contains('on')).map((b) => Number(b.dataset.h)).sort((a, b) => a - b);
  const state = () => JSON.stringify([now(), oees(), elig(), $('#cpm-moee')?.value, win()]); const s0 = state();
  const dirty = () => { const ch = state() !== s0; $('#cpm-m-save').disabled = !ch; $('#cpm-m-undo').disabled = !ch; $('#cpm-m-dirty').hidden = !ch; };
  $$('.cpm-mwin').forEach((b) => { b.onclick = () => { b.classList.toggle('on'); dirty(); }; });
  $$('.cpm-mr, .cpm-mo, #cpm-moee').forEach((el) => { el.oninput = dirty; }); $$('.cpm-mm').forEach((el) => { el.onchange = dirty; });
  $('#cpm-m-undo').onclick = () => renderCpm(part);
  $('#cpm-m-save').onclick = async () => {
    const out = {};
    if (has('#cpm-moee')) { const v = Number($('#cpm-moee').value); if (!(v > 0 && v <= 100)) { toast('The OEE is a % from 1 to 100', 'error'); return; } out.cpm_match_oee = String(v / 100); out.cpm_match_oee_machines = JSON.stringify(elig()); }
    if (has('.cpm-mr')) { out.cpm_match_ratio = JSON.stringify(now()); out.cpm_match_cust_oee = JSON.stringify(oees()); }
    if (has('.cpm-mwin')) out.cpm_rnw_hours = JSON.stringify({ ...(d.rnw_hours || {}), Matching: win() });
    try { await api.put('/cpm/settings', out); toast('Matching saved'); renderCpm(part); } catch (err) { toast(err.message, 'error'); } };
}

async function cpmFlex(body) {
  const d = await cpmGet('/cpm/flex');
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
    <div class="card"><h3 class="pl-h">Flex — actual ÷ forecast, by month <span class="muted small">— from ${cpmN(d.pairs)} customer-months (uploaded years, and the months gone by since the forecasts have been read here) · used on CPM Monthly as the expected flex</span></h3>
      <div class="kdb-scroll"><table class="log small cpm-t"><thead><tr><th>Customer</th>${M.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Year</th><th>By year</th></tr></thead><tbody>
      <tr class="pl-load-total"><td><b>Everyone</b></td>${d.overall.months.map(cell).join('')}${cell(d.overall.year)}<td></td></tr>
      ${d.customers.map((c) => `<tr><td><b>${esc(c.trigram)}</b></td>${c.months.map(cell).join('')}${cell(c.year)}<td class="small">${c.years.map((y) => `${y.year}: ${y.ratio >= 1 ? '+' : ''}${cpmPct(y.ratio - 1)}`).join(' · ')}</td></tr>`).join('') || `<tr><td colspan="15" class="muted">No months with both a forecast and an actual yet.</td></tr>`}
      </tbody></table></div>
      <p class="small muted">+12% = 12% more done than forecast. The expected flex for a customer and month is its own average for that month over the years; without one, its yearly flex, then everyone's for the month. Kept within ×0.2 – ×3.</p></div>`;
  $('#cpm-hfile').onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = ''; const kind = $('#cpm-hkind').value; const year = $('#cpm-hyear').value;
    cpmRegenTab = 'flex';
    for (const f of files) {
      const r = await fetch(`/api/cpm/history?kind=${kind}&year=${year}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': f.name } });
      const x = await r.json().catch(() => ({}));
      toast(r.ok ? `${f.name}: ${cpmN(x.rows)} figures, ${x.customers} customers, ${x.years.join(', ')}${x.unmapped?.length ? ` — ${x.unmapped.length} names not matched to a customer` : ''}` : x.error || r.statusText, r.ok ? '' : 'error');
    }
    renderCpm('flex');
  };
  $$('[data-cpm-hdel]').forEach((b) => { b.onclick = async () => { const [y, k] = b.dataset.cpmHdel.split('|'); if (!confirm(`Remove the uploaded ${k} for ${y}?`)) return; await api.del(`/cpm/history?year=${y}&kind=${encodeURIComponent(k)}`); renderCpm('flex'); }; });
}

// ---- Customers: split, OEE, forecast names --------------------------------------------------------
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
      <p class="small muted">Split and OEE in %. Left blank, the split is <b>learned from what was persoed</b> over the last year (each card's type from the card database — shown greyed) — or, for Amex, its forecast's own technology rows; the OEE is Production's for the customer (Setup › OEE), else ${d.oee_default_from === 'production' ? 'Production\'s for customers without one' : 'the default on Capacity'} (${Math.round(d.oee_default * 100)}%).</p>
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

// ---- Capacity: shifts, holidays, machines --------------------------------------
async function cpmCapacity(body) {
  const d = await api.get(`/cpm/overview?year=${new Date().getFullYear()}&period=month&flex=0&live=1`);
  const st = d.settings; const opts = (() => { try { return JSON.parse(st.cpm_machines || '{}'); } catch { return {}; } })();
  body.innerHTML = `<div class="card"><h3 class="pl-h">Working time</h3><div class="form-grid">
      <label class="f">Shifts a day<input type="number" min="0" max="4" step="1" data-cpm-set="cpm_shifts" value="${esc(st.cpm_shifts)}"></label>
      <label class="f" title="Normally 8: the whole shift, as breaks, change-overs, slow running and rejects are in each customer's OEE. Set it lower only for time the machines aren't run at all and the OEE doesn't already count — or the losses are taken off twice.">Hours a shift counted<input type="number" min="1" max="12" step="0.25" data-cpm-set="cpm_shift_hours" value="${esc(st.cpm_shift_hours || '8')}"></label>
      <label class="f" title="A customer with no OEE here or in Production › Setup › OEE takes Production's OEE for customers without one; this only when Production has none either">OEE when a customer has none${d.oee_fallback_from === 'production' ? ` — Production's ${Math.round(d.oee_fallback * 100)}% is used` : ''}<input type="number" min="1" max="100" step="1" data-cpm-set="cpm_oee_default" data-pct value="${Math.round(Number(st.cpm_oee_default) * 100)}" ${d.oee_fallback_from === 'production' ? 'placeholder="only if Production has none"' : ''}></label>
      <label class="f full">Holidays — no production (YYYY-MM-DD, one a line)<textarea rows="3" data-cpm-set="cpm_holidays" placeholder="2026-01-01&#10;2026-04-06">${esc(String(st.cpm_holidays || '').split(/[\s,;]+/).filter(Boolean).join('\n'))}</textarea></label>
      <div class="f full small muted">Working days are Production's (Setup). Capacity = speed × working days × shifts × the hours a shift counted (8: the whole shift) × the share for perso. Breaks, change-overs and other losses are in each customer's OEE, which the demand is divided by, so keep the hours at 8 unless machines aren't run at all for part of a shift.</div></div></div>
    <div class="card"><h3 class="pl-h">Machines <span class="muted small">— Production's machines and speeds (Setup); here only what's particular to capacity planning</span></h3>
      <div class="kdb-scroll"><table class="log small"><thead><tr><th>Machine</th><th>Runs</th><th title="The share of the machine's time given to perso (the rest to other work) — not its uptime: breakdowns, breaks and other losses are in the OEE">Share for perso %</th>${d.techs.map((t) => `<th>${esc(t)} speed /h</th>`).join('')}</tr></thead><tbody>
      <tr class="muted"><td colspan="3"><i>Production › Setup › speeds</i></td>${d.techs.map((t) => `<td title="${esc(d.speed_from?.[t] || 'no speed in Production')}">${d.speeds[t] ? `<b>${cpmN(d.speeds[t])}</b>/h<br><span class="small">${esc(d.speed_from[t])}</span>` : '<b class="pl-late">none</b>'}</td>`).join('')}</tr>
      ${d.machines.filter((m) => !m.added).map((m) => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.techs.join(', '))}</td>
        <td><input type="number" min="0" max="100" step="1" data-cpm-m="${esc(m.name)}" data-f="avail" value="${opts[m.name]?.avail !== undefined ? Math.round(opts[m.name].avail * 100) : ''}" placeholder="100"></td>
        ${d.techs.map((t) => `<td>${m.techs.includes(t) ? `<span class="row" style="gap:4px;flex-wrap:nowrap"><input type="number" min="0" step="10" class="${opts[m.name]?.speed?.[t] ? 'cpm-manual' : ''}" data-cpm-m="${esc(m.name)}" data-f="speed" data-t="${t}" value="${opts[m.name]?.speed?.[t] ?? ''}" placeholder="${d.speeds[t] || '—'}" title="${opts[m.name]?.speed?.[t] ? `Set by hand for capacity planning — Production's is ${d.speeds[t] || 'none'}/h` : 'Production\'s speed — type to set this machine\'s own'}">${opts[m.name]?.speed?.[t] ? `<button class="small ghost" data-cpm-reset="${esc(m.name)}" data-t="${t}" title="Back to Production's speed (${d.speeds[t] || 'none'}/h)">↺</button>` : ''}</span>` : ''}</td>`).join('')}</tr>`).join('') || '<tr><td colspan="6" class="muted">No machines — add them in Production › Setup.</td></tr>'}
      </tbody></table></div>
      <p class="small muted">A machine that runs several technologies gives its hours to whichever is short each month; what neither needs is shared. Speeds follow Production's as they change; one typed here (marked) is used for that machine instead — ↺ goes back to Production's.</p></div>`;
  $$('[data-cpm-set]').forEach((el) => { el.onchange = async () => {
    const v = el.hasAttribute('data-pct') ? String(Number(el.value) / 100) : el.tagName === 'TEXTAREA' ? el.value.split(/\s+/).filter(Boolean).join(',') : el.value;
    try { await api.put('/cpm/settings', { [el.dataset.cpmSet]: v }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
  }; });
  $$('[data-cpm-reset]').forEach((b) => { b.onclick = async () => {
    const m = b.dataset.cpmReset; const o = { ...opts, [m]: { ...(opts[m] || {}), speed: { ...(opts[m]?.speed || {}) } } }; delete o[m].speed[b.dataset.t];
    try { await api.put('/cpm/settings', { cpm_machines: JSON.stringify(o) }); toast('Back to Production\'s speed'); renderCpm('capacity'); } catch (err) { toast(err.message, 'error'); }
  }; });
  $$('[data-cpm-m]').forEach((el) => { el.onchange = async () => {
    const o = { ...opts }; const m = el.dataset.cpmM; o[m] = { ...(o[m] || {}) };
    if (el.dataset.f === 'avail') { if (el.value === '') delete o[m].avail; else o[m].avail = Number(el.value) / 100; } else { o[m].speed = { ...(o[m].speed || {}) }; if (el.value === '') delete o[m].speed[el.dataset.t]; else o[m].speed[el.dataset.t] = Number(el.value); }
    Object.assign(opts, o);
    try { await api.put('/cpm/settings', { cpm_machines: JSON.stringify(o) }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
  }; });
}

// ---- Site Capacity: what the machines could make flat out — run speed × available hours, no OEE ----
async function cpmSite(body) {
  const year = Number(store.get('cpmSiteYear', new Date().getFullYear())) || new Date().getFullYear();
  const d = await cpmGet(`/cpm/site?year=${year}`);
  const names = d.machines.map((m) => m.name);
  const top = Math.max(1, ...d.machines.map((m) => m.counted?.year || 0));
  const anyMix = d.machines.some((m) => m.mix); const anyFast = d.machines.some((m) => m.counted?.basis === 'fastest');
  const basis = anyMix && anyFast ? 'at its usual mix, or its fastest' : anyMix ? 'at its usual mix' : 'at its fastest';
  const mixText = (x) => Object.entries(x.split).filter(([, v]) => v > 0).map(([t, v]) => `${esc(t)} ${cpmPct(v)}`).join(' · ');
  const avgMonth = (x) => x.year / 12;
  const tile = (label, v, sub) => `<div class="cpm-site-tile"><div class="small muted">${label}</div><div class="cpm-site-big">${cpmK(v)}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  const usedTechs = d.techs.filter((t) => d.by_tech[t].machines);
  const fromTip = (x, t) => (x.from === 'machine' ? `${t} speed set for this machine on Capacity` : x.from === 'production' ? `${t}: ${d.speed_from[t]?.from || 'Production\'s speed'}` : `No ${t} speed`);
  const multi = d.machines.some((m) => m.techs.length > 1);
  body.innerHTML = `
    <div class="card"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Theoretical site capacity</h3>
        <span class="row" style="gap:4px"><button type="button" class="icon" data-site-year="${year - 1}" title="${year - 1}">‹</button><b>${year}</b><button type="button" class="icon" data-site-year="${year + 1}" title="${year + 1}">›</button></span>
        <div class="spacer"></div><a class="button small" href="/api/cpm/site/export?year=${year}" download title="This page as an Excel workbook: each machine's speed, share for perso and hours as inputs, the cards worked out by formulas, with the charts">⬇ Excel</a></div>
      <p class="small muted">Cards the machines could make running flat out at their run speed through every available hour: <b>no OEE</b> and no forecast.
        <b>${d.workdays}</b> working days in ${year}${d.holidays ? ` (${d.holidays} holiday${d.holidays === 1 ? '' : 's'} out)` : ''} × <b>${cpmN(d.shifts)}</b> shift${d.shifts === 1 ? '' : 's'} × <b>${cpmN(d.hours, 2)}</b> hours (the whole shift: the losses are in the OEE) = <b>${cpmN(d.hours_day, 2)} h</b> a working day, × each machine's availability for perso.
        <a href="#/cpm/capacity">Change these on Capacity</a>.</p>
      ${d.warnings.length ? `<div class="kpi-actions">${d.warnings.map((w) => `<div class="kpi-action notice"><span>⚠ ${esc(w)}</span></div>`).join('')}</div>` : ''}
      <div class="cpm-site-tiles">
        ${tile('Site, a working day', d.total.day, `${cpmN(d.machines.length)} machine${d.machines.length === 1 ? '' : 's'}${multi ? `, several-technology ones ${basis}` : ''}`)}
        ${tile('Site, a week', d.total.week, `${d.week_days} working days`)}
        ${tile('Site, a month', avgMonth(d.total), 'on average')}
        ${tile(`Site, ${year}`, d.total.year)}
        ${usedTechs.length > 1 ? usedTechs.map((t) => tile(`${CPM_TECH_ICON[t] || ''} ${esc(t)} only, ${year}`, d.by_tech[t].year, `if the ${d.by_tech[t].machines} machine${d.by_tech[t].machines === 1 ? '' : 's'} that can ran only ${esc(t)}`)).join('') : ''}
      </div></div>
    <div class="card"><h3>Per machine</h3>
      <div class="kdb-scroll"><table class="log small cpm-site-table"><thead><tr><th>Machine</th><th>Technology</th><th class="num">Speed /h</th><th class="num">Available</th><th class="num">Hours a day</th><th class="num">A day</th><th class="num">A week</th><th class="num">A month <span class="muted">(avg)</span></th><th class="num">${year}</th><th>Share of the site</th></tr></thead><tbody>
      ${d.machines.map((m) => { const rows = m.techs.length + (m.mix ? 1 : 0); return m.techs.map((t, i) => { const x = m.per[t]; const best = m.counted?.basis === 'fastest' && m.counted.tech === t;
        return `<tr>${i ? '' : `<td rowspan="${rows}"><i class="sw" style="background:${cpmMachCol(m.name, names)}"></i> <b>${esc(m.name)}</b></td>`}
          <td>${CPM_TECH_ICON[t] || ''} ${esc(t)}${best ? ' <span class="chip" title="No history of what it ran by technology: counted at its fastest in the site total">★ fastest, counted</span>' : ''}</td>
          <td class="num" title="${esc(fromTip(x, t))}">${x.speed ? cpmN(x.speed) : '<b class="pl-late">none</b>'}${x.from === 'machine' ? ' <span class="muted">✎</span>' : ''}</td>
          ${i ? '' : `<td class="num" rowspan="${rows}">${cpmPct(m.avail)}</td><td class="num" rowspan="${rows}">${cpmN(m.hours_day, 2)}</td>`}
          <td class="num">${cpmN(x.day)}</td><td class="num">${cpmN(x.week)}</td><td class="num">${cpmN(avgMonth(x))}</td><td class="num"><b>${cpmN(x.year)}</b></td>
          ${i ? '' : `<td rowspan="${rows}"><span class="cpm-site-bar"><i style="width:${Math.round(((m.counted?.year || 0) / top) * 100)}%;background:${cpmMachCol(m.name, names)}"></i></span> ${d.total.year ? cpmPct((m.counted?.year || 0) / d.total.year) : '—'}</td>`}</tr>`; }).join('')
        + (m.mix ? `<tr class="cpm-site-mix"><td title="${esc(`From ${cpmN(m.mix.cards)} cards it persoed ${m.mix.from} – ${m.mix.to}${m.mix.unknown ? ` (${cpmN(m.mix.unknown)} more whose technology isn't known, left out)` : ''}`)}">At its usual mix <span class="chip" title="Counted in the site total">★ counted</span><br><span class="small muted">${mixText(m.mix)} · last 12 months</span></td>
          <td class="num" title="Cards an hour at this mix">${cpmN(m.mix.hour)}</td><td class="num">${cpmN(m.mix.day)}</td><td class="num">${cpmN(m.mix.week)}</td><td class="num">${cpmN(avgMonth(m.mix))}</td><td class="num"><b>${cpmN(m.mix.year)}</b></td></tr>` : ''); }).join('')}
      </tbody><tfoot><tr><th colspan="5">Site${multi ? ` <span class="muted small">(several-technology machines ${basis})</span><br><span class="small muted">${usedTechs.map((t) => `${esc(t)} ${cpmK(d.counted_by_tech[t].year)}`).join(' · ')} a year</span>` : ''}</th><th class="num">${cpmN(d.total.day)}</th><th class="num">${cpmN(d.total.week)}</th><th class="num">${cpmN(avgMonth(d.total))}</th><th class="num">${cpmN(d.total.year)}</th><th></th></tr>
        ${usedTechs.length > 1 ? usedTechs.map((t) => `<tr class="muted"><td colspan="5">${CPM_TECH_ICON[t] || ''} ${esc(t)} only <span class="small">(every machine that can run it, running nothing else)</span></td><td class="num">${cpmN(d.by_tech[t].day)}</td><td class="num">${cpmN(d.by_tech[t].week)}</td><td class="num">${cpmN(avgMonth(d.by_tech[t]))}</td><td class="num">${cpmN(d.by_tech[t].year)}</td><td></td></tr>`).join('') : ''}</tfoot></table></div>
      <p class="small muted">${multi ? 'A machine that runs several technologies can\'t run them at once: each line is what it makes running only that one. The site total counts it at <b>its usual mix</b> (⚖): each technology\'s share of the cards it persoed over the last 12 months, each made at its own speed. Without that history (the technology comes from the card database), it\'s counted at its fastest. ' : ''}A speed marked ✎ is set for that machine on Capacity; the others are Production's (Setup › speeds). Hover over a speed for where it comes from.</p></div>
    <div class="card"><h3>Month by month${multi ? ` <span class="muted small">(several-technology machines ${basis})</span>` : ''}</h3>
      <div class="kdb-scroll"><table class="log small cpm-site-table"><thead><tr><th>Machine</th>${d.months.map((mo) => `<th class="num">${esc(mo.label)}</th>`).join('')}<th class="num">${year}</th></tr>
        <tr class="muted"><td><i>Working days</i></td>${d.months.map((mo) => `<td class="num">${mo.workdays}</td>`).join('')}<td class="num">${d.workdays}</td></tr></thead><tbody>
      ${d.machines.map((m) => `<tr><td><i class="sw" style="background:${cpmMachCol(m.name, names)}"></i> ${esc(m.name)}${m.counted?.basis === 'mix' ? ' <span class="muted">(mix)</span>' : m.counted?.basis === 'fastest' ? ` <span class="muted">(${esc(m.counted.tech)})</span>` : ''}</td>${(m.counted?.months || d.months.map(() => 0)).map((v) => `<td class="num">${cpmK(v)}</td>`).join('')}<td class="num"><b>${cpmK(m.counted?.year || 0)}</b></td></tr>`).join('')}
      </tbody><tfoot><tr><th>Site</th>${d.total.months.map((v) => `<th class="num">${cpmK(v)}</th>`).join('')}<th class="num">${cpmK(d.total.year)}</th></tr></tfoot></table></div></div>`;
  $$('[data-site-year]').forEach((b) => { b.onclick = () => { store.set('cpmSiteYear', Number(b.dataset.siteYear)); renderCpm('site'); }; });
}

// ---- Scenarios: changes over the base, each person's own -----------------------------------------
const CPM_CHANGES = {
  speed: { label: 'Speed change', fields: ['machine', 'tech', 'pct'] },
  add_machine: { label: '➕ Add a machine', fields: ['name', 'techs'] },
  remove_machine: { label: '➖ Remove a machine / downtime', fields: ['machine'] },
  capabilities: { label: 'Change what a machine runs', fields: ['machine', 'techs'] },
  restrict: { label: 'Restrict a machine to customers / cards', fields: ['machine', 'customers', 'cards'] },
  rnw_window: { label: 'Renewal window (CPM Daily only)', fields: ['tech', 'hours'] },
  shifts: { label: 'Shifts', fields: ['shifts'] },
  oee: { label: 'OEE change', fields: ['customer', 'tech', 'points'] },
  volume: { label: 'Customer volume', fields: ['customer', 'pct', 'flat'] },
  new_customer: { label: 'New customer', fields: ['name', 'qty', 'split', 'oee'] },
};
async function cpmScenarios(body) {
  const [list, ov, cs] = await Promise.all([api.get('/cpm/scenarios'), api.get(`/cpm/overview?year=${new Date().getFullYear()}&period=month&flex=0&live=1`), api.get('/cpm/customers')]);
  const openId = Number(store.get('cpmScenario', 0)) || null; const sc = list.find((s) => s.id === openId) || null;
  // what in it would do nothing, or only show elsewhere (as saved)
  const scWarn = sc ? await api.get(`/cpm/overview?year=${new Date().getFullYear()}&period=month&flex=0&scenarios=${sc.id}&live=1`).then((o) => o.scenarios[0].warnings.filter((w) => !o.warnings.includes(w))).catch(() => []) : [];
  const baseMachines = ov.machines.filter((m) => !m.added).map((m) => m.name);
  let machines = baseMachines; // with the machines this scenario adds, so they can be changed too
  const T = ov.techs; const custs = [...new Set([...cs.customers.map((c) => c.trigram), ...cs.not_set_up.map((c) => c.trigram)])].sort();
  const cardFields = { material: 'Material', name: 'Cardbody name', sides: 'Print sides', tag: 'Tag', provider: 'Provider', type: 'Type' };
  const cardVals = {}; // field → [{ value, qty }]
  const loadCards = () => $$('.cpm-change').forEach(async (el) => {
    const list = el.querySelector('.cpm-cf-list'); if (!list) return;
    const sel = el.querySelector('.cpm-cf'); const q = el.querySelector('.cpm-cf-q'); const n = el.querySelector('.cpm-cf-n');
    const draw = async () => {
      const f = sel.value; if (!cardVals[f]) { const r = await api.get(`/cpm/card-values?field=${f}`); cardVals[f] = r.linked ? r.values : null; }
      const picked = new Set(JSON.parse(list.dataset.sel || '[]'));
      const vals = cardVals[f]; if (!vals) { list.innerHTML = '<span class="small pl-warn">The card database isn\'t linked (Production › Setup) — there are no cards to pick from.</span>'; return; }
      const term = q.value.trim().toLowerCase(); const shown = vals.filter((v) => picked.has(v.value) || !term || v.value.toLowerCase().includes(term));
      n.textContent = `${picked.size} ticked · ${vals.length} values`;
      list.innerHTML = shown.slice(0, 200).map((v) => `<label class="row small" title="${cpmN(v.qty)} persoed in the last year"><input type="checkbox" name="values" value="${esc(v.value)}" ${picked.has(v.value) ? 'checked' : ''}> ${esc(v.value)} <span class="muted">${v.qty ? cpmK(v.qty) : ''}</span></label>`).join('') || '<span class="small muted">Nothing matches.</span>';
      list.querySelectorAll('input').forEach((i) => { i.onchange = () => { const s = new Set(JSON.parse(list.dataset.sel || '[]')); if (i.checked) s.add(i.value); else s.delete(i.value); list.dataset.sel = JSON.stringify([...s]); n.textContent = `${s.size} ticked · ${vals.length} values`; }; });
    };
    sel.onchange = () => { list.dataset.sel = '[]'; list.innerHTML = ''; draw(); }; q.oninput = draw; draw();
  });
  const sel = (name, val, opts, all = 'all') => `<select name="${name}"><option value="">${all}</option>${opts.map((o) => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  const field = (c, f) => {
    if (f === 'machine') return `<label class="f">Machine${sel('machine', c.machine, machines, c.type === 'speed' ? 'all machines' : '— choose —')}</label>`;
    if (f === 'tech') return `<label class="f">Technology${sel('tech', c.tech, T, 'all')}</label>`;
    if (f === 'customer') return `<label class="f">Customer${sel('customer', c.customer, custs, 'all customers')}</label>`;
    if (f === 'techs') return `<div class="f"><span>Runs</span><div class="row">${T.map((t) => `<label class="row small"><input type="checkbox" name="techs" value="${t}" ${(c.techs || []).includes(t) ? 'checked' : ''}> ${t}</label>`).join(' ')}</div></div>`;
    if (f === 'hours') return `<div class="f full"><span>Renewals run in these hours</span><div class="row" style="gap:3px;flex-wrap:wrap">${Array.from({ length: 24 }, (_, i) => (6 + i) % 24).map((h) => `<label class="cpm-hr-pick"><input type="checkbox" name="hours" value="${h}" ${(c.hours || []).map(Number).includes(h) ? 'checked' : ''}><span>${String(h).padStart(2, '0')}</span></label>`).join('')}</div></div>`;
    if (f === 'customers') return `<div class="f full"><span>Only these customers <span class="muted">(none ticked: any)</span></span><div class="cpm-picks">${custs.map((t) => `<label class="row small"><input type="checkbox" name="customers" value="${esc(t)}" ${(c.customers || []).includes(t) ? 'checked' : ''}> ${esc(t)}</label>`).join('')}</div></div>`;
    if (f === 'cards') return `<div class="f full"><span>Only these cards <span class="muted">(from the card database; none ticked: any)</span></span>
      <div class="row" style="gap:6px;flex-wrap:wrap"><select name="field" class="cpm-cf">${Object.entries(cardFields).map(([k, l]) => `<option value="${k}" ${(c.field || 'material') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input type="search" class="cpm-cf-q" placeholder="Filter…" style="max-width:220px"><span class="small muted cpm-cf-n"></span></div>
      <div class="cpm-picks cpm-cf-list" data-sel="${esc(JSON.stringify(c.values || []))}"><span class="small muted">Loading…</span></div></div>`;
    if (f === 'split') return `<div class="f"><span>Split %</span><div class="row">${T.map((t) => `<label class="row small">${t} <input type="number" name="split_${t}" min="0" max="100" style="width:70px" value="${c.split?.[t] ? Math.round(c.split[t] * 100) : ''}"></label>`).join(' ')}</div></div>`;
    const L = { pct: ['Change %', '+10 or −15'], points: ['OEE change (points) — lowers the capacity needed; capacity stays', '+5'], shifts: ['Shifts a day', ''], hours: ['Productive hours a shift', ''], name: ['Name', ''], qty: ['Cards a month', ''], oee: ['OEE %', '35'], flat: ['and / or flat cards added — over From … Until, spread over their working days (no Until: the From month)', 'e.g. 50000'] }[f];
    return `<label class="f">${L[0]}<input type="${f === 'name' ? 'text' : 'number'}" name="${f}" value="${esc(c[f] ?? (f === 'oee' && c.oee ? Math.round(c.oee * 100) : ''))}" placeholder="${L[1]}"></label>`;
  };
  const refreshMachines = () => { machines = [...baseMachines, ...(sc?.changes || []).filter((c) => c.type === 'add_machine' && c.name && !baseMachines.includes(c.name)).map((c) => c.name)]; };
  const changeHtml = (c, i) => `<div class="card cpm-change" data-i="${i}" data-type="${esc(c.type)}"><div class="row" style="justify-content:space-between"><b>${CPM_CHANGES[c.type].label}</b><button class="link small" data-cpm-rm="${i}">✕ remove</button></div>
      <div class="form-grid">${CPM_CHANGES[c.type].fields.map((f) => field(c, f)).join('')}
        <label class="f">From month<input type="month" name="from" value="${esc(c.from || '')}"></label><label class="f" title="Leave blank to keep the change from then on">Until (blank: from then on)<input type="month" name="to" value="${esc(c.to || '')}"></label></div>${c.type === 'volume' ? '<div class="cpm-vprev"><p class="small muted">Preview: pick a customer and a change.</p></div>' : ''}</div>`;
  refreshMachines();
  body.innerHTML = `<div class="cpm-scen"><div class="card cpm-scen-list"><h3 class="pl-h">Scenarios</h3>
      ${list.map((s) => `<div class="cpm-scen-item ${s.id === openId ? 'on' : ''}" data-cpm-open="${s.id}"><b>${esc(s.name)}</b><div class="small muted">${s.changes.length} change${s.changes.length === 1 ? '' : 's'} · ${s.mine ? (s.shared ? 'yours, shared' : 'yours') : `${esc(s.owner_name || 'someone')}'s`}</div></div>`).join('') || '<p class="small muted">None yet.</p>'}
      <div class="row" style="gap:6px;margin-top:8px"><input type="text" id="cpm-sc-name" placeholder="Name, e.g. MX1 to DOD"><button class="small primary" id="cpm-sc-new">+ New</button></div>
      <p class="small muted">Your scenarios are yours; tick “share” to let the rest of Prod Management see one (they can copy it, not change it).</p></div>
    <div class="cpm-scen-edit">${sc ? `<div class="card"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="cpm-sc-title" value="${esc(sc.name)}" ${sc.mine ? '' : 'disabled'} style="font-weight:700;flex:1;min-width:220px">
        ${sc.mine ? `<label class="row small"><input type="checkbox" id="cpm-sc-share" ${sc.shared ? 'checked' : ''}> share with Prod Management</label>` : `<span class="small muted">${esc(sc.owner_name || 'Someone')}'s — read only</span>`}
        <button class="small" id="cpm-sc-compare">📊 Compare on CPM Monthly</button>${ddMenu('⋯', `<button id="cpm-sc-copy">⧉ Make a copy</button>${sc.mine ? '<hr><button class="danger" id="cpm-sc-del">🗑 Delete this scenario</button>' : ''}`, { title: 'Copy or delete' })}</div>
        <textarea id="cpm-sc-notes" rows="2" placeholder="Notes — what it's for" ${sc.mine ? '' : 'disabled'} style="margin-top:6px">${esc(sc.notes || '')}</textarea></div>
      <div id="cpm-sc-warn">${scWarn.length ? `<div class="kc-note">⚠ ${scWarn.map(esc).join('<br>⚠ ')}</div>` : ''}</div>
      <div id="cpm-changes">${sc.changes.map(changeHtml).join('') || '<p class="muted">No changes yet — add one below.</p>'}</div>
      ${sc.mine ? `<div class="row" style="gap:6px;flex-wrap:wrap"><select id="cpm-add-type">${Object.entries(CPM_CHANGES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}</select><button class="small" id="cpm-add-change">+ Add change</button><div class="spacer"></div><button class="primary" id="cpm-sc-save">💾 Save</button></div>` : ''}`
      : '<div class="card lib-empty"><p>Pick a scenario on the left, or make a new one.</p><p class="small muted">A scenario is a list of changes laid over the base plan — machines added, removed or changed, speeds, shifts, OEE, customer volumes — each from a month (and until one). The base forecast keeps updating underneath.</p></div>'}</div></div>`;
  const readOne = (el) => {
    const c = { type: sc.changes[Number(el.dataset.i)].type };
    for (const inp of el.querySelectorAll('[name]')) {
      if (inp.name === 'techs') { if (inp.checked) (c.techs = c.techs || []).push(inp.value); continue; }
      if (inp.name === 'customers' || inp.name === 'values') { if (inp.checked) (c[inp.name] = c[inp.name] || []).push(inp.value); continue; }
      if (inp.name === 'hours') { if (inp.checked) (c.hours = c.hours || []).push(Number(inp.value)); continue; }
      if (inp.name.startsWith('split_')) { if (inp.value) (c.split = c.split || {})[inp.name.slice(6)] = Number(inp.value) / 100; continue; }
      if (inp.value === '') continue;
      c[inp.name] = inp.type === 'number' ? (inp.name === 'oee' ? Number(inp.value) / 100 : Number(inp.value)) : inp.value;
    }
    if (CPM_CHANGES[c.type].fields.includes('techs') && !c.techs) c.techs = [];
    if (c.type === 'restrict') { const list = el.querySelector('.cpm-cf-list'); if (list) c.values = JSON.parse(list.dataset.sel || '[]'); if (!c.values?.length) delete c.values; }
    return c;
  };
  const read = () => $$('.cpm-change').map(readOne);
  // a customer volume change: what it moves, month by month (worked out on the server against the base plan, as typed)
  const vprev = async (el) => {
    const box = el.querySelector('.cpm-vprev'); if (!box) return; const c = readOne(el);
    if (!Number(c.pct) && !Number(c.flat)) { box.innerHTML = '<p class="small muted">Preview: type a % and / or flat cards.</p>'; return; }
    const flex = store.get('cpmFlex', true); let p;
    try { p = await api.get(`/cpm/scenario-preview?flex=${flex ? 1 : 0}&change=${encodeURIComponent(JSON.stringify(c))}`); } catch (err) { box.innerHTML = `<p class="small pl-late">${esc(err.message)}</p>`; return; }
    if (!document.body.contains(box)) return;
    const used = p.techs.filter((t) => p.months.some((m) => Math.abs(m.techs[t].cards1 - m.techs[t].cards0) > 0.5));
    const sum = (f) => p.months.reduce((a, m) => a + used.reduce((b, t) => b + f(m.techs[t]), 0), 0);
    const ld = (v) => (v === null ? '—' : `<span class="cpm-u ${cpmUtilCls(v)}">${cpmPct(v)}</span>`);
    const sg = (v) => `${v >= 0 ? '+' : '−'}${cpmK(Math.abs(v))}`;
    box.innerHTML = !p.months.length ? '<p class="small muted">Preview: no change in the months it covers (no forecast for the customer then?).</p>'
      : `<div class="small"><b>Preview</b> <span class="muted">— this change on its own against the base plan${flex ? ' (with flex)' : ''}, ${p.year}: <b>${sg(sum((x) => x.cards1 - x.cards0))} cards</b>, ${sg(sum((x) => x.need1 - x.need0))} capacity needed (÷ OEE)</span></div>
      <div class="kdb-scroll"><table class="log small cpm-vprev-t"><thead><tr><th>Month</th><th class="num" title="${esc(p.customer ? `${p.customer}'s own cards, all its technologies` : 'Every customer\'s cards')}">${esc(p.customer || 'All customers')}: before → after</th>${used.map((t) => `<th class="num" style="color:${cpmTc(t)}" title="All customers' ${esc(t)} cards that month, with the change">${esc(t)} in all</th><th class="num">needed</th><th class="num">load</th>`).join('')}</tr></thead><tbody>
      ${p.months.map((m) => `<tr><th>${esc(m.label)}</th><td class="num">${cpmK(m.cust0)} → <b>${cpmK(m.cust1)}</b> <span class="cpm-added-t">${sg(m.cust1 - m.cust0)}</span></td>${used.map((t) => { const x = m.techs[t];
        return `<td class="num" title="${esc(`${cpmN(x.cards0)} → ${cpmN(x.cards1)}`)}">${cpmK(x.cards1)} <span class="cpm-added-t">${sg(x.cards1 - x.cards0)}</span></td><td class="num">${sg(x.need1 - x.need0)}</td><td class="num">${ld(x.load0)} → ${ld(x.load1)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>
      ${p.warnings.map((w) => `<p class="small pl-warn">${esc(w)}</p>`).join('')}`;
  };
  const wirePrev = () => $$('.cpm-change[data-type="volume"]').forEach((el) => { let tm = null; const go = () => { clearTimeout(tm); tm = setTimeout(() => vprev(el), 400); }; el.oninput = go; el.onchange = go; vprev(el); });
  $$('[data-cpm-open]').forEach((el) => { el.onclick = () => { store.set('cpmScenario', Number(el.dataset.cpmOpen)); renderCpm('scenarios'); }; });
  $('#cpm-sc-new').onclick = async () => { const name = $('#cpm-sc-name').value.trim() || 'New scenario'; const s = await api.post('/cpm/scenarios', { name, changes: [] }); store.set('cpmScenario', s.id); renderCpm('scenarios'); };
  if (!sc) return;
  loadCards();
  $('#cpm-sc-compare').onclick = () => { store.set('cpmCompare', [sc.id]); location.hash = '#/cpm/overview'; };
  $('#cpm-sc-copy').onclick = async () => { const s = await api.post('/cpm/scenarios', { name: `${sc.name} (copy)`, notes: sc.notes, changes: sc.mine ? read() : sc.changes }); store.set('cpmScenario', s.id); toast('Copied — it\'s yours to change'); renderCpm('scenarios'); };
  if (!sc.mine) return;
  $('#cpm-sc-del').onclick = async () => { if (!confirm(`Delete “${sc.name}”?`)) return; await api.del(`/cpm/scenarios/${sc.id}`); store.set('cpmScenario', 0); renderCpm('scenarios'); };
  $('#cpm-add-change').onclick = () => { sc.changes = [...read(), { type: $('#cpm-add-type').value }]; refreshMachines(); $('#cpm-changes').innerHTML = sc.changes.map(changeHtml).join(''); wireRm(); loadCards(); };
  const wireRm = () => { wirePrev(); return $$('[data-cpm-rm]').forEach((b) => { b.onclick = () => { const l = read(); l.splice(Number(b.dataset.cpmRm), 1); sc.changes = l; refreshMachines(); $('#cpm-changes').innerHTML = l.map(changeHtml).join('') || '<p class="muted">No changes yet — add one below.</p>'; wireRm(); loadCards(); }; }); };
  wireRm();
  $('#cpm-sc-save').onclick = async () => {
    try { await api.put(`/cpm/scenarios/${sc.id}`, { name: $('#cpm-sc-title').value, notes: $('#cpm-sc-notes').value, shared: $('#cpm-sc-share').checked, changes: read() }); toast('Scenario saved'); renderCpm('scenarios'); } catch (err) { toast(err.message, 'error'); }
  };
}

// The forecast's total per month, as Reporting's Database adds it up (BeNeLux + Amex), against what the
// technology charts count — so the two can be checked against each other
function cpmFcTotals(d) {
  const src = d.forecast_sources || {}; const st = d.forecast_status || {};
  const LBL = { benelux: 'BeNeLux', amex: 'Amex' };
  const status = ['benelux', 'amex'].map((k) => { const x = st[k] || {}; return `<div class="small ${x.error ? 'pl-late' : 'muted'}"><b>${LBL[k]}</b>: ${x.error
    ? `${x.file ? `${esc(x.file.split(/[\\/]/).pop())} — ` : ''}couldn't be read: ${esc(x.error)}`
    : x.file ? `${esc(x.file.split(/[\\/]/).pop())}${x.modified ? ` (saved ${esc(fmtDateTime(x.modified))})` : ''} — read ${esc(fmtDateTime(x.at))}${k === 'benelux' && x.lines !== undefined ? `: ${cpmN(x.lines)} lines, ${cpmN(x.kept)} Benelux “basic” ones` : ''}${x.years?.length ? `, years ${x.years.join(', ')}` : ''}${x.by_position?.length ? ` · <span class="pl-warn" title="${esc(x.by_position.join('\n'))}">${x.by_position.length} column${x.by_position.length === 1 ? '' : 's'} not found by name — taken where SITHUB expects ${x.by_position.length === 1 ? 'it' : 'them'}</span>` : ''}` : 'not read yet'}</div>`; }).join('');
  const head = `<div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap"><h3 class="pl-h" style="margin:0">Forecast ${d.year} <span class="muted small">— the files linked in Reporting › Sources, by SITHUB's rules (BeNeLux: Benelux + “basic” lines; Amex: TOTAL BAU)</span></h3><button class="small" id="cpm-reread" title="Read the linked forecast files again now">↻ Read the forecasts again</button></div>${status}`;
  if (!Object.keys(src).length) return `<div class="card">${head}</div>`;
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const bn = src.benelux || Array(12).fill(0); const ax = src.amex || Array(12).fill(0);
  const tot = bn.map((q, i) => q + ax[i]);
  const counted = M.map((_, i) => d.forecast_counted?.[`${d.year}-${String(i + 1).padStart(2, '0')}`] || 0);
  const sit = bn.map((q) => q + ax[0]); // SITHUB looks every month's Amex up against January
  const sum = (a) => a.reduce((t, x) => t + x, 0);
  const tr = (label, a, cls = '', title = '') => `<tr class="${cls}"><th title="${esc(title)}">${label}</th>${a.map((x) => `<td class="num">${cpmN(Math.round(x))}</td>`).join('')}<td class="num"><b>${cpmN(Math.round(sum(a)))}</b></td></tr>`;
  const off = counted.map((x, i) => x - tot[i]);
  return `<div class="card">${head}
    <div class="kdb-scroll"><table class="log small cpm-tbl"><thead><tr><th></th>${M.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Year</th></tr></thead><tbody>
      ${tr('BeNeLux', bn)}${tr('Amex', ax)}${tr('<b>Total</b>', tot)}
      ${tr('Counted in the charts', counted, '', 'The forecast split over DOD / Emboss / Laser below — less than the total when a customer has no split to go by (see the notes above)')}
      ${off.some((x) => Math.abs(x) >= 1) ? tr('Not counted', off.map((x) => -x), 'pl-late') : ''}
      ${ax[0] && ax.some((x) => x !== ax[0]) ? tr('SITHUB Database', sit, 'muted', 'SITHUB\'s Database row adds January\'s Amex figure to every month (its lookup is fixed to 01/01/2026) — the total above takes each month\'s own') : ''}
    </tbody></table></div>
    ${ax[0] && ax.some((x) => x !== ax[0]) ? '<p class="small muted">SITHUB\'s Database adds January\'s Amex to every month (its lookup is fixed on 01/01/2026); the total here takes each month\'s own Amex figure, so February on differs by that.</p>' : ''}</div>`;
}

// ---- Headcount: the forecast as working hours, and the people they take, against the people there are -----
// (src/cpmhc.js does the sums, on this Capacity planning's forecast, flex, scenario, split and working days)
async function cpmHeadcount(body) {
  const year = Number(store.get('cpmYear', new Date().getFullYear())) || new Date().getFullYear();
  const flex = store.get('cpmFlex', true); const scId = Number(store.get('cpmHcScenario', 0)) || 0;
  const [d, scs] = await Promise.all([cpmGet(`/cpm/headcount?year=${year}&flex=${flex ? 1 : 0}${scId ? `&scenario=${scId}` : ''}`), api.get('/cpm/scenarios').catch(() => [])]);
  const C = d.config; const M = d.months;
  const h1 = (v) => cpmN(v, 0); const p1 = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const sum = (f) => M.reduce((a, m) => a + (f(m) || 0), 0);
  const withStaff = M.filter((m) => m.heads !== null);
  const avg = (f, list = M) => (list.length ? list.reduce((a, m) => a + (f(m) || 0), 0) / list.length : null);
  const worst = withStaff.reduce((w, m) => (w === null || m.gap_fte < w.gap_fte ? m : w), null);
  const tile = (label, v, sub, cls = '') => `<div class="cpm-site-tile ${cls}"><div class="small muted">${label}</div><div class="cpm-site-big">${v}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div>`;
  const gapCls = (g) => (g === null || g === undefined ? '' : g < -0.05 ? 'pl-late' : g > 0.05 ? 'pl-ok' : '');
  const gapTxt = (g, f) => (g === null || g === undefined ? '—' : `${g > 0 ? '+' : g < 0 ? '−' : ''}${f(Math.abs(g))}`);
  const scList = (Array.isArray(scs) ? scs : scs.scenarios || []);
  // ---- the chart: people needed (bars: perso and matching, other work) against the people there (line)
  const chart = () => {
    const W = 920; const H = 250; const L = 44; const B = 24; const T = 16; const slot = (W - L - 6) / 12; const x = (i) => L + (i + 0.5) * slot; const bw = slot * 0.6;
    const top = Math.max(1, ...M.map((m) => Math.max(m.fte_needed || 0, m.heads || 0)), ...(d.base || []).map((b) => b.fte_needed || 0)) * 1.12;
    const step = top > 60 ? 10 : top > 25 ? 5 : top > 10 ? 2 : 1; const max = Math.ceil(top / step) * step; const y = (v) => T + (H - T - B) * (1 - v / max);
    const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);
    return `<svg class="cpm-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMinYMin meet">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - 4}" y1="${y(v)}" y2="${y(v)}" class="cpm-grid"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="cpm-ax">${v}</text>`).join('')}
      ${M.map((m, i) => { const coreF = m.per_head ? m.core / m.per_head : 0; const othF = m.per_head ? m.other_total / m.per_head : 0; const short = m.heads !== null && m.fte_needed > m.heads + 0.05;
        return `<g><title>${esc(`${m.label}: ${p1(m.fte_needed)} people needed (${h1(m.total)} h: perso & matching ${h1(m.core)}, other ${h1(m.other_total)}) · ${m.heads === null ? 'no people set' : `${p1(m.heads)} there (${h1(m.available)} h)`}`)}</title>
          <rect x="${x(i) - bw / 2}" y="${y(coreF)}" width="${bw}" height="${Math.max(0, y(0) - y(coreF))}" class="cpm-hc-core"/>
          <rect x="${x(i) - bw / 2}" y="${y(coreF + othF)}" width="${bw}" height="${Math.max(0, y(coreF) - y(coreF + othF))}" class="cpm-hc-other"/>
          <text x="${x(i)}" y="${y(Math.max(coreF + othF, m.heads || 0)) - 7}" text-anchor="middle" class="cpm-lbl ${short ? 'cpm-hc-short' : ''}">${p1(m.fte_needed)}${short ? ` (−${p1(m.fte_needed - m.heads)})` : ''}</text></g>`; }).join('')}
      ${withStaff.length ? `<polyline fill="none" stroke="var(--text)" stroke-width="2.2" points="${M.map((m, i) => (m.heads === null ? null : `${x(i)},${y(m.heads)}`)).filter(Boolean).join(' ')}"/>
        ${M.map((m, i) => (m.heads === null ? '' : `<circle cx="${x(i)}" cy="${y(m.heads)}" r="3" class="cpm-cap"><title>${esc(`${m.label}: ${p1(m.heads)} people there`)}</title></circle>`)).join('')}` : ''}
      ${d.base ? `<polyline fill="none" stroke="#7a5cff" stroke-width="2" stroke-dasharray="6 4" points="${d.base.map((b, i) => `${x(i)},${y(b.fte_needed || 0)}`).join(' ')}"><title>The base plan's people needed</title></polyline>` : ''}
      ${M.map((m, i) => `<text x="${x(i)}" y="${H - 7}" text-anchor="middle" class="cpm-ax">${esc(m.label)}</text>`).join('')}
    </svg>
    <div class="cpm-legend"><span><i class="sw cpm-hc-core-sw"></i>People needed for perso and matching</span><span><i class="sw cpm-hc-other-sw"></i>for the other work</span><span><i class="ln"></i>People there</span>${d.base ? '<span><i class="ln dash" style="border-color:#7a5cff"></i>Base plan, people needed</span>' : ''}<span class="muted">${p1(C.day_hours)} h a day × working days × ${cpmPct(C.efficiency)} efficiency a person</span></div>`;
  };
  // ---- month by month: the hours, the people (typed in), and the gap
  const totRow = (label, f, fmt = h1, o = {}) => `<tr class="${o.cls || ''}"><th title="${esc(o.tip || '')}">${o.strong ? `<b>${label}</b>` : label}</th>${M.map((m) => `<td class="num">${o.strong ? `<b>${fmt(f(m))}</b>` : fmt(f(m))}</td>`).join('')}<td class="num"><b>${o.noTotal ? '' : fmt(sum(f))}</b></td></tr>`;
  const staffIn = (k) => `<tr class="cpm-hc-staff"><th>${{ perm: 'Permanent', agency: 'Agency / temporary', sick: 'Long-term sick (−)' }[k]}</th>${M.map((m) => { const st = m.staff;
      return `<td class="num"><input type="number" min="0" step="0.5" class="cpm-hc-in ${st && !st.set ? 'carried' : ''}" data-hc-staff="${m.month}" data-k="${k}" value="${st ? st[k] ?? 0 : ''}" title="${st && !st.set ? `As set for ${esc(st.from)} — change it to set ${esc(m.label)}` : `${esc(m.label)}`}"></td>`; }).join('')}<td></td></tr>`;
  const table = `<div class="kdb-scroll"><table class="log small cpm-hc-table"><thead><tr><th></th>${M.map((m) => `<th class="num">${esc(m.label)}</th>`).join('')}<th class="num">${year}</th></tr></thead><tbody>
      ${totRow('Working days', (m) => m.workdays, (v) => cpmN(v), { tip: 'Production\'s working days, less the holidays on Capacity' })}
      ${totRow('Cards (forecast)', (m) => m.cards, cpmK, { tip: `The forecast${flex ? ' × flex' : ''}${d.scenario ? `, with ${d.scenario.name}` : ''}` })}
      <tr class="cpm-hc-sec"><th colspan="14">Hours needed</th></tr>
      ${d.techs.map((t) => totRow(`${CPM_TECH_ICON[t] || ''} ${esc(t)} perso`, (m) => m.perso[t], h1, { tip: `Cards × the customer's ${t} share ÷ ${cpmN(d.rates[t])} cards an hour` })).join('')}
      ${d.methods.map((k) => totRow(`Matching: ${esc(d.method_labels[k])}`, (m) => m.match[k], h1, { tip: `Cards × the customer's ${d.method_labels[k]} share ÷ ${cpmN(d.rates[k])} cards an hour` })).join('')}
      ${totRow('Other work', (m) => m.other_total - m.extra, h1, { tip: C.other.map((o) => `${o.name}: ${o.per_day} h a working day`).join('\n') || 'None set — add it under Rates and other work' })}
      <tr><th title="Hours for a month only (a campaign, a project): typed in">One-off hours</th>${M.map((m) => `<td class="num"><input type="number" min="0" step="1" class="cpm-hc-in" data-hc-extra="${m.month}" value="${C.extra[m.month] || ''}"></td>`).join('')}<td class="num">${h1(sum((m) => m.extra))}</td></tr>
      ${totRow('Hours needed', (m) => m.total, h1, { strong: true, cls: 'cpm-hc-tot' })}
      <tr class="cpm-hc-sec"><th colspan="14">People there <span class="muted small">— type in; a month left as it is carries on from the one before (paler)</span></th></tr>
      ${['perm', 'agency', 'sick'].map(staffIn).join('')}
      ${totRow('People there', (m) => m.heads, p1, { noTotal: true, tip: 'Permanent + agency / temporary − long-term sick' })}
      ${totRow('Hours there', (m) => m.available, h1, { tip: `People × ${C.day_hours} h a day × working days × ${cpmPct(C.efficiency)}` })}
      <tr class="cpm-hc-sec"><th colspan="14">The gap</th></tr>
      ${totRow('People needed', (m) => m.fte_needed, p1, { strong: true, noTotal: true, tip: 'Hours needed ÷ the hours a person gives that month' })}
      ${d.base ? totRow('People needed, base plan', (m) => d.base.find((b) => b.month === m.month)?.fte_needed, p1, { noTotal: true }) : ''}
      <tr class="cpm-hc-tot"><th title="People there − people needed: + spare, − short"><b>People spare / short</b></th>${M.map((m) => `<td class="num"><b class="${gapCls(m.gap_fte)}">${gapTxt(m.gap_fte, p1)}</b></td>`).join('')}<td></td></tr>
      <tr><th title="Hours there − hours needed: + spare, − short">Hours spare / short</th>${M.map((m) => `<td class="num"><span class="${gapCls(m.gap_hours)}">${gapTxt(m.gap_hours, h1)}</span></td>`).join('')}<td class="num"><span class="${gapCls(withStaff.length ? sum((m) => m.gap_hours) : null)}">${withStaff.length ? gapTxt(sum((m) => m.gap_hours), h1) : ''}</span></td></tr>
    </tbody></table></div>`;
  // ---- per customer: the hours a month, and its matching split (OTTO % typed in; the rest by hand). Summary: a row a
  // customer; Detailed: each customer's hours by technology (perso) and matching method, with its total
  const custView = store.get('cpmHcCustView', 'summary') === 'detail' ? 'detail' : 'summary';
  const matchIn = (c) => `<input type="number" min="0" max="100" step="1" class="cpm-hc-in ${c.match_set ? '' : 'carried'}" data-hc-match="${esc(c.trigram || c.key)}" value="${Math.round((c.match.OTTO || 0) * 100)}" title="${c.match_set ? '' : 'The default — type to set this customer\'s'}"> %`;
  const custName = (c) => `${esc(c.trigram || c.name)}${c.trigram && c.name && c.name !== c.trigram ? ` <span class="muted">${esc(c.name)}</span>` : ''}`;
  const cell = (h) => `<td class="num">${h ? h1(h) : '<span class="muted">–</span>'}</td>`;
  const parts = [...d.techs.map((t) => [t, `${CPM_TECH_ICON[t] || ''} ${esc(t)}`]), ...d.methods.map((k) => [k, `Matching: ${esc(d.method_labels[k])}`])];
  const custRows = custView === 'summary'
    ? d.customers.map((c) => `<tr><th>${custName(c)}</th><td class="num">${matchIn(c)}</td>${c.hours.map(cell).join('')}<td class="num"><b>${h1(c.total)}</b></td></tr>`).join('')
    : d.customers.map((c) => { const rows = parts.filter(([k]) => c.by?.[k]?.some((v) => v > 0));
      return `<tr class="cpm-hc-cust"><th>${custName(c)}</th><td class="num">${matchIn(c)}</td>${c.hours.map((h) => `<td class="num"><b>${h ? h1(h) : '–'}</b></td>`).join('')}<td class="num"><b>${h1(c.total)}</b></td></tr>
        ${rows.map(([k, label]) => `<tr class="cpm-hc-part"><th>${label}</th><td></td>${c.by[k].map(cell).join('')}<td class="num">${h1(c.by[k].reduce((a, v) => a + v, 0))}</td></tr>`).join('')}`; }).join('');
  const custs = `<div class="kdb-scroll"><table class="log small cpm-hc-table"><thead><tr><th>Customer</th><th class="num" title="Its cards matched on OTTO; the rest by hand">Matching on OTTO</th>${M.map((m) => `<th class="num">${esc(m.label)}</th>`).join('')}<th class="num">${year}</th></tr></thead><tbody>
      ${custRows}
    </tbody></table></div>${d.customers.length ? '' : '<p class="muted small">No forecast for this year yet (Reporting › Sources: the BeNeLux and Amex forecasts).</p>'}`;
  const custSeg = `<span class="seg" role="group" aria-label="Per customer view"><button type="button" data-hc-cview="summary" class="${custView === 'summary' ? 'on' : ''}" title="A row a customer: its hours for perso and matching">Summary</button><button type="button" data-hc-cview="detail" class="${custView === 'detail' ? 'on' : ''}" title="Each customer's hours by technology and matching method">Detailed</button></span>`;
  // ---- the rates and other work
  const rateIn = (k, label) => `<label class="f">${label}<span class="row" style="gap:6px"><input type="number" min="1" step="1" data-hc-rate="${k}" value="${C.rates[k] || ''}" placeholder="${d.rate_from[k] === 'production' ? `${cpmN(d.rates[k])} (Production)` : 'cards an hour'}" style="max-width:130px"> /h</span></label>`;
  const setup = `<div class="cpm-hc-setup">
      <div><h4>Cards an hour, for a person</h4><p class="small muted" style="margin-top:0">Perso by technology (blank: Production's machine speed), and matching by method.</p>
        <div class="row" style="gap:10px;flex-wrap:wrap">${d.techs.map((t) => rateIn(t, `${CPM_TECH_ICON[t] || ''} ${t}`)).join('')}${d.methods.map((k) => rateIn(k, `Matching: ${d.method_labels[k]}`)).join('')}</div>
        <div class="row" style="gap:10px;flex-wrap:wrap;margin-top:8px">
          <label class="f">Hours a day<input type="number" min="1" max="24" step="0.25" data-hc-day value="${C.day_hours}" style="max-width:90px"></label>
          <label class="f">Efficiency<span class="row" style="gap:6px"><input type="number" min="1" max="100" step="1" data-hc-eff value="${Math.round(C.efficiency * 100)}" style="max-width:80px"> %</span></label>
          <label class="f" title="For customers without a split of their own">Matching on OTTO, by default<span class="row" style="gap:6px"><input type="number" min="0" max="100" step="1" data-hc-mdef value="${Math.round((C.match_default?.OTTO ?? 1) * 100)}" style="max-width:80px"> %</span></label></div></div>
      <div><h4>Other work <span class="small muted">— hours a working day</span></h4>
        <table class="log small"><tbody id="hc-orows">${C.other.map((o) => `<tr data-hc-orow><td><input type="text" data-hc-oname value="${esc(o.name)}"></td><td class="num"><input type="number" min="0" step="0.5" data-hc-oday value="${o.per_day}" style="max-width:90px"> h</td><td><button type="button" class="icon" data-hc-odel title="Remove">✕</button></td></tr>`).join('')}
          <tr><td><input type="text" id="hc-onew-name" placeholder="＋ e.g. Quality checks"></td><td class="num"><input type="number" min="0" step="0.5" id="hc-onew-day" placeholder="h a day" style="max-width:90px"></td><td><button type="button" class="small" id="hc-onew">Add</button></td></tr></tbody></table>
        <div class="small muted">${p1(C.other.reduce((a, o) => a + (o.per_day || 0), 0))} h a working day in all</div></div></div>`;
  body.innerHTML = `
    <div class="cpm-hc-savebar" id="hc-savebar"><span class="small muted">Change the people, one-off hours, matching, rates or other work below, then save them together.</span><div class="spacer"></div>
      <span class="small pl-warn" id="hc-dirty" hidden>Not saved yet</span><button class="small" id="hc-undo" disabled>Undo changes</button><button class="small primary" id="hc-save" disabled>💾 Save</button></div>
    <div class="card"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><h3 style="margin:0">Headcount</h3>
        <span class="row" style="gap:4px"><button type="button" class="icon" data-hc-year="${year - 1}">‹</button><b>${year}</b><button type="button" class="icon" data-hc-year="${year + 1}">›</button></span>
        <label class="small row" style="gap:4px"><input type="checkbox" id="hc-flex" ${flex ? 'checked' : ''}> Apply flex</label>
        <label class="small row" style="gap:4px">Plan <select id="hc-scen"><option value="0">Base</option>${scList.map((s) => `<option value="${s.id}" ${s.id === scId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <div class="spacer"></div><a class="button small" href="/api/cpm/headcount/export?year=${year}&flex=${flex ? 1 : 0}${scId ? `&scenario=${scId}` : ''}" download title="Headcount as an Excel workbook: the cards, rates, working days, hours a day, efficiency, people and other work as inputs, the hours and people worked out by formulas, with the charts; and the hours per customer">⬇ Excel</a><button type="button" id="hc-import" title="Read the rates, matching split, other work, one-off hours and people from the old HC Forecast workbook">📥 Import the HC Forecast workbook</button><input type="file" id="hc-file" accept=".xlsx,.xlsm" hidden></div>
      <p class="small muted">The forecast turned into the working hours it takes and the people to do them: each customer's cards${flex ? ' (× flex)' : ''}${d.scenario ? ` with <b>${esc(d.scenario.name)}</b>` : ''}, split across DOD / Emboss / Laser as on <a href="#/cpm/customers">Customers</a>, ÷ a person's cards an hour, plus matching and the other work — against the people there, at ${p1(C.day_hours)} h a day and ${cpmPct(C.efficiency)} efficiency.</p>
      ${d.warnings.length ? `<div class="kpi-actions">${d.warnings.map((w) => `<div class="kpi-action notice"><span>⚠ ${esc(w)}</span></div>`).join('')}</div>` : ''}
      <div class="cpm-site-tiles">
        ${tile(`Hours needed, ${year}`, h1(sum((m) => m.total)), `${h1(sum((m) => m.core))} perso & matching · ${h1(sum((m) => m.other_total))} other`)}
        ${tile('People needed, a month', p1(avg((m) => m.fte_needed)), `on average · most ${p1(Math.max(...M.map((m) => m.fte_needed || 0)))}`)}
        ${tile('People there, a month', withStaff.length ? p1(avg((m) => m.heads, withStaff)) : '—', withStaff.length ? `on average over ${withStaff.length} month${withStaff.length === 1 ? '' : 's'}` : 'none set yet')}
        ${worst ? tile('Tightest month', `${esc(worst.label)} ${gapTxt(worst.gap_fte, p1)}`, worst.gap_fte < 0 ? 'people short' : 'people spare', worst.gap_fte < -0.05 ? 'cpm-hc-bad' : '') : ''}
      </div></div>
    <div class="card"><h3>People needed and there, month by month</h3>${chart()}</div>
    <div class="card"><h3>Month by month</h3>${table}</div>
    <div class="card"><h3>Per customer <span class="small muted">— hours a month for perso and matching${custView === 'detail' ? ', by technology and method' : ''}</span> ${custSeg}</h3>${custs}</div>
    <div class="card"><h3>Rates and other work</h3>${setup}</div>`;
  // ---- edits are kept until Save (one save, then the tab is worked out again); Undo changes drops them
  const pend = { staff: {}, extra: {}, match: {}, rates: {} }; let dirty = false;
  const touch = (el) => { el?.classList.add('cpm-hc-edited'); dirty = true; $('#hc-save').disabled = false; $('#hc-undo').disabled = false; $('#hc-dirty').hidden = false; };
  const leave = () => !dirty || confirm('Leave without saving? Your changes on Headcount will be lost.');
  const go = (fn) => () => { if (!leave()) return; dirty = false; fn(); renderCpm('headcount'); };
  $$('[data-hc-year]').forEach((b) => { b.onclick = go(() => store.set('cpmYear', Number(b.dataset.hcYear))); });
  $('#hc-flex').onchange = (e) => { if (!leave()) { e.target.checked = !e.target.checked; return; } dirty = false; store.set('cpmFlex', e.target.checked); renderCpm('headcount'); };
  $$('[data-hc-cview]').forEach((b) => { b.onclick = (e) => { e.stopPropagation(); go(() => store.set('cpmHcCustView', b.dataset.hcCview))(); }; });
  $('#hc-scen').onchange = (e) => { if (!leave()) { e.target.value = String(scId); return; } dirty = false; store.set('cpmHcScenario', Number(e.target.value)); renderCpm('headcount'); };
  $$('[data-hc-staff]').forEach((i) => { i.oninput = () => { const mo = i.dataset.hcStaff; pend.staff[mo] = Object.fromEntries($$(`[data-hc-staff="${mo}"]`).map((x) => [x.dataset.k, x.value === '' ? 0 : Number(x.value)])); i.classList.remove('carried'); touch(i); }; });
  $$('[data-hc-extra]').forEach((i) => { i.oninput = () => { pend.extra[i.dataset.hcExtra] = i.value === '' ? 0 : Number(i.value); touch(i); }; });
  $$('[data-hc-match]').forEach((i) => { i.oninput = () => { pend.match[i.dataset.hcMatch] = i.value === '' ? null : { OTTO: Number(i.value) / 100 }; i.classList.remove('carried'); touch(i); }; });
  $$('[data-hc-rate]').forEach((i) => { i.oninput = () => { pend.rates[i.dataset.hcRate] = i.value === '' ? null : Number(i.value); touch(i); }; });
  $('[data-hc-day]').oninput = (e) => { pend.day_hours = Number(e.target.value); touch(e.target); };
  $('[data-hc-eff]').oninput = (e) => { pend.efficiency = Number(e.target.value) / 100; touch(e.target); };
  $('[data-hc-mdef]').oninput = (e) => { pend.match_default = { OTTO: Number(e.target.value) / 100 }; touch(e.target); };
  // other work: rows changed, removed or added here; the whole list is saved
  const others = () => $$('#hc-orows [data-hc-orow]').filter((r) => !r.hidden).map((r) => ({ name: r.querySelector('[data-hc-oname]').value.trim(), per_day: Number(r.querySelector('[data-hc-oday]').value) || 0 }));
  const wireO = (r) => {
    r.querySelectorAll('[data-hc-oname], [data-hc-oday]').forEach((i) => { i.oninput = () => { pend.other = true; touch(i); }; });
    r.querySelector('[data-hc-odel]').onclick = () => { r.hidden = true; pend.other = true; touch(null); };
  };
  $$('#hc-orows [data-hc-orow]').forEach(wireO);
  $('#hc-onew').onclick = () => {
    const name = $('#hc-onew-name').value.trim(); if (!name) return toast('Name the work first', 'error');
    $('#hc-onew-name').closest('tr').insertAdjacentHTML('beforebegin', `<tr data-hc-orow><td><input type="text" data-hc-oname value="${esc(name)}" class="cpm-hc-edited"></td><td class="num"><input type="number" min="0" step="0.5" data-hc-oday value="${Number($('#hc-onew-day').value) || 0}" style="max-width:90px" class="cpm-hc-edited"> h</td><td><button type="button" class="icon" data-hc-odel title="Remove">✕</button></td></tr>`);
    wireO($('#hc-onew-name').closest('tr').previousElementSibling);
    $('#hc-onew-name').value = ''; $('#hc-onew-day').value = ''; pend.other = true; touch(null);
  };
  $('#hc-undo').onclick = () => { dirty = false; renderCpm('headcount'); };
  $('#hc-save').onclick = async (e) => {
    const b = { ...pend }; if (pend.other) b.other = others(); else delete b.other;
    for (const k of ['staff', 'extra', 'match', 'rates']) if (!Object.keys(b[k]).length) delete b[k];
    e.target.disabled = true; e.target.textContent = '⏳ Saving…';
    try { await api.put('/cpm/headcount/config', b); dirty = false; toast('Saved'); renderCpm('headcount'); }
    catch (err) { toast(err.message, 'error'); e.target.disabled = false; e.target.textContent = '💾 Save'; }
  };
  // leaving the page (another page or tab, or closing it) with changes not saved asks first
  leaveGuard = () => !dirty || confirm('Leave without saving? Your changes on Headcount will be lost.');
  window.onbeforeunload = () => (dirty && document.body.contains($('#hc-savebar')) ? 'Changes not saved' : undefined);
  $('#hc-import').onclick = () => $('#hc-file').click();
  $('#hc-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await fetch('/api/cpm/headcount/import', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
      const x = await r.json(); if (!r.ok) throw new Error(x.error || r.statusText);
      cpmRegenTab = 'headcount';
      toast(`Read ${x.rates} rates, ${x.customers} customers' matching, ${x.other} kinds of other work, ${x.months} months of people${x.unknown.length ? ` — ${x.unknown.length} names not linked to a customer here` : ''}`);
      renderCpm('headcount');
    } catch (err) { toast(err.message, 'error'); }
  };
}
