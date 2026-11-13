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
  // folded branches (kept in this browser), and how big it's drawn
  const folded = new Set((() => { try { return store.get('orgFolded', []) || []; } catch { return []; } })());
  const card = (n, cls = 'org-node') => {
    const ks = kids.get(key(n)) || []; const all = below(n); const shut = ks.length && folded.has(key(n));
    return `<div class="${cls}" ${edit ? 'draggable="true"' : ''} data-org-person="${esc(n)}" data-org-drop="${esc(n)}" title="${edit ? `Drag onto someone to move ${esc(n)} (and everyone below) under them` : esc(n)}">
        ${personDot(n)}<div class="org-name"><b>${esc(n)}</b><span class="small muted">${esc(dept.get(key(n)) || '')}</span></div>
        ${all ? `<button type="button" class="org-count${shut ? ' shut' : ''}" data-org-fold="${esc(n)}" title="${ks.length} report${ks.length === 1 ? 's' : ''} directly, ${all} in all — click to ${shut ? 'unfold' : 'fold'} them">${shut ? `▸ +${all}` : `▾ ${ks.length}${all > ks.length ? `·${all}` : ''}`}</button>` : ''}
        ${edit ? `<button type="button" class="icon org-x" data-org-out="${esc(n)}" title="Take ${esc(n)} out of the tree (their people move up to their manager)">✕</button>` : ''}</div>`;
  };
  const node = (n) => {
    const ks = kids.get(key(n)) || [];
    if (!ks.length || folded.has(key(n))) return `<li>${card(n)}</li>`;
    // everyone under them has no one under them: one compact team box, not a wide row of cards
    if (ks.length > 1 && ks.every((k) => !(kids.get(key(k)) || []).length)) return `<li>${card(n)}<ul class="org-team-wrap"><li><div class="org-team">${ks.map((k) => card(k, 'org-row')).join('')}</div></li></ul></li>`;
    return `<li>${card(n)}<ul>${ks.map(node).join('')}</ul></li>`;
  };
  let zoom = Number(store.get('orgZoom', 1)) || 1;
  const tops = kids.get('') || [];
  const pool = d.people.filter((p) => !inTree.has(key(p.name)));
  root.innerHTML = `<div class="card org-card">
    <div class="row"><h2 style="margin:0">🌳 Management tree</h2><span class="small muted">${d.links.length} in it</span><div class="spacer"></div>
      ${edit ? '' : '<span class="small muted">Only an admin changes it</span>'}</div>
    <p class="small muted">Who reports to whom. A manager sees the <b>open tasks of everyone below them</b>, directly or through others (in 👥 People and ✅ Tasks), and anyone with someone below them sees all 💶 CAPEX.
      ${edit ? 'Drag a person onto someone to put them (and everyone below them) under that person; onto the top line to put them at the top; back to <i>Not in the tree</i> to take them out.' : ''}</p>
    ${edit ? '<div class="org-top" data-org-drop="">⤒ Drop here to put someone at the top</div>' : ''}
    ${tops.length ? `<div class="row org-tools small"><span class="seg"><button type="button" data-org-zoom="-1" title="Smaller">−</button><button type="button" data-org-zoom="0" title="Back to full size">${Math.round(zoom * 100)}%</button><button type="button" data-org-zoom="1" title="Bigger">＋</button><button type="button" data-org-zoom="fit" title="Fit the whole tree to the width of the page">⤢ Fit</button></span>
      <button type="button" class="link small" data-org-foldall="1">▸ Fold all</button><button type="button" class="link small" data-org-foldall="0">▾ Unfold all</button></div>` : ''}
    <div class="org-scroll">${tops.length ? `<div class="org-canvas" style="zoom:${zoom}"><ul class="org org-root">${tops.map(node).join('')}</ul></div>` : `<div class="empty small">${edit ? 'Nobody in the tree yet: drag the site manager from below to the top line, then their team onto them.' : 'Nobody in the tree yet.'}</div>`}</div>
    ${edit ? `<div class="org-pool" data-org-drop="-"><div class="row"><b class="small">Not in the tree</b> <span class="small muted">${pool.length}</span><div class="spacer"></div>
        <select class="org-dept" title="One department"><option value="">All departments</option>${[...new Set(pool.map((p) => p.department).filter(Boolean))].sort().map((x) => `<option>${esc(x)}</option>`).join('')}</select>
        <input type="search" class="org-find" placeholder="Find…" autocomplete="off" style="max-width:180px"></div>
      <div class="org-chips">${pool.map((p) => `<span class="org-chip" draggable="true" data-org-person="${esc(p.name)}" data-find="${esc(`${p.name} ${p.department || ''}`.toLowerCase())}" data-dept="${esc((p.department || '').toLowerCase())}" title="Drag into the tree">${personDot(p.name)} ${esc(p.name)}${p.department ? ` <span class="small muted">${esc(p.department)}</span>` : ''}</span>`).join('') || '<span class="small muted">Everyone in the contacts is in the tree.</span>'}</div></div>` : ''}
  </div>`;
  const setFolded = (list) => { try { store.set('orgFolded', [...list]); } catch { /* not kept */ } renderOrgTree(root); };
  root.querySelectorAll('[data-org-fold]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); const k = key(b.dataset.orgFold); folded.has(k) ? folded.delete(k) : folded.add(k); setFolded(folded); }));
  root.querySelectorAll('[data-org-foldall]').forEach((b) => b.addEventListener('click', () => setFolded(b.dataset.orgFoldall === '1' ? [...kids.keys()].filter(Boolean) : [])));
  const scroller = root.querySelector('.org-scroll'); const canvas = root.querySelector('.org-canvas');
  const setZoom = (z) => { try { store.set('orgZoom', Math.max(0.3, Math.min(1.5, Math.round(z * 100) / 100))); } catch { /* not kept */ } renderOrgTree(root); };
  root.querySelectorAll('[data-org-zoom]').forEach((b) => b.addEventListener('click', () => {
    const v = b.dataset.orgZoom;
    if (v === 'fit' && canvas) setZoom(zoom * (scroller.clientWidth - 12) / (treeWidth() || 1));
    else setZoom(v === '0' ? 1 : zoom + Number(v) * 0.1);
  }));
  // the tree's own drawn width (its top-level branches side by side), whatever the zoom
  const treeWidth = () => [...(root.querySelector('.org-root')?.children || [])].reduce((a, li) => a + li.getBoundingClientRect().width, 0);
  // start in the middle (the top of the tree), as it's drawn centred
  if (scroller && canvas && treeWidth() > scroller.clientWidth) scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
  const poolFilter = () => { const q = (root.querySelector('.org-find')?.value || '').trim().toLowerCase(); const dp = (root.querySelector('.org-dept')?.value || '').toLowerCase();
    root.querySelectorAll('.org-chip').forEach((c) => { c.hidden = (!!q && !c.dataset.find.includes(q)) || (!!dp && c.dataset.dept !== dp); }); };
  root.querySelector('.org-dept')?.addEventListener('change', poolFilter);
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
  root.querySelector('.org-find')?.addEventListener('input', poolFilter);
}
