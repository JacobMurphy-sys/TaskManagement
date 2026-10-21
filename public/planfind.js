// 🔍 Planning search (src/planfind.js): a bar floating over the Planning page to find a work order or a
// card (AX) and open what's known about it — its lines, where it is in the plan, its history and runs.
// Shown on Planning only (route() calls planFindBar); press F to jump to it. renderPlanning() leaves the
// plan it drew in planNow, so an open work order also shows its place in the queue and its projection.
let planNow = null;
let pfCurrent = null; // the work order or card shown in the window
let pfTimer = null; let pfSeq = 0; let pfList = []; let pfActive = -1;
const pfBack = []; // the views opened before this one in the window, for ← Back

function planFindBar(show) {
  let bar = $('#pf-bar');
  if (!show) { if (bar) bar.hidden = true; return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'pf-bar'; bar.className = 'pf-bar';
    bar.innerHTML = `<div class="pf-list" hidden></div>
      <label class="pf-box"><span>🔍</span><input type="search" autocomplete="off" spellcheck="false" placeholder="Find a work order or card (AX)…" aria-label="Find a work order or card">
        <kbd title="Press F to search">F</kbd></label>`;
    document.body.append(bar);
    const input = $('input', bar);
    input.addEventListener('input', () => { clearTimeout(pfTimer); pfTimer = setTimeout(() => pfSuggest(input.value), 160); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!pfList.length) return; pfActive = (pfActive + (e.key === 'ArrowDown' ? 1 : -1) + pfList.length) % pfList.length; pfDrawList(); }
      else if (e.key === 'Enter') { e.preventDefault(); const s = pfList[Math.max(0, pfActive)]; if (s) pfPick(s); else if (input.value.trim().length >= 2) pfOpen('wo', input.value.trim()); }
      else if (e.key === 'Escape') { pfClose(); input.blur(); }
    });
    input.addEventListener('focus', () => { if (pfList.length) $('.pf-list', bar).hidden = false; });
    $('.pf-list', bar).addEventListener('mousedown', (e) => { const li = e.target.closest('[data-pf-i]'); if (li) { e.preventDefault(); pfPick(pfList[Number(li.dataset.pfI)]); } });
    document.addEventListener('mousedown', (e) => { if (!e.target.closest('#pf-bar')) $('.pf-list', bar).hidden = true; });
    document.addEventListener('keydown', (e) => {
      if (bar.hidden || e.key.toLowerCase() !== 'f' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest('input, textarea, select, [contenteditable="true"]') || $('#modal').open) return;
      e.preventDefault(); input.focus(); input.select();
    });
  }
  bar.hidden = false;
}
const pfClose = () => { const l = $('#pf-bar .pf-list'); if (l) l.hidden = true; };
async function pfSuggest(q) {
  const seq = ++pfSeq;
  if (q.trim().length < 2) { pfList = []; pfDrawList(); return; }
  let list; try { list = await api.get(`/plan/find?q=${encodeURIComponent(q.trim())}`); } catch { return; }
  if (seq !== pfSeq) return; // a newer search has gone out
  pfList = list; pfActive = list.length ? 0 : -1; pfDrawList(q.trim());
}
function pfDrawList(q = $('#pf-bar input').value.trim()) {
  const box = $('#pf-bar .pf-list');
  if (!q || q.length < 2) { box.hidden = true; return; }
  box.innerHTML = pfList.length ? pfList.map((s, i) => `<div class="pf-item ${i === pfActive ? 'on' : ''}" data-pf-i="${i}"><span class="pf-kind">${s.kind === 'wo' ? '📦 WO' : '💳 Card'}</span>
      <b>${esc(s.label)}</b>${s.open ? ' <span class="pf-open">open</span>' : ''}<div class="small muted">${esc(s.sub || '')}</div></div>`).join('')
    : `<div class="pf-none small muted">Nothing found for “${esc(q)}”. Enter looks it up as a work order anyway.</div>`;
  box.hidden = false;
}
function pfPick(s) { pfClose(); pfBack.length = 0; pfOpen(s.kind, s.key); }

