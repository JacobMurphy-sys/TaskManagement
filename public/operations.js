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
    el.innerHTML = opsSvg(spec, Math.max(300, el.clientWidth), Math.max(110, el.clientHeight || 220));
  }
}
window.addEventListener('resize', () => { clearTimeout(opsDraw.t); opsDraw.t = setTimeout(opsDraw, 150); });
document.addEventListener('click', (e) => { if (e.target.closest('[data-qd-tab^="ochart:"]')) setTimeout(opsDraw); });
// spec: { cats: [{ label, title, dim, on }], bars: [{ key, cls, label }], lines: [{ key, cls, label }], values: [{ … }], fmt, max, target, targetLabel }
function opsSvg(spec, W, H) {
  const L = 44; const R = 12; const T = 16; const B = 22;
  const vals = spec.values;
  const all = [...spec.bars.flatMap((b) => vals.map((v) => v[b.key] || 0)), ...(spec.lines || []).flatMap((l) => vals.map((v) => v[l.key] ?? 0)), spec.target || 0];
  // a little headroom, then the smallest round step that needs no more than 7 gridlines: the bars fill the chart
  let max = spec.max || Math.max(...all, 1e-9) * 1.04;
  const range = max - (spec.min ?? 0); const p = 10 ** Math.floor(Math.log10(range / 6));
  const step = [1, 2, 2.5, 5, 10, 20].map((x) => x * p).find((s) => Math.ceil(range / s - 1e-9) <= 7);
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

// ---- the site KPIs: a tile each along the top (src/sitekpis.js), its target set on ⚙ KPIs -----------------------
// A KPI's figure as it's written: percentages from fractions, money, cards an hour …
function opsKpiFmt(k, v, { unit = false } = {}) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v); const dec = k.decimals ?? 0;
  const fix = (x, d) => x.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
  if (k.pct) return `${fix(n * 100, dec)}%`;
  if (k.key === 'transfo') return `€${fix(n, dec)}`;
  if (k.key === 'capex' || k.key === 'inventory') return `${fix(n, 0)}k€`;
  if (k.key === 'volume') return OK(n);
  if (k.key === 'productivity') return `${fix(n, 0)}${unit ? ' c/h' : ''}`;
  return fix(n, dec);
}
// the target as a figure on the KPI's own scale (a % target is typed as 99.6)
const opsTargetVal = (k) => (k.target === null || k.target === undefined ? null : k.pct ? k.target / 100 : k.target);
const opsMeets = (k, v) => { const t = opsTargetVal(k); if (t === null || v === null || v === undefined) return null; return k.better === 'down' ? v <= t : v >= t; };
const opsKpiTitle = (k) => `${esc(k.label)}${k.key === 'otd' ? ` <span class="ops-k-sub">${esc(k.measure === 'c' ? 'OTD C' : k.measure === 'all' ? 'OTD' : 'OTD SC')}</span>` : k.sub ? ` <span class="ops-k-sub">${esc(k.sub)}</span>` : ''}`;

