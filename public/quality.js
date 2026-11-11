'use strict';
// 🧪 Quality and ⛑ EHS: Reporting's month-by-month pages (the Quality module), from the Salesforce export
// and the safety concern forms (src/quality.js). Pick a month: its tiles, the 12 months up to it, where things
// came from (the month against the year to date), then the month's cases or forms and what's still open.
// Loaded before app.js; uses its helpers and kpi.js's kpiTabsHtml.

const QN = (v) => Number(v || 0).toLocaleString('en-GB');
const QEUR = (v) => `€${Number(v || 0).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const qShort = (m) => ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m.slice(5, 7)) - 1];
const qDate = (d) => (d ? `<span class="nowrap">${esc(fmtShortDate(d))}</span>` : '<span class="muted">—</span>');
// series colours: tokens in styles.css (light and dark), checked for colour-blind readers; always with a legend
const Q_SEV = [['Critical', 'q-c1'], ['Major', 'q-c2'], ['Minor', 'q-c3'], ['Other', 'q-c4']];
const Q_EHS = [['AC', 'q-c1', 'Accidents'], ['NM', 'q-c2', 'Near misses'], ['SC', 'q-c3', 'Safety concerns']];

async function renderQualityTab(kind) {
  const month = store.get('qMonth', '');
  let d;
  try { d = await api.get(`/kpi/${kind}${month ? `?month=${encodeURIComponent(month)}` : ''}`); } catch (err) { main().innerHTML = `<div class="card">${esc(err.message)}</div>`; return; }
  const src = d.source;
  const srcName = kind === 'quality' ? 'the Salesforce export' : kind === 'operations' ? 'the perso export' : 'the safety concern form';
  const read = d.read || {};
  const sourcesLink = modOk('kpi_sources') ? '<a class="button small" href="#/kpi/sources">Set it on Sources</a>' : '<span class="small muted">ask an admin to set it on Reporting › Sources</span>';
  const note = read.status === 'error' || read.status === 'missing'
    ? `<div class="kpi-action notice"><span>⚠ Couldn't read ${srcName}: ${esc(read.error || `can't find ${read.file}`)}</span>${sourcesLink}</div>`
    : !src && read.status === 'not set up' ? `<div class="kpi-action notice"><span>⚠ Where ${srcName} is saved isn't set yet.</span>${sourcesLink}</div>` : '';
  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 Reporting</h1>
      <select id="q-month" class="kpi-pick" title="The month to show">${d.months.map((m) => `<option value="${m.month}" ${m.month === (d.period?.key || d.month) ? 'selected' : ''}>${esc(m.label)}</option>`).join('')}</select>
      ${kpiTabsHtml(kind)}
      <div class="spacer"></div>
      <span class="small muted q-src" title="${esc(kind === 'operations' ? Object.entries(d.sources || {}).filter(([, s]) => s).map(([k, s]) => `${k}: ${s.file || ''}`).join('\n') : src?.file || '')}">${kind === 'operations' ? opsSourcesLine(d) : src ? `${kind === 'quality' ? '🧪 Salesforce' : '⛑ Safety concern forms'} · read ${esc(fmtDateTime(src.imported_at))}${src.modified ? ` · file saved ${esc(fmtDateTime(src.modified))}` : ''}` : ''}</span>
    </div>
    ${note}
    ${kind === 'quality' ? qualityHtml(d) : kind === 'operations' ? opsHtml(d) : ehsHtml(d)}`;
  main().classList.add('cockpit-main', 'kpi-dash'); // 🧪 Quality and ⛑ EHS are dashboards: one screen, panels scroll on their own
  qDrawCharts(); if (kind === 'operations') opsDraw();
  $('#q-month').addEventListener('change', (e) => { store.set('qMonth', e.target.value); renderQualityTab(kind); });
  // a case or form opens out to its details
  // a case or form opens out with its ▸, or a click anywhere on its row that isn't on its text (text stays selectable)
  main().onclick = async (e) => {
    const cp = e.target.closest('[data-q-copy]');
    if (cp && !String(window.getSelection?.() || '')) {
      if (await copyText(cp.textContent.trim())) {
        toast(`${cp.dataset.qCopy} copied`); cp.classList.add('copied'); setTimeout(() => cp.classList.remove('copied'), 900);
      } else toast('Couldn\'t copy here: select the text and press Ctrl+C', 'error');
      return;
    }
    if (cp) return; // selecting part of it
    let b = e.target.closest('[data-q-more]');
    if (!b) {
      const tr = e.target.closest('.q-cases tbody tr:not(.q-more)');
      if (!tr || e.target.closest('a, button, input, select, label, summary') || qOverText(e) || String(window.getSelection?.() || '')) return;
      b = tr.querySelector('[data-q-more]'); if (!b) return;
    }
    const row = document.getElementById(b.dataset.qMore); if (!row) return;
    row.hidden = !row.hidden; b.textContent = row.hidden ? '▸' : '▾'; b.setAttribute('aria-expanded', String(!row.hidden));
    b.closest('tr').classList.toggle('q-open', !row.hidden);
  };
}

// is the pointer over a word (rather than the empty part of a cell)?
function qOverText(e) {
  let node = null;
  if (document.caretPositionFromPoint) node = document.caretPositionFromPoint(e.clientX, e.clientY)?.offsetNode;
  else if (document.caretRangeFromPoint) node = document.caretRangeFromPoint(e.clientX, e.clientY)?.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) return false;
  const r = document.createRange(); r.selectNodeContents(node);
  return [...r.getClientRects()].some((b) => e.clientX >= b.left - 1 && e.clientX <= b.right + 1 && e.clientY >= b.top - 1 && e.clientY <= b.bottom + 1);
}

// ---- the pieces ---------------------------------------------------------------------------------
const qTile = (label, value, sub = '', tone = '') => `<div class="q-tile ${tone}"><div class="q-tile-l">${label}</div><div class="q-tile-v">${value}</div>${sub ? `<div class="q-tile-s">${sub}</div>` : ''}</div>`;
function qDelta(now, prev, { goodDown = true } = {}) {
  if (prev === null || prev === undefined) return '';
  const diff = now - prev;
  if (!diff) return `<span class="q-delta">= last month</span>`;
  const good = goodDown ? diff < 0 : diff > 0;
  return `<span class="q-delta ${good ? 'good' : 'bad'}">${diff > 0 ? '▲' : '▼'} ${Math.abs(diff)} vs last month</span>`;
}
const qLegend = (series) => `<div class="q-legend">${series.map(([, cls, label]) => `<span><i class="q-sw ${cls}"></i>${esc(label)}</span>`).join('')}</div>`;

// 12 months as stacked columns (one per month, the chosen one marked), the total above each; hover a column for its figures
const Q_CHARTS = new Map(); let qChartN = 0;
const qStackChart = (trend, series, selected) => { const id = `qch${++qChartN}`; Q_CHARTS.set(id, [trend, series, selected]); return `<div class="q-chart-slot" id="${id}"></div>`; };
function qDrawCharts() {
  for (const [id, args] of Q_CHARTS) { const el = document.getElementById(id); if (!el) { Q_CHARTS.delete(id); continue; } el.innerHTML = qStackSvg(...args, Math.max(260, el.clientWidth)); }
}
window.addEventListener('resize', () => { clearTimeout(qDrawCharts.t); qDrawCharts.t = setTimeout(qDrawCharts, 150); });
function qStackSvg(trend, series, selected, width) {
  const W = width; const H = Math.max(190, Math.min(250, Math.round(width * 0.3))); const L = 30; const B = 26; const T = 18;
  const max = Math.max(1, ...trend.map((t) => series.reduce((s, [k]) => s + (t[k] || 0), 0)));
  const step = max <= 5 ? 1 : max <= 10 ? 2 : max <= 25 ? 5 : max <= 50 ? 10 : Math.ceil(max / 5 / 10) * 10;
  const top = Math.ceil(max / step) * step;
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const cw = (W - L) / trend.length; const bw = Math.min(34, cw * 0.56);
  const clip = `qcl${Math.random().toString(36).slice(2, 7)}`; // clip ids unique on the page (two charts)
  const grid = []; for (let v = 0; v <= top; v += step) grid.push(`<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" class="q-grid${v ? '' : ' base'}"/><text x="${L - 6}" y="${y(v) + 4}" class="q-ax" text-anchor="end">${v}</text>`);
  const cols = trend.map((t, i) => {
    const x = L + i * cw + (cw - bw) / 2;
    const total = series.reduce((s, [k]) => s + (t[k] || 0), 0);
    let acc = 0;
    const segs = series.map(([k, cls]) => {
      const v = t[k] || 0; if (!v) return '';
      const y1 = y(acc + v); const y0 = y(acc); acc += v;
      const h = Math.max(0, y0 - y1 - (acc < total ? 2 : 0)); // a 2px gap between segments
      return `<rect x="${x}" y="${y1 + (acc < total ? 2 : 0)}" width="${bw}" height="${h}" class="${cls}"/>`;
    }).join('');
    const tip = `${t.label}: ${total}${total ? ` — ${series.filter(([k]) => t[k]).map(([k, , l]) => `${l || k} ${t[k]}`).join(', ')}` : ''}`;
    const on = t.month === selected;
    return `<g class="q-col${on ? ' on' : ''}"><title>${esc(tip)}</title>
      <rect x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" class="q-hit"/>
      <clipPath id="${clip}${i}"><rect x="${x}" y="${y(total)}" width="${bw}" height="${Math.max(0, y(0) - y(total))}" rx="4"/></clipPath><g clip-path="url(#${clip}${i})">${segs}</g>
      ${total ? `<text x="${x + bw / 2}" y="${y(total) - 5}" class="q-val" text-anchor="middle">${total}</text>` : ''}
      <text x="${x + bw / 2}" y="${H - 8}" class="q-ax${on ? ' on' : ''}" text-anchor="middle">${qShort(t.month)}${t.month.slice(5, 7) === '01' || i === 0 ? ` ${t.month.slice(2, 4)}` : ''}</text></g>`;
  }).join('');
  return `<svg class="q-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Month by month">${grid.join('')}${cols}</svg>`;
}
const qTrendTable = (trend, series) => `<details class="q-table-toggle"><summary class="small muted">Show as a table</summary><div class="kdb-scroll"><table class="log small">
  <thead><tr><th>Month</th>${series.map(([k, , l]) => `<th class="num">${esc(l || k)}</th>`).join('')}<th class="num">Total</th></tr></thead>
  <tbody>${trend.map((t) => `<tr><td>${esc(t.label)}</td>${series.map(([k]) => `<td class="num">${t[k] || ''}</td>`).join('')}<td class="num"><b>${series.reduce((s, [k]) => s + (t[k] || 0), 0) || ''}</b></td></tr>`).join('')}</tbody></table></div></details>`;