// ---- the window ----------------------------------------------------------------------------------
const pfN = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB'));
const pfWhen = (iso) => (iso ? fmtDateTime(iso) : '—');
const pfTile = (l, v, sub = '') => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${v}</div>${sub ? `<div class="kdb-tile-s">${sub}</div>` : ''}</div>`;
const pfWoLink = (wo) => `<a href="#" data-pf-wo="${esc(wo)}">${esc(wo)}</a>`;
const pfItemLink = (ax) => (ax ? `<a href="#" data-pf-item="${esc(ax)}">${esc(ax)}</a>` : '—');
const pfKind = (c) => (c ? [c.type, c.material, c.sides].filter(Boolean).map(esc).join(' · ') : '');
function pfRunsTable(runs, { item = true, job = false } = {}) {
  if (!runs.length) return '<p class="small muted">No runs in the ⏱ Production timing reports.</p>';
  return `<div class="kdb-scroll pf-scroll"><table class="log pll-t"><thead><tr><th></th>${job ? '<th>Job</th>' : ''}<th>Machine</th><th>Started</th><th>Ended</th>${item ? '<th>Card</th>' : ''}<th class="num">Cards</th><th class="num">Took</th><th class="num">Cards/h</th></tr></thead><tbody>
    ${runs.map((r) => `<tr><td class="small muted">${r.source === 'otto' ? 'Matching' : 'Perso'}${r.remake ? ' · <span class="pl-late">remake</span>' : ''}</td>${job ? `<td>${pfWoLink(r.wo)}${r.job !== r.wo ? ` <span class="small muted">${esc(r.job)}</span>` : ''}</td>` : ''}<td>${esc(r.machine || '—')}</td>
      <td class="small">${esc(pfWhen(r.start_at))}</td><td class="small">${esc(pfWhen(r.end_at))}</td>${item ? `<td>${pfItemLink(r.item)}${r.item_name ? ` <span class="small muted">${esc(r.item_name)}</span>` : ''}</td>` : ''}
      <td class="num">${pfN(r.qty)}</td><td class="num">${r.minutes === null ? '—' : fmtSpan(r.minutes)}</td><td class="num">${pfN(r.per_hour)}</td></tr>`).join('')}
  </tbody></table></div>`;
}
const pfHead = (title, sub = '') => `<div class="modal-head"><h2 style="margin:0">${pfBack.length ? `<button type="button" class="small" data-pf-back title="Back to ${esc(pfBack[pfBack.length - 1].key)}">← Back</button> ` : ''}${title}</h2><button class="icon" data-action="close-modal">✕</button></div>${sub ? `<p class="muted" style="margin-top:2px">${sub}</p>` : ''}`;

async function pfOpen(kind, key, { push = false, scroll = 0 } = {}) {
  if (push && pfCurrent) pfBack.push({ ...pfCurrent, scroll: $('#modal').scrollTop });
  pfCurrent = { kind, key };
  if (!$('#modal').open || !$('#pfx')) { openModal('<div id="pfx" class="pfx"><p class="muted">Looking it up…</p></div>', { wide: true }); $('#pfx').addEventListener('click', pfClick); }
  let d; try { d = await api.get(`/plan/find/${kind}/${encodeURIComponent(key)}`); } catch (err) { $('#pfx').innerHTML = `${pfHead('🔍 Not found')}<p>${esc(err.message)}</p>`; return; }
  $('#pfx').innerHTML = kind === 'wo' ? pfWoHtml(d) : pfItemHtml(d);
  $('#modal').scrollTop = scroll; // back: where you were
}
function pfClick(e) {
  const wo = e.target.closest('[data-pf-wo]'); const it = e.target.closest('[data-pf-item]');
  if (wo || it) { e.preventDefault(); pfOpen(wo ? 'wo' : 'item', wo ? wo.dataset.pfWo : it.dataset.pfItem, { push: true }); return; }
  if (e.target.closest('[data-pf-back]')) { const prev = pfBack.pop(); if (prev) { pfCurrent = null; pfOpen(prev.kind, prev.key, { scroll: prev.scroll }); } return; }
  const x = e.target.closest('[data-pf-explode]');
  if (x) {
    const here = { ...pfCurrent, scroll: $('#modal').scrollTop };
    pllExplode({ ...JSON.parse(x.dataset.pfExplode), days: 365 }, { back: { label: here.kind === 'wo' ? `work order ${here.key}` : `card ${here.key}`, go: () => pfOpen(here.kind, here.key, { scroll: here.scroll }) } });
  }
}

// How many of each card: exact from the export (or as recorded from it), else estimated from the runs.
function pfMakeupHtml(m) {
  if (!m || !m.cards.length) return '';
  const est = m.basis === 'runs';
  const why = m.basis === 'export' ? 'from the open work orders export'
    : m.basis === 'recorded' ? 'as recorded from the export while it was open'
      : m.basis === 'runs' ? `<b>estimated</b> from its production runs: each card's share of the cards run (remakes left out)${m.history_total ? `, applied to the ${pfN(m.history_total)} cards the work order had` : ' — no total was recorded, so these are the cards run'}`
        : 'no card lines known — only what ran';
  const maxShare = Math.max(1, ...m.cards.map((c) => c.share || 0));
  return `<h3 class="pl-h">Cards in it <span class="muted small">${m.cards.length} card${m.cards.length === 1 ? '' : 's'}${m.total ? ` · ${est ? '≈ ' : ''}${pfN(m.total)} in all` : ''} — ${why}</span></h3>
    <div class="kdb-scroll pf-scroll"><table class="log pll-t"><thead><tr><th>Card (AX)</th><th>Card</th><th class="num">${est ? '≈ ' : ''}Cards</th><th>Share</th><th class="num" title="Cards run in the ⏱ Production runs, remakes apart">Run</th><th class="num">Remade</th><th class="num">Runs</th></tr></thead><tbody>
      ${m.cards.map((c) => `<tr><td>${pfItemLink(c.article)}</td><td class="small">${c.card ? `${esc(c.card.name || '')} <span class="muted">${pfKind(c.card)}</span>` : '<span class="muted">not in the card database</span>'}</td>
        <td class="num"><b>${c.qty === null ? '<span class="muted" title="Ran, but not in the work order\'s lines">—</span>' : `${est ? '≈ ' : ''}${pfN(c.qty)}`}</b></td>
        <td>${c.share === null ? '' : `<div class="pllx-share"><div class="pll-track"><div style="width:${(c.share / maxShare) * 100}%"></div></div><span>${c.share}%</span></div>`}</td>
        <td class="num">${c.runs ? pfN(c.run) : '<span class="muted">—</span>'}</td><td class="num">${c.remade ? `<span class="pl-late">${pfN(c.remade)}</span>` : ''}</td><td class="num">${c.runs || ''}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function pfWoHtml(d) {
  if (!d.found) return `${pfHead(`🔍 ${esc(d.wo)}`)}<p>No work order <b>${esc(d.wo)}</b> in the open work orders, the Matching export, the plan history or the production runs.</p>`;
  // where it is in the plan drawn on the page (open work orders only)
  const all = planNow ? [...planNow.running, ...planNow.queue] : [];
  const jobs = all.filter((j) => String(j.wo).toUpperCase() === d.wo);
  const pos = (j) => { const q = planNow.queue.indexOf(j); return j.running ? 'running' : q >= 0 ? `#${q + 1} of ${planNow.queue.length} waiting` : '—'; };
  const done = d.history.length && d.history.every((h) => h.done_at) && !d.open.length;
  const status = d.open.some((l) => /progress/i.test(l.status || '')) ? '<span class="pf-chip run">Running</span>' : d.open.length ? '<span class="pf-chip open">Open</span>'
    : done ? '<span class="pf-chip done">Done</span>' : d.runs.length ? '<span class="pf-chip done">Ran · not open now</span>' : '<span class="pf-chip">Not in the open export</span>';
  const projected = jobs.some((j) => j.start_at || j.finish_at);
  const lateText = (m) => (m === null || m === undefined ? '—' : m > 0 ? `<span class="pl-late">${fmtSpan(m)} late</span>` : `<span class="pl-ok">on time${m < 0 ? ` (${fmtSpan(-m)} spare)` : ''}</span>`);
  const P = d.perso; const O = d.otto;
  return `${pfHead(`📦 ${esc(d.wo)} ${status}`, [d.customer ? `<b>${esc(d.customer)}</b>${d.customer_name ? ` ${esc(d.customer_name)}` : ''}` : '', d.open[0] ? `due ${esc(fmtDate(`${d.open[0].due}T12:00`))}${d.open[0].cutoff ? ` at ${esc(d.open[0].cutoff)}` : ''}` : '', d.open[0]?.shipper ? `🚚 ${esc(d.open[0].shipper)}` : '', d.open[0]?.prio ? `${esc(d.open[0].prio)} priority` : ''].filter(Boolean).join(' · '))}
    ${jobs.length ? `<h3 class="pl-h">In the plan now</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Job</th><th>Place</th><th class="num">Cards</th><th>Deadline</th>${projected ? '<th>Machines</th><th>Starts</th><th>Finishes</th><th>Against the deadline</th>' : ''}</tr></thead><tbody>
      ${jobs.map((j) => `<tr><td><b>${esc(j.per || j.key)}</b>${j.pinned ? ' 📌' : ''}</td><td>${pos(j)}</td><td class="num">${pfN(j.qty)}</td><td class="small">${esc(j.deadline ? fmtDateTime(j.deadline) : '—')}</td>
        ${projected ? `<td class="small">${esc((j.machines || []).join(', ') || j.machine_planned || '—')}</td><td class="small">${esc(pfWhen(j.start_at))}</td><td class="small">${esc(pfWhen(j.finish_at))}</td><td>${j.unplanned ? '<span class="pl-warn">not planned</span>' : lateText(j.late_minutes)}</td>` : ''}</tr>`).join('')}
    </tbody></table></div>${projected ? '' : '<p class="small muted">Starts, finishes and machines show here once the plan has speeds to project with (⚙ Setup).</p>'}` : ''}
    ${pfMakeupHtml(d.makeup)}
    ${d.open.length ? `<h3 class="pl-h">Lines in the open work orders <span class="muted small">${d.open.length}</span></h3><div class="kdb-scroll pf-scroll"><table class="log pll-t"><thead><tr><th>PER</th><th>Card (AX)</th><th>Card</th><th class="num">Cards</th><th>Status</th><th>Due</th><th>Group</th></tr></thead><tbody>
      ${d.open.map((l) => `<tr><td>${esc(l.per)}</td><td>${pfItemLink(l.article)}</td><td class="small">${l.card ? `${esc(l.card.name || '')} <span class="muted">${pfKind(l.card)}</span>` : '<span class="muted">not in the card database</span>'}</td>
        <td class="num">${pfN(l.qty)}</td><td class="small">${esc(l.status || '')}</td><td class="small">${esc(l.due || '')}</td><td class="small">${esc(l.group || '')}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${d.matching.length ? `<h3 class="pl-h">Matching</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Job</th><th class="num">Items</th><th>Status</th><th>Plan date</th><th>Machine</th></tr></thead><tbody>
      ${d.matching.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${pfN(m.qty)}</td><td class="small">${m.done ? '✔ ' : ''}${esc(m.status || '')}</td><td class="small">${esc(m.due || '')}</td><td class="small">${esc(m.machine || '—')}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${d.history.length ? `<h3 class="pl-h">Plan history <span class="muted small">— from each version of the open work orders export</span></h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Job</th><th class="num">Cards</th><th>First seen</th><th>Started</th><th>Done</th><th>Deadline</th><th>Against it</th></tr></thead><tbody>
      ${d.history.map((h) => `<tr><td>${esc(h.per || h.key)}</td><td class="num">${pfN(h.qty)}</td><td class="small">${esc(pfWhen(h.first_seen))}</td><td class="small">${esc(pfWhen(h.started_at))}</td><td class="small">${esc(h.done_at ? fmtDateTime(h.done_at) : 'not yet')}</td>
        <td class="small">${esc(h.deadline ? fmtDateTime(h.deadline) : '—')}</td><td>${h.done_at ? lateText(h.late_minutes) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    <h3 class="pl-h">Production runs</h3>
    ${P.runs || O.runs ? `<div class="kdb-tiles">${pfTile('Perso runs', pfN(P.runs), P.machines.join(', '))}${pfTile('Cards run', pfN(P.cards), P.remade ? `${pfN(P.remade)} remade` : '')}${pfTile('Time', P.minutes ? fmtSpan(P.minutes) : '—', P.per_hour ? `${pfN(P.per_hour)} cards/h` : '')}
      ${pfTile('First → last', P.first ? esc(fmtShortDate(P.first)) : '—', P.last ? `to ${esc(fmtDateTime(P.last))}` : '')}${O.runs ? pfTile('Matching runs', pfN(O.runs), `${pfN(O.cards)} items · ${O.minutes ? fmtSpan(O.minutes) : '—'}`) : ''}</div>` : ''}
    ${pfRunsTable(d.runs)}`;
}

function pfItemHtml(d) {
  if (!d.found) return `${pfHead(`🔍 ${esc(d.label)}`)}<p>No card <b>${esc(d.label)}</b> in the card database, the open work orders or the production runs.</p>`;
  const c = d.card; const T = d.total; const L = d.learned;
  const fields = c ? [['Type', c.type], ['Material', c.material], ['Print sides', c.sides], ['Customer', c.customer], ['Trigram', c.trigram], ['Provider', c.provider], ['PersoCode', c.persocode], ['Tag', c.tag], ['Front DoD', c.front], ['Back DoD', c.back]].filter(([, v]) => v) : [];
  const fromText = { card: `its own ${L?.runs} run${L?.runs === 1 ? '' : 's'} (with its kind)`, kind: `its kind of card (${L?.runs} runs) — none of its own yet`, all: 'all runs — no history for it or its kind' };
  const runItem = d.runs[0]?.item;
  const group = (rows, label) => (rows.length ? `<div><h3 class="pl-h">${label}</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>${label.replace(/^By /, '').replace(/^./, (x) => x.toUpperCase())}</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Time</th><th class="num">Cards/h</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.machine || r.customer)}</b></td><td class="num">${pfN(r.runs)}</td><td class="num">${pfN(r.cards)}</td><td class="num">${r.minutes ? fmtSpan(r.minutes) : '—'}</td><td class="num">${pfN(r.per_hour)}</td></tr>`).join('')}
  </tbody></table></div></div>` : '');
  return `${pfHead(`💳 ${esc(d.label)}${d.name ? ` <span class="muted" style="font-weight:normal">${esc(d.name)}</span>` : ''}`, c ? pfKind(c) || 'in the card database' : '<span class="pl-warn">not in the card database</span>')}
    ${fields.length ? `<div class="pf-fields">${fields.map(([k, v]) => `<div><span class="small muted">${k}</span><b>${esc(v)}</b></div>`).join('')}</div>` : ''}
    <div class="kdb-tiles">${pfTile('Runs', pfN(T.runs), T.first ? `since ${esc(fmtShortDate(T.first))}` : 'none yet')}${pfTile('Cards run', pfN(T.cards), T.remade ? `${pfN(T.remade)} remade` : '')}
      ${pfTile('Usual cards/h', pfN(d.median_per_hour), 'the middle of its runs, set-up included')}
      ${L ? pfTile('🧠 Learned', `${pfN(L.per_hour)}/h`, `from ${esc(fromText[L.from] || L.from)}`) + pfTile('1,000 cards take', fmtSpan(L.minutes_1000), `with ${pfN(L.setup)} min set-up`) : ''}</div>
    ${runItem ? `<div class="row" style="margin:8px 0"><button type="button" data-pf-explode="${esc(JSON.stringify({ by: 'job', filter: { card: runItem } }))}">⤢ Explode its runs</button><span class="small muted">by job, machine, shift or any way, over any dates</span></div>` : ''}
    ${d.open.length ? `<h3 class="pl-h">In the open work orders <span class="muted small">${d.open.length}</span></h3><div class="kdb-scroll pf-scroll"><table class="log pll-t"><thead><tr><th>WO</th><th>PER</th><th class="num">Cards</th><th>Status</th><th>Due</th><th>Priority</th><th>Shipper</th></tr></thead><tbody>
      ${d.open.map((l) => `<tr><td>${pfWoLink(l.wo)}</td><td>${esc(l.per)}</td><td class="num">${pfN(l.qty)}</td><td class="small">${esc(l.status || '')}</td><td class="small">${esc(l.due || '')}</td><td class="small">${esc(l.prio || '')}</td><td class="small">${esc(l.shipper || '')}</td></tr>`).join('')}
    </tbody></table></div>` : ''}
    ${d.by_machine.length || d.by_customer.length ? `<div class="grid pll-grid">${group(d.by_machine, 'By machine')}${group(d.by_customer, 'By customer')}</div>` : ''}
    <h3 class="pl-h">Latest runs ${d.runs.length ? `<span class="muted small">${d.runs.length < T.runs ? `the last ${d.runs.length} of ${pfN(T.runs)}` : ''}</span>` : ''}</h3>
    ${pfRunsTable(d.runs, { item: false, job: true })}`;
}
