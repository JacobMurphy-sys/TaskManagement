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
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 Reporting</h1>${KPI_PICK_SLOT}${kpiTabsHtml('vault')}<div class="spacer"></div></div>
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
