'use strict';
// Owners and the People & departments lists. A task can have several owners; they're
// picked from the project team, the lists in Settings, or names used before, or typed.
// Loaded before app.js; uses its helpers.

const splitOwners = (v) => String(v ?? '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
const ownsTask = (owner, name) => splitOwners(owner).some((o) => o.toLowerCase() === String(name || '').trim().toLowerCase());

async function ownerOptions(projectId) {
  return api.get(`/owner-options${projectId ? `?project_id=${projectId}` : ''}`);
}

// ---- Contacts book: one searchable window for picking people ------------------------

// A name's department (from the contacts lists), or ''.
const deptOfName = (groups, name) => groups.map((g) => Object.entries(g.departments || {})
  .find(([n]) => n.toLowerCase() === String(name).toLowerCase())?.[1]).find(Boolean) || '';
// What to show next to a name: "Department · details".
const contactInfo = (groups, g, name) => [deptOfName(groups, name), g.details?.[name]].filter(Boolean).join(' · ');

// Opens over whatever is showing (even the task window). Resolves to the chosen names
// (in order: ones already chosen first) or null if cancelled. With multiple: false a
// click picks one name straight away. With wholeDepartments, a department can tick
// everyone in it at once.
function contactsBook({ groups = [], selected = [], title = 'Contacts', multiple = true, wholeDepartments = false } = {}) {
  let dlg = $('#contacts-dialog');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'contacts-dialog';
    document.body.append(dlg);
    // Clicking outside keeps what's ticked (like Done); Cancel or Esc throws it away.
    closeOnBackdrop(dlg, () => dlg.dispatchEvent(new CustomEvent('outside')));
  }
  const chosen = [...selected];
  const isChosen = (n) => chosen.some((c) => c.toLowerCase() === n.toLowerCase());
  const known = new Set(groups.flatMap((g) => g.names.map((n) => n.toLowerCase())));
  const extra = chosen.filter((n) => !known.has(n.toLowerCase()));
  const all = [...(extra.length ? [{ label: 'Chosen (not in a list)', names: extra, details: {} }] : []), ...groups];
  dlg.innerHTML = `<div class="cb-head"><h2 style="margin:0">📇 ${esc(title)}</h2><button class="icon" data-cb="cancel" title="Close">✕</button></div>
    <input type="search" class="cb-search" placeholder="Search names, roles, departments…" autocomplete="off">
    <div class="cb-list"></div>
    <div class="cb-foot row"><span class="small muted cb-count"></span><div class="spacer"></div>
      <a href="#/contacts" class="small" data-cb="manage">Manage contacts…</a>
      <button data-cb="cancel">Cancel</button>${multiple ? '<button class="primary" data-cb="done">Done</button>' : ''}</div>`;
  const search = $('.cb-search', dlg);
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const hit = (g, n) => !q || n.toLowerCase().includes(q) || contactInfo(groups, g, n).toLowerCase().includes(q);
    const everyone = (g, n) => {
      const members = multiple && wholeDepartments ? g.members?.[n] : null;
      if (!members?.length) return '';
      const left = members.filter((m) => !isChosen(m)).length;
      return `<button type="button" class="link small cb-everyone" data-cb-all="${esc(n)}" ${left ? '' : 'disabled'}
        title="${esc(members.join(', '))}">${left ? `＋ everyone in ${esc(n)} (${members.length})` : `all ${members.length} chosen`}</button>`;
    };
    const html = all.map((g) => {
      const names = g.names.filter((n) => hit(g, n));
      return names.length ? `<div class="cb-group">${esc(g.label)}</div>${names.map((n) => `<label class="cb-row">
        ${multiple ? `<input type="checkbox" data-cb-name="${esc(n)}" ${isChosen(n) ? 'checked' : ''}>` : `<button type="button" class="link" data-cb-pick="${esc(n)}">${esc(n)}</button>`}
        ${multiple ? `<span class="cb-name">${esc(n)}</span>` : ''}<span class="small muted">${esc(contactInfo(groups, g, n))}</span>${everyone(g, n)}</label>`).join('')}` : '';
    }).join('');
    const typed = search.value.trim();
    const exact = typed && all.some((g) => g.names.some((n) => n.toLowerCase() === typed.toLowerCase()));
    $('.cb-list', dlg).innerHTML = html + (typed && !exact ? `<button type="button" class="cb-add" data-cb-new="${esc(typed)}">＋ Use “${esc(typed)}” (not in your contacts)</button>` : '')
      || '<div class="empty small">No contacts yet — add names on the 📇 Contacts page, or type one above.</div>';
    $('.cb-count', dlg).textContent = multiple ? `${chosen.length} chosen` : '';
  };
  draw();
  if (!dlg.open) dlg.showModal();
  search.focus();
  return new Promise((resolve) => {
    const onOutside = () => close(multiple ? chosen : null);
    const close = (result) => { dlg.removeEventListener('outside', onOutside); dlg.close(); dlg.onclick = null; resolve(result); };
    dlg.addEventListener('outside', onOutside);
    search.oninput = draw;
    search.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = $('[data-cb-name], [data-cb-pick], [data-cb-new]', dlg);
      if (first) first.click();
      search.select();
    };
    dlg.oncancel = (e) => { e.preventDefault(); close(null); };
    dlg.onchange = (e) => {
      const n = e.target.dataset.cbName;
      if (n === undefined) return;
      if (e.target.checked) { if (!isChosen(n)) chosen.push(n); } else chosen.splice(chosen.findIndex((c) => c.toLowerCase() === n.toLowerCase()), 1);
      $('.cb-count', dlg).textContent = `${chosen.length} chosen`;
    };
    dlg.onclick = (e) => {
      const t = e.target;
      if (t.closest('[data-cb="cancel"]')) return close(null);
      if (t.closest('[data-cb="done"]')) return close(chosen);
      if (t.closest('[data-cb="manage"]')) { close(null); closeModal(); return; }
      const pick = t.closest('[data-cb-pick]');
      if (pick) return close([pick.dataset.cbPick]);
      const dept = t.closest('[data-cb-all]');
      if (dept) {
        e.preventDefault(); // it sits in a label: don't tick the department itself
        const members = all.find((g) => g.members?.[dept.dataset.cbAll])?.members[dept.dataset.cbAll] || [];
        for (const m of members) if (!isChosen(m)) chosen.push(m);
        draw();
        return;
      }
      const add = t.closest('[data-cb-new]');
      if (add) {
        if (!multiple) return close([add.dataset.cbNew]);
        if (!isChosen(add.dataset.cbNew)) chosen.push(add.dataset.cbNew);
        all.unshift({ label: 'Added now', names: [add.dataset.cbNew], details: {} });
        search.value = '';
        draw();
      }
    };
  });
}