// where they came from: a bar per name, the year to date light and this month dark within it
// fmt: how a number is written (Operations' card counts, compact like 515k, in wider columns)
function qBarsList(list, monthLabel, fmt) {
  if (!list?.length) return '<div class="empty small">Nothing this year yet.</div>';
  const max = Math.max(1, ...list.map((x) => x.ytd)); const f = fmt || ((v) => v);
  return `<div class="q-bars${fmt ? ' wide' : ''}">${list.map((x) => `<div class="q-bar-row${x.other ? ' other' : ''}" title="${esc(x.name)}: ${x.month.toLocaleString('en-GB')} in ${esc(monthLabel)}, ${x.ytd.toLocaleString('en-GB')} this year">
      <span class="q-bar-name">${esc(x.name)}</span>
      <span class="q-bar"><i class="ytd" style="width:${(x.ytd / max) * 100}%"></i><i class="mon" style="width:${(x.month / max) * 100}%"></i></span>
      <span class="q-bar-n"><b>${x.month ? f(x.month) : ''}</b></span><span class="q-bar-n muted">${f(x.ytd)}</span></div>`).join('')}</div>`;
}
function qBars(title, list, monthLabel) {
  if (!list?.length) return `<div class="card q-card"><h3>${title}</h3><div class="empty small">Nothing this year yet.</div></div>`;
  const max = Math.max(1, ...list.map((x) => x.ytd));
  return `<div class="card q-card"><h3>${title}</h3>
    <div class="q-bars">${list.map((x) => `<div class="q-bar-row${x.other ? ' other' : ''}" title="${esc(x.name)}: ${x.month} in ${esc(monthLabel)}, ${x.ytd} this year">
      <span class="q-bar-name">${esc(x.name)}</span>
      <span class="q-bar"><i class="ytd" style="width:${(x.ytd / max) * 100}%"></i><i class="mon" style="width:${(x.month / max) * 100}%"></i></span>
      <span class="q-bar-n"><b>${x.month || ''}</b></span><span class="q-bar-n muted">${x.ytd}</span></div>`).join('')}</div>
    <div class="q-bars-key small muted"><span><i class="q-sw mon"></i>${esc(monthLabel)}</span><span><i class="q-sw ytd"></i>year to date</span></div></div>`;
}
// a case's or form's text: a click on it copies it (for the monthly slides); selecting part of it still works
const qText = (label, v) => (v ? `<div class="q-more-f"><b>${label}</b><div class="pre q-copy" data-q-copy="${esc(label)}" title="Click to copy">${esc(v)}</div></div>` : '');

