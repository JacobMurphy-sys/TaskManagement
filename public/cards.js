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
    <p class="small muted">${d.file ? `<b>${esc(d.name)}</b> · table ${esc(d.schema?.table || d.table)} · ${cdN(d.count)} cards. ` : ''}Add a card here and SITHUB writes it into the Access database straight away, so Production and the Power BI reports reading it have it: no Access or inventory management account needed. Whoever has the <b>Review new cards</b> right is told, and checks it or undoes it. A copy of the database is kept before each change.</p>
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
    ${cdReviewHtml(d)}
    ${cdChoicesHtml(d)}`;
  $('[data-cd-new]')?.addEventListener('click', () => cardForm(d, {}));
  cdChoicesWire(d);
  $$('[data-cd-checked]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.post(`/plan/cards/additions/${b.dataset.cdChecked}/checked`); toast('Checked'); } catch (err) { toast(err.message, 'error'); } renderCards();
  }));
  $$('[data-cd-undo]').forEach((b) => b.addEventListener('click', async () => {
    const a = d.additions.find((x) => x.id === Number(b.dataset.cdUndo));
    const reason = prompt(`Undo ${a.ax_ref}? It's taken out of the card database again (a copy is kept first), and ${a.by_name || 'whoever added it'} is told why.\n\nWhy?`); if (!reason?.trim()) return;
    b.disabled = true;
    try { await api.post(`/plan/cards/additions/${a.id}/undo`, { reason }); toast(`${a.ax_ref} taken out of the card database`); } catch (err) { toast(err.message, 'error'); } renderCards();
  }));
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
    const list = cdList(d.choices, c.name);
    if (list && (c.kind === 'text' || c.kind === 'memo')) { // 🔽 one of its fixed answers
      const hit = list.find((x) => x.toLowerCase() === String(v).toLowerCase()) || '';
      return `<label class="cd-f"><span>${esc(c.name)}${need ? ' <b class="pl-late" title="Needed">*</b>' : ''}</span><select id="${id}" data-cd-col="${esc(c.name)}" ${need ? 'required' : ''}>
        <option value="">${need ? 'Choose…' : '—'}</option>${list.map((x) => `<option ${x === hit ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label>`;
    }
    const input = c.kind === 'boolean' ? `<input type="checkbox" id="${id}" data-cd-col="${esc(c.name)}" ${v ? 'checked' : ''}>`
      : c.kind === 'memo' ? `<textarea id="${id}" data-cd-col="${esc(c.name)}" rows="2">${esc(v)}</textarea>`
        : `<input id="${id}" data-cd-col="${esc(c.name)}" type="${c.kind === 'date' ? 'date' : c.kind === 'integer' || c.kind === 'number' ? 'number' : 'text'}" ${c.kind === 'number' ? 'step="any"' : ''} ${c.kind === 'text' ? `maxlength="${Math.max(1, Math.floor((c.size || 510) / 2))}"` : ''} value="${esc(v)}" ${sug ? `list="${id}-l"` : ''} ${need ? 'required' : ''} autocomplete="off">${sug ? `<datalist id="${id}-l">${sug.map((x) => `<option value="${esc(x)}">`).join('')}</datalist>` : ''}`;
    const yesNo = list && c.kind === 'boolean' ? `<span class="small pl-late">A Yes/No column in Access, so it can't hold ${esc(list.join(' / '))}: change it to Short Text in Access to use them</span>` : '';
    return `<label class="cd-f${c.name === P.key ? ' cd-key' : ''}"><span>${esc(c.name)}${need ? ' <b class="pl-late" title="Needed">*</b>' : ''}${from.has(c.name) ? ' <span class="small muted" title="From the production report or the work order">· from the reports</span>' : ''}</span>${input}${yesNo}</label>`;
  };
  const skipped = S.columns.filter((c) => !c.writable);
  const label = 'Add to the card database';
  openModal(`<div class="modal-head"><h2 style="margin:0">🗂 ${m.ax ? `Add ${esc(m.ax)}` : 'New card'} <span class="small muted">to ${esc(d.name)} · ${esc(S.table)}</span></h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted">The ${esc(S.table)} table's own columns. <b class="pl-late">*</b> needed. As you type, the values already used in the database are offered, so it stays consistent. It's live as soon as it's added; whoever reviews new cards is told.${skipped.length ? ` Filled in by Access: ${skipped.map((c) => esc(c.name)).join(', ')}.` : ''}</p>
    <form id="cd-form"><div class="cd-grid">${ordered.map(field).join('')}</div>
      <div id="cd-err" class="notice small" hidden></div>
      <div class="row" style="margin-top:10px"><span class="spacer"></span><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary" id="cd-save">${label}</button></div></form>`, { wide: true });
  $('#cd-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = {};
    $$('[data-cd-col]', $('#cd-form')).forEach((el) => { values[el.dataset.cdCol] = el.type === 'checkbox' ? el.checked : el.value; });
    const btn = $('#cd-save'); btn.disabled = true; btn.textContent = 'Writing to Access…';
    try {
      const r = await api.post('/plan/cards/add', { values });
      closeModal(); toast(`${r.ax_ref} added to the card database`); renderCards();
    } catch (err) { const box = $('#cd-err'); box.hidden = false; box.textContent = err.message; btn.disabled = false; btn.textContent = label; }
  });
}

