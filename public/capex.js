// 💶 CAPEX planner: the pending investments and larger projects — what's asked for, why, what it
// costs, when, and where it stands. A detailed Excel export to edit and examine, and PDF one-pagers to
// present: one investment, or the whole plan on a page.

const CAPEX_STATUS_COL = { draft: '#8a8a9a', submitted: '#7382e6', approved: '#238446', ordered: '#0e7490', installed: '#430099', closed: '#555555', rejected: '#c93636', on_hold: '#b86e00' };
const CAPEX_OPEN = ['draft', 'submitted', 'approved', 'ordered', 'on_hold'];
const capexQuarter = (d) => (d ? `${String(d).slice(0, 4)} Q${Math.floor((Number(String(d).slice(5, 7)) - 1) / 3) + 1}` : '');
const capexPill = (st, label) => `<span class="cx-pill" style="--sc:${CAPEX_STATUS_COL[st] || '#888'}">${esc(label || st)}</span>`;

async function renderCapex(openId) {
  const d = await api.get('/capex');
  const S = d.statuses; const cur = state.settings.currency;
  const f = { status: store.get('cxStatus', 'open'), cat: store.get('cxCat', ''), who: store.get('cxWho', ''), year: store.get('cxYear', ''), q: store.get('cxQ', '') };
  const years = [...new Set(d.items.map((x) => String(x.planned_date || '').slice(0, 4)).filter(Boolean))].sort();
  const owners = [...new Set(d.items.map((x) => x.owner).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const list = d.items.filter((x) => (f.status === 'all' || (f.status === 'open' ? CAPEX_OPEN.includes(x.status) : x.status === f.status))
    && (!f.cat || x.category === f.cat) && (!f.who || sameName(x.owner, f.who)) && (!f.year || String(x.planned_date).startsWith(f.year))
    && (!f.q || `${x.ref} ${x.title} ${x.supplier || ''} ${x.department || ''}`.toLowerCase().includes(f.q.toLowerCase())));
  const amt = (xs) => xs.reduce((a, x) => a + (x.amount || 0), 0);
  const mineCur = d.items.filter((x) => (x.currency || cur) === cur); const others = d.items.length - mineCur.length;
  const tile = (label, xs, col, sub) => `<div class="kdb-tile cx-tile" style="border-top-color:${col}"><div class="kdb-tile-l">${label}</div><div class="kdb-tile-v">${money(amt(xs))}</div><div class="kdb-tile-s">${xs.length} investment${xs.length === 1 ? '' : 's'}${sub ? ` · ${sub}` : ''}</div></div>`;
  const yr = String(new Date().getFullYear());
  // the pipeline: one bar, a segment per status, sized by cost
  const open = mineCur.filter((x) => CAPEX_OPEN.includes(x.status)); const openTot = amt(open) || 1;
  const pipe = CAPEX_OPEN.map((st) => [st, amt(open.filter((x) => x.status === st))]).filter(([, v]) => v > 0);
  const row = (x) => `<tr class="clickable" data-cx="${x.id}">
      <td class="nowrap small muted">${esc(x.ref || '')}</td>
      <td><b>${esc(x.title)}</b>${x.next_action && CAPEX_OPEN.includes(x.status) ? `<div class="next-action small">▶ ${esc(x.next_action)}</div>` : ''}</td>
      <td class="small">${esc(x.category)}</td><td>${personChip(x.owner)}</td>
      <td class="nowrap small" title="${esc(fmtDate(x.planned_date))}">${esc(capexQuarter(x.planned_date))}</td>
      <td class="num nowrap"><b>${money(x.amount, x.currency || cur)}</b>${x.actual_cost !== null && x.actual_cost !== undefined ? `<div class="small ${x.actual_cost > x.amount ? 'pl-late' : 'muted'}">actual ${money(x.actual_cost, x.currency || cur)}</div>` : ''}</td>
      <td>${capexPill(x.status, S[x.status])}</td><td>${prioPill(x.priority)}</td>
      <td><a class="icon" href="/api/capex/${x.id}/onepager.pdf" title="One-pager (PDF)" download>📄</a></td></tr>`;
  const qs = new URLSearchParams({ ...(f.status !== 'all' ? { status: f.status } : {}), ...(list.length !== d.items.length ? { ids: list.map((x) => x.id).join(',') } : {}) }).toString();
  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">💶 CAPEX</h1>
      <div class="seg">${[['open', 'Open'], ['all', 'All'], ...Object.entries(S).filter(([k]) => !CAPEX_OPEN.includes(k))].map(([k, l]) => `<button type="button" data-cx-status="${k}" class="${f.status === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="spacer"></div>
      <button class="primary" id="cx-new">＋ New investment</button>
      ${ddMenu('⋯', `<a href="/api/capex/export.xlsx?${qs}" download>⬇ Excel — the register to edit and examine</a><a href="/api/capex/overview.pdf?${qs}" download>📄 The plan on a page (PDF)</a>`, { title: 'Excel export, PDF one-pager' })}
    </div>
    <div class="kdb-tiles pl-tiles">
      ${tile('Pending decision', mineCur.filter((x) => ['draft', 'submitted', 'on_hold'].includes(x.status)), '#7382e6', 'draft, submitted or on hold')}
      ${tile('Approved, not ordered', mineCur.filter((x) => x.status === 'approved'), '#238446')}
      ${tile('Committed', mineCur.filter((x) => x.status === 'ordered'), '#0e7490', 'ordered')}
      ${tile(`Delivered ${yr}`, mineCur.filter((x) => ['installed', 'closed'].includes(x.status) && String(x.approved_on || x.planned_date || '').startsWith(yr)), '#430099')}
    </div>
    ${others ? `<div class="kc-note notice notice-info">${others} investment${others === 1 ? ' is' : 's are'} in another currency than ${esc(cur)} — not in the totals above (the Excel summary has a section per currency).</div>` : ''}
    ${pipe.length ? `<div class="card cx-pipe-card"><div class="cx-pipe">${pipe.map(([st, v]) => `<div class="cx-seg" style="flex:${v / openTot};--sc:${CAPEX_STATUS_COL[st]}" title="${esc(S[st])}: ${esc(money(v))}"><span>${esc(S[st])}</span><b>${esc(money(v))}</b></div>`).join('')}</div>
      <div class="small muted" style="margin-top:4px">The open pipeline, ${esc(money(amt(open)))} — by where each investment stands</div></div>` : ''}
    <div class="card">
      <div class="row" style="gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <input type="search" id="cx-q" placeholder="Find…" value="${esc(f.q)}" style="max-width:200px">
        <select id="cx-cat" style="width:auto"><option value="">All categories</option>${[...new Set([...d.categories, ...d.categories_used])].map((c) => `<option ${c === f.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <label class="person-pick" style="margin:0">${f.who ? personDot(f.who) : '👤'}<select id="cx-who"><option value="">Everyone</option>${owners.map((n) => `<option ${sameName(n, f.who) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
        <select id="cx-year" style="width:auto"><option value="">Any year</option>${years.map((y) => `<option ${y === f.year ? 'selected' : ''}>${y}</option>`).join('')}</select>
        <div class="spacer"></div><span class="small muted">${list.length} shown · ${esc(money(amt(list.filter((x) => (x.currency || cur) === cur))))}</span></div>
      ${list.length ? `<div class="kdb-scroll"><table class="log cx-table"><thead><tr><th>Ref</th><th>Investment <span class="small muted">· ▶ next action</span></th><th>Category</th><th>Requested by</th><th>Planned</th><th class="num">Cost</th><th>Status</th><th>Priority</th><th></th></tr></thead>
        <tbody>${list.map(row).join('')}</tbody></table></div>` : `<div class="empty">${d.items.length ? 'Nothing matches.' : 'No investments yet — ＋ New investment to log the first one.'}</div>`}
    </div>`;
  const set = (k, v) => { store.set(k, v); renderCapex(); };
  $$('[data-cx-status]').forEach((b) => { b.onclick = () => set('cxStatus', b.dataset.cxStatus); });
  $('#cx-cat').onchange = (e) => set('cxCat', e.target.value); $('#cx-who').onchange = (e) => set('cxWho', e.target.value); $('#cx-year').onchange = (e) => set('cxYear', e.target.value);
  let qt = null; $('#cx-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { store.set('cxQ', e.target.value); renderCapex().then(() => { const i = $('#cx-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300); };
  $('#cx-new').onclick = () => capexForm(null, d);
  $$('tr[data-cx]').forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a')) return; capexForm(d.items.find((x) => String(x.id) === tr.dataset.cx), d); }; });
  if (openId) { const x = d.items.find((y) => String(y.id) === String(openId)); if (x) capexForm(x, d); }
}

// the form: the essentials first (all needed), then the business case, approval and purchase
function capexForm(x, d) {
  const isNew = !x; x = x || { status: 'draft', priority: 2 }; const S = d.statuses; const cur = state.settings.currency;
  const req = (k) => (d.required[k] ? ' <span class="req">*</span>' : '');
  const names = [...new Set([...state.projects.flatMap((p) => [p.leader, p.sponsor, p.team_names, p.task_owners].flatMap(splitOwners)), ...d.items.flatMap((y) => [y.owner, y.sponsor].filter(Boolean))])].sort((a, b) => a.localeCompare(b));
  const v = (k) => esc(x[k] ?? '');
  openModal(`
    <div class="modal-head"><h2 style="margin:0">💶 ${isNew ? 'New investment' : `${esc(x.ref)} — ${esc(x.title)}`}</h2>${isNew ? '' : `<a class="button small" href="/api/capex/${x.id}/onepager.pdf" download>📄 One-pager</a>`}<button class="icon" data-action="close-modal">✕</button></div>
    <form id="cx-form" class="form-grid">
      <div class="full cx-sec">The essentials <span class="small muted">— <span class="req">*</span> needed to save</span></div>
      <label class="f full">Title${req('title')}<input type="text" name="title" required value="${v('title')}" placeholder="e.g. Second DOD printer for line 3"></label>
      <label class="f">Category${req('category')}<input type="text" name="category" required list="cx-cats" value="${v('category')}" placeholder="Pick or type"><datalist id="cx-cats">${d.categories.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="f">Requested by${req('owner')}<input type="text" name="owner" required list="cx-names" value="${v('owner')}"><datalist id="cx-names">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></label>
      <label class="f">Planned date${req('planned_date')}<input type="date" name="planned_date" required value="${v('planned_date')}"></label>
      <label class="f"><span class="f-l">Estimated cost (<span id="cx-cur">${esc(x.currency || cur)}</span>)${req('amount')}</span><input type="number" name="amount" required min="0" step="0.01" value="${v('amount')}"></label>
      <label class="f" title="Blank: the app's (${esc(cur)})">Currency<input type="text" name="currency" maxlength="5" list="cx-curs" value="${v('currency')}" placeholder="${esc(cur)}" style="max-width:120px">${curList('cx-curs')}</label>
      <label class="f">Status<select name="status">${Object.entries(S).map(([k, l]) => `<option value="${k}" ${k === x.status ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
      <label class="f full">Business justification${req('justification')} <span class="small muted">— why it's needed, what it brings</span><textarea name="justification" required rows="3">${v('justification')}</textarea></label>
      <div class="full cx-sec">The business case</div>
      <label class="f">Priority<select name="priority">${options(PRIORITY, x.priority || 2)}</select></label>
      <label class="f">Sponsor<input type="text" name="sponsor" list="cx-names" value="${v('sponsor')}"></label>
      <label class="f">Department<input type="text" name="department" value="${v('department')}"></label>
      <label class="f">Annual saving<input type="number" name="annual_saving" min="0" step="0.01" value="${v('annual_saving')}"></label>
      <label class="f" title="Worked out from the saving when blank">Payback (months)<input type="number" name="payback_months" min="0" step="0.1" value="${v('payback_months')}" placeholder="from the saving"></label>
      <label class="f">Linked project<select name="project_id"><option value="">—</option>${state.projects.map((p) => `<option value="${p.id}" ${p.id === x.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
      <label class="f full">Description<textarea name="description" rows="2">${v('description')}</textarea></label>
      <label class="f full">Risk if not done<textarea name="risk_if_not" rows="2">${v('risk_if_not')}</textarea></label>
      <label class="f full">▶ Next action <span class="small muted">— one line, the talking point for the next review</span><input type="text" name="next_action" maxlength="300" value="${v('next_action')}"></label>
      <div class="full cx-sec">Approval and purchase</div>
      <label class="f">Supplier<input type="text" name="supplier" value="${v('supplier')}"></label>
      <label class="f">Quote reference<input type="text" name="quote_ref" value="${v('quote_ref')}"></label>
      <label class="f">Approved on<input type="date" name="approved_on" value="${v('approved_on')}"></label>
      <label class="f">Approved by<input type="text" name="approved_by" list="cx-names" value="${v('approved_by')}"></label>
      <label class="f">PO number<input type="text" name="po_number" value="${v('po_number')}"></label>
      <label class="f">Actual cost<input type="number" name="actual_cost" min="0" step="0.01" value="${v('actual_cost')}"></label>
      <label class="f full">Notes<textarea name="notes" rows="2">${v('notes')}</textarea></label>
      <div class="full row">${isNew ? '' : '<button type="button" class="danger" id="cx-del">Delete…</button>'}<div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button>
        <button class="primary" type="submit">${isNew ? 'Add investment' : 'Save'}</button></div>
    </form>`);
  // a label's text (with its * and hint) in one piece above its box
  for (const l of $$('#cx-form label.f')) { const first = l.querySelector('input, select, textarea'); if (!first || l.firstElementChild?.classList.contains('f-l')) continue;
    const span = document.createElement('span'); span.className = 'f-l'; while (l.firstChild && l.firstChild !== first) span.append(l.firstChild); l.prepend(span); }
  $('#cx-form [name=currency]').oninput = (e) => { $('#cx-cur').textContent = e.target.value.trim() || cur; };
  $('#cx-form').onsubmit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try { if (isNew) await api.post('/capex', body); else await api.patch(`/capex/${x.id}`, body); closeModal(); toast(isNew ? 'Investment added' : 'Saved'); renderCapex(); } catch (err) { toast(err.message, 'error'); }
  };
  const del = $('#cx-del'); if (del) del.onclick = async () => { if (!confirm(`Delete ${x.ref} “${x.title}”? (The activity log keeps a record.)`)) return; try { await api.del(`/capex/${x.id}`); closeModal(); renderCapex(); } catch (err) { toast(err.message, 'error'); } };
  $('#cx-form [name=title]').focus();
}
