// 📈 Forecast (the Forecast module): the customer forecasts sent in — through the upload link (no account needed) or
// from here — who sent which and when, what each held month by month, and which one 📐 Capacity planning reads.
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
    return `<div class="kdb-tile fc-tile"><div class="kdb-tile-l">${esc(d.kinds[k])}</div>
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
    <div class="kanban-tools"><h1 style="margin:0">📈 Forecast</h1>
      <div class="seg">${[['', 'All'], ...Object.entries(d.kinds)].map(([k, l]) => `<button type="button" data-fc-kind="${k}" class="${kind === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>
      <div class="spacer"></div>
      <label class="button primary" title="Upload a BeNeLux or Amex forecast workbook">⬆ Upload a forecast<input type="file" id="fc-file" accept=".xlsx,.xlsm" hidden></label></div>
    <p class="small muted">The customer forecasts sent in, newest first. The newest of each kind goes into 📐 Capacity planning straight away (unless the file linked in Reporting › Sources is newer).</p>
    <div class="kdb-tiles">${Object.keys(d.kinds).map(cap).join('')}</div>
    <div class="card">
      <div class="row"><h2 style="margin:0">🔗 Upload link</h2><span class="small ${d.link.on ? '' : 'muted'}">${d.link.on ? '● on' : '○ off'}</span><div class="spacer"></div>
        ${d.link.can_edit ? `<button type="button" data-fc-link="${d.link.on ? 'off' : 'on'}">${d.link.on ? 'Switch off' : 'Switch on'}</button>${d.link.on ? '<button type="button" data-fc-renew title="Make a new link: the old one stops working">↻ New link</button>' : ''}` : ''}</div>
      <p class="small muted">For the people who send forecasts but have no SITHUB account: the link opens a page that only sends a forecast (they give their name) and shows what was sent from that browser before. Nothing else of SITHUB. Anyone with the link can send one, so share it only with them; make a new link if it goes further.</p>
      ${d.link.on && url ? `<div class="row"><input type="text" readonly value="${esc(url)}" id="fc-url" style="flex:1;min-width:0"><button type="button" class="primary" data-fc-copy>📋 Copy</button><a class="button" href="${esc(d.link.path)}" target="_blank" rel="noopener">Open ↗</a></div>${/^(localhost|127\.|\[?::1)/.test(location.hostname) ? '<div class="small pl-late" style="margin-top:6px">⚠ This link uses this PC\'s own address, so it only works here. Copy it from another PC (opening SITHUB by the server\'s name) to share it.</div>' : ''}`
    : `<div class="empty small">${d.link.can_edit ? 'Switch the link on to get it.' : 'The link is off: an admin switches it on.'}</div>`}
    </div>
    <div class="card"><h2>Sent in <span class="small muted">${list.length}</span></h2>
      ${list.length ? `<div class="kdb-scroll"><table class="log"><thead><tr><th>When</th><th>From</th><th>Forecast</th><th>Months · total</th><th>File</th><th>Note</th><th></th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`
    : '<div class="empty">No forecasts sent in yet.</div>'}</div>`;
  $$('[data-fc-kind]').forEach((b) => b.addEventListener('click', () => { store.set('fcKind', b.dataset.fcKind); renderForecast(); }));
  $('#fc-file')?.addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const r = await fetch('/api/forecasts/upload', { method: 'POST', body: f, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name) } });
      const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText);
      toast(`${j.kind_label} received (${j.rows} rows) — Capacity planning has it`);
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