// ---- 🔎 added from SITHUB: live at once; to check (by someone with "Review new cards"), checked, or undone ----
function cdReviewHtml(d) {
  const adds = d.additions || []; const todo = adds.filter((a) => a.status === 'new'); const rest = adds.filter((a) => a.status !== 'new');
  const vals = (a) => Object.entries(a.fields || {}).filter(([, v]) => v !== null && v !== '' && v !== false).map(([k, v]) => `${k}: ${v === true ? '✓' : v}`).join(' · ');
  const row = (a) => `<tr><td><b>${esc(a.ax_ref)}</b><div class="small muted cd-vals" title="${esc(vals(a))}">${esc(vals(a))}</div></td><td>${esc(a.by_name || '')}<div class="small muted">${esc(fmtDateTime(a.created_at))}</div></td>
    <td class="nowrap">${d.can_review ? `<button type="button" class="small" data-cd-checked="${a.id}" title="It's right: off this list">✓ Checked</button> <button type="button" class="small" data-cd-undo="${a.id}" title="Take it out of the card database again">↩ Undo…</button>` : ''}</td></tr>`;
  const status = (a) => (a.status === 'checked' ? `✓ checked — ${esc(a.checked_by || '')}, ${esc(fmtDateTime(a.checked_at))}` : `↩ undone — ${esc(a.undone_by || '')}, ${esc(fmtDateTime(a.undone_at))}: “${esc(a.reason || '')}”`);
  return `<div class="card"><h2>🔎 To check <span class="small muted">${todo.length}</span></h2>
    <p class="small muted">Cards added here are live straight away. Whoever has the <b>Review new cards</b> right gets a ✉ message for each, and checks it here: <b>✓ Checked</b> takes it off this list; <b>↩ Undo</b> takes it out of the card database again (a copy of the database is kept first), and whoever added it is told why.${d.can_review ? '' : ' Someone with the right does this.'}</p>
    ${todo.length ? `<div class="kdb-scroll"><table class="log"><thead><tr><th>AX Ref · what was written</th><th>Added by</th><th></th></tr></thead><tbody>${todo.map(row).join('')}</tbody></table></div>` : '<div class="empty small">Nothing to check.</div>'}
    ${rest.length ? `<details class="q-table-toggle"><summary class="small muted">Checked or undone lately (${rest.length})</summary><table class="log small"><thead><tr><th>AX Ref</th><th>Added by</th><th></th></tr></thead><tbody>
      ${rest.map((a) => `<tr class="${a.status === 'undone' ? 'muted' : ''}"><td><b>${esc(a.ax_ref)}</b> <span class="muted">${esc(a.item_name || '')}</span></td><td>${esc(a.by_name || '')}, ${esc(fmtDateTime(a.created_at))}</td><td>${status(a)}</td></tr>`).join('')}</tbody></table></details>` : ''}</div>`;
}