// ---- 🧪 Quality -----------------------------------------------------------------------------------
function qualityHtml(d) {
  const t = d.tiles; const sev = t.severity;
  const sevChips = (s) => Q_SEV.filter(([k]) => s[k]).map(([k, cls]) => `<span class="q-chip"><i class="q-sw ${cls}"></i>${s[k]} ${k.toLowerCase()}</span>`).join('') || '<span class="muted">none</span>';
  const sevPill = (s) => `<span class="q-pill ${(Q_SEV.find(([k]) => k === s) || Q_SEV[3])[1]}">${esc(s)}</span>`;
  const series = Q_SEV.map(([k, cls]) => [k, cls, k]);
  const caseRow = (c, i, list) => `<tr class="${c.contain_late ? 'q-late' : ''}"><td><button type="button" class="icon q-more-btn" data-q-more="q-${list}-${i}" aria-expanded="false" title="Root causes and more">▸</button></td>
      <td><b>${esc(c.ref ?? '')}</b></td><td>${qDate(c.day)}</td><td>${esc(c.customer || '')}</td><td>${sevPill(c.severity)}</td><td>${esc(c.status || '')}</td>
      <td class="q-sum">${c.summary ? `<span class="q-copy" data-q-copy="Summary" title="Click to copy">${esc(c.summary)}</span>` : ''}</td><td>${esc(c.defect || '')}</td>
      <td>${c.contained ? qDate(c.contained) : c.target ? `<span class="${c.contain_late ? 'q-bad' : 'muted'}">due ${qDate(c.target)}</span>` : '<span class="muted">—</span>'}</td>
      <td>${c.closed ? qDate(c.closed) : `<span class="muted">${c.age ?? ''} d open</span>`}</td><td class="num">${c.cost ? QEUR(c.cost) : ''}</td></tr>
    <tr id="q-${list}-${i}" class="q-more" hidden><td></td><td colspan="10"><div class="q-more-grid">
      ${qText('Root cause for occurrence', c.cause)}${qText('Root cause for non-detection', c.non_detection)}
      <div class="q-more-f"><b>Details</b><div class="small">${[c.kind, c.category && `Product: ${c.category}`, c.origin && `Origin: ${c.origin}`, c.failure_type && `Failure type: ${c.failure_type}`,
        c.parts && `${QN(c.parts)} parts confirmed defective`, /^y/i.test(c.recurrence || '') && '↻ re-occurrence', c.owner && `Owner: ${c.owner}`].filter(Boolean).map(esc).join(' · ')}</div></div></div></td></tr>`;
  const table = (list, key, empty) => (list.length ? `<div class="kdb-scroll"><table class="log q-cases"><thead><tr><th></th><th>Ref</th><th>Opened</th><th>Customer</th><th>Severity</th><th>Status</th>
    <th>Summary</th><th>Defect</th><th>Contained</th><th>Closed</th><th class="num">Cost</th></tr></thead><tbody>${list.map((c, i) => caseRow(c, i, key)).join('')}</tbody></table></div>` : `<div class="empty small">${empty}</div>`);
  const onTimePct = t.contained_with_target ? Math.round((t.contained_on_time / t.contained_with_target) * 100) : null;
  const pk = qPackParts(d);
  const tab = (group, key, label, title = '') => { const on = qdOn(group, key); return `<button type="button" class="${on ? 'on' : ''}" data-qd-tab="${group}:${key}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`; };
  const pane = (group, key, html) => `<div class="qd-pane" data-qd-pane="${group}:${key}"${qdOn(group, key) ? '' : ' hidden'}>${html}</div>`;
  const where = [['customer', 'Customer'], ['defect', 'Defect'], ['origin', 'Origin'], ['category', 'Product'], ['failure_type', 'Failure type']];
  const short = { otd: 'OTD', cpms: 'CPMS', lead: 'Lead time' };
  const chartKeys = [...pk.charts.map(([k, title]) => [k, short[k] || title, title]), ['trend', 'By severity', 'Complaints by the month they were opened, by severity']];
  qdDefaults({ chart: 'otd', where: 'customer', cases: d.open.length && !d.cases.length ? 'open' : 'month' });
  const cur = qdCur('chart');
  return `
    <div class="qd">
    <div class="q-tiles qd-tiles">
      ${qTile(`Complaints in ${esc(qShort(d.month))}`, QN(t.opened), `${sevChips(sev)}<div>${qDelta(t.opened, t.opened_prev)}</div>`, t.opened ? '' : 'quiet')}
      ${qTile(`${d.year} so far`, QN(t.ytd), sevChips(t.ytd_severity))}
      ${qTile('Open now', QN(t.open), `${t.open_not_contained ? `${t.open_not_contained} not contained yet` : 'all contained'}${t.open_contain_late ? ` · <b class="q-bad">${t.open_contain_late} past the containment date</b>` : ''}`, t.open_contain_late ? 'warn' : '')}
      ${qTile(`Contained in ${esc(qShort(d.month))}`, QN(t.contained), `${onTimePct === null ? '' : `${onTimePct}% on time · `}${t.days_to_contain === null ? '' : `${t.days_to_contain} d average`}`)}
      ${qTile(`Closed in ${esc(qShort(d.month))}`, QN(t.closed), t.days_to_close === null ? '' : `${t.days_to_close} d average from opening`)}
      ${qTile('Cost', QEUR(t.cost), `${QEUR(t.cost_ytd)} this year${t.parts ? ` · ${QN(t.parts)} parts` : ''}${t.recurrences ? ` · ${t.recurrences} re-occurrence${t.recurrences === 1 ? '' : 's'}` : ''}`)}
    </div>
    <div class="qd-top">
      <section class="ck-panel qd-charts">
        <div class="ck-ph"><h3 title="${esc(pk.span)}">📈</h3><div class="seg qd-tabs">${chartKeys.map(([k, l, title]) => tab('chart', k, esc(l), title)).join('')}</div>
          <span class="spacer"></span>
          ${pk.missing.length ? `<span class="chip overdue" title="The OTD and CPMS charts need ${esc(pk.missing.join(' and '))} — read on Reporting's Sources">⚠ data missing</span>` : ''}
          <span class="qd-chart-tools"${cur === 'trend' ? ' hidden' : ''}><button class="small primary" data-qcopy="${cur === 'trend' ? 'otd' : cur}" title="Copy for PowerPoint: the chart as a picture, then paste it into the slide (Ctrl+V)">📋 Copy</button>
            <button class="small" data-qpng="${cur === 'trend' ? 'otd' : cur}" title="Save it as a picture (PNG)">⬇ PNG</button></span>
          ${pk.settings}</div>
        <div class="qd-body qd-chart-body">
          ${pk.charts.map(([k, , svg]) => pane('chart', k, `<div class="qd-svg">${qxScreen(svg)}</div>`)).join('')}
          ${pane('chart', 'trend', `<div class="qd-trend">${qLegend(series)}${qStackChart(d.trend, series, d.month)}</div>`)}
        </div>
      </section>
      <section class="ck-panel qd-where">
        <div class="ck-ph"><h3>Where from</h3><div class="seg qd-tabs">${where.map(([k, l]) => tab('where', k, l)).join('')}</div></div>
        <div class="qd-body">${where.map(([k]) => pane('where', k, qBarsList(d.breakdowns[k], d.label))).join('')}</div>
        <div class="qd-foot q-bars-key small muted"><span><i class="q-sw mon"></i>${esc(d.label)}</span><span><i class="q-sw ytd"></i>year to date</span></div>
      </section>
    </div>
    <section class="ck-panel qd-cases">
      <div class="ck-ph"><div class="seg qd-tabs">${tab('cases', 'month', `Opened in ${esc(qShort(d.month))} <span class="tm-count">${d.cases.length}</span>`)}${tab('cases', 'open', `Still open <span class="tm-count">${d.open.length}</span>`, 'Any month: the oldest and those past their containment date first')}</div>
        <span class="small muted">▸ or click a row for its root causes · click a root cause or summary to copy it</span></div>
      <div class="qd-body">${pane('cases', 'month', table(d.cases, 'm', `No complaints opened in ${esc(d.label)}.`))}${pane('cases', 'open', table(d.open, 'o', 'Nothing open.'))}</div>
    </section>
    </div>`;
}

