// 👥 People: what's open for each person — their tasks (subtasks among them), the projects they're on
// with each project's next action, and their own next action: the talking point for the next 1:1 or
// review. Each person has a colour (picked from the name, or set here).

async function renderTeam() {
  const list = await api.get('/people/overview');
  const q = store.get('teamQuery', ''); const sort = store.get('teamSort', 'overdue'); const busyOnly = store.get('teamBusy', true);
  const SORTS = { overdue: ['Most overdue', (a, b) => b.counts.overdue - a.counts.overdue || b.counts.open - a.counts.open || a.name.localeCompare(b.name)],
    open: ['Most open', (a, b) => b.counts.open - a.counts.open || a.name.localeCompare(b.name)], name: ['Name', (a, b) => a.name.localeCompare(b.name)] };
  const shown = list.filter((p) => (!busyOnly || p.counts.open || p.counts.projects || p.next_action) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))).sort((SORTS[sort] || SORTS.overdue)[1]);
  const total = (k) => shown.reduce((a, p) => a + p.counts[k], 0);
  const TASKS_SHOWN = 6;
  const card = (p) => {
    const c = p.counts; const col = personColour(p.name);
    const tasks = p.tasks.slice(0, TASKS_SHOWN);
    return `<div class="card person-card" style="--pc:${col}" data-person="${esc(p.name)}">
      <div class="pc-head">
        <label class="pc-dot" title="${p.colour ? 'Colour set here' : 'Colour picked from the name'} — click to choose another">${personDot(p.name).replace('class="pdot"', 'class="pdot lg"')}<input type="color" class="pc-colour" value="${col}"></label>
        <div class="pc-name"><b>${esc(p.name)}</b><div class="pc-counts">
          <span title="Open tasks">${c.open} open</span>${c.overdue ? `<span class="why bad">${c.overdue} overdue</span>` : ''}${c.week ? `<span class="why warn">${c.week} due this week</span>` : ''}${c.blocked ? `<span class="why bad">⛔ ${c.blocked} blocked</span>` : ''}${c.waiting ? `<span class="why">⏳ ${c.waiting} waiting</span>` : ''}${c.projects ? `<span class="why">🗂 ${c.projects} project${c.projects === 1 ? '' : 's'}</span>` : ''}</div></div>
        ${ddMenu('⋯', `<button data-team-go="home">🏠 Their Home and focus</button><button data-team-go="tasks">✅ All their open tasks</button><button data-team-go="board">🗂 Their projects on the board</button>${p.colour ? '<hr><button data-team-go="colour-reset">🎨 Back to the colour from their name</button>' : ''}`, { title: 'Open their Home, tasks or projects' })}
      </div>
      <label class="na-line" title="${p.next_action_at ? `Set ${esc(fmtDateTime(p.next_action_at))}` : 'The talking point for their next 1:1 or review'}">▶ <input type="text" class="pc-next" maxlength="300" value="${esc(p.next_action || '')}" placeholder="Next action with ${esc(p.name.split(' ')[0])}…"></label>
      ${p.projects.length ? `<div class="pc-sec"><div class="pc-h">Projects</div>${p.projects.map((x) => `<div class="pc-proj"><a href="#/project/${x.id}"><b>${esc(x.name)}</b></a> <span class="small muted">${esc(x.role)}${x.status === 'on_hold' ? ' · on hold' : ''}</span>
          ${x.overdue_count ? `<span class="why bad">${x.overdue_count} overdue</span>` : ''}${x.next_action ? `<div class="next-action small">▶ ${esc(x.next_action)}</div>` : ''}</div>`).join('')}</div>` : ''}
      ${p.tasks.length ? `<div class="pc-sec"><div class="pc-h">Open tasks</div><ul class="mini">${tasks.map(miniTask).join('')}</ul>
        ${p.tasks.length > TASKS_SHOWN ? `<button class="link small" data-team-go="tasks">All ${p.tasks.length} open tasks →</button>` : ''}</div>` : '<div class="small muted pc-sec">No open tasks.</div>'}
    </div>`;
  };
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">👥 People</h1>
      <input type="search" id="team-q" placeholder="Find a person…" value="${esc(q)}" style="max-width:220px">
      <label class="person-pick" title="Order">↕<select id="team-sort">${Object.entries(SORTS).map(([k, [l]]) => `<option value="${k}" ${k === sort ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="small muted row"><input type="checkbox" id="team-busy" ${busyOnly ? 'checked' : ''}> only people with open work</label>
      <div class="spacer"></div><span class="small muted">${shown.length} people · ${total('open')} open tasks${total('overdue') ? ` · <b class="pl-late">${total('overdue')} overdue</b>` : ''}</span></div>
    <div class="person-grid">${shown.map(card).join('') || '<div class="card empty">No one here yet — people appear as task owners, project leaders, sponsors and team members.</div>'}</div>`;
  let qt = null;
  $('#team-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { store.set('teamQuery', e.target.value); renderTeam().then(() => { const i = $('#team-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 250); };
  $('#team-sort').onchange = (e) => { store.set('teamSort', e.target.value); renderTeam(); };
  $('#team-busy').onchange = (e) => { store.set('teamBusy', e.target.checked); renderTeam(); };
  for (const el of $$('.person-card')) {
    const name = el.dataset.person;
    const save = async (body) => { try { await api.put('/people/focus', { name, ...body }); return true; } catch (err) { toast(err.message, 'error'); return false; } };
    const na = el.querySelector('.pc-next'); let t = null;
    const saveNa = async () => { clearTimeout(t); if (na.value.trim() === (na.dataset.saved ?? na.defaultValue)) return; if (await save({ next_action: na.value })) { na.dataset.saved = na.value.trim(); na.classList.add('saved'); setTimeout(() => na.classList.remove('saved'), 900); } };
    na.oninput = () => { clearTimeout(t); t = setTimeout(saveNa, 1200); }; na.onchange = saveNa; na.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); na.blur(); } };
    el.querySelector('.pc-colour').onchange = async (e) => { if (await save({ colour: e.target.value })) { await loadPersonColours(); renderTeam(); } };
    el.onclick = async (e) => {
      const go = e.target.closest('[data-team-go]'); if (!go) return;
      const g = go.dataset.teamGo;
      if (g === 'home') { store.set('homePerson', name); location.hash = '#/dashboard'; }
      if (g === 'tasks') { store.set('tasksScope', 'all'); store.set('tasksPerson', name); store.set('tasksProject', ''); location.hash = '#/tasks'; }
      if (g === 'board') { store.set('boardPerson', name); location.hash = '#/kanban'; }
      if (g === 'colour-reset' && await save({ colour: '' })) { await loadPersonColours(); renderTeam(); }
    };
  }
}
