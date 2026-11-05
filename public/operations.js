'use strict';
// 🏭 Operations: Reporting's month-by-month operations dashboard (Prod Management, src/operations.js): OTD from the
// OTD report and the planner's work orders on time (dailies and renewals), cards persoed and shipped, and scrap, on
// one screen like Quality and EHS. Loaded after quality.js; uses its dashboard pieces (tiles, mini-tabs, bar lists).

const ON = (v) => Number(v || 0).toLocaleString('en-GB');
const OK = (v) => { const n = Number(v || 0); return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : n >= 1e4 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(n)); };
const OP = (v, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)}%`);
const opsPctDelta = (now, prev) => {
  if (!prev) return '';
  const ch = (now - prev) / prev;
  return `<span class="q-delta ${ch >= 0 ? 'good' : 'bad'}">${ch >= 0 ? '▲' : '▼'} ${Math.abs(ch) < 0.1 ? Math.abs(ch * 100).toFixed(1) : Math.abs(Math.round(ch * 100))}% vs last month</span>`;
};
const opsPtDelta = (now, prev, goodUp = true) => {
  if (now === null || prev === null || now === undefined || prev === undefined) return '';
  const d = (now - prev) * 100; if (Math.abs(d) < 0.05) return '<span class="q-delta">= last month</span>';
  const good = goodUp ? d > 0 : d < 0;
  return `<span class="q-delta ${good ? 'good' : 'bad'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)} pt vs last month</span>`;
};