// the dashboard's mini-tabs: which one each panel shows (kept per browser)
const qdState = () => store.get('qdTabs', {}) || {};
const qdCur = (group) => qdState()[group];
const qdOn = (group, key) => qdCur(group) === key;
function qdDefaults(defs) { const st = qdState(); let ch = false; for (const [g, k] of Object.entries(defs)) if (!st[g]) { st[g] = k; ch = true; } if (ch) store.set('qdTabs', st); }
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-qd-tab]'); if (!b) return;
  const [group, key] = b.dataset.qdTab.split(':');
  const st = qdState(); st[group] = key; store.set('qdTabs', st);
  const panel = b.closest('.ck-panel');
  panel.querySelectorAll('[data-qd-tab]').forEach((x) => x.classList.toggle('on', x === b));
  panel.querySelectorAll('[data-qd-pane]').forEach((x) => { x.hidden = x.dataset.qdPane !== `${group}:${key}`; });
  if (group === 'echart') qDrawCharts();
  if (group === 'chart') {
    const tools = panel.querySelector('.qd-chart-tools'); if (tools) tools.hidden = key === 'trend';
    if (key !== 'trend') { panel.querySelector('[data-qcopy]').dataset.qcopy = key; panel.querySelector('[data-qpng]').dataset.qpng = key; }
    qDrawCharts();
  }
});

