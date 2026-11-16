// 🗄 Reporting › Vault: Reporting's source reports kept month by month (src/vault.js), so last year's figures outlive
// files that start again on 1 January. A grid of the sources by month: sealed, reopened, still open (sealed on the
// 5th of the next month), the month in progress. Click a month for what was kept: when, how, by whom, its rows and the
// file as it was; an admin (the setup right) seals a month by hand, reopens one, or seals it again.

const VAULT_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const vaultQty = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

async function renderKpiVault(pick) {
  const year = Number(store.get('vaultYear', 0)) || new Date().getFullYear();
  const d = await api.get(`/vault?year=${year}`);
  const now = new Date().toISOString().slice(0, 7);
  const at = new Map(d.periods.map((p) => [`${p.source}|${p.period}`, p]));
  const sealDay = (p) => { const [y, m] = p.split('-').map(Number); const n = m === 12 ? [y + 1, 1] : [y, m + 1]; return new Date(n[0], n[1] - 1, d.seal_after_day); };
  const cell = (src, i) => {
    const p = `${year}-${String(i + 1).padStart(2, '0')}`; const v = at.get(`${src}|${p}`); const live = d.live[src]?.[p];
    const sel = pick === `${src}|${p}` ? ' on' : '';
    if (!d.sources[src].vaulted) return `<td class="vt-cell muted small">${live ? 'as entered' : ''}</td>`;
    if (v?.status === 'sealed') return `<td class="vt-cell vt-sealed${v.diff ? ' vt-diff' : ''}${sel}" data-vt="${src}|${p}" title="Sealed ${esc(fmtDateTime(v.sealed_at))} (${esc(v.how)})${v.diff ? ' — the file now says something else for this month: click to see' : ''}">🔒 ${v.rows.toLocaleString('en-GB')}${v.diff ? ' <b>⚠</b>' : ''}</td>`;
    if (v?.status === 'reopened') return `<td class="vt-cell vt-reopened${sel}" data-vt="${src}|${p}" title="Reopened by ${esc(v.reopened_by || '?')}: the file's figures are used until it's sealed again">↺ open</td>`;
    if (p === now) return `<td class="vt-cell muted small" title="This month: sealed after it's over">${live ? `${live.rows.toLocaleString('en-GB')} · now` : ''}</td>`;
    if (p > now) return '<td class="vt-cell"></td>';
    if (!live) return '<td class="vt-cell muted small" title="Nothing for this month">—</td>';
    return `<td class="vt-cell vt-open${sel}" data-vt="${src}|${p}" title="Not sealed yet: ${sealDay(p) <= new Date() ? 'due, sealed at the next hourly check' : `sealed automatically from ${esc(fmtDate(sealDay(p).toISOString()))}`}">○ ${live.rows.toLocaleString('en-GB')}</td>`;
  };
  const sealedN = d.periods.filter((p) => p.status === 'sealed').length;
  const diffs = d.periods.filter((p) => p.status === 'sealed' && p.diff);
  // the month clicked
  let detail = '';
  if (pick) {
    const [src, p] = pick.split('|'); const v = at.get(pick); const live = d.live[src]?.[p];
    const [y, m] = p.split('-').map(Number); const label = `${d.sources[src]?.label || src} · ${VAULT_MON[m - 1]} ${y}`;
    detail = `<div class="card vt-detail"><div class="row"><h3 style="margin:0">${esc(label)}</h3><div class="spacer"></div><button type="button" class="icon" data-vt-close title="Close">✕</button></div>
      ${v ? `<p class="small">${v.status === 'sealed' ? '🔒 <b>Sealed</b>' : '↺ <b>Reopened</b>'} — sealed ${esc(fmtDateTime(v.sealed_at))}, ${esc(v.how)}${v.sealed_by ? ` by ${esc(v.sealed_by)}` : ''}.
          ${v.status === 'reopened' ? `Reopened ${esc(fmtDateTime(v.reopened_at))} by ${esc(v.reopened_by || '?')}: the file's figures are used for this month until it's sealed again.` : 'Reports read these figures for this month, whatever the file says now.'}</p>
        <div class="kdb-tiles">${[['Rows', v.rows.toLocaleString('en-GB')], ['Quantity', vaultQty(v.qty)], ...(v.scrap ? [['Scrap', vaultQty(v.scrap)]] : []), ['File kept', v.file_id ? esc(v.file_name) : '—', v.file_modified ? `saved ${esc(fmtDateTime(v.file_modified))}` : v.file_id ? '' : v.how.startsWith('kept') ? 'the file had moved on' : 'too big, or not found']]
    .map(([l, val, sub]) => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v" style="font-size:1rem">${val}</div>${sub ? `<div class="kdb-tile-s">${sub}</div>` : ''}</div>`).join('')}</div>
        ${v.diff ? `<div class="notice small">⚠ The file read ${esc(fmtDateTime(v.diff.at))} says <b>${v.diff.rows.toLocaleString('en-GB')} rows · ${vaultQty(v.diff.qty)}</b> for this month, against <b>${v.rows.toLocaleString('en-GB')} · ${vaultQty(v.qty)}</b> sealed. The sealed figures are kept${d.can_edit ? ': reopen the month to take the file\'s, then seal it again' : ''}.</div>` : ''}
        <div class="row" style="margin-top:8px"><a class="button" href="/api/vault/${v.id}/rows.csv" download>⬇ Rows (CSV)</a>${v.file_id ? `<a class="button" href="/api/vault/files/${v.file_id}" download>⬇ ${esc(v.file_name)}</a>` : ''}
          ${d.can_edit ? (v.status === 'sealed' ? `<button type="button" data-vt-reopen="${v.id}" title="The next read of the file is used for this month, until it's sealed again">↺ Reopen</button>` : `<button type="button" class="primary" data-vt-reseal="${v.id}">🔒 Seal again</button>`) : ''}</div>`
    : `<p class="small">○ <b>Not sealed yet.</b> ${live ? `${live.rows.toLocaleString('en-GB')} rows from the file now.` : ''} ${sealDay(p) <= new Date() ? 'It\'s due: sealed at the next hourly check (the file read once more first)' : `It's sealed automatically from ${esc(fmtDate(sealDay(p).toISOString()))}`}, or kept the moment the file stops covering it.</p>
        ${d.can_edit ? `<button type="button" class="primary" data-vt-seal="${esc(pick)}">🔒 Seal it now</button>` : ''}`}</div>`;
  }
  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 Reporting</h1>${KPI_PICK_SLOT}${kpiTabsHtml('vault')}<div class="spacer"></div>
      ${d.can_edit ? '<button type="button" class="primary" data-vt-upload title="Old reports (last year\'s exports…) into the vault, month by month">⬆ Upload old reports</button>' : ''}</div>
    <div class="card">
      <div class="row"><h2 style="margin:0">🗄 Report vault</h2><div class="spacer"></div>
        <span class="seg">${[...new Set([...d.years, year])].sort().map((y) => `<button type="button" data-vt-year="${y}" class="${y === year ? 'on' : ''}">${y}</button>`).join('')}</span></div>
      <p class="small muted">The source reports cover 1 January to today, so on 1 January they start again. The vault keeps a copy of each month once it's over, so last year's figures stay in every report: each month is <b>sealed</b> on the ${d.seal_after_day}th of the next (the file read once more first), with the rows SITHUB read and the file itself. A month the file stops covering before then is kept there and then. Reports read the sealed figures for sealed months, whatever the file says later; a difference is flagged here.</p>
      <div class="kdb-tiles">
        <div class="kdb-tile"><div class="kdb-tile-l">${year}: months sealed</div><div class="kdb-tile-v">${sealedN}</div><div class="kdb-tile-s">across ${Object.values(d.sources).filter((s) => s.vaulted).length} sources</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">Differences</div><div class="kdb-tile-v">${diffs.length}</div><div class="kdb-tile-s">${diffs.length ? 'the file says otherwise for a sealed month' : 'files agree with what was sealed'}</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">Files kept</div><div class="kdb-tile-v">${d.files.n}</div><div class="kdb-tile-s">${(d.files.bytes / 1048576).toFixed(1)} MB, compressed</div></div></div>
      <div class="kdb-scroll"><table class="log vt-grid"><thead><tr><th>Source</th>${VAULT_MON.map((mm) => `<th class="vt-cell">${mm}</th>`).join('')}</tr></thead>
        <tbody>${Object.entries(d.sources).map(([k, s]) => `<tr><td class="nowrap"><b>${esc(s.label)}</b>${s.vaulted ? '' : '<div class="small muted">typed into SITHUB: kept as entered</div>'}</td>${VAULT_MON.map((_, i) => cell(k, i)).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="small muted vt-key"><span>🔒 sealed (rows)</span><span>⚠ the file differs</span><span>○ not sealed yet</span><span>↺ reopened</span></div>
    </div>
    ${detail}`;
  $$('[data-vt-year]').forEach((b) => b.addEventListener('click', () => { store.set('vaultYear', Number(b.dataset.vtYear)); renderKpiVault(); }));
  $('[data-vt-upload]')?.addEventListener('click', () => vaultUploadDialog(d));
  $$('[data-vt]').forEach((c) => c.addEventListener('click', () => renderKpiVault(c.dataset.vt === pick ? null : c.dataset.vt)));
  $('[data-vt-close]')?.addEventListener('click', () => renderKpiVault());
  const act = async (fn, msg) => { try { await fn(); toast(msg); } catch (err) { toast(err.message, 'error'); } renderKpiVault(pick); };
  $('[data-vt-seal]')?.addEventListener('click', (e) => { const [source, period] = e.target.dataset.vtSeal.split('|'); e.target.disabled = true; e.target.textContent = 'Reading the file, then sealing…'; act(() => api.post('/vault/seal', { source, period }), 'Sealed'); });
  $('[data-vt-reseal]')?.addEventListener('click', (e) => { e.target.disabled = true; act(() => api.post(`/vault/${e.target.dataset.vtReseal}/seal`), 'Sealed again from the file'); });
  $('[data-vt-reopen]')?.addEventListener('click', (e) => {
    if (!confirm('Reopen this month? Reports will use what the file says for it from the next read, until it\'s sealed again.')) return;
    act(() => api.post(`/vault/${e.target.dataset.vtReopen}/reopen`), 'Reopened');
  });
}

// ⬆ Old reports into the vault: pick the source and its file; SITHUB reads it as it reads the source every day and
// shows, month by month, what it would keep; then it's sealed (the file kept with it) and in every report.
function vaultUploadDialog(d) {
  const last = new Date().getFullYear() - 1;
  const ACT = { seal: ['🔒 kept', ''], replace: ['🔒 kept (replaces what was sealed)', 'vt-up-replace'], 'skip-sealed': ['already sealed: left as it is', 'muted'], 'skip-current': ['this month: not over yet', 'muted'] };
  openModal(`<div class="modal-head"><h2 style="margin:0">⬆ Old reports into the vault</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted">An old export of a source (last year's, or one from before SITHUB kept them), read exactly as SITHUB reads that source every day. Each month in it is sealed into the vault with the file, and appears in every report (the Database, Operations, Quality, EHS…). Check it first: you'll see what each month holds before anything is kept.</p>
    <div class="cd-grid">
      <label class="cd-f"><span>Which report</span><select id="vu-src">${Object.entries(d.sources).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join('')}</select></label>
      <label class="cd-f"><span>The file</span><input type="file" id="vu-file" accept=".xlsx,.xlsm,.xls"></label>
      <label class="cd-f" id="vu-year-l" hidden><span>Year of its weeks <span class="small muted">(OTD weeks typed without a year)</span></span><input type="number" id="vu-year" value="${last}" min="2000" max="2100"></label>
    </div>
    <label class="row small" style="margin-top:8px"><input type="checkbox" id="vu-replace"> Replace months already sealed with this file's figures</label>
    <div id="vu-out" style="margin-top:10px"></div>
    <div class="row" style="margin-top:10px"><span class="spacer"></span><button type="button" data-action="close-modal">Cancel</button>
      <button type="button" id="vu-check">Check the file</button><button type="button" class="primary" id="vu-go" disabled>Keep in the vault</button></div>`, { wide: true });
  const src = $('#vu-src'); const showYear = () => { $('#vu-year-l').hidden = src.value !== 'otd'; };
  src.addEventListener('change', () => { showYear(); $('#vu-go').disabled = true; $('#vu-out').innerHTML = ''; }); showYear();
  $('#vu-file').addEventListener('change', () => { $('#vu-go').disabled = true; $('#vu-out').innerHTML = ''; });
  $('#vu-replace').addEventListener('change', () => { if (!$('#vu-go').disabled) send(true); });
  const send = async (dry) => {
    const f = $('#vu-file').files[0]; if (!f) { toast('Choose the file first', 'error'); return; }
    const btn = dry ? $('#vu-check') : $('#vu-go'); const was = btn.textContent; btn.disabled = true; btn.textContent = dry ? 'Reading…' : 'Keeping…';
    const qs = new URLSearchParams({ source: src.value, ...(dry ? { dry: '1' } : {}), ...($('#vu-replace').checked ? { replace: '1' } : {}), ...(src.value === 'otd' ? { year: $('#vu-year').value } : {}) });
    try {
      const r = await fetch(`/api/vault/upload?${qs}`, { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name), 'X-File-Modified': new Date(f.lastModified).toISOString() } });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText);
      const n = j.months.filter((m) => m.action === 'seal' || m.action === 'replace').length;
      if (!dry) { closeModal(); toast(`${n} month${n === 1 ? '' : 's'} of ${d.sources[j.source].label} kept in the vault`); store.set('vaultYear', Number(j.months.find((m) => m.action === 'seal' || m.action === 'replace')?.period.slice(0, 4)) || new Date().getFullYear()); renderKpiVault(); return; }
      $('#vu-out').innerHTML = `<p class="small"><b>${esc(j.file)}</b>: ${j.rows_read.toLocaleString('en-GB')} rows read${j.skipped ? `, ${j.skipped.toLocaleString('en-GB')} without a date (left out)` : ''}. ${n ? `<b>${n} month${n === 1 ? '' : 's'}</b> would be kept:` : 'Nothing new to keep.'}</p>
        <div class="kdb-scroll" style="max-height:300px"><table class="log small"><thead><tr><th>Month</th><th class="num">Rows</th><th class="num">Quantity</th><th></th></tr></thead><tbody>
        ${j.months.map((m) => { const [y, mo] = m.period.split('-').map(Number); const [t, cls] = ACT[m.action]; const clash = m.action === 'seal' && m.now_rows && Math.abs(m.now_qty - m.qty) > 1e-6;
          return `<tr class="${cls}"><td>${VAULT_MON[mo - 1]} ${y}</td><td class="num">${m.rows.toLocaleString('en-GB')}</td><td class="num">${vaultQty(m.qty)}</td><td>${t}${clash ? `<div class="small pl-late">The current file says ${vaultQty(m.now_qty)} (${m.now_rows.toLocaleString('en-GB')} rows): this file's figures will be used, and the difference flagged</div>` : m.action === 'seal' && m.now_rows ? '<div class="small muted">the same as the current file</div>' : ''}</td></tr>`; }).join('')}</tbody></table></div>`;
      $('#vu-go').disabled = !n;
    } catch (err) { $('#vu-out').innerHTML = `<div class="notice small">⚠ ${esc(err.message)}</div>`; $('#vu-go').disabled = true; }
    btn.textContent = was; if (dry) btn.disabled = false;
  };
  $('#vu-check').addEventListener('click', () => send(true));
  $('#vu-go').addEventListener('click', () => send(false));
}