// ---- charts: grouped bars (and lines), drawn at their panel's size in the site's theme -----------------
const OPS_CHARTS = new Map(); let opsChartN = 0;
const opsChart = (spec) => { const id = `opc${++opsChartN}`; OPS_CHARTS.set(id, spec); return `<div class="q-chart-slot ops-slot" id="${id}"></div>`; };
function opsDraw() {
  for (const [id, spec] of OPS_CHARTS) {
    const el = document.getElementById(id); if (!el) { OPS_CHARTS.delete(id); continue; }
    if (!el.offsetParent) continue; // on a hidden mini-tab: drawn when shown
    el.innerHTML = opsSvg(spec, Math.max(300, el.clientWidth), Math.max(180, el.clientHeight || 220));
  }
}
window.addEventListener('resize', () => { clearTimeout(opsDraw.t); opsDraw.t = setTimeout(opsDraw, 150); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-qd-tab^="ochart:"]')) setTimeout(opsDraw); });
// spec: { cats: [{ label, title, dim, on }], bars: [{ key, cls, label }], lines: [{ key, cls, label }], values: [{ … }], fmt, max, target, targetLabel }
function opsSvg(spec, W, H) {
  const L = 44; const R = 12; const T = 16; const B = 22;
  const vals = spec.values;
  const all = [...spec.bars.flatMap((b) => vals.map((v) => v[b.key] || 0)), ...(spec.lines || []).flatMap((l) => vals.map((v) => v[l.key] ?? 0)), spec.target || 0];
  let max = spec.max || Math.max(...all, 1e-9) * 1.12;
  const raw = (max - (spec.min ?? 0)) / 4; const p = 10 ** Math.floor(Math.log10(raw)); const step = [1, 2, 2.5, 5, 10].map((x) => x * p).find((s) => s >= raw) || 10 * p;
  max = Math.ceil(max / step - 1e-9) * step;
  const min = Math.floor((spec.min ?? 0) / step + 1e-9) * step;
  const y = (v) => T + (H - T - B) * (1 - (Math.max(min, Math.min(max, v)) - min) / (max - min || 1));
  const n = vals.length; const cw = (W - L - R) / n;
  const nb = spec.bars.length; const bw = Math.max(2, Math.min(18, (cw * 0.72) / Math.max(1, nb)));
  const out = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="q-grid${v === min ? ' base' : ''}"/><text x="${L - 6}" y="${y(v) + 4}" class="q-ax" text-anchor="end">${spec.fmt ? spec.fmt(v) : OK(v)}</text>`);
  const every = Math.max(1, Math.ceil(n / Math.floor((W - L) / 34)));
  vals.forEach((v, i) => {
    const c = spec.cats[i]; const x0 = L + i * cw; const gx = x0 + (cw - bw * nb) / 2;
    const tip = `${c.title || c.label}: ${[...spec.bars, ...(spec.lines || [])].map((s) => `${s.label} ${spec.fmt && s.lineFmt !== false && (spec.lines || []).includes(s) ? spec.fmt(v[s.key] ?? 0) : s.fmt ? s.fmt(v[s.key]) : ON(v[s.key])}`).join(' · ')}`;
    out.push(`<g class="q-col${c.on ? ' on' : ''}${c.dim ? ' dim' : ''}"><title>${esc(tip)}</title><rect x="${x0}" y="${T}" width="${cw}" height="${H - T - B}" class="q-hit"/>`);
    spec.bars.forEach((b, j) => { const val = v[b.key] || 0; if (val > 0) out.push(`<rect x="${gx + j * bw + 0.5}" y="${y(val)}" width="${Math.max(1, bw - 1)}" height="${Math.max(0, y(min) - y(val))}" rx="2" class="${b.cls}"/>`); });
    if (i % every === 0 || c.on) out.push(`<text x="${x0 + cw / 2}" y="${H - 6}" class="q-ax${c.on ? ' on' : ''}" text-anchor="middle">${esc(c.label)}</text>`);
    out.push('</g>');
  });
  for (const l of spec.lines || []) {
    let d = ''; let pen = false;
    vals.forEach((v, i) => { const val = v[l.key]; if (val === null || val === undefined) { pen = false; return; } d += `${pen ? 'L' : 'M'}${(L + cw * (i + 0.5)).toFixed(1)},${y(val).toFixed(1)} `; pen = true; });
    if (d) out.push(`<path d="${d}" class="ops-line ${l.cls}"/>`);
    vals.forEach((v, i) => { const val = v[l.key]; if (val !== null && val !== undefined) out.push(`<circle cx="${L + cw * (i + 0.5)}" cy="${y(val)}" r="3" class="ops-dot ${l.cls}"/>`); });
  }
  if (spec.target !== undefined && spec.target !== null) out.push(`<line x1="${L}" x2="${W - R}" y1="${y(spec.target)}" y2="${y(spec.target)}" class="ops-target"/><text x="${W - R}" y="${y(spec.target) - 4}" class="q-ax ops-target-l" text-anchor="end">${esc(spec.targetLabel || 'target')}</text>`);
  return `<svg class="q-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(spec.aria || 'Chart')}">${out.join('')}</svg>`;
}
const opsLegend = (items) => `<div class="q-legend">${items.map(([cls, label, line]) => `<span><i class="q-sw ${cls}${line ? ' line' : ''}"></i>${esc(label)}</span>`).join('')}</div>`;

// which sources the page was built from, and when they were read
function opsSourcesLine(d) {
  const s = d.sources || {}; const read = Object.values(s).filter(Boolean).map((x) => x.imported_at).sort().pop();
  const names = [['perso', 'perso'], ['shipped', 'shipped'], ['otd', 'OTD report'], ['scrap', d.scrap_from === 'consumption' ? 'goods consumption' : 'machine rejections']].filter(([k]) => s[k]).map(([, l]) => l);
  return names.length ? `🏭 ${esc(names.join(' · '))}${read ? ` · read ${esc(fmtDateTime(read))}` : ''}` : '';
}

// ---- the dashboard ---------------------------------------------------------------------------------------
function opsHtml(d) {
  const t = d.tiles; const o = t.otd; const ot = t.on_time;
  const tab = (group, key, label, title = '') => `<button type="button" class="${qdOn(group, key) ? 'on' : ''}" data-qd-tab="${group}:${key}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  const pane = (group, key, html) => `<div class="qd-pane" data-qd-pane="${group}:${key}"${qdOn(group, key) ? '' : ' hidden'}>${html}</div>`;
  qdDefaults({ ochart: 'day', ocust: 'persoed', otable: 'ontime' });
  const target = 0.98;
  const day = (s) => Number(s.slice(8, 10));
  const dayCats = d.by_day.map((x) => ({ label: String(day(x.day)), title: new Date(`${x.day}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), dim: x.weekend }));
  const monCats = d.trend.map((x) => ({ label: qShort(x.month), title: x.label, on: x.month === d.month }));
  const pctFmt = (v) => `${Math.round(v * 1000) / 10}%`;
  const otdVals = d.trend.map((x) => ({ ...x }));
  const otdMin = Math.max(0, Math.floor((Math.min(...otdVals.flatMap((x) => [x.otd_sc, x.otd_c]).filter((v) => v !== null), target) - 0.02) * 50) / 50);
  const charts = {
    day: [opsLegend([['q-c3', 'Persoed'], ['q-c2', 'Shipped']]), opsChart({ aria: 'Cards persoed and shipped by day', cats: dayCats, values: d.by_day, bars: [{ key: 'persoed', cls: 'q-c3', label: 'Persoed' }, { key: 'shipped', cls: 'q-c2', label: 'Shipped' }] })],
    month: [opsLegend([['q-c3', 'Persoed'], ['q-c2', 'Shipped']]), opsChart({ aria: 'Cards persoed and shipped by month', cats: monCats, values: d.trend, bars: [{ key: 'persoed', cls: 'q-c3', label: 'Persoed' }, { key: 'shipped', cls: 'q-c2', label: 'Shipped' }] })],
    otd: [opsLegend([['q-c3', 'OTD SC (Service Center)', true], ['q-c2', 'OTD C (customer)', true]]), opsChart({ aria: 'OTD by month', cats: monCats, values: otdVals, bars: [], lines: [{ key: 'otd_sc', cls: 'q-c3', label: 'OTD SC' }, { key: 'otd_c', cls: 'q-c2', label: 'OTD C' }], fmt: pctFmt, min: otdMin, max: 1, target, targetLabel: `${pctFmt(target)} target` })],
    scrap: [opsLegend([['q-c1', 'Scrap rate (scrap ÷ cards persoed)', true]]), opsChart({ aria: 'Scrap rate by month', cats: monCats, values: d.trend, bars: [], lines: [{ key: 'scrap_rate', cls: 'q-c1', label: 'Scrap rate' }], fmt: (v) => `${(v * 100).toFixed(2)}%` })],
  };
  const custTabs = [['persoed', 'Persoed'], ['shipped', 'Shipped'], ['scrap', 'Scrap'], ['causes', 'Scrap causes']];
  // the tables
  const pctCell = (b) => (b.cards ? `<span class="ops-pct ${b.pct === null ? '' : b.pct >= target ? 'good' : b.pct >= 0.9 ? 'warn' : 'bad'}">${OP(b.pct)}</span><div class="small muted">${OK(b.cards)} cards${b.late ? ` · ${OK(b.late)} late` : ''}${b.overdue ? ` · <b class="q-bad">${OK(b.overdue)} overdue</b>` : ''}${b.open ? ` · ${OK(b.open)} open` : ''}</div>` : '<span class="muted">—</span>');
  const delayOf = new Map(d.otd_customers.map((c) => [String(c.customer || '').toLowerCase(), c]));
  const onTime = d.on_time_customers.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Customer</th><th title="Work orders that aren't Low priority">Dailies on time</th><th title="Low priority work orders">Renewals on time</th><th class="num" title="From the OTD report, this month">Delays (OTD report)</th></tr></thead><tbody>
      ${d.on_time_customers.map((c) => { const dl = delayOf.get(String(c.customer).toLowerCase()) || (c.name ? delayOf.get(c.name.toLowerCase()) : null);
        return `<tr><td><b>${esc(c.customer)}</b>${c.name ? `<div class="small muted">${esc(c.name)}</div>` : ''}</td><td>${pctCell(c.daily)}</td><td>${pctCell(c.renewal)}</td>
          <td class="num">${dl ? `${dl.internal ? `${ON(dl.internal)} SC` : ''}${dl.internal && dl.external ? ' · ' : ''}${dl.external ? `${ON(dl.external)} customer` : ''}` : '<span class="muted">—</span>'}</td></tr>`; }).join('')}</tbody></table></div>`
    : `<div class="empty small">${d.planner ? `No work orders were due in ${esc(d.label)}.` : 'The planner has no history yet: work orders are recorded from the open perso export (Production) as it\'s read.'}</div>`;
  const otdTable = d.otd_customers.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Customer</th><th class="num">Shipped</th><th class="num">SC delays</th><th class="num">OTD SC</th><th class="num">Customer delays</th><th class="num">OTD C</th><th>Main reasons</th></tr></thead><tbody>
      ${d.otd_customers.map((c) => `<tr><td><b>${esc(c.customer || '?')}</b></td><td class="num">${c.shipped ? ON(c.shipped) : '<span class="muted" title="No cards shipped under this name this month">—</span>'}</td>
        <td class="num">${c.internal ? ON(c.internal) : ''}</td><td class="num">${OP(c.otd_sc)}</td><td class="num">${c.external ? ON(c.external) : ''}</td><td class="num">${OP(c.otd_c)}</td>
        <td class="small">${c.reasons.map((r) => `${esc(r.reason)} <span class="muted">${ON(r.qty)}</span>`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty small">No delays in the OTD report for ${esc(d.label)}.</div>`;
  const lateTable = d.late.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Work order</th><th>Customer</th><th>Kind</th><th class="num">Cards</th><th>Deadline</th><th>Done</th><th class="num">Late by</th></tr></thead><tbody>
      ${d.late.map((j) => `<tr><td><b>${esc(j.wo)}</b>${j.per ? ` <span class="muted small">${esc(j.per)}</span>` : ''}</td><td>${esc(j.customer || '')}${j.name ? ` <span class="small muted">${esc(j.name)}</span>` : ''}</td>
        <td>${j.renewal ? '<span class="chip">Renewal</span>' : '<span class="chip">Daily</span>'}</td><td class="num">${ON(j.qty)}</td><td>${esc(fmtDateTime(j.deadline, { weekday: false }))}</td>
        <td>${j.open ? '<b class="q-bad">not yet</b>' : esc(fmtDateTime(j.done_at, { weekday: false }))}</td><td class="num">${j.late_hours >= 48 ? `${Math.round(j.late_hours / 24)} d` : `${j.late_hours} h`}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty small">${d.planner ? `No late work orders in ${esc(d.label)}.` : 'No planner history yet.'}</div>`;
  const scrapTable = d.scrap_detail.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>${d.scrap_from === 'consumption' ? 'Reason' : 'Machine · mode'}</th><th class="num">Cards</th><th class="num">Share</th><th>Customers</th>${d.scrap_from === 'consumption' ? '<th>Cards (items)</th>' : ''}</tr></thead><tbody>
      ${d.scrap_detail.map((s) => `<tr><td><b>${esc(s.cause)}</b></td><td class="num">${ON(s.qty)}</td><td class="num">${OP(s.share)}</td>
        <td class="small">${s.customers.map((c) => `${esc(c.name)} <span class="muted">${ON(c.qty)}</span>`).join(' · ')}</td>${d.scrap_from === 'consumption' ? `<td class="small">${s.items.map((c) => `${esc(c.name)} <span class="muted">${ON(c.qty)}</span>`).join(' · ')}</td>` : ''}</tr>`).join('')}</tbody></table></div>`
    : `<div class="empty small">No scrap recorded for ${esc(d.label)}.</div>`;
  return `
    <div class="qd">
    <div class="q-tiles qd-tiles">
      ${qTile(`OTD SC in ${esc(qShort(d.month))}`, OP(o.otd_sc), `<div>OTD C ${OP(o.otd_c)} · year ${OP(o.ytd_sc)}</div><div>${opsPtDelta(o.otd_sc, o.prev_sc)}</div>`, o.otd_sc !== null && o.otd_sc < target ? 'warn' : '')}
      ${qTile('Work orders on time', OP(ot.daily.pct), `<div>dailies · renewals ${OP(ot.renewal.pct)}</div><div>${ON(ot.daily.wos + ot.renewal.wos)} due in ${esc(qShort(d.month))}${ot.daily.overdue + ot.renewal.overdue ? ` · <b class="q-bad">${OK(ot.daily.overdue + ot.renewal.overdue)} overdue</b>` : ''}</div>`, ot.daily.pct !== null && ot.daily.pct < 0.9 ? 'warn' : '')}
      ${qTile('Cards persoed', OK(t.persoed), `<div>${t.persoed_pin ? `${OK(t.persoed_pin)} PIN mailers · ` : ''}${OK(t.persoed_ytd)} this year</div><div>${opsPctDelta(t.persoed, t.persoed_prev)}</div>`)}
      ${qTile('Cards shipped', OK(t.shipped), `<div>${t.shipped_pin ? `${OK(t.shipped_pin)} PIN mailers · ` : ''}${OK(t.shipped_ytd)} this year</div><div>${opsPctDelta(t.shipped, t.shipped_prev)}</div>`)}
      ${qTile('Scrap', ON(t.scrap), `<div>${t.scrap_rate === null ? 'no cards persoed' : `${(t.scrap_rate * 100).toFixed(2)}% of cards persoed`}</div><div>${opsPtDelta(t.scrap_rate, t.scrap_rate_prev, false)}</div>`, t.scrap_rate_prev !== null && t.scrap_rate > t.scrap_rate_prev * 1.2 ? 'warn' : '')}
      ${qTile('Late, still open', ON(t.open_late.wos), `<div>work orders past their deadline now</div><div>${OK(t.open_late.cards)} cards</div>`, t.open_late.wos ? 'warn' : '')}
    </div>
    <div class="qd-top">
      <section class="ck-panel qd-charts">
        <div class="ck-ph"><h3>📈</h3><div class="seg qd-tabs">${tab('ochart', 'day', 'By day', `Cards persoed and shipped each day of ${d.label}`)}${tab('ochart', 'month', 'By month', 'Cards persoed and shipped, the 12 months up to it')}${tab('ochart', 'otd', 'OTD', 'OTD SC and OTD C, the 12 months up to it')}${tab('ochart', 'scrap', 'Scrap rate', 'Scrap ÷ cards persoed, the 12 months up to it')}</div></div>
        <div class="qd-body qd-chart-body">${Object.entries(charts).map(([k, [legend, chart]]) => pane('ochart', k, `<div class="qd-trend">${legend}${chart}</div>`)).join('')}</div>
      </section>
      <section class="ck-panel qd-where">
        <div class="ck-ph"><h3>Customers</h3><div class="seg qd-tabs">${custTabs.map(([k, l]) => tab('ocust', k, l)).join('')}</div></div>
        <div class="qd-body">${custTabs.map(([k]) => pane('ocust', k, qBarsList(d.customers[k], d.label, OK))).join('')}</div>
        <div class="qd-foot q-bars-key small muted"><span><i class="q-sw mon"></i>${esc(d.label)}</span><span><i class="q-sw ytd"></i>year to date</span>${qdOn('ocust', 'causes') || qdOn('ocust', 'scrap') ? '' : ''}</div>
      </section>
    </div>
    <section class="ck-panel qd-cases">
      <div class="ck-ph"><div class="seg qd-tabs">${tab('otable', 'ontime', 'On time by customer', 'The planner\'s work orders due this month, finished by their deadline: dailies and renewals (Low priority)')}${tab('otable', 'otd', `OTD report <span class="tm-count">${d.otd_customers.length}</span>`, 'The month\'s delays by customer, from the OTD report')}${tab('otable', 'late', `Late work orders <span class="tm-count">${d.late.length}</span>`)}${tab('otable', 'scrap', `Scrap by cause <span class="tm-count">${d.scrap_detail.length}</span>`)}</div>
        <span class="small muted">On time: finished by the deadline, of what's finished · dailies: not Low priority · renewals: Low priority</span></div>
      <div class="qd-body">${pane('otable', 'ontime', onTime)}${pane('otable', 'otd', otdTable)}${pane('otable', 'late', lateTable)}${pane('otable', 'scrap', scrapTable)}</div>
    </section>
    </div>`;
}
