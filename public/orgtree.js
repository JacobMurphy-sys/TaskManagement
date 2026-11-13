// 🌳 The management tree (📇 Contacts): who reports to whom, as a chart joined by lines. Drag a person onto someone
// to put them under that person, onto the top line to put them at the top, or back to "Not in the tree" to take them
// out (whoever reported to them moves up to their manager). A manager sees the open tasks of everyone below them
// (directly or through others); anyone with someone below them sees all 💶 CAPEX. Only an admin changes it.

async function renderOrgTree(root) {
  if (!root) return;
  let d;
  try { d = await api.get('/org'); } catch (err) { root.innerHTML = `<div class="card"><h2>🌳 Management tree</h2><div class="small muted">${esc(err.message)}</div></div>`; return; }
  const key = (n) => String(n || '').trim().toLowerCase();
  const dept = new Map(d.people.map((p) => [key(p.name), p.department]));
  const kids = new Map(); const inTree = new Set(d.links.map((l) => key(l.person)));
  for (const l of d.links) { const m = l.manager && inTree.has(key(l.manager)) ? key(l.manager) : ''; if (!kids.has(m)) kids.set(m, []); kids.get(m).push(l.person); }
  const below = (n) => { let c = 0; const st = [key(n)]; const seen = new Set(); while (st.length) for (const k of kids.get(st.pop()) || []) if (!seen.has(key(k))) { seen.add(key(k)); c++; st.push(key(k)); } return c; };
  const edit = d.can_edit;
  const node = (n) => {
    const ks = kids.get(key(n)) || []; const all = below(n);
    return `<li><div class="org-node" ${edit ? 'draggable="true"' : ''} data-org-person="${esc(n)}" data-org-drop="${esc(n)}" title="${edit ? `Drag onto someone to move ${esc(n)} (and everyone below) under them` : esc(n)}">
        ${personDot(n)}<div class="org-name"><b>${esc(n)}</b><span class="small muted">${esc(dept.get(key(n)) || '')}</span></div>
        ${all ? `<span class="org-count" title="${all} below, directly or through others">${ks.length}${all > ks.length ? `·${all}` : ''}</span>` : ''}
        ${edit ? `<button type="button" class="icon org-x" data-org-out="${esc(n)}" title="Take ${esc(n)} out of the tree (their people move up to their manager)">✕</button>` : ''}</div>
      ${ks.length ? `<ul>${ks.map(node).join('')}</ul>` : ''}</li>`;
  };
  const tops = kids.get('') || [];
  const pool = d.people.filter((p) => !inTree.has(key(p.name)));
  root.innerHTML = `<div class="card org-card">
    <div class="row"><h2 style="margin:0">🌳 Management tree</h2><span class="small muted">${d.links.length} in it</span><div class="spacer"></div>
      ${edit ? '' : '<span class="small muted">Only an admin changes it</span>'}</div>
    <p class="small muted">Who reports to whom. A manager sees the <b>open tasks of everyone below them</b>, directly or through others (in 👥 People and ✅ Tasks), and anyone with someone below them sees all 💶 CAPEX.
      ${edit ? 'Drag a person onto someone to put them (and everyone below them) under that person; onto the top line to put them at the top; back to <i>Not in the tree</i> to take them out.' : ''}</p>
    ${edit ? '<div class="org-top" data-org-drop="">⤒ Drop here to put someone at the top</div>' : ''}
    <div class="org-scroll">${tops.length ? `<ul class="org org-root">${tops.map(node).join('')}</ul>` : `<div class="empty small">${edit ? 'Nobody in the tree yet: drag the site manager from below to the top line, then their team onto them.' : 'Nobody in the tree yet.'}</div>`}</div>
    ${edit ? `<div class="org-pool" data-org-drop="-"><div class="row"><b class="small">Not in the tree</b> <span class="small muted">${pool.length}</span><div class="spacer"></div>
        <input type="search" class="org-find" placeholder="Find…" autocomplete="off" style="max-width:180px"></div>
      <div class="org-chips">${pool.map((p) => `<span class="org-chip" draggable="true" data-org-person="${esc(p.name)}" data-find="${esc(`${p.name} ${p.department || ''}`.toLowerCase())}" title="Drag into the tree">${personDot(p.name)} ${esc(p.name)}${p.department ? ` <span class="small muted">${esc(p.department)}</span>` : ''}</span>`).join('') || '<span class="small muted">Everyone in the contacts is in the tree.</span>'}</div></div>` : ''}
  </div>`;
  if (!edit) return;
  const save = async (person, to) => {
    try {
      if (to === '-') await api.del(`/org/${encodeURIComponent(person)}`);
      else await api.put(`/org/${encodeURIComponent(person)}`, { manager: to || null });
      toast(to === '-' ? `${person} taken out of the tree` : to ? `${person} now reports to ${to}` : `${person} at the top`);
    } catch (err) { toast(err.message, 'error'); }
    renderOrgTree(root);
  };
  let dragging = null;
  root.querySelectorAll('[data-org-person][draggable]').forEach((el) => {
    el.addEventListener('dragstart', (e) => { dragging = el.dataset.orgPerson; e.dataTransfer.setData('text/plain', dragging); el.classList.add('dragging'); e.stopPropagation(); });
    el.addEventListener('dragend', () => { el.classList.remove('dragging'); root.querySelectorAll('.drag-over').forEach((x) => x.classList.remove('drag-over')); });
  });
  root.querySelectorAll('[data-org-drop]').forEach((el) => {
    el.addEventListener('dragover', (e) => { if (!dragging || key(el.dataset.orgDrop) === key(dragging)) return; e.preventDefault(); e.stopPropagation(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over'); });
    el.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over'); const p = dragging || e.dataTransfer.getData('text/plain'); dragging = null; if (p && key(p) !== key(el.dataset.orgDrop)) save(p, el.dataset.orgDrop); });
  });
  root.querySelectorAll('[data-org-out]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); save(b.dataset.orgOut, '-'); }));
  root.querySelector('.org-find')?.addEventListener('input', (e) => { const q = e.target.value.trim().toLowerCase(); root.querySelectorAll('.org-chip').forEach((c) => { c.hidden = !!q && !c.dataset.find.includes(q); }); });
}