function opsKpiTile(d, k, focus) {
  const v = d.site.values[k.key] || {}; const t = d.tiles;
  const meets = opsMeets(k, v.now);
  const bits = [];
  if (k.target !== null) bits.push(`<span class="ops-k-target">target ${opsKpiFmt(k, opsTargetVal(k), { unit: true })}</span>`);
  if (v.prev !== null && v.prev !== undefined && v.now !== null && v.now !== undefined) {
    const up = v.now > v.prev; const same = Math.abs(v.now - v.prev) < 1e-9; const good = same ? null : (k.better === 'down' ? !up : up);
    bits.push(`<span class="q-delta ${good === null ? '' : good ? 'good' : 'bad'}">${same ? '=' : up ? '▲' : '▼'} ${same ? '' : opsKpiFmt(k, Math.abs(v.now - v.prev))} vs ${esc(qShort(addMonthsJs(d.month, -1)))}</span>`);
  }
  // what the figure is made of, short
  const extra = {
    volume: `${OK(t.shipped)} shipped`,
    ontime: `renewals ${OP(t.on_time.renewal.pct)}`,
    openlate: `${OK(t.open_late.cards)} cards past their deadline`,
    capex: d.site.detail.capex.pipeline ? `+ ${OK(d.site.detail.capex.pipeline / 1000)}k€ in the pipeline` : `${d.site.detail.capex.year}, committed`,
    mir: d.site.detail.mir ? (d.site.detail.mir.last ? `last accident ${esc(fmtShortDate(d.site.detail.mir.last))}` : 'no accidents recorded') : '',
    productivity: d.site.detail.productivity.range ? `@ site level (${opsKpiFmt(k, d.site.detail.productivity.range[0])} – ${opsKpiFmt(k, d.site.detail.productivity.range[1])})` : '',
  }[k.key];
  if (!d.period?.ytd && v.ytd !== null && v.ytd !== undefined && !['capex', 'volume'].includes(k.key)) bits.push(`<span>year ${opsKpiFmt(k, v.ytd)}</span>`);
  if (extra) bits.push(`<span>${extra}</span>`);
  if (k.typed && v.now === null) bits.push(`<span>✎ ${d.period?.ytd ? 'none typed in yet' : 'type this month\'s in'}</span>`);
  if (d.period?.ytd && k.typed && v.now !== null) bits.push('<span>average of the months typed in</span>');
  const tone = meets === null ? '' : meets ? 'ok' : 'warn';
  return `<button type="button" class="q-tile ops-kpi ${tone}${focus === k.key ? ' on' : ''}${k.typed && v.now === null ? ' quiet' : ''}" data-ops-kpi="${k.key}" aria-pressed="${focus === k.key}" title="${esc(`${k.label}${k.unit ? ` (${k.unit})` : ''}: click to see it on its own, again to go back`)}">
    <div class="q-tile-l">${opsKpiTitle(k)}${meets === null ? '' : `<span class="ops-k-dot ${meets ? 'ok' : 'bad'}" title="${meets ? 'On target' : 'Off target'}"></span>`}</div>
    <div class="q-tile-v">${opsKpiFmt(k, v.now, { unit: true })}</div><div class="q-tile-s">${bits.join('')}</div></button>`;
}
const addMonthsJs = (m, n) => { const dt = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`; };

// ⚙ KPIs: which are shown, each one's target, and how OTD is counted (the setup right)
function opsKpiSettings(d) {
  openModal(`<div class="modal-head"><h2 style="margin:0">⚙ Site KPIs</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted">Tick the KPIs to show along the top of 🏭 Operations, in this order, and set each one's target (blank: none). A tile turns green when it meets its target and amber when it doesn't. Percentages are typed as they read (99.6 for 99.6%).</p>
    <div class="kdb-scroll"><table class="log small ops-kset"><thead><tr><th>Show</th><th>KPI</th><th>Target</th><th>Good when</th><th>From</th></tr></thead><tbody>
    ${d.site.config.map((k) => `<tr><td><input type="checkbox" data-ks-on="${k.key}" ${k.on ? 'checked' : ''} aria-label="Show ${esc(k.label)}"></td>
      <td><b>${esc(k.label)}</b>${k.sub ? ` <span class="muted">${esc(k.sub)}</span>` : ''}${k.key === 'otd' ? `<br><select data-ks-measure="otd">${Object.entries(k.measures).map(([m, l]) => `<option value="${m}" ${k.measure === m ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>` : ''}</td>
      <td><span class="row" style="gap:4px;flex-wrap:nowrap">${k.key === 'transfo' ? '€' : ''}<input type="number" step="any" style="width:90px" data-ks-target="${k.key}" value="${k.target ?? ''}" placeholder="none">${k.pct ? '%' : k.key === 'capex' || k.key === 'inventory' ? 'k€' : k.key === 'productivity' ? 'c/h' : ''}</span></td>
      <td>${k.better === 'down' ? '▼ lower' : '▲ higher'}</td>
      <td class="small muted">${k.typed ? `✎ typed in each month${k.key === 'mir' ? ' (until the safety concern forms are linked on Sources)' : ''}` : { mir: 'accidents (AC) on the safety concern forms (⛑ EHS)', cpms: 'complaints (Salesforce, else typed weekly) ÷ cards shipped', otd: 'the OTD report ÷ cards shipped', wastage: 'scrap ÷ cards persoed', productivity: 'cards persoed ÷ Protime hours', capex: '💶 CAPEX: approved and on, this year', volume: 'the perso export', ontime: 'the planner\'s work orders', openlate: 'the planner\'s work orders' }[k.key] || ''}</td></tr>`).join('')}
    </tbody></table></div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px"><button data-action="close-modal">Cancel</button><button class="primary" id="ks-save">Save</button></div>`, { wide: true });
  $('#ks-save').onclick = async () => {
    const kpis = {};
    for (const k of d.site.config) {
      kpis[k.key] = { on: $(`[data-ks-on="${k.key}"]`).checked, target: $(`[data-ks-target="${k.key}"]`).value.trim() || null };
      if (k.key === 'otd') kpis.otd.measure = $('[data-ks-measure="otd"]').value;
    }
    try { await api.put('/kpi/operations/config', { kpis }); closeModal(); toast('Saved'); renderQualityTab('operations'); } catch (err) { toast(err.message, 'error'); }
  };
}

// ---- the dashboard ---------------------------------------------------------------------------------------
let OPS_D = null;
const opsFocus = () => { const f = store.get('opsFocus', ''); return OPS_D?.site.config.some((k) => k.key === f && k.on) ? f : ''; };
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-ops-kpi]'); if (b && OPS_D) {
    store.set('opsFocus', opsFocus() === b.dataset.opsKpi ? '' : b.dataset.opsKpi); // the same tile again: back to the overview
    const el = document.querySelector('.qd.ops'); if (el) { el.outerHTML = opsHtml(OPS_D); opsDraw(); }
    return;
  }
  if (e.target.closest('[data-ops-kset]') && OPS_D) opsKpiSettings(OPS_D);
});
// a figure typed in for a month: saved as it's left
document.addEventListener('change', async (e) => {
  const inp = e.target.closest('[data-ops-val]'); if (!inp || !OPS_D) return;
  const k = OPS_D.site.config.find((x) => x.key === inp.dataset.opsVal);
  try {
    await api.put('/kpi/operations/value', { kpi: k.key, month: inp.dataset.month, value: inp.value.trim() === '' ? null : inp.value.trim() });
    toast('Saved');
    const n = inp.value.trim() === '' ? null : Number(inp.value.replace(',', '.')); const v = OPS_D.site.values[k.key];
    const val = n === null ? null : k.pct ? n / 100 : n;
    const row = v.trend.find((x) => x.month === inp.dataset.month); if (row) row.value = val;
    if (inp.dataset.month === OPS_D.month) v.now = val; if (inp.dataset.month === addMonthsJs(OPS_D.month, -1)) v.prev = val;
    const el = document.querySelector('.qd.ops'); if (el) { el.outerHTML = opsHtml(OPS_D); opsDraw(); }
  } catch (err) { toast(err.message, 'error'); }
});

