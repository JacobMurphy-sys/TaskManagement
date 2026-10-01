'use strict';
// Owners and the People & departments lists. A task can have several owners; they're
// picked from the project team, the lists in Settings, or names used before, or typed.
// Loaded before app.js; uses its helpers.

const splitOwners = (v) => String(v ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const ownsTask = (owner, name) => splitOwners(owner).some((o) => o.toLowerCase() === String(name || '').trim().toLowerCase());

async function ownerOptions(projectId) {
  return api.get(`/owner-options${projectId ? `?project_id=${projectId}` : ''}`);
}

// Chips for the chosen names plus a box that suggests from `groups` ([{ label, names }]).
// Enter or a comma adds what's typed; Backspace in an empty box removes the last one.
// onChange(value) gets "Name, Name" (or null) after every change.
function ownerPicker(root, { value = '', groups = [], placeholder = 'Add owner…', onChange = () => {} } = {}) {
  let owners = splitOwners(value);
  let active = -1;
  root.classList.add('owner-picker');
  root.innerHTML = `<div class="op-box"><span class="op-chips"></span>
    <input type="text" class="op-input" autocomplete="off" placeholder="${esc(placeholder)}"></div>
    <div class="op-menu" hidden></div>`;
  const input = $('.op-input', root);
  const menu = $('.op-menu', root);
  const has = (n) => owners.some((o) => o.toLowerCase() === n.toLowerCase());
  const emit = () => onChange(owners.length ? owners.join(', ') : null);
  const drawChips = () => {
    $('.op-chips', root).innerHTML = owners.map((o, i) => `<span class="op-chip">👤 ${esc(o)}<button type="button" data-op-remove="${i}" title="Remove ${esc(o)}">✕</button></span>`).join('');
    input.placeholder = owners.length ? '+ another' : placeholder;
  };
  const matches = () => {
    const q = input.value.trim().toLowerCase();
    return groups.map((g) => ({ label: g.label, names: g.names.filter((n) => !has(n) && (!q || n.toLowerCase().includes(q))).slice(0, 25) }))
      .filter((g) => g.names.length);
  };
  const drawMenu = () => {
    const list = matches();
    const flat = list.flatMap((g) => g.names);
    if (active >= flat.length) active = flat.length - 1;
    let i = -1;
    menu.innerHTML = list.map((g) => `<div class="op-group">${esc(g.label)}</div>${g.names.map((n) => {
      i += 1;
      return `<div class="op-option ${i === active ? 'on' : ''}" data-op-add="${esc(n)}">${esc(n)}</div>`;
    }).join('')}`).join('') || (input.value.trim() ? `<div class="op-hint">Press Enter to add “${esc(input.value.trim())}”</div>` : '<div class="op-hint">Type a name</div>');
    menu.hidden = false;
    return flat;
  };
  const add = (name) => {
    for (const n of splitOwners(name)) if (!has(n)) owners.push(n);
    input.value = '';
    active = -1;
    drawChips();
    drawMenu();
    emit();
  };
  root.addEventListener('mousedown', (e) => { if (e.target.closest('[data-op-add], [data-op-remove]')) e.preventDefault(); });
  root.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-op-add]');
    const rm = e.target.closest('[data-op-remove]');
    if (pick) add(pick.dataset.opAdd);
    else if (rm) { owners.splice(Number(rm.dataset.opRemove), 1); drawChips(); emit(); input.focus(); }
    else input.focus();
  });
  input.addEventListener('focus', drawMenu);
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) { add(input.value); return; }
    active = input.value.trim() ? 0 : -1;
    drawMenu();
  });
  input.addEventListener('keydown', (e) => {
    const flat = matches().flatMap((g) => g.names);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = Math.max(0, Math.min(flat.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
      drawMenu();
    } else if (e.key === 'Enter') {
      if (!input.value.trim() && active < 0) return; // let Enter through (e.g. to submit a row)
      e.preventDefault();
      e.stopPropagation();
      add(active >= 0 && flat[active] ? flat[active] : input.value);
    } else if (e.key === 'Backspace' && !input.value && owners.length) {
      owners.pop();
      drawChips();
      emit();
    } else if (e.key === 'Escape' && !menu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      menu.hidden = true;
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) add(input.value);
    menu.hidden = true;
  });
  drawChips();
  return {
    get value() { return owners.length ? owners.join(', ') : null; },
    clear() { owners = []; input.value = ''; drawChips(); },
    focus() { input.focus(); },
  };
}

// ---- Settings → People & departments ----------------------------------------------

