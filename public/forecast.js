// Forecast (the Forecast module): the customer forecasts sent in — through the upload link (no account needed) or
// from here — who sent which and when, what each held month by month, and which one Capacity planning reads.
// An admin (the setup right) switches the link on or off and makes a new one (src/forecasts.js).

const fcQty = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const fcMonth = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: '2-digit' }); };

async function renderForecast() {
  const d = await api.get('/forecasts');
  const url = d.link.path ? `${location.origin}${d.link.path}` : '';
  const kind = store.get('fcKind', '');
  const list = d.uploads.filter((u) => !kind || u.kind === kind);
  // what Capacity planning reads now, per kind
  const cap = (k) => {
    const st = d.capacity?.[k] || {}; const up = d.uploads.find((u) => u.id === d.newest[k]);
    const sent = String(st.file || '').startsWith('📈');
    return `<div class="kdb-tile fc-tile"><div class="kdb-tile-l">${esc(d.kinds[k])} <span class="muted">· what the A3 and Capacity read now</span></div>
      <div class="small">${st.error ? `<span class="pl-late">⚠ ${esc(st.error)}</span>` : st.file ? `${sent ? '📈 sent in' : '🔗 the linked file'}: <b>${esc(String(st.file).replace(/^📈\s*/, ''))}</b>` : '<span class="muted">nothing yet</span>'}</div>
      <div class="small muted">${st.at ? `read ${esc(fmtDateTime(st.at))}${st.rows !== undefined ? ` · ${st.rows} rows` : ''}` : ''}${up && !sent ? ` · newest sent in: ${esc(fmtDateTime(up.created_at))} (the linked file is newer)` : ''}</div></div>`;
  };
  const months = (u) => { const ks = Object.keys(u.summary || {}).sort(); if (!ks.length) return ''; const tot = ks.reduce((a, k) => a + u.summary[k], 0);
    return `<span title="${esc(ks.map((k) => `${fcMonth(k)}: ${Math.round(u.summary[k]).toLocaleString()}`).join('\n'))}">${esc(fcMonth(ks[0]))}–${esc(fcMonth(ks[ks.length - 1]))} · <b>${fcQty(tot)}</b></span>`; };
  const row = (u) => `<tr>
      <td class="nowrap small">${esc(fmtDateTime(u.created_at))}</td>
      <td>${personChip(u.submitter)} <span class="small muted">${u.via === 'link' ? '🔗 by the link' : '👤 signed in'}</span></td>
      <td class="small">${esc(u.kind_label)}${d.newest[u.kind] === u.id ? ' <span class="cx-pill" style="--sc:#238446" title="The newest of its kind: what Capacity planning reads, unless the linked file is newer">newest</span>' : ''}</td>
      <td class="small">${months(u)}</td>
      <td class="small"><a href="/api/forecasts/${u.id}/file" download>⬇ ${esc(u.file_name)}</a> <span class="muted">${Math.max(1, Math.round(u.size / 1024))} KB</span></td>
      <td class="small">${esc(u.note || '')}</td>
      <td>${d.link.can_edit ? `<button type="button" class="icon" data-fc-del="${u.id}" title="Remove this forecast">✕</button>` : ''}</td></tr>`;
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">Forecast</h1>
      <div class="seg">${[['', 'All'], ...Object.entries(d.kinds)].map(([k, l]) => `<button type="button" data-fc-kind="${k}" class="${kind === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
      <div class="spacer"></div>
      <label class="button primary" title="Upload a BeNeLux or Amex forecast workbook">⬆ Upload a forecast<input type="file" id="fc-file" accept=".xlsx,.xlsm" hidden></label></div>
    <p class="small muted">The customer forecasts sent in, newest first. Each is checked when it arrives; the newest of each kind then feeds <b>everything using the forecast</b>: the A3 built from then on (% of forecast, Missing), the Database's report tables and Capacity planning, in place of the file linked in Reporting › Sources (unless that file is newer).</p>
    <div class="card fc-viz" id="fc-viz"><h2 style="margin:0">The forecast</h2><div class="empty small">Reading the forecast…</div></div>
    <div class="kdb-tiles">${Object.keys(d.kinds).map(cap).join('')}</div>
    <div class="card">
      <div class="row"><h2 style="margin:0">Upload link</h2><span class="small ${d.link.on ? '' : 'muted'}">${d.link.on ? '● on' : '○ off'}</span><div class="spacer"></div>
        ${d.link.can_edit ? `<button type="button" data-fc-link="${d.link.on ? 'off' : 'on'}">${d.link.on ? 'Switch off' : 'Switch on'}</button>${d.link.on ? '<button type="button" data-fc-renew title="Make a new link: the old one stops working">↻ New link</button>' : ''}` : ''}</div>
      <p class="small muted">For the people who send forecasts but have no SITHUB account: the link opens a page that only sends a forecast (they give their name) and shows what was sent from that browser before. Nothing else of SITHUB. Anyone with the link can send one, so share it only with them; make a new link if it goes further.</p>
      ${d.link.on && url ? `<div class="row"><input type="text" readonly value="${esc(url)}" id="fc-url" style="flex:1;min-width:0"><button type="button" class="primary" data-fc-copy>📋 Copy</button><a class="button" href="${esc(d.link.path)}" target="_blank" rel="noopener">Open ↗</a></div>${/^(localhost|127\.|\[?::1)/.test(location.hostname) ? '<div class="small pl-late" style="margin-top:6px">⚠ This link uses this PC\'s own address, so it only works here. Copy it from another PC (opening SITHUB by the server\'s name) to share it.</div>' : ''}`
    : `<div class="empty small">${d.link.can_edit ? 'Switch the link on to get it.' : 'The link is off: an admin switches it on.'}</div>`}
    </div>
    <div class="card"><h2>Sent in <span class="small muted">${list.length}</span></h2>
      ${list.length ? `<div class="kdb-scroll"><table class="log"><thead><tr><th>When</th><th>From</th><th>Forecast</th><th>Months · total</th><th>File</th><th>Note</th><th></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`
    : '<div class="empty">No forecasts sent in yet.</div>'}</div>`;
  $$('[data-fc-kind]').forEach((b) => b.addEventListener('click', () => { store.set('fcKind', b.dataset.fcKind); renderForecast(); }));
  fcViz(kind, d).catch((err) => { const b = $('#fc-viz'); if (b) b.innerHTML = `<h2 style="margin:0">The forecast</h2><div class="empty small">${esc(err.message)}</div>`; });
  $('#fc-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await fetch('/api/forecasts/upload', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name) } });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText);
      toast(`${j.kind_label} received (${j.rows} rows) — the A3 and Capacity planning read it from now on`);
    } catch (err) { toast(err.message, 'error'); }
    renderForecast();
  });
  $('[data-fc-copy]')?.addEventListener('click', async () => toast(await copyText(url) ? 'Link copied' : 'Select the link and copy it', 'success'));
  $('[data-fc-link]')?.addEventListener('click', async (e) => { try { await api.put('/forecasts/link', { on: e.target.dataset.fcLink === 'on' }); } catch (err) { toast(err.message, 'error'); } renderForecast(); });
  $('[data-fc-renew]')?.addEventListener('click', async () => {
    if (!confirm('Make a new link? The current one stops working, so whoever has it will need the new one.')) return;
    try { await api.post('/forecasts/link/renew'); toast('New link made — the old one no longer works'); } catch (err) { toast(err.message, 'error'); }
    renderForecast();
  });
  $$('[data-fc-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this forecast? If it\'s the newest of its kind, Capacity planning goes back to the one before it (or the linked file).')) return;
    try { await api.del(`/forecasts/${b.dataset.fcDel}`); } catch (err) { toast(err.message, 'error'); }
    renderForecast();
  }));
}