// ---- 📈 the monthly slides: the Quality team's three charts, each copied into PowerPoint with one button --
let qPackSvgs = {}; let qPackReady = {};
function qPackParts(d) {
  const p = d.pack; if (!p) return { charts: [], settings: '', missing: [], span: '' };
  const charts = qxPackCharts(p, p.titles || {});
  qPackSvgs = Object.fromEntries(charts.map(([k, , svg]) => [k, svg]));
  qPackReady = {}; // the pictures, made now so a click copies at once
  setTimeout(() => charts.forEach(([k, , svg]) => qxReady(svg).then((x) => { if (qPackSvgs[k] === svg) qPackReady[k] = x; }).catch(() => {})), 50);
  const first = p.months[0].month; const last = p.months[p.months.length - 1].month; const yr = p.ytd.month.slice(0, 4);
  const missing = [!p.shipped_read && 'cards shipped (the shipped export)', !p.otd_read && 'the OTD report'].filter(Boolean);
  const t = p.targets; const tt = p.titles || {};
  const settings = `<details class="q-pack-set"><summary class="button small" title="Targets and titles">⚙</summary><div class="card q-pack-pop">
        <div class="q-pack-grid">
          <label>OTD target <span class="muted">%</span><input type="number" step="0.1" min="0" max="100" data-qt="otd" value="${+(t.otd * 100).toFixed(2)}"></label>
          <label>CPMS target<input type="number" step="0.01" min="0" data-qt="cpms" value="${t.cpms}"></label>
          <label>Contained within <span class="muted">days</span><input type="number" step="0.5" min="0" data-qt="contain" value="${t.contain}"></label>
          <label>Communicated within <span class="muted">days</span><input type="number" step="0.5" min="0" data-qt="communicate" value="${t.communicate}"></label>
          <label class="wide">Title: OTD chart<input type="text" data-qtitle="otd" value="${esc(tt.otd || '')}" placeholder="Complaints OTD"></label>
          <label class="wide">Title: CPMS chart<input type="text" data-qtitle="cpms" value="${esc(tt.cpms || '')}" placeholder="CPMS Quality"></label>
          <label class="wide">Title: lead time chart<input type="text" data-qtitle="lead" value="${esc(tt.lead || '')}" placeholder="Lead Time Service Center"></label>
        </div>
        <p class="small muted" style="margin:6px 0 0">Kept for everyone. OTD SC counts the Service Center's delays (internal), OTD C the customer's (external), each against the cards shipped. CPMS and the green bars count Customer Complaints only (not Inter-company).</p></div></details>`;
  return { charts, settings, missing, span: `For the monthly slides — OTD and CPMS: ${yr} and ${yr} YTD · lead time: ${qShort(first)} ${first.slice(0, 4)} to ${qShort(last)} ${last.slice(0, 4)}` };
}
document.addEventListener('click', async (e) => {
  const c = e.target.closest('[data-qcopy]'); const g = e.target.closest('[data-qpng]');
  if (!c && !g) return;
  const k = (c || g).dataset.qcopy || (c || g).dataset.qpng; const svg = qPackSvgs[k]; if (!svg) return;
  try {
    if (c) { const how = await qxCopy(svg, qPackReady[k] || null); toast(how === 'image' ? '📋 Copied — paste it into the slide (Ctrl+V)' : '📋 Copied — paste it into the slide (Ctrl+V); if nothing appears, use ⬇ PNG'); }
    else await qxDownload(svg, `${k}-${$('#q-month')?.value || 'chart'}`);
  } catch (err) { toast(err.message, 'error'); }
});
document.addEventListener('change', async (e) => {
  const tg = e.target.closest('[data-qt], [data-qtitle]'); if (!tg) return;
  const body = tg.dataset.qt ? { [tg.dataset.qt]: tg.value } : { titles: { [tg.dataset.qtitle]: tg.value } };
  try { await api.put('/kpi/quality/targets', body); toast('Saved'); const open = tg.closest('details')?.open; await renderQualityTab('quality'); if (open) $('.q-pack-set')?.setAttribute('open', ''); } catch (err) { toast(err.message, 'error'); }
});