// Chips for the chosen names plus a box that suggests from `groups` ([{ label, names }]).
// Enter or a comma adds what's typed; Backspace in an empty box removes the last one.
// onChange(value) gets "Name, Name" (or null) after every change.
// With wholeDepartments, typing a department also offers everyone in it.
function ownerPicker(root, { value = '', groups = [], placeholder = 'Add owner…', bookTitle = 'Choose owners', wholeDepartments = false, onChange = () => {} } = {}) {
  let owners = splitOwners(value);
  let active = -1;
  root.classList.add('owner-picker');
  root.innerHTML = `<div class="op-box"><span class="op-chips"></span>
    <input type="text" class="op-input" autocomplete="off" placeholder="${esc(placeholder)}">
    <button type="button" class="op-book" title="Choose from the contacts book">📇</button></div>
    <div class="op-menu" hidden></div>`;
  const input = $('.op-input', root);
  const menu = $('.op-menu', root);
  const has = (n) => owners.some((o) => o.toLowerCase() === n.toLowerCase());
  const emit = () => onChange(owners.length ? owners.join(', ') : null);
  const drawChips = () => {
    $('.op-chips', root).innerHTML = owners.map((o, i) => `<span class="op-chip">👤 ${esc(o)}<button type="button" data-op-remove="${i}" title="Remove ${esc(o)}">✕</button></span>`).join('');
    input.placeholder = owners.length ? '+ another' : placeholder;
  };
  // Each option: { add: names to add, label, info }.
  const matches = () => {
    const q = input.value.trim().toLowerCase();
    return groups.map((g) => ({ label: g.label, options: g.names.filter((n) => (!q || n.toLowerCase().includes(q) || deptOfName(groups, n).toLowerCase().includes(q))).slice(0, 25)
      .flatMap((n) => {
        const members = (wholeDepartments && g.members?.[n] || []).filter((m) => !has(m));
        return [...(has(n) ? [] : [{ add: n, label: n, info: deptOfName(groups, n) }]),
          ...(members.length ? [{ add: members.join(', '), label: `＋ everyone in ${n}`, info: `${members.length} ${members.length === 1 ? 'person' : 'people'}` }] : [])];
      }) })).filter((g) => g.options.length);
  };
  // Suggestions appear only while typing; the 📇 button shows everyone.
  const drawMenu = () => {
    if (!input.value.trim()) { menu.hidden = true; return []; }
    const list = matches();
    const flat = list.flatMap((g) => g.options);
    if (active >= flat.length) active = flat.length - 1;
    let i = -1;
    menu.innerHTML = list.map((g) => `<div class="op-group">${esc(g.label)}</div>${g.options.map((o) => {
      i += 1;
      return `<div class="op-option ${i === active ? 'on' : ''}" data-op-add="${esc(o.add)}">${esc(o.label)}${o.info ? ` <span class="small muted">${esc(o.info)}</span>` : ''}</div>`;
    }).join('')}`).join('') || `<div class="op-hint">Press Enter to add “${esc(input.value.trim())}”</div>`;
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
  root.addEventListener('mousedown', (e) => { if (e.target.closest('[data-op-add], [data-op-remove], .op-book')) e.preventDefault(); });
  root.addEventListener('click', async (e) => {
    const pick = e.target.closest('[data-op-add]');
    const rm = e.target.closest('[data-op-remove]');
    if (e.target.closest('.op-book')) {
      const chosen = await contactsBook({ groups, selected: owners, title: bookTitle, wholeDepartments });
      if (chosen) { owners = chosen; drawChips(); emit(); }
      return;
    }
    if (pick) add(pick.dataset.opAdd);
    else if (rm) { owners.splice(Number(rm.dataset.opRemove), 1); drawChips(); emit(); input.focus(); }
    else input.focus();
  });
  input.addEventListener('input', () => {
    if (/[,;]/.test(input.value)) { add(input.value); return; }
    active = input.value.trim() ? 0 : -1;
    drawMenu();
  });
  input.addEventListener('keydown', (e) => {
    const flat = matches().flatMap((g) => g.options.map((o) => o.add));
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
  const deptList = lists.find((l) => l.departments);
  const deptOptions = (current) => {
    const names = (deptList?.items || []).filter((d) => d.active || (current && d.name.toLowerCase() === current.toLowerCase())).map((d) => d.name);
    if (current && !names.some((n) => n.toLowerCase() === current.toLowerCase())) names.push(current); // deleted from the list: keep it
    return `<option value="">—</option>${names.map((n) => `<option ${current && n.toLowerCase() === current.toLowerCase() ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
  };
  const head = (l) => (l.departments
    ? '<th>Department</th><th>Details</th><th>Active</th><th class="num" title="People with this department">People</th><th class="num" title="Open tasks the department owns, plus those its people own">Open tasks</th><th></th>'
    : `<th>Name</th>${deptList ? '<th>Department</th>' : ''}<th>Details <span class="muted">(role, email, extension…)</span></th><th>Active</th><th class="num" title="Open tasks this name owns">Open tasks</th><th></th>`);
  const row = (l, i) => `<tr data-item="${i.id}" data-name="${esc(i.name)}" data-open="${i.open_tasks}" data-dept="${esc(l.departments ? '' : i.department || '')}" data-members="${i.members?.length || 0}" data-kind="${l.departments ? 'dept' : 'person'}">
          <td class="pl-who"><span>${esc(i.name)}</span><button class="icon" data-pl-rename="${i.id}" title="Rename — changes it everywhere it's used">✎</button></td>
          ${!l.departments && deptList ? `<td><select name="department" title="Department (from the ${esc(deptList.name)} list)">${deptOptions(i.department)}</select></td>` : ''}
          <td><input type="text" name="detail" value="${esc(i.detail || '')}"></td>
          <td><input type="checkbox" name="active" ${i.active ? 'checked' : ''}></td>
          ${l.departments ? `<td class="num" title="${esc((i.members || []).join(', '))}">${i.members?.length || ''}</td>
          <td class="num" title="${i.open_tasks} owned by the department itself">${i.dept_open_tasks || ''}</td>` : `<td class="num">${i.open_tasks || ''}</td>`}
          <td><button class="icon" data-pl-remove="${i.id}" title="Remove from the list">✕</button></td></tr>`;
  root.innerHTML = `<div class="card people-card">
    <h2>Lists</h2>
    <p class="small muted">Names offered in the 📇 contacts book when you choose a task's <b>owners</b>, a meeting's <b>attendees</b> or a project's team, after the project's own team.
      Make as many lists as you like (e.g. <i>People</i>, <i>Departments</i>, <i>Suppliers</i>). Untick <b>Active</b> to stop offering a name
      without touching tasks that already use it. Tasks can still have names that aren't in any list.
      Use <b>✎</b> to rename someone: the new name replaces the old one everywhere it's used, so nothing loses its link.
      ${deptList ? `Give people a <b>Department</b> from the <i>${esc(deptList.name)}</i> list; renaming a department moves everyone in it, and a department can't be removed while people are in it.` : 'Add a list called <i>Departments</i> to give people a department.'}</p>
    <div class="people-lists">${lists.map((l) => `<div class="people-list ${!l.departments && deptList ? 'has-dept' : ''}" data-list="${l.id}">
      <div class="row">${l.departments ? `<b class="pl-name pl-fixed" title="This list's name is fixed: people's departments come from it">${esc(l.name)}</b>`
        : `<input type="text" class="pl-name" value="${esc(l.name)}" title="List name">`}
        <span class="small muted">${l.items.length} name${l.items.length === 1 ? '' : 's'}</span><div class="spacer"></div>
        ${l.departments ? '' : `<button class="icon" data-pl-delete="${l.id}" title="Delete this list">🗑</button>`}</div>
      <table class="log"><thead><tr>${head(l)}</tr></thead>
        <tbody>${l.items.map((i) => row(l, i)).join('')}</tbody></table>
      ${l.items.length ? '' : '<div class="empty small">No names yet.</div>'}
      <div class="row pl-add"><input type="text" class="pl-new" placeholder="Add a name… (Enter)" autocomplete="off">
        <button class="link small" data-pl-bulk="${l.id}">Paste several…</button></div>
      <div class="pl-bulk" hidden><textarea rows="4" placeholder="One name per line, e.g. pasted from Excel or an email"></textarea>
        <button data-pl-bulk-save="${l.id}">Add all</button></div>
    </div>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input type="text" id="pl-new-list" placeholder="New list, e.g. Suppliers… (Enter)" autocomplete="off" style="max-width:320px">
      <button data-pl-new-list>Add list</button></div>
  </div>`;
  root.dispatchEvent(new Event('contacts-redrawn'));
  const reload = () => renderPeopleSettings(root);
  const run = async (fn, msg) => { try { const r = await fn(); if (msg) toast(typeof msg === 'function' ? msg(r) : msg); } catch (err) { toast(err.message, 'error'); } await reload(); };

  $$('input.pl-name', root).forEach((el) => el.addEventListener('change', () =>
    run(() => api.patch(`/name-lists/${el.closest('[data-list]').dataset.list}`, { name: el.value }), 'List renamed')));
  $$('tr[data-item] input, tr[data-item] select', root).forEach((el) => el.addEventListener('change', () => {
    const tr = el.closest('tr');
    run(() => api.patch(`/name-list-items/${tr.dataset.item}`, { [el.name]: el.type === 'checkbox' ? el.checked : el.value }), 'Saved');
  }));
  // Names are fixed text; renaming is deliberate and carries the new name everywhere.
  const rename = (tr) => {
    const old = tr.dataset.name;
    const name = prompt(`Rename “${old}” to:\n\nThe new name replaces the old one everywhere it's used — task and action owners, meeting attendees, project teams, leaders and sponsors${tr.dataset.kind === 'dept' ? ", and everyone in this department" : ''}.`, old);
    if (!name || name.trim() === old) return;
    run(() => api.patch(`/name-list-items/${tr.dataset.item}`, { name }), (r) => {
      const also = [r.renamed_tasks && `${r.renamed_tasks} task${r.renamed_tasks === 1 ? '' : 's'} updated`,
        r.moved_people && `${r.moved_people} ${r.moved_people === 1 ? 'person' : 'people'} moved`].filter(Boolean);
      return `Renamed to ${r.name}${also.length ? ` — ${also.join(', ')}` : ''}`;
    });
  };
  $$('.pl-new', root).forEach((el) => el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !el.value.trim()) return;
    const list = el.closest('[data-list]').dataset.list;
    run(() => api.post(`/name-lists/${list}/items`, { name: el.value }), `${el.value.trim()} added`)
      .then(() => $(`[data-list="${list}"] .pl-new`, root)?.focus());
  }));
  root.onclick = (e) => { // assigned so re-rendering doesn't stack handlers
    const t = e.target;
    if (t.closest('[data-pl-rename]')) rename(t.closest('tr'));
    else if (t.closest('[data-pl-remove]')) {
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

// ---- 📇 Contacts page: the name lists, plus everyone on a project team -----------------

async function renderContacts() {
  main().innerHTML = `<div class="kanban-tools"><h1 style="margin:0">📇 Contacts</h1>
      <span class="muted small">People and departments offered when choosing owners, attendees and team members</span>
      <div class="spacer"></div>
      <select id="contacts-dept" title="Show one department" hidden></select>
      <input type="search" id="contacts-search" placeholder="Search contacts…" autocomplete="off" style="max-width:260px"></div>
    <div id="contacts-lists"></div>
    <div id="contacts-teams" style="margin-top:16px"></div>`;
  const teams = await api.get('/contacts/teams');
  $('#contacts-teams').innerHTML = `<div class="card"><h2>On project teams <span class="muted small">${teams.length}</span></h2>
    <p class="small muted">From each project's 👥 team (edit them on the project). Not in a list above yet? Use ＋ to add them.</p>
    ${teams.length ? `<table class="log"><thead><tr><th>Name</th><th>Department</th><th>Role</th><th>Contact</th><th>Projects</th><th></th></tr></thead><tbody>
      ${teams.map((t) => `<tr data-dept="${esc(t.department || '')}" data-search="${esc([t.name, t.department, ...t.roles, t.contact, ...t.projects.map((x) => x.name)].join(' ').toLowerCase())}">
        <td><b>${esc(t.name)}</b></td><td>${esc(t.department || '')}</td><td>${esc(t.roles.join(', '))}</td><td>${contactLink(t.contact)}</td>
        <td>${t.projects.map((x) => `<a href="#/project/${x.id}">${esc(x.name)}</a>`).join(', ')}</td>
        <td><button class="link small" data-team-add="${esc(t.name)}" data-detail="${esc(t.roles.join(', '))}" title="Add to a contacts list">＋ List</button></td></tr>`).join('')}
      </tbody></table>` : '<div class="empty small">No team members yet.</div>'}</div>`;
  // Department filter: only people (rows that can have a department) are filtered by it.
  const sel = $('#contacts-dept');
  const fillDepts = async () => {
    const lists = await api.get('/name-lists');
    const dl = lists.find((l) => l.departments);
    sel.hidden = !dl;
    if (!dl) { sel.value = ''; return; }
    const was = sel.value;
    const names = [...new Set([...dl.items.map((d) => d.name), ...lists.flatMap((l) => l.items.map((i) => i.department)).filter(Boolean)])];
    sel.innerHTML = `<option value="">All departments</option>${names.map((n) => `<option>${esc(n)}</option>`).join('')}<option value="-">No department</option>`;
    sel.value = [...sel.options].some((o) => o.value === was) ? was : '';
  };
  const filter = () => {
    const q = $('#contacts-search').value.trim().toLowerCase();
    const d = sel.value.toLowerCase();
    const deptOk = (tr) => !d || (d === '-' ? !tr.dataset.dept : tr.dataset.dept.toLowerCase() === d);
    $$('#contacts-lists tr[data-item]').forEach((tr) => {
      const isDept = tr.dataset.kind === 'dept';
      tr.hidden = (!!q && ![tr.dataset.name, ...[...tr.querySelectorAll('input[type=text], select')].map((i) => i.value)].some((v) => v.toLowerCase().includes(q)))
        || (isDept ? !!d && tr.dataset.name.toLowerCase() !== d : !deptOk(tr));
    });
    $$('#contacts-teams tr[data-search]').forEach((tr) => { tr.hidden = (!!q && !tr.dataset.search.includes(q)) || !deptOk(tr); });
  };
  await renderPeopleSettings($('#contacts-lists'));
  await fillDepts();
  filter();
  $('#contacts-search').addEventListener('input', filter);
  sel.addEventListener('change', filter);
  $('#contacts-lists').addEventListener('contacts-redrawn', () => { filter(); fillDepts().then(filter); });
  $('#contacts-teams').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-team-add]');
    if (!b) return;
    const lists = await api.get('/name-lists');
    if (!lists.length) { toast('Make a list first (e.g. People)', 'error'); return; }
    const target = lists.length === 1 ? lists[0] : lists.find((l) => l.name.toLowerCase() === 'people') || lists[0];
    try {
      await api.post(`/name-lists/${target.id}/items`, { name: b.dataset.teamAdd, detail: b.dataset.detail });
      toast(`${b.dataset.teamAdd} added to ${target.name}`);
    } catch (err) { toast(err.message, 'error'); }
    await renderPeopleSettings($('#contacts-lists'));
  });
}

// ---- Contact autofill for single-name fields (charter sponsor, leader, team) ---------

// Contacts plus the leaders and sponsors of other projects.
async function contactGroups(projectId) {
  const groups = await ownerOptions(projectId);
  const known = new Set(groups.flatMap((g) => g.names.map((n) => n.toLowerCase())));
  const roles = new Map();
  for (const p of state.projects) {
    for (const [name, what] of [[p.leader, 'Leader'], [p.sponsor, 'Sponsor']]) {
      if (!name || known.has(name.toLowerCase())) continue;
      const k = name.toLowerCase();
      const r = roles.get(k) || { name, parts: [] };
      if (r.parts.length < 2) r.parts.push(`${what} of ${p.name}`);
      roles.set(k, r);
    }
  }
  if (roles.size) {
    const list = [...roles.values()];
    const group = { label: 'Leaders & sponsors', names: list.map((r) => r.name), details: Object.fromEntries(list.map((r) => [r.name, r.parts.join(', ')])) };
    const used = groups.findIndex((g) => g.label === 'Used before');
    groups.splice(used < 0 ? groups.length : used, 0, group);
  }
  return groups;
}
// A role to fill in: only from the contacts lists' details (not "Leader of …" or a role on this project).
const NOT_ROLES = ['Project team', 'Leaders & sponsors', 'Used before'];
const roleOf = (groups, name) => groups.filter((g) => !NOT_ROLES.includes(g.label))
  .map((g) => Object.entries(g.details || {}).find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1]).find(Boolean) || '';

// Typing in a name field suggests contacts (with their role alongside) via
// <datalist id="people">, and a 📇 button opens the contacts book:
//   input[data-contact="Title"]       one name; with data-role-field, the role in the same row is filled too
//   textarea[data-contact-lines]      "Name, role" lines; the book can add several
async function enhanceContactFields(root, projectId) {
  const groups = await contactGroups(projectId);
  const dl = $('datalist#people', root);
  if (dl) {
    const seen = new Set();
    dl.innerHTML = groups.flatMap((g) => g.names.filter((n) => !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase()))
      .map((n) => `<option value="${esc(n)}" label="${esc(contactInfo(groups, g, n) || g.label)}">`)).join('');
  }
  const addButton = (field, onClick) => {
    if (field.parentElement.classList.contains('cf-wrap')) return;
    const wrap = document.createElement('span');
    wrap.className = 'cf-wrap';
    field.before(wrap);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cf-book';
    btn.textContent = '📇';
    btn.title = 'Choose from the contacts book';
    wrap.append(field, btn);
    btn.addEventListener('click', onClick);
  };
  for (const input of $$('input[data-contact]', root)) {
    addButton(input, async () => {
      const pick = await contactsBook({ groups, title: input.dataset.contact || 'Choose a contact', multiple: false });
      if (!pick) return;
      input.value = pick[0];
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const role = 'roleField' in input.dataset ? $('input[name=role]', input.closest('tr')) : null;
      const detail = roleOf(groups, pick[0]);
      if (role && !role.value.trim() && detail) {
        role.value = detail;
        role.dispatchEvent(new Event('change', { bubbles: true }));
      }
      input.focus();
    });
  }
  for (const ta of $$('textarea[data-contact-lines]', root)) {
    addButton(ta, async () => {
      const already = ta.value.split(/\r?\n/).map((l) => l.split(',')[0].trim()).filter(Boolean);
      const pick = await contactsBook({ groups, selected: already, title: 'Choose the project team' });
      if (!pick) return;
      const lines = ta.value.split(/\r?\n/).filter((l) => l.trim());
      const keep = lines.filter((l) => pick.some((n) => n.toLowerCase() === l.split(',')[0].trim().toLowerCase()));
      const add = pick.filter((n) => !already.some((a) => a.toLowerCase() === n.toLowerCase()))
        .map((n) => { const d = roleOf(groups, n); return d ? `${n}, ${d}` : n; });
      ta.value = [...keep, ...add].join('\n');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}