async function renderPeopleSettings(root) {
  const lists = await api.get('/name-lists');
  root.innerHTML = `<div class="card people-card">
    <h2>👥 People &amp; departments</h2>
    <p class="small muted">Lists of names offered when you choose a task's <b>owners</b> or a meeting's <b>attendees</b>, after the project's team.
      Make as many lists as you like (e.g. <i>People</i>, <i>Departments</i>, <i>Suppliers</i>). Untick <b>Active</b> to stop offering a name
      without touching tasks that already use it. Tasks can still have names that aren't in any list.</p>
    <div class="people-lists">${lists.map((l) => `<div class="people-list" data-list="${l.id}">
      <div class="row"><input type="text" class="pl-name" value="${esc(l.name)}" title="List name">
        <span class="small muted">${l.items.length} name${l.items.length === 1 ? '' : 's'}</span><div class="spacer"></div>
        <button class="icon" data-pl-delete="${l.id}" title="Delete this list">🗑</button></div>
      <table class="log"><thead><tr><th>Name</th><th>Details <span class="muted">(role, team, email…)</span></th><th>Active</th><th class="num" title="Open tasks this name owns">Open tasks</th><th></th></tr></thead>
        <tbody>${l.items.map((i) => `<tr data-item="${i.id}" data-name="${esc(i.name)}" data-open="${i.open_tasks}">
          <td><input type="text" name="name" value="${esc(i.name)}"></td>
          <td><input type="text" name="detail" value="${esc(i.detail || '')}"></td>
          <td><input type="checkbox" name="active" ${i.active ? 'checked' : ''}></td>
          <td class="num">${i.open_tasks || ''}</td>
          <td><button class="icon" data-pl-remove="${i.id}" title="Remove from the list">✕</button></td></tr>`).join('')}</tbody></table>
      ${l.items.length ? '' : '<div class="empty small">No names yet.</div>'}
      <div class="row pl-add"><input type="text" class="pl-new" placeholder="Add a name… (Enter)" autocomplete="off">
        <button class="link small" data-pl-bulk="${l.id}">Paste several…</button></div>
      <div class="pl-bulk" hidden><textarea rows="4" placeholder="One name per line, e.g. pasted from Excel or an email"></textarea>
        <button data-pl-bulk-save="${l.id}">Add all</button></div>
    </div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input type="text" id="pl-new-list" placeholder="New list, e.g. Suppliers… (Enter)" autocomplete="off" style="max-width:320px">
      <button data-pl-new-list>Add list</button></div>
  </div>`;
  const reload = () => renderPeopleSettings(root);
  const run = async (fn, msg) => { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); } catch (err) { toast(err.message, 'error'); } await reload(); };

  $$('.pl-name', root).forEach((el) => el.addEventListener('change', () =>
    run(() => api.patch(`/name-lists/${el.closest('[data-list]').dataset.list}`, { name: el.value }), 'List renamed')));
  $$('tr[data-item] input', root).forEach((el) => el.addEventListener('change', () => {
    const tr = el.closest('tr');
    const body = { [el.name]: el.type === 'checkbox' ? el.checked : el.value };
    if (el.name === 'name' && Number(tr.dataset.open) && el.value.trim() && el.value.trim() !== tr.dataset.name) {
      body.rename_tasks = confirm(`“${tr.dataset.name}” owns ${tr.dataset.open} open task(s). Rename it on those tasks too?`);
    }
    run(() => api.patch(`/name-list-items/${tr.dataset.item}`, body), (r) => (r.renamed_tasks ? `Saved — renamed on ${r.renamed_tasks} task(s)` : 'Saved'));
  }));
  $$('.pl-new', root).forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !el.value.trim()) return;
    const list = el.closest('[data-list]').dataset.list;
    run(() => api.post(`/name-lists/${list}/items`, { name: el.value }), `${el.value.trim()} added`)
      .then(() => $(`[data-list="${list}"] .pl-new`, root)?.focus());
  }));
  root.onclick = (e) => { // assigned so re-rendering doesn't stack handlers
    const t = e.target;
    if (t.closest('[data-pl-remove]')) {
      const tr = t.closest('tr');
      if (Number(tr.dataset.open) && !confirm(`Remove “${tr.dataset.name}” from the list? Its ${tr.dataset.open} open task(s) keep it as an owner.`)) return;
      run(() => api.del(`/name-list-items/${tr.dataset.item}`));
    } else if (t.closest('[data-pl-delete]')) {
      const id = t.closest('[data-pl-delete]').dataset.plDelete;
      const name = $(`[data-list="${id}"] .pl-name`, root).value;
      if (confirm(`Delete the list “${name}” and all its names? Tasks keep their owners.`)) run(() => api.del(`/name-lists/${id}`), 'List deleted');
    } else if (t.closest('[data-pl-bulk]')) {
      const box = $('.pl-bulk', t.closest('[data-list]'));
      box.hidden = !box.hidden;
      if (!box.hidden) $('textarea', box).focus();
    } else if (t.closest('[data-pl-bulk-save]')) {
      const id = t.closest('[data-pl-bulk-save]').dataset.plBulkSave;
      const text = $(`[data-list="${id}"] .pl-bulk textarea`, root).value;
      run(() => api.post(`/name-lists/${id}/items`, { names: text }), (r) => `${r.added} added${r.skipped ? `, ${r.skipped} already there` : ''}`);
    } else if (t.closest('[data-pl-new-list]')) addList();
  };
  const addList = () => {
    const name = $('#pl-new-list', root).value.trim();
    if (name) run(() => api.post('/name-lists', { name }), `List “${name}” added`);
  };
  $('#pl-new-list', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') addList(); });
}