function opsHtml(d) {
  OPS_D = d;
  const t = d.tiles; const target = 0.98;
  const kpis = d.site.config.filter((k) => k.on);
  const focus = opsFocus();
  const tab = (group, key, label, title = '') => `<button type="button" class="${qdOn(group, key) ? 'on' : ''}" data-qd-tab="${group}:${key}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  const pane = (group, key, html) => `<div class="qd-pane" data-qd-pane="${group}:${key}"${qdOn(group, key) ? '' : ' hidden'}>${html}</div>`;
  qdDefaults({ ochart: 'day', ocust: 'persoed', otable: 'ontime', f_otd: 'otd', f_waste: 'cause', f_prod: 'machines', f_vol: 'persoed' });
  const ytd = !!d.period?.ytd; const perShort = ytd ? `${d.year} so far` : qShort(d.month); // the period, short: "Oct", or "2026 so far"
  const day = (s) => Number(s.slice(8, 10));
  const dayCats = d.by_day.map((x) => ({ label: ytd ? `${day(x.day)}/${Number(x.day.slice(5, 7))}` : String(day(x.day)), title: new Date(`${x.day}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }), dim: x.weekend }));
  const monCats = d.trend.map((x) => ({ label: qShort(x.month), title: x.label, on: x.month === d.month }));
  const pctFmt = (v) => `${Math.round(v * 1000) / 10}%`;
  const kOf = (key) => d.site.config.find((k) => k.key === key);
  const tgt = (key) => { const k = kOf(key); const v = opsTargetVal(k); return v === null ? {} : { target: v, targetLabel: `${opsKpiFmt(k, v, { unit: true })} target` }; };
  const otdT = tgt('otd').target ?? null; // a target line only when one is set (⚙)
  const woT = opsTargetVal(kOf('ontime')) ?? target;
  const otdVals = d.trend.map((x) => ({ ...x, otd_all: x.shipped ? 1 - ((x.otd_internal || 0) + (x.otd_external || 0)) / x.shipped : null }));
  const otdMin = Math.max(0, Math.floor((Math.min(...otdVals.flatMap((x) => [x.otd_sc, x.otd_c]).filter((v) => v !== null), otdT ?? 1) - 0.02) * 50) / 50);
  const otdTarget = otdT === null ? {} : { target: otdT, targetLabel: `${pctFmt(otdT)} target` };
  const charts = {
    day: [opsLegend([['q-c3', 'Persoed'], ['q-c2', 'Shipped']]), opsChart({ aria: 'Cards persoed and shipped by day', cats: dayCats, values: d.by_day, bars: [{ key: 'persoed', cls: 'q-c3', label: 'Persoed' }, { key: 'shipped', cls: 'q-c2', label: 'Shipped' }] })],
    month: [opsLegend([['q-c3', 'Persoed'], ['q-c2', 'Shipped']]), opsChart({ aria: 'Cards persoed and shipped by month', cats: monCats, values: d.trend, bars: [{ key: 'persoed', cls: 'q-c3', label: 'Persoed' }, { key: 'shipped', cls: 'q-c2', label: 'Shipped' }] })],
    otd: [opsLegend([['q-c3', 'OTD SC (Service Center)', true], ['q-c2', 'OTD C (customer)', true]]), opsChart({ aria: 'OTD by month', cats: monCats, values: otdVals, bars: [], lines: [{ key: 'otd_sc', cls: 'q-c3', label: 'OTD SC' }, { key: 'otd_c', cls: 'q-c2', label: 'OTD C' }], fmt: pctFmt, min: otdMin, max: 1, ...otdTarget })],
    scrap: [opsLegend([['q-c1', 'Scrap rate (scrap ÷ cards persoed)', true]]), opsChart({ aria: 'Scrap rate by month', cats: monCats, values: d.trend, bars: [], lines: [{ key: 'scrap_rate', cls: 'q-c1', label: 'Scrap rate' }], fmt: (v) => `${(v * 100).toFixed(2)}%`, ...tgt('wastage') })],
  };
  const custTabs = [['persoed', 'Persoed'], ['shipped', 'Shipped'], ['scrap', 'Scrap'], ['causes', 'Scrap causes']];
  // the tables
  const pctCell = (b) => (b.cards ? `<span class="ops-pct ${b.pct === null ? '' : b.pct >= woT ? 'good' : b.pct >= 0.9 ? 'warn' : 'bad'}">${OP(b.pct)}</span><div class="small muted">${OK(b.cards)} cards${b.late ? ` · ${OK(b.late)} late` : ''}${b.overdue ? ` · <b class="q-bad">${OK(b.overdue)} overdue</b>` : ''}${b.open ? ` · ${OK(b.open)} open` : ''}</div>` : '<span class="muted">—</span>');
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

  // a panel: a heading (and mini-tabs) and its body
  const panel = (cls, head, body, foot = '') => `<section class="ck-panel ${cls}"><div class="ck-ph">${head}</div><div class="qd-body${cls.includes('qd-charts') ? ' qd-chart-body' : ''}">${body}</div>${foot}</section>`;
  const chartBox = (legend, chart) => `<div class="qd-trend">${legend}${chart}</div>`;
  const barsKey = `<div class="qd-foot q-bars-key small muted"><span><i class="q-sw mon"></i>${esc(d.label)}</span><span><i class="q-sw ytd"></i>year to date</span></div>`;
  // a KPI month by month: its line and its target
  const kpiChart = (key, { min = null, max = null } = {}) => {
    const k = kOf(key); const v = d.site.values[key];
    const vals = v.trend.map((x) => ({ v: x.value }));
    if (!vals.some((x) => x.v !== null)) return `<div class="empty small">No ${esc(k.label)} figures in the 12 months up to ${esc(d.label)}${k.typed ? ': type them in on the right.' : '.'}</div>`;
    return chartBox(opsLegend([['q-c3', `${k.label}${k.sub ? ` (${k.sub})` : ''}`, true]]), opsChart({ aria: `${k.label} by month`, cats: monCats, values: vals, bars: [], lines: [{ key: 'v', cls: 'q-c3', label: k.label }], fmt: (x) => opsKpiFmt(k, x), ...(min !== null ? { min } : {}), ...(max !== null ? { max } : {}), ...tgt(key) }));
  };
  const head = (title, note = '') => `<h3>${title}</h3>${note ? `<span class="small muted">${note}</span>` : ''}`;
  const back = `<button type="button" class="small" data-ops-kpi="${focus}" title="Back to the overview">✕ Back to the overview</button>`;

  // ---- each KPI on its own (a tile clicked)
  const focusViews = {
    otd: () => {
      const k = kOf('otd');
      const lines = [{ key: 'otd_sc', cls: 'q-c3', label: 'OTD SC' }, { key: 'otd_c', cls: 'q-c2', label: 'OTD C' }, ...(k.measure === 'all' ? [{ key: 'otd_all', cls: 'q-c1', label: 'OTD' }] : [])];
      return `<div class="qd-top">${panel('qd-charts', head('🚚 Service level, month by month', `counted as ${esc(k.measures[k.measure])}`), chartBox(opsLegend(lines.map((l) => [l.cls, l.label, true])), opsChart({ aria: 'OTD by month', cats: monCats, values: otdVals, bars: [], lines, fmt: pctFmt, min: otdMin, max: 1, ...otdTarget })))}
        ${panel('qd-where', head('Delays by customer', esc(d.label)), d.otd_customers.length ? qBarsList(d.otd_customers.map((c) => ({ name: c.customer || '?', month: (c.internal || 0) + (c.external || 0), ytd: (c.internal || 0) + (c.external || 0) })), d.label, OK) : `<div class="empty small">No delays in the OTD report for ${esc(d.label)}.</div>`)}</div>
        ${panel('qd-cases', `<div class="seg qd-tabs">${tab('f_otd', 'otd', `OTD report <span class="tm-count">${d.otd_customers.length}</span>`)}${tab('f_otd', 'ontime', 'On time by customer')}${tab('f_otd', 'late', `Late work orders <span class="tm-count">${d.late.length}</span>`)}</div>${back}`,
          `${pane('f_otd', 'otd', otdTable)}${pane('f_otd', 'ontime', onTime)}${pane('f_otd', 'late', lateTable)}`)}`;
    },
    wastage: () => `<div class="qd-top">${panel('qd-charts', head('🗑 Wastage, month by month', 'scrap ÷ cards persoed'), chartBox(...charts.scrap))}
        ${panel('qd-where', `<h3>By</h3><div class="seg qd-tabs">${tab('f_waste', 'cause', 'Cause')}${tab('f_waste', 'cust', 'Customer')}${tab('f_waste', 'day', 'Day')}</div>`,
          `${pane('f_waste', 'cause', qBarsList(d.customers.causes, d.label, OK))}${pane('f_waste', 'cust', qBarsList(d.customers.scrap, d.label, OK))}${pane('f_waste', 'day', qBarsList(d.by_day.filter((x) => x.scrap).map((x) => ({ name: fmtShortDate(x.day), month: x.scrap, ytd: x.scrap })), d.label, OK))}`, barsKey)}</div>
        ${panel('qd-cases', `${head(`Scrap by cause <span class="tm-count">${d.scrap_detail.length}</span>`)}${back}`, scrapTable)}`,
    volume: () => `<div class="qd-top">${panel('qd-charts', `<h3>📦</h3><div class="seg qd-tabs">${tab('ochart', 'day', 'By day')}${tab('ochart', 'month', 'By month')}</div>`, ['day', 'month'].map((c) => pane('ochart', c, chartBox(...charts[c]))).join(''))}
        ${panel('qd-where', `<h3>Customers</h3><div class="seg qd-tabs">${tab('f_vol', 'persoed', 'Persoed')}${tab('f_vol', 'shipped', 'Shipped')}</div>`, `${pane('f_vol', 'persoed', qBarsList(d.customers.persoed, d.label, OK))}${pane('f_vol', 'shipped', qBarsList(d.customers.shipped, d.label, OK))}`, barsKey)}</div>
        ${panel('qd-cases', `${head('Cards each day')}${back}`, `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Day</th><th class="num">Persoed</th><th class="num">Shipped</th><th class="num">Scrap</th></tr></thead><tbody>${d.by_day.filter((x) => x.persoed || x.shipped || x.scrap).map((x) => `<tr><td>${esc(fmtShortDate(x.day))}</td><td class="num">${ON(x.persoed)}</td><td class="num">${ON(x.shipped)}</td><td class="num">${x.scrap ? ON(x.scrap) : ''}</td></tr>`).join('') || `<tr><td colspan="4" class="muted">Nothing in ${esc(d.label)}.</td></tr>`}</tbody></table></div>`)}`,
    productivity: () => {
      const p = d.site.detail.productivity; const k = kOf('productivity');
      const mach = p.machines.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Machine</th><th class="num">Cards an hour</th><th class="num">Cards</th><th class="num">Run hours</th><th class="num">Runs</th></tr></thead><tbody>
        ${p.machines.slice().sort((a, b) => b.per_hour - a.per_hour).map((x) => `<tr><td><b>${esc(x.machine)}</b></td><td class="num"><span class="ops-pct ${opsMeets(k, x.per_hour) === null ? '' : opsMeets(k, x.per_hour) ? 'good' : 'warn'}">${opsKpiFmt(k, x.per_hour)}</span></td><td class="num">${ON(x.cards)}</td><td class="num">${x.hours.toLocaleString('en-GB')}</td><td class="num">${ON(x.runs)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty small">No runs with start and end times in ${esc(d.label)}: each machine's cards an hour come from the timing reports (Production › Insights › ⏱ Timing).</div>`;
      const weeks = p.weeks.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Week</th><th class="num">Cards persoed</th><th class="num">Working hours</th><th class="num">Cards an hour</th></tr></thead><tbody>
        ${p.weeks.map((w) => `<tr><td>${esc(w.week)}</td><td class="num">${ON(w.cards)}</td><td class="num">${w.hours === null ? '<span class="muted" title="Not typed in on the Weekly SC Report">—</span>' : ON(w.hours)}</td><td class="num">${opsKpiFmt(k, w.productivity)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty small">No reporting weeks in ${esc(d.label)}.</div>`;
      return `<div class="qd-top">${panel('qd-charts', head('⚙ Productivity, month by month', 'cards persoed ÷ working hours (Protime, typed in each week)'), kpiChart('productivity'))}
        ${panel('qd-where', head('Machines', `cards an hour of run time${p.range ? ` · ${opsKpiFmt(k, p.range[0])} – ${opsKpiFmt(k, p.range[1])}` : ''}`), mach)}</div>
        ${panel('qd-cases', `${head(`Weeks in ${esc(perShort)}`, p.hours_typed ? '' : 'no working hours typed in yet: ✎ on the Weekly SC Report\'s weeks')}${back}`, weeks)}`;
    },
    cpms: () => {
      const c = d.site.detail.cpms;
      const cases = c.cases.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Case</th><th>Opened</th><th>Customer</th><th>Severity</th><th>Summary</th><th>Status</th></tr></thead><tbody>
        ${c.cases.map((x) => `<tr><td><b>${esc(x.ref || '')}</b></td><td>${esc(fmtShortDate(x.day))}</td><td>${esc(x.customer || '')}</td><td>${esc(x.severity || '')}</td><td class="small">${esc(x.summary || '')}</td><td class="small">${esc(x.status || '')}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty small">${c.from === 'salesforce' ? `No customer complaints opened in ${esc(d.label)}.` : 'Complaints are typed in each week (✎ on the Weekly SC Report) until the Salesforce export is linked on Sources; their cases show here once it is.'}</div>`;
      const rows = `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Month</th><th class="num">Complaints</th><th class="num">Cards shipped</th><th class="num">CPMS</th></tr></thead><tbody>
        ${c.trend.slice().reverse().map((x) => { const v = d.site.values.cpms.trend.find((y) => y.month === x.month)?.value; return `<tr><td>${esc(qShort(x.month))} ${x.month.slice(0, 4)}</td><td class="num">${x.cc ?? '—'}</td><td class="num">${OK(x.shipped)}</td><td class="num">${opsKpiFmt(kOf('cpms'), v)}</td></tr>`; }).join('')}</tbody></table></div>`;
      return `<div class="qd-top">${panel('qd-charts', head('🧪 Quality, month by month', 'CPMS: customer complaints per million cards shipped'), kpiChart('cpms'))}${panel('qd-where', head('By month'), rows)}</div>
        ${panel('qd-cases', `${head(`Complaints opened in ${esc(perShort)}`)}${modOk('quality') ? '<a class="button small" href="#/kpi/quality">🧪 Quality</a>' : ''}${back}`, cases)}`;
    },
    capex: () => {
      const c = d.site.detail.capex; const k = kOf('capex'); const t0 = opsTargetVal(k);
      const vals = c.by_month.map((x) => ({ committed: x.committed / 1000, pipeline: x.pipeline / 1000 }));
      const cats = c.by_month.map((x) => ({ label: qShort(x.month), title: x.month, on: x.month === d.month }));
      const st = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', ordered: 'Ordered', installed: 'Installed', closed: 'Closed', on_hold: 'On hold' };
      const items = c.items.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Ref</th><th>Investment</th><th>Category</th><th>Owner</th><th>Planned</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody>
        ${c.items.map((x) => `<tr><td>${esc(x.ref || '')}</td><td><b>${esc(x.title)}</b></td><td>${esc(x.category || '')}</td><td>${esc(x.owner || '')}</td><td>${esc(fmtShortDate(x.planned_date))}</td><td><span class="chip">${esc(st[x.status] || x.status)}</span></td><td class="num">${esc(x.currency || '')}${ON(x.amount)}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty small">Nothing planned for ${c.year} in 💶 CAPEX.</div>`;
      const sum = `<div class="ops-capex-sum"><div><span class="small muted">Committed</span><b>${OK(c.committed)}</b><span class="small muted">approved, ordered, installed, closed</span></div><div><span class="small muted">Pipeline</span><b>${OK(c.pipeline)}</b><span class="small muted">submitted, on hold</span></div><div><span class="small muted">Draft</span><b>${OK(c.draft)}</b></div>${t0 !== null ? `<div><span class="small muted">Budget (target)</span><b>${OK(t0 * 1000)}</b><span class="small muted">${t0 ? `${Math.round((c.committed / (t0 * 1000)) * 100)}% committed` : ''}</span></div>` : ''}</div>
        ${c.currencies.length > 1 ? `<p class="small muted">⚠ In more than one currency (${esc(c.currencies.join(', '))}): added up as they are.</p>` : ''}`;
      return `<div class="qd-top">${panel('qd-charts', head(`💶 CAPEX ${c.year}, by planned month`, 'k, committed and in the pipeline'), chartBox(opsLegend([['q-c3', 'Committed'], ['q-c2', 'Pipeline']]), opsChart({ aria: 'CAPEX by month', cats, values: vals, bars: [{ key: 'committed', cls: 'q-c3', label: 'Committed (k)' }, { key: 'pipeline', cls: 'q-c2', label: 'Pipeline (k)' }], fmt: (x) => `${Math.round(x)}k` })))}
        ${panel('qd-where', head(`The year ${c.year}`), sum)}</div>
        ${panel('qd-cases', `${head(`Investments planned in ${c.year} <span class="tm-count">${c.items.length}</span>`)}${modOk('capex') ? '<a class="button small" href="#/capex">💶 CAPEX</a>' : ''}${back}`, items)}`;
    },
    mir: () => {
      const a = d.site.detail.mir; const list = a?.accidents || [];
      const rows = list.length ? `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Form</th><th>Day</th><th>Where</th><th>What happened</th><th>First aid</th><th>Status</th></tr></thead><tbody>
        ${list.map((x) => `<tr><td><b>${esc(x.num ?? '')}</b></td><td>${esc(fmtShortDate(x.day))}</td><td>${esc(x.location || '')}</td><td class="small">${esc(x.description || x.detail || '')}</td><td class="small">${esc(x.first_aid || '')}</td><td class="small">${esc(x.status || '')}</td></tr>`).join('')}</tbody></table></div>`
        : `<div class="empty small">No accidents in ${esc(d.label)}.${a?.last ? ` The last was on ${esc(fmtShortDate(a.last))}.` : ''}</div>`;
      return `<div class="qd-top">${panel('qd-charts', head('⛑ MIR, month by month', 'medical incidents: accidents on the safety concern forms'), kpiChart('mir', { max: Math.max(6, ...d.site.values.mir.trend.map((x) => x.value || 0)) }))}
        ${panel('qd-where', head('By month'), `<div class="kdb-scroll"><table class="log q-cases ops-table"><thead><tr><th>Month</th><th class="num">Accidents</th></tr></thead><tbody>${d.site.values.mir.trend.slice().reverse().map((x) => `<tr><td>${esc(qShort(x.month))} ${x.month.slice(0, 4)}</td><td class="num">${x.value ?? 0}</td></tr>`).join('')}</tbody></table></div>`)}</div>
        ${panel('qd-cases', `${head(`Accidents in ${esc(perShort)} <span class="tm-count">${list.length}</span>`)}${modOk('quality') ? '<a class="button small" href="#/kpi/ehs">⛑ EHS</a>' : ''}${back}`, rows)}`;
    },
    ontime: () => `${panel('qd-cases', `<div class="seg qd-tabs">${tab('otable', 'ontime', 'On time by customer')}${tab('otable', 'late', `Late work orders <span class="tm-count">${d.late.length}</span>`)}</div><span class="small muted">On time: finished by the deadline, of what's finished · dailies: not Low priority · renewals: Low priority</span>${back}`, `${pane('otable', 'ontime', onTime)}${pane('otable', 'late', lateTable)}`)}`,
    openlate: () => `${panel('qd-cases', `${head(`Late work orders in ${esc(perShort)} <span class="tm-count">${d.late.length}</span>`, `${ON(t.open_late.wos)} past their deadline and still open now`)}${back}`, lateTable)}`,
  };
  // a KPI typed in each month: its line, and the months to type into
  const typedView = (key) => {
    const k = kOf(key); const v = d.site.values[key];
    const months = v.trend.slice().reverse();
    const inputs = `<div class="kdb-scroll"><table class="log q-cases ops-table ops-typed"><thead><tr><th>Month</th><th>${esc(k.label)}${k.unit ? ` <span class="muted">(${esc(k.unit)})</span>` : ''}</th></tr></thead><tbody>
      ${months.map((x) => `<tr class="${x.month === d.month ? 'on' : ''}"><td>${esc(qShort(x.month))} ${x.month.slice(0, 4)}</td><td><input type="number" step="any" data-ops-val="${key}" data-month="${x.month}" value="${x.value === null ? '' : k.pct ? Math.round(x.value * 10000) / 100 : x.value}" placeholder="—" aria-label="${esc(`${k.label}, ${x.month}`)}">${k.pct ? ' %' : ''}</td></tr>`).join('')}</tbody></table></div>`;
    return `<div class="qd-top">${panel('qd-charts', head(`${esc(k.label)}, month by month`, 'typed in each month'), kpiChart(key))}${panel('qd-where', `${head('✎ Type it in', 'saved as you leave the box')}${back}`, inputs)}</div>`;
  };

  const overview = `<div class="qd-top">
      ${panel('qd-charts', `<h3>📈</h3><div class="seg qd-tabs">${tab('ochart', 'day', 'By day', `Cards persoed and shipped each day of ${d.label}`)}${tab('ochart', 'month', 'By month', 'Cards persoed and shipped, the 12 months up to it')}${tab('ochart', 'otd', 'OTD', 'OTD SC and OTD C, the 12 months up to it')}${tab('ochart', 'scrap', 'Scrap rate', 'Scrap ÷ cards persoed, the 12 months up to it')}</div>`,
        Object.entries(charts).map(([k, [legend, chart]]) => pane('ochart', k, chartBox(legend, chart))).join(''))}
      ${panel('qd-where', `<h3>Customers</h3><div class="seg qd-tabs">${custTabs.map(([k, l]) => tab('ocust', k, l)).join('')}</div>`, custTabs.map(([k]) => pane('ocust', k, qBarsList(d.customers[k], d.label, OK))).join(''), barsKey)}
    </div>
    ${panel('qd-cases', `<div class="seg qd-tabs">${tab('otable', 'ontime', 'On time by customer', 'The planner\'s work orders due this month, finished by their deadline: dailies and renewals (Low priority)')}${tab('otable', 'otd', `OTD report <span class="tm-count">${d.otd_customers.length}</span>`, 'The month\'s delays by customer, from the OTD report')}${tab('otable', 'late', `Late work orders <span class="tm-count">${d.late.length}</span>`)}${tab('otable', 'scrap', `Scrap by cause <span class="tm-count">${d.scrap_detail.length}</span>`)}</div>
        <span class="small muted">On time: finished by the deadline, of what's finished · dailies: not Low priority · renewals: Low priority · click a KPI above to see it on its own</span>`,
      `${pane('otable', 'ontime', onTime)}${pane('otable', 'otd', otdTable)}${pane('otable', 'late', lateTable)}${pane('otable', 'scrap', scrapTable)}`)}`;

  const body = !focus ? overview : kOf(focus).typed ? typedView(focus) : (focusViews[focus] || (() => overview))();
  return `
    <div class="qd ops${focus ? ' focused' : ''}">
    <div class="ops-kpi-row">
      <div class="q-tiles qd-tiles ops-kpis" style="--ops-n:${Math.max(1, kpis.length)}">${kpis.map((k) => opsKpiTile(d, k, focus)).join('')}</div>
      ${acctAdmin() ? '<button type="button" class="icon ops-kset" data-ops-kset title="⚙ Site KPIs: which are shown and their targets">⚙</button>' : ''}
    </div>
    ${body}
    </div>`;
}