// ---- The forecast, drawn: the forecast in use now (each kind: the linked file or the newest sent in), month by month
// for a year, stacked by customer (the 7 biggest in their own colours, the rest as Other), with a version sent in
// earlier as a dashed mark on each month to see what changed. A table view below.
const FC_TOP = 7;
const FC_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fcN = (v) => Math.round(v).toLocaleString('en-GB');
let FC_LAST = null; // what was drawn last (redrawn when the window is resized)
async function fcViz(kind, d0) {
  const box = $('#fc-viz'); if (!box) return;
  const kinds = kind ? [kind] : Object.keys(d0.kinds);
  // to compare with: a version of this forecast sent in before (one kind at a time); by default the one before the newest
  const versions = kind ? d0.uploads.filter((u) => u.kind === kind) : [];
  let cmp = kind ? String(store.get(`fcCompare_${kind}`, 'auto')) : '';
  if (cmp === 'auto') { const i = versions.findIndex((u) => u.id === d0.newest[kind]); cmp = i >= 0 && versions[i + 1] ? String(versions[i + 1].id) : ''; }
  if (cmp && !versions.some((u) => String(u.id) === cmp)) cmp = '';
  const v = await api.get(`/forecasts/view${cmp ? `?compare=${cmp}` : ''}`);
  if (!$('#fc-viz')) return;
  const rows = v.rows.filter((r) => kinds.includes(r.kind));
  const from = kinds.map((k) => { const c = v.current[k]; return c?.error ? `${esc(v.kinds[k])}: <span class="pl-late">⚠ ${esc(c.error)}</span>` : c?.from === 'sent_in' ? `${esc(v.kinds[k])}: 📈 sent in by ${esc(c.sent_in.submitter)}, ${esc(fmtDateTime(c.sent_in.created_at))}` : c?.from === 'file' ? `${esc(v.kinds[k])}: 🔗 the linked file${c.modified ? `, saved ${esc(fmtDateTime(c.modified))}` : ''}` : `${esc(v.kinds[k])}: <span class="muted">none</span>`; }).join(' · ');
  const years = [...new Set(rows.map((r) => r.year))].sort();
  if (!years.length) { box.innerHTML = `<h2 style="margin:0">The forecast</h2><p class="small muted">${from}</p><div class="empty">No forecast to draw yet: send one in, or link the files in Reporting › Sources.</div>`; return; }
  const thisYear = new Date().getFullYear();
  let year = Number(store.get('fcYear', 0)); if (!years.includes(year)) year = years.includes(thisYear) ? thisYear : years[years.length - 1];
  // customers in a fixed order (all years of what's shown), so a colour stays with its customer when the year changes
  const all = new Map(); for (const r of rows) all.set(r.cust, (all.get(r.cust) || 0) + r.qty);
  const ranked = [...all].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  const top = ranked.length <= FC_TOP + 1 ? ranked : ranked.slice(0, FC_TOP);
  const series = [...top.map((c, i) => ({ key: c, label: c, n: i + 1 })), ...(ranked.length > top.length ? [{ key: '\u0000other', label: `Other (${ranked.length - top.length} customers)`, n: 'o' }] : [])];
  const group = (c) => (top.includes(c) ? c : '\u0000other');
  const yr = rows.filter((r) => r.year === year);
  const byM = FC_MON.map(() => new Map()); for (const r of yr) { const m = byM[r.month - 1]; const g = group(r.cust); m.set(g, (m.get(g) || 0) + r.qty); }
  const totals = byM.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const cmpRows = v.compare && kinds.includes(v.compare.kind) ? v.compare.rows.filter((r) => r.year === year) : null;
  const cmpTot = cmpRows ? FC_MON.map((_, i) => cmpRows.filter((r) => r.month === i + 1).reduce((a, r) => a + r.qty, 0)) : null;
  const yearTot = totals.reduce((a, b) => a + b, 0); const cmpYear = cmpTot ? cmpTot.reduce((a, b) => a + b, 0) : null;
  const pct = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(((a - b) / b) * 100).toFixed(1)}%` : '');
  const cmpInfo = v.compare ? `the version of ${fmtDateTime(v.compare.created_at)} (${v.compare.submitter})` : '';
  const biggest = [...yr.reduce((m, r) => m.set(r.cust, (m.get(r.cust) || 0) + r.qty), new Map())].sort((a, b) => b[1] - a[1])[0];
  const tile = (l, val, sub) => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${val}</div><div class="kdb-tile-s">${sub}</div></div>`;
  // the table: every customer (not folded into Other), the months and the year, and the change against the version compared
  const custs = [...yr.reduce((m, r) => m.set(r.cust, (m.get(r.cust) || 0) + r.qty), new Map())].sort((a, b) => b[1] - a[1]);
  const cell = (c, m) => yr.filter((r) => r.cust === c && r.month === m).reduce((a, r) => a + r.qty, 0);
  const cmpCust = (c) => (cmpRows ? cmpRows.filter((r) => r.cust === c).reduce((a, r) => a + r.qty, 0) : 0);
  const table = `<details class="q-table-toggle"><summary class="small muted">Show as a table (every customer)</summary><div class="kdb-scroll"><table class="log small fc-table">
    <thead><tr><th>Customer</th>${FC_MON.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">${year}</th>${cmpRows ? '<th class="num" title="Against the version compared">vs before</th>' : ''}</tr></thead>
    <tbody>${custs.map(([c, t]) => `<tr><td>${esc(c)}</td>${FC_MON.map((_, i) => { const x = cell(c, i + 1); return `<td class="num">${x ? fcN(x) : ''}</td>`; }).join('')}<td class="num"><b>${fcN(t)}</b></td>${cmpRows ? `<td class="num">${cmpCust(c) ? `${t >= cmpCust(c) ? '▲' : '▼'} ${pct(t, cmpCust(c))}` : 'new'}</td>` : ''}</tr>`).join('')}
    <tr class="fc-total"><td><b>Total</b></td>${totals.map((x) => `<td class="num"><b>${x ? fcN(x) : ''}</b></td>`).join('')}<td class="num"><b>${fcN(yearTot)}</b></td>${cmpRows ? `<td class="num"><b>${pct(yearTot, cmpYear)}</b></td>` : ''}</tr></tbody></table></div></details>`;
  box.innerHTML = `<div class="row"><h2 style="margin:0">The forecast</h2><div class="spacer"></div>
      <input type="search" id="fc-find" list="fc-custs" placeholder="Find a customer…" value="${esc(store.get('fcCust', '') || '')}" autocomplete="off" style="width:220px" aria-label="Find a customer">
      <datalist id="fc-custs">${ranked.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
      <span class="seg">${years.map((y) => `<button type="button" data-fc-year="${y}" class="${y === year ? 'on' : ''}">${y}</button>`).join('')}</span>
      ${kind ? `<label class="small">Compare with <select id="fc-cmp"><option value="">nothing</option>${versions.filter((u) => u.id !== d0.newest[kind] || v.current[kind]?.from !== 'sent_in').map((u) => `<option value="${u.id}" ${String(u.id) === cmp ? 'selected' : ''}>${esc(fmtDateTime(u.created_at))} · ${esc(u.submitter)}</option>`).join('')}</select></label>` : '<span class="small muted" title="Pick BeNeLux or Amex above to compare with an earlier version">compare: one forecast at a time</span>'}</div>
    <p class="small muted" style="margin:4px 0 8px">In use now — ${from}</p>
    <div class="kdb-tiles">${tile(`${year} in all`, fcQty(yearTot), `${totals.filter(Boolean).length} months`)}
      ${cmpYear !== null ? tile('Against the version before', pct(yearTot, cmpYear) || '—', `${fcQty(cmpYear)} in ${esc(cmpInfo)}`) : ''}
      ${biggest ? tile('Biggest customer', esc(biggest[0]), `${fcQty(biggest[1])} · ${Math.round((biggest[1] / (yearTot || 1)) * 100)}% of the year`) : ''}
      ${tile('Busiest month', FC_MON[totals.indexOf(Math.max(...totals))], fcQty(Math.max(...totals)))}</div>
    <div class="fc-legend small">${series.map((x) => `<span><i class="fc-sw fc-s${x.n}"></i>${esc(x.label)}</span>`).join('')}${cmpTot ? `<span><i class="fc-sw fc-cmp"></i>${esc(cmpInfo)}</span>` : ''}</div>
    <div id="fc-cust"></div>
    <div id="fc-chart"></div>${table}`;
  FC_LAST = { series, byM, totals, cmpTot, year, cmpInfo };
  fcDraw();
  // 🔎 a customer: typing narrows the table (and opens it); a customer picked shows its own volumes
  const find = $('#fc-find', box);
  const narrow = () => { const q = find.value.trim().toLowerCase(); const t = $('.fc-table', box); if (!t) return;
    $$('tbody tr:not(.fc-total)', t).forEach((tr) => { tr.hidden = !!q && !tr.cells[0].textContent.toLowerCase().includes(q); });
    if (q) t.closest('details').open = true; };
  const pick = () => { const q = find.value.trim(); const c = ranked.find((x) => x.toLowerCase() === q.toLowerCase()) || null; store.set('fcCust', c || ''); fcCustPanel(c, { rows, year, cmpRows, cmpInfo, labels: v.kinds, totalsByYear: (y) => rows.filter((r) => r.year === y).reduce((a, r) => a + r.qty, 0) }); };
  find.addEventListener('input', () => { narrow(); pick(); });
  narrow(); pick();
  $$('[data-fc-year]', box).forEach((b) => b.addEventListener('click', () => { store.set('fcYear', Number(b.dataset.fcYear)); fcViz(kind, d0); }));
  $('#fc-cmp', box)?.addEventListener('change', (e) => { store.set(`fcCompare_${kind}`, e.target.value); fcViz(kind, d0); });
}
// one customer's forecast: month by month for each year in the forecast, its share of the year, the change against
// the version compared, and — when it's set up on Capacity planning — its cards by technology (its split there)
let fcSplits = null;
async function fcCustPanel(c, { rows, year, cmpRows, cmpInfo, labels = {}, totalsByYear }) {
  const el = $('#fc-cust'); if (!el) return;
  if (!c) { el.innerHTML = ''; return; }
  const mine = rows.filter((r) => r.cust === c); const years = [...new Set(mine.map((r) => r.year))].sort();
  const m = (y, k) => mine.filter((r) => r.year === y && r.month === k).reduce((a, r) => a + r.qty, 0);
  const yt = (y) => mine.filter((r) => r.year === y).reduce((a, r) => a + r.qty, 0);
  const cm = (k) => (cmpRows ? cmpRows.filter((r) => r.cust === c && r.month === k).reduce((a, r) => a + r.qty, 0) : null);
  const cy = cmpRows ? cmpRows.filter((r) => r.cust === c).reduce((a, r) => a + r.qty, 0) : null;
  const pct = (a, b) => (b ? `${a >= b ? '+' : '−'}${Math.abs(((a - b) / b) * 100).toFixed(1)}%` : '');
  const kinds = [...new Set(mine.map((r) => r.kind))];
  // its technology split (Capacity planning › Customers), if it can be seen and the customer is set up there
  if (fcSplits === null) { try { const r = await api.get('/cpm/customers'); fcSplits = r.customers || []; } catch { fcSplits = []; } }
  if (!$('#fc-cust') || store.get('fcCust', '') !== c) return;
  const cu = fcSplits.find((x) => x.name === c || x.trigram === c);
  const split = cu ? (cu.split && Object.keys(cu.split).length ? { from: 'set on Capacity planning', s: cu.split } : cu.learned && Object.keys(cu.learned).length ? { from: 'learned from what ran', s: cu.learned } : null) : null;
  const sTot = split ? Object.values(split.s).reduce((a, b) => a + (Number(b) || 0), 0) : 0;
  const techs = split && sTot ? Object.entries(split.s).filter(([, v]) => Number(v) > 0).map(([t, v]) => [t, Number(v) / sTot]) : [];
  const yr = years.includes(year) ? year : years[years.length - 1];
  const max = Math.max(1, ...FC_MON.map((_, i) => Math.max(m(yr, i + 1), cm(i + 1) || 0)));
  const bars = `<div class="fc-cbars">${FC_MON.map((mn, i) => { const v = m(yr, i + 1); const w = cm(i + 1);
    return `<div class="fc-cbar" title="${esc(`${mn} ${yr}: ${fcN(v)}${w !== null ? ` — ${cmpInfo}: ${fcN(w)}` : ''}`)}"><div class="fc-cbar-v">${v ? fcQty(v) : ''}</div><div class="fc-cbar-t"><i style="height:${(v / max) * 100}%"></i>${w !== null && w ? `<b style="bottom:${(w / max) * 100}%"></b>` : ''}</div><div class="fc-cbar-m">${mn}</div></div>`; }).join('')}</div>`;
  el.innerHTML = `<div class="card fc-cust"><div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap"><h3 style="margin:0">${esc(c)}</h3><span class="small muted">${kinds.map((k) => esc(labels[k] || k)).join(' · ')}${cu ? ` · ${esc(cu.trigram)} on Capacity planning` : ''}</span><div class="spacer"></div><button type="button" class="link small" id="fc-cust-x">Clear</button></div>
    <div class="kdb-tiles">${years.map((y) => `<div class="kdb-tile"><div class="kdb-tile-l">${y}</div><div class="kdb-tile-v">${fcQty(yt(y))}</div><div class="kdb-tile-s">${totalsByYear(y) ? `${((yt(y) / totalsByYear(y)) * 100).toFixed(1)}% of the forecast` : ''}</div></div>`).join('')}
      ${cy !== null ? `<div class="kdb-tile"><div class="kdb-tile-l">Against the version before</div><div class="kdb-tile-v">${pct(yt(year), cy) || (cy ? '' : 'new')}</div><div class="kdb-tile-s">${fcQty(cy)} in ${esc(cmpInfo)}</div></div>` : ''}</div>
    <div class="small muted" style="margin:6px 0 2px">${yr}, month by month${cmpRows ? ' — the line: the version compared' : ''}</div>${bars}
    <div class="kdb-scroll"><table class="log small fc-table"><thead><tr><th></th>${FC_MON.map((x) => `<th class="num">${x}</th>`).join('')}<th class="num">Year</th></tr></thead><tbody>
      ${years.map((y) => `<tr><th>${y}</th>${FC_MON.map((_, i) => { const v = m(y, i + 1); return `<td class="num">${v ? fcN(v) : ''}</td>`; }).join('')}<td class="num"><b>${fcN(yt(y))}</b></td></tr>`).join('')}
      ${cmpRows ? `<tr class="muted"><th title="${esc(cmpInfo)}">${year} before</th>${FC_MON.map((_, i) => { const w = cm(i + 1); return `<td class="num">${w ? fcN(w) : ''}</td>`; }).join('')}<td class="num">${fcN(cy)}</td></tr>
        <tr><th>Change</th>${FC_MON.map((_, i) => { const v = m(year, i + 1); const w = cm(i + 1); const dlt = v - w; return `<td class="num ${dlt > 0.5 ? 'pl-ok' : dlt < -0.5 ? 'pl-late' : 'muted'}">${Math.abs(dlt) > 0.5 ? `${dlt > 0 ? '+' : '−'}${fcN(Math.abs(dlt))}` : ''}</td>`; }).join('')}<td class="num"><b>${pct(yt(year), cy)}</b></td></tr>` : ''}
      ${techs.map(([t, sh]) => `<tr class="fc-tech"><th title="${esc(`${Math.round(sh * 100)}% — the split ${split.from}`)}">${yr} ${esc(t)} <span class="muted">${Math.round(sh * 100)}%</span></th>${FC_MON.map((_, i) => { const v = m(yr, i + 1) * sh; return `<td class="num muted">${v ? fcN(v) : ''}</td>`; }).join('')}<td class="num muted">${fcN(yt(yr) * sh)}</td></tr>`).join('')}
    </tbody></table></div>${techs.length ? `<p class="small muted" style="margin:4px 0 0">By technology: the forecast × its split ${esc(split.from)}.</p>` : ''}</div>`;
  $('#fc-cust-x').onclick = () => { const f = $('#fc-find'); if (f) { f.value = ''; f.dispatchEvent(new Event('input')); } };
}
function fcDraw() {
  const el = $('#fc-chart'); if (!el || !FC_LAST) return;
  const { series, byM, totals, cmpTot, year, cmpInfo } = FC_LAST;
  const W = Math.max(320, el.clientWidth); const H = Math.max(220, Math.min(340, Math.round(W * 0.32)));
  const L = 52; const B = 26; const T = 22; const R = 6;
  const max = Math.max(1, ...totals, ...(cmpTot || []));
  const ax = qxAxis(max, { ticks: 5 });
  const y = (val) => T + (H - T - B) * (1 - val / ax.max);
  const cw = (W - L - R) / 12; const bw = Math.min(46, cw * 0.62);
  const clip = `fcc${Math.random().toString(36).slice(2, 7)}`;
  const grid = []; for (let g = 0; g <= ax.max + 1e-9; g += ax.step) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" class="q-grid${g ? '' : ' base'}"/><text x="${L - 6}" y="${y(g) + 4}" class="q-ax" text-anchor="end">${g ? fcQty(g) : 0}</text>`);
  const cols = byM.map((m, i) => {
    const x = L + i * cw + (cw - bw) / 2; const total = totals[i];
    let acc = 0; const parts = series.filter((s) => m.get(s.key));
    const segs = parts.map((s, j) => {
      const val = m.get(s.key); const y1 = y(acc + val); const y0 = y(acc); acc += val;
      const gap = j < parts.length - 1 ? 2 : 0;
      return `<rect x="${x}" y="${y1 + gap}" width="${bw}" height="${Math.max(0, y0 - y1 - gap)}" class="fc-s${s.n}"/>`;
    }).join('');
    const c = cmpTot?.[i];
    const tip = `${FC_MON[i]} ${year}: ${fcN(total)}${parts.length ? `\n${parts.map((s) => `${s.label}: ${fcN(m.get(s.key))}`).join('\n')}` : ''}${c !== undefined && c !== null ? `\n— ${cmpInfo}: ${fcN(c)}${c ? ` (${total >= c ? '+' : '−'}${Math.abs(((total - c) / c) * 100).toFixed(1)}%)` : ''}` : ''}`;
    const labelY = Math.min(y(total), c ? y(c) : Infinity) - 6;
    return `<g class="q-col"><title>${esc(tip)}</title>
      <rect x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" class="q-hit"/>
      ${total ? `<clipPath id="${clip}${i}"><rect x="${x}" y="${y(total)}" width="${bw}" height="${Math.max(0, y(0) - y(total))}" rx="4"/></clipPath><g clip-path="url(#${clip}${i})">${segs}</g>` : ''}
      ${c ? `<line x1="${x - 4}" x2="${x + bw + 4}" y1="${y(c)}" y2="${y(c)}" class="fc-cmp-line"/>` : ''}
      ${total && cw > 34 ? `<text x="${x + bw / 2}" y="${labelY}" class="q-val" text-anchor="middle">${fcQty(total)}</text>` : ''}
      <text x="${x + bw / 2}" y="${H - 8}" class="q-ax" text-anchor="middle">${FC_MON[i]}</text></g>`;
  }).join('');
  el.innerHTML = `<svg class="q-chart fc-chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="The ${year} forecast month by month, by customer">${grid.join('')}${cols}</svg>`;
}
window.addEventListener('resize', () => { clearTimeout(fcDraw.t); fcDraw.t = setTimeout(fcDraw, 150); });