// ---- 🔽 the fixed answers: columns answered from a list (Type, Material, Print Sides, Provider, Front / Back DoD…) ----
const cdList = (choices, name) => { const k = Object.keys(choices || {}).find((x) => x.toLowerCase() === String(name).toLowerCase()); return k && choices[k].length ? choices[k] : null; };
function cdChoicesHtml(d) {
  const cols = d.schema?.columns || null;
  const colOf = (k) => cols?.find((c) => c.name.toLowerCase() === k.toLowerCase());
  const rows = Object.entries(d.choices || {}).map(([k, list]) => {
    const c = colOf(k);
    const warn = !cols ? '' : !c ? '<span class="small muted">not a column of this table</span>'
      : c.kind === 'boolean' ? '<span class="small pl-late">a Yes/No column in Access: change it to Short Text to use these</span>'
        : !['text', 'memo'].includes(c.kind) ? '<span class="small pl-late">not a text column: the list isn\'t used</span>' : '';
    return `<tr><td class="nowrap"><b>${esc(k)}</b>${warn ? `<div>${warn}</div>` : ''}</td>
      <td><div class="cd-chips">${list.map((x, i) => `<span class="cd-chip">${esc(x)}${d.can_edit_choices ? `<button type="button" class="icon" data-cd-rm="${esc(k)}" data-i="${i}" title="Remove ${esc(x)}">✕</button>` : ''}</span>`).join('')}
        ${d.can_edit_choices ? `<form class="cd-addans" data-cd-col-add="${esc(k)}"><input type="text" placeholder="Add an answer" maxlength="255"><button type="submit" class="small">＋</button></form>` : ''}</div></td>
      <td>${d.can_edit_choices ? `<button type="button" class="link small" data-cd-free="${esc(k)}" title="Type it freely instead of choosing">Remove the list</button>` : ''}</td></tr>`;
  }).join('');
  const others = (cols || []).filter((c) => c.writable && ['text', 'memo'].includes(c.kind) && !cdList(d.choices, c.name) && c.name !== d.prefill?.key);
  return `<div class="card"><h2>🔽 Fixed answers</h2>
    <p class="small muted">Columns answered from a list on the form rather than typed, so every card is filled in the same way. ${d.can_edit_choices ? 'Add or remove answers here; removing one doesn\'t change cards already in the database.' : 'An admin changes them.'}</p>
    ${rows ? `<table class="log cd-ans"><tbody>${rows}</tbody></table>` : '<div class="empty small">No fixed answers: every column is typed freely.</div>'}
    ${d.can_edit_choices ? `<div class="row small" style="margin-top:8px">Give another column a list:
      ${others.length ? `<select id="cd-newcol"><option value="">Column…</option>${others.map((c) => `<option>${esc(c.name)}</option>`).join('')}</select>` : '<input type="text" id="cd-newcol" placeholder="Column name" style="max-width:180px">'}
      <input type="text" id="cd-newans" placeholder="First answer" style="max-width:180px"><button type="button" class="small" data-cd-newlist>＋ Add</button></div>` : ''}</div>`;
}
function cdChoicesWire(d) {
  const save = async (column, answers) => { try { await api.put('/plan/cards/choices', { column, answers }); } catch (err) { toast(err.message, 'error'); } renderCards(); };
  const listOf = (k) => [...(d.choices[k] || [])];
  $$('[data-cd-rm]').forEach((b) => b.addEventListener('click', () => { const l = listOf(b.dataset.cdRm); l.splice(Number(b.dataset.i), 1); save(b.dataset.cdRm, l); }));
  $$('[data-cd-col-add]').forEach((f) => f.addEventListener('submit', (e) => { e.preventDefault(); const v = f.querySelector('input').value.trim(); if (v) save(f.dataset.cdColAdd, [...listOf(f.dataset.cdColAdd), v]); }));
  $$('[data-cd-free]').forEach((b) => b.addEventListener('click', () => { if (confirm(`Type ${b.dataset.cdFree} freely instead of choosing from a list?`)) save(b.dataset.cdFree, []); }));
  $('[data-cd-newlist]')?.addEventListener('click', () => { const c = $('#cd-newcol').value.trim(); const v = $('#cd-newans').value.trim(); if (!c || !v) { toast('Pick a column and give its first answer', 'error'); return; } save(c, [v]); });
}