// ---- ⛑ EHS ----------------------------------------------------------------------------------------
function ehsHtml(d) {
  const t = d.tiles;
  const typeLabel = Object.fromEntries(d.types);
  const typePill = (k) => `<span class="q-pill ${(Q_EHS.find(([x]) => x === k) || [, 'q-c4'])[1]}" title="${esc(typeLabel[k] || k)}">${esc(k)} · ${esc(typeLabel[k] || '')}</span>`;
  const series = Q_EHS;
  const riskTone = (r) => (r >= 15 ? 'r4' : r >= 6 ? 'r3' : r >= 2 ? 'r2' : 'r1');
  const tileFor = ([k, cls, label]) => qTile(`<i class="q-sw ${cls}"></i>${label}`, QN(t.month[k]), `${t.ytd[k]} in ${d.year}<div>${qDelta(t.month[k], t.prev[k])}</div>`, k === 'AC' && t.month[k] ? 'warn' : '');
  const formRow = (f, i, list) => `<tr><td><button type="button" class="icon q-more-btn" data-q-more="e-${list}-${i}" aria-expanded="false" title="What happened and what was done">▸</button></td>
      <td>${typePill(f.kind)}</td><td>${qDate(f.day)}${f.time ? ` <span class="muted small">${esc(f.time)}</span>` : ''}</td><td>${esc(f.location || '')}${f.detail ? `<div class="small muted">${esc(f.detail)}</div>` : ''}</td>
      <td>${esc(f.category || '')}</td><td>${f.risk !== null && f.risk !== undefined ? `<span class="q-risk ${riskTone(Number(f.risk))}" title="${esc(`${f.occurrence || '?'} × ${f.effect || '?'}`)}">${QN(f.risk)}</span>` : ''}</td>
      <td>${esc(f.status || 'Open')}</td><td class="q-sum">${esc(f.description || '')}</td><td class="num">${f.days_open ?? ''}</td></tr>
    <tr id="e-${list}-${i}" class="q-more" hidden><td></td><td colspan="8"><div class="q-more-grid">
      ${qText('What happened', f.description)}${qText('Immediate actions', f.immediate)}${qText('Corrective actions', f.corrective)}${qText('SCF response', f.scf_response)}
      <div class="q-more-f"><b>Details</b><div class="small">${[f.first_aid && `First aid: ${f.first_aid}`, f.occurrence && `How often: ${f.occurrence}`, f.effect && `How bad: ${f.effect}`, f.response && `Response: ${f.response}`,
        f.name && `Reported by ${f.name}`, f.otl && `OTL ${f.otl}`, f.responder && `Responder ${f.responder}${f.response_day ? `, ${fmtDate(f.response_day)}` : ''}`].filter(Boolean).map(esc).join(' · ')}</div></div></div></td></tr>`;
  const table = (list, key, empty) => (list.length ? `<div class="kdb-scroll"><table class="log q-cases"><thead><tr><th></th><th>Type</th><th>Date</th><th>Where</th><th>Category</th><th title="How often × how bad, as on the form">Risk</th>
    <th>Status</th><th>What happened</th><th class="num" title="Days from the incident to the response (open: to today)">Days</th></tr></thead><tbody>${list.map((f, i) => formRow(f, i, key)).join('')}</tbody></table></div>` : `<div class="empty small">${empty}</div>`);
  // the risk grid: how often (rows) × how bad (columns) as on the form, this year's forms counted in their cell
  const effects = d.matrix[0]?.cells || [];
  const matrix = `<div class="kdb-scroll"><table class="q-matrix"><thead><tr><th class="small muted">How often ↓ · how bad →</th>${effects.map((c) => `<th title="${esc(c.effect)} (×${c.score})">${esc(c.effect.replace(/\s*\(.*\)/, ''))}</th>`).join('')}</tr></thead>
    <tbody>${d.matrix.map((r) => `<tr><th title="×${r.score}">${esc(r.occurrence)}</th>${r.cells.map((c) => `<td class="q-risk-cell ${riskTone(c.risk)}${c.count ? ' has' : ''}" title="${esc(`${r.occurrence} × ${c.effect} = risk ${c.risk}${c.count ? ` — ${c.count} form${c.count === 1 ? '' : 's'} in ${d.year}${c.open ? `, ${c.open} open` : ''}` : ''}`)}">${c.count ? `<b>${c.count}</b>${c.open ? '<i class="q-open-dot"></i>' : ''}` : ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <div class="q-bars-key small muted"><span><i class="q-sw r1"></i>risk under 2</span><span><i class="q-sw r2"></i>2–5</span><span><i class="q-sw r3"></i>6–14</span><span><i class="q-sw r4"></i>15 and up</span><span><i class="q-open-dot"></i>still open</span>${d.unscored ? `<span>${d.unscored} form${d.unscored === 1 ? '' : 's'} without a score</span>` : ''}</div>`;
  const tab = (group, key, label, title = '') => `<button type="button" class="${qdOn(group, key) ? 'on' : ''}" data-qd-tab="${group}:${key}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  const pane = (group, key, html) => `<div class="qd-pane" data-qd-pane="${group}:${key}"${qdOn(group, key) ? '' : ' hidden'}>${html}</div>`;
  const where = [['category', 'Category'], ['location', 'Location'], ['first_aid', 'First aid'], ['response', 'Response']];
  qdDefaults({ echart: 'trend', ewhere: 'category', eforms: d.open.length && !d.forms.length ? 'open' : 'month' });
  return `
    <div class="qd">
    <div class="q-tiles qd-tiles">
      ${qTile('Days without an accident', t.days_since_accident === null ? '—' : QN(t.days_since_accident), t.last_accident ? `last one ${esc(fmtDate(t.last_accident))}${d.month === new Date().toISOString().slice(0, 7) ? '' : ` · at the end of ${esc(qShort(d.month))}`}` : 'none recorded', 'hero')}
      ${series.map(tileFor).join('')}
      ${qTile('Open forms', QN(t.open), `<div>open or actioned, any month</div>${t.open_high ? `<div><b class="q-bad">${t.open_high} with risk 6 or more</b></div>` : ''}`, t.open_high ? 'warn' : '')}
      ${qTile(`Response in ${esc(qShort(d.month))}`, t.days_to_respond === null ? '—' : `${t.days_to_respond} d`, `${t.responded} of ${t.total} form${t.total === 1 ? '' : 's'} answered${t.first_aid ? ` · ${t.first_aid} needed first aid or more` : ''}`)}
    </div>
    <div class="qd-top">
      <section class="ck-panel qd-charts">
        <div class="ck-ph"><h3>📈</h3><div class="seg qd-tabs">${tab('echart', 'trend', 'By month', 'Forms by the month of the incident, by type')}${tab('echart', 'risk', `Risk in ${d.year}`, 'How often × how bad, as scored on the form; this year\'s forms in their cell')}</div></div>
        <div class="qd-body qd-chart-body">
          ${pane('echart', 'trend', `<div class="qd-trend">${qLegend(series)}${qStackChart(d.trend, series, d.month)}</div>`)}
          ${pane('echart', 'risk', matrix)}
        </div>
      </section>
      <section class="ck-panel qd-where">
        <div class="ck-ph"><h3>Where</h3><div class="seg qd-tabs">${where.map(([k, l]) => tab('ewhere', k, l)).join('')}</div></div>
        <div class="qd-body">${where.map(([k]) => pane('ewhere', k, qBarsList(d.breakdowns[k], d.label))).join('')}</div>
        <div class="qd-foot q-bars-key small muted"><span><i class="q-sw mon"></i>${esc(d.label)}</span><span><i class="q-sw ytd"></i>year to date</span></div>
      </section>
    </div>
    <section class="ck-panel qd-cases">
      <div class="ck-ph"><div class="seg qd-tabs">${tab('eforms', 'month', `In ${esc(qShort(d.month))} <span class="tm-count">${d.forms.length}</span>`)}${tab('eforms', 'open', `Still open <span class="tm-count">${d.open.length}</span>`, 'Any month: the highest risk first')}</div>
        <span class="small muted">▸ or click a row for what was done · click the text to copy it</span></div>
      <div class="qd-body">${pane('eforms', 'month', table(d.forms, 'm', `No forms for ${esc(d.label)}.`))}${pane('eforms', 'open', table(d.open, 'o', 'Nothing open.'))}</div>
    </section>
    </div>`;
}
