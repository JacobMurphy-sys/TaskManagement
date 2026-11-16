// 🗂 The card database (Production, the Prod Management module): adding cards to the Access database from SITHUB, for
// people without Access or an inventory management account (src/cardwrite.js). Cards the open work orders or the
// production reports name that the database hasn't got are listed, started with what the reports know (customer, item
// name); the rest is typed in. The form is the table's own columns, required ones marked, with the values already
// used offered as you type.

const cdN = (v) => Math.round(v || 0).toLocaleString('en-GB');

async function renderCards() {
  const d = await api.get('/plan/cards');
  const ok = d.status === 'ok' && d.writable && d.schema;
  const why = !d.file ? 'No card database is set: Production › ⚙ Setup › Sources.'
    : d.status !== 'ok' ? `The card database can't be read: ${esc(d.error || d.status)}`
      : !d.writable ? 'The card database is set to an Excel file. SITHUB can add cards to an Access database (.accdb / .mdb) only.'
        : d.reading ? 'The card database is still being read (a minute or so for a big one): refresh in a moment.' : '';
  const miss = d.missing || [];
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">🗂 Card database</h1><div class="spacer"></div>
      ${ok ? '<button type="button" class="primary" data-cd-new>＋ New card</button>' : ''}
      <button type="button" data-cd-test title="Checks the server can write to the database (changes nothing)">🔌 Test writing</button></div>
    <p class="small muted">${d.file ? `<b>${esc(d.name)}</b> · table ${esc(d.schema?.table || d.table)} · ${cdN(d.count)} cards. ` : ''}Add a card here and SITHUB writes it into the Access database itself, so Production and the Power BI reports reading it have it: no Access or inventory management account needed. A copy of the database is kept before writing.</p>
    ${why ? `<div class="notice">${why}</div>` : ''}
    <div id="cd-test"></div>
    <div class="card"><h2>To add <span class="small muted">${miss.length}</span></h2>
      <p class="small muted">Cards (AX Ref) on open work orders or produced in the last year that the card database hasn't got: Production can't tell their kind, so no speed rule reaches them. The customer and item name come from the production reports; the rest is filled in on the form.</p>
      ${miss.length ? `<div class="kdb-scroll"><table class="log"><thead><tr><th>AX Ref</th><th>Item name</th><th>Customer</th><th class="num">Open</th><th>Work orders</th><th class="num">Produced</th><th></th></tr></thead><tbody>
        ${miss.map((m, i) => `<tr><td><b><a href="#" data-pf-open-item="${esc(m.ax)}">${esc(m.ax)}</a></b></td><td>${esc(m.item_name || '')}</td><td>${esc(m.customer || m.trigram || '')}</td>
          <td class="num">${m.open_qty ? cdN(m.open_qty) : ''}</td><td class="small">${m.wo_count ? `${esc(m.wos.slice(0, 3).join(', '))}${m.wo_count > 3 ? ` +${m.wo_count - 3}` : ''}` : ''}</td>
          <td class="num">${m.produced ? `${cdN(m.produced)}<div class="small muted">${esc(fmtDate(m.last_run))}</div>` : ''}</td>
          <td>${ok ? `<button type="button" class="small primary" data-cd-add="${i}">＋ Add</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty small">${d.status === 'ok' ? 'Every card on the open work orders and in the production reports is in the card database.' : 'Shown once the card database can be read.'}</div>`}</div>
    <div class="card"><h2>Added from SITHUB <span class="small muted">the last ${d.additions.length}</span></h2>
      ${d.additions.length ? `<table class="log small"><thead><tr><th>When</th><th>AX Ref</th><th>Item name</th><th>By</th></tr></thead><tbody>${d.additions.map((a) => `<tr><td>${esc(fmtDateTime(a.created_at))}</td><td><b>${esc(a.ax_ref)}</b></td><td>${esc(a.item_name || '')}</td><td>${esc(a.by_name || '')}</td></tr>`).join('')}</tbody></table>`
    : '<div class="empty small">None yet.</div>'}</div>`;
  $('[data-cd-new]')?.addEventListener('click', () => cardForm(d, {}));
  $$('[data-cd-add]').forEach((b) => b.addEventListener('click', () => { const m = miss[Number(b.dataset.cdAdd)]; cardForm(d, m); }));
  $('[data-cd-test]').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Testing…';
    const box = $('#cd-test');
    try {
      const r = await api.post('/plan/cards/test');
      box.innerHTML = `<div class="notice small">✅ The server can write to the card database (${esc(r.provider || '')}, ${r.bits || '?'}-bit; ${cdN(r.rows)} rows). Nothing was changed.</div>`;
    } catch (err) {
      box.innerHTML = `<div class="notice small" style="border-color:var(--danger)">⚠ ${esc(err.message)}${/Access Database Engine/.test(err.message) ? ` <a href="${esc(d.engine_url)}" target="_blank" rel="noopener">Microsoft's download page ↗</a>` : ''}</div>`;
    }
    e.target.disabled = false; e.target.textContent = '🔌 Test writing';
  });
  $$('[data-pf-open-item]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); if (typeof pfOpen === 'function') pfOpen('item', a.dataset.pfOpenItem); }));
}

// the form: the table's columns; m: a card to add (ax, item_name, customer, trigram), or {} for a new one
function cardForm(d, m) {
  const S = d.schema; const P = d.prefill || {};
  const start = { [P.key]: m.ax, [P.name]: m.item_name, [P.customer]: m.customer, [P.trigram]: m.trigram };
  const from = new Set(Object.entries(start).filter(([k, v]) => k && k !== 'undefined' && v).map(([k]) => k));
  const cols = S.columns.filter((c) => c.writable);
  // the key and what the reports fill first, then required columns, then the rest as the table has them
  const rank = (c) => (c.name === P.key ? 0 : from.has(c.name) ? 1 : c.required ? 2 : 3);
  const ordered = [...cols].sort((a, b) => rank(a) - rank(b));
  const field = (c, i) => {
    const v = start[c.name] ?? ''; const need = c.required || c.name === P.key;
    const id = `cdf-${i}`; const sug = S.suggestions[c.name];
    const input = c.kind === 'boolean' ? `<input type="checkbox" id="${id}" data-cd-col="${esc(c.name)}" ${v ? 'checked' : ''}>`
      : c.kind === 'memo' ? `<textarea id="${id}" data-cd-col="${esc(c.name)}" rows="2">${esc(v)}</textarea>`
        : `<input id="${id}" data-cd-col="${esc(c.name)}" type="${c.kind === 'date' ? 'date' : c.kind === 'integer' || c.kind === 'number' ? 'number' : 'text'}" ${c.kind === 'number' ? 'step="any"' : ''} ${c.kind === 'text' ? `maxlength="${Math.max(1, Math.floor((c.size || 510) / 2))}"` : ''} value="${esc(v)}" ${sug ? `list="${id}-l"` : ''} ${need ? 'required' : ''} autocomplete="off">${sug ? `<datalist id="${id}-l">${sug.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}`;
    return `<label class="cd-f${c.name === P.key ? ' cd-key' : ''}"><span>${esc(c.name)}${need ? ' <b class="pl-late" title="Needed">*</b>' : ''}${from.has(c.name) ? ' <span class="small muted" title="From the production report or the work order">· from the reports</span>' : ''}</span>${input}</label>`;
  };
  const skipped = S.columns.filter((c) => !c.writable);
  openModal(`<div class="modal-head"><h2 style="margin:0">🗂 ${m.ax ? `Add ${esc(m.ax)}` : 'New card'} <span class="small muted">to ${esc(d.name)} · ${esc(S.table)}</span></h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted">The ${esc(S.table)} table's own columns. <b class="pl-late">*</b> needed. As you type, the values already used in the database are offered, so it stays consistent.${skipped.length ? ` Filled in by Access: ${skipped.map((c) => esc(c.name)).join(', ')}.` : ''}</p>
    <form id="cd-form"><div class="cd-grid">${ordered.map(field).join('')}</div>
      <div id="cd-err" class="notice small" hidden></div>
      <div class="row" style="margin-top:10px"><span class="spacer"></span><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary" id="cd-save">Add to the card database</button></div></form>`, { wide: true });
  $('#cd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    $$('[data-cd-col]', $('#cd-form')).forEach((el) => { values[el.dataset.cdCol] = el.type === 'checkbox' ? el.checked : el.value; });
    const btn = $('#cd-save'); btn.disabled = true; btn.textContent = 'Writing to Access…';
    try {
      const r = await api.post('/plan/cards/add', { values });
      closeModal(); toast(`${r.ax_ref} added to the card database`); renderCards();
    } catch (err) { const box = $('#cd-err'); box.hidden = false; box.textContent = err.message; btn.disabled = false; btn.textContent = 'Add to the card database'; }
  });
}
