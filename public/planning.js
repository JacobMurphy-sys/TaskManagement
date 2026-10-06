'use strict';
// 🏭 Planning: the open perso work orders (linked export), as a priority list — FIFO (by
// deadline: due date at the shipper's cut-off) or BAU (due day, then High/Normal/Low, then
// cut-off) — with what's running on top, the cards due by each cut-off, and, with a
// capacity set, each job's projected finish against its deadline. Loaded before app.js.

async function renderPlanning() {
  const mode = store.get('planMode', 'fifo') === 'bau' ? 'bau' : 'fifo';
  const [p, settings] = await Promise.all([api.get(`/plan?mode=${mode}`), api.get('/settings')]);
  const f = store.get('planFilter', {}) || {};
  const all = [...p.running, ...p.queue];
  const today = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = ymd(today); const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const deadlineAt = (j) => { if (!j.deadline) return null; const [d, t] = j.deadline.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };
  const dayLabel = (iso) => (iso === todayIso ? 'Today' : iso === ymd(tomorrow) ? 'Tomorrow' : new Date(`${iso}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
  const left = (j) => {
    const at = deadlineAt(j); if (!at) return { text: '—', cls: '' };
    const min = Math.round((at - today) / 60000);
    if (min < 0) return { text: `${fmtSpan(-min)} overdue`, cls: 'pl-over' };
    return { text: `in ${fmtSpan(min)}`, cls: j.due === todayIso ? 'pl-today' : j.due === ymd(tomorrow) ? 'pl-tomorrow' : '' };
  };
  const match = (j) => (!f.customer || j.customer === f.customer) && (!f.shipper || j.shipper === f.shipper) && (!f.prio || String(j.prio).toLowerCase() === f.prio)
    && (!f.q || `${j.wo} ${j.per} ${j.customer} ${j.group} ${j.shipper} ${j.articles.map((a) => a.article).join(' ')}`.toLowerCase().includes(f.q.toLowerCase()));
  const customers = [...new Set(all.map((j) => j.customer).filter(Boolean))].sort();
  const shippers = [...new Set(all.map((j) => j.shipper).filter(Boolean))].sort();
  const sum = (list) => list.reduce((t, j) => t + j.qty, 0);
  const n = (v) => Number(v || 0).toLocaleString('en-GB');
  const overdue = all.filter((j) => deadlineAt(j) && deadlineAt(j) < today);
  const dueToday = all.filter((j) => j.due === todayIso);
  const late = p.projected ? all.filter((j) => j.late_minutes > 0) : [];
  const prioChip = (pr) => `<span class="pl-prio pl-${esc(String(pr || '').toLowerCase())}">${esc(pr || '—')}</span>`;
  const finish = (j) => (!p.projected ? '' : (j.finish_at ? `<span class="${j.late_minutes > 0 ? 'pl-late' : 'pl-ok'}" title="Projected finish ${esc(fmtDateTime(j.finish_at))}">${new Date(j.finish_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${j.late_minutes > 0 ? ` · ${fmtSpan(j.late_minutes)} late` : ''}</span>`
    : j.unplanned ? `<span class="pl-warn">⚠ ${esc([
      j.unplanned_why?.includes('machine') ? `no running machine for ${[...new Set(j.articles.filter((a) => a.unplanned === 'machine').map((a) => a.card?.type))].join(', ')}` : '',
      j.unplanned_why?.includes('speed') ? 'no speed for a card' : '',
      j.unplanned_why?.includes('time') ? 'no working time — check the working day and days in ⚙ Setup' : ''].filter(Boolean).join(' · '))}</span>` : '<span class="muted">—</span>')
    + (j.machines?.length ? `<div class="small muted">${esc(j.machines.join(', '))}</div>` : ''));
  const row = (j, i) => {
    const l = left(j);
    return `<tr class="pl-job ${l.cls ? `${l.cls}-row` : ''} ${p.projected && j.late_minutes > 0 ? 'pl-late-row' : ''}" data-pl-job="${esc(j.key)}">
      <td class="num muted">${i === null ? '▶' : i + 1}</td>
      <td><b>${esc(dayLabel(j.due))}</b> ${j.no_cutoff ? '<span class="pl-warn" title="No cut-off time in the export (UNDEFINED) — taken as the end of the day">end of day ⚠</span>' : esc(j.deadline?.slice(11) || '')}<div class="small ${l.cls}">${esc(l.text)}</div></td>
      <td><b>${esc(j.wo)}</b> <span class="muted">/ ${esc(j.per)}</span><div class="small muted">${j.articles.length} card article${j.articles.length === 1 ? '' : 's'}</div></td>
      <td>${esc(j.customer || '—')}${j.kind?.length ? `<div class="small muted" title="${esc(j.kind.join(', '))}">${esc(j.kind[0])}${j.kind.length > 1 ? ` +${j.kind.length - 1}` : ''}</div>` : j.no_card ? '<div class="small pl-warn">not in the card database</div>' : ''}</td>
      <td class="num"><b>${n(j.qty)}</b>${j.plan_minutes !== undefined && !j.unplanned ? `<div class="small muted" title="Production time${j.minutes === null ? ' (flat rate — not every card has a speed)' : ' from the card speeds'}">${fmtSpan(j.plan_minutes)}${j.minutes === null || j.articles.some((a) => a.speed_from !== null && !String(a.speed_from).startsWith('rule')) ? ' ≈' : ''}</div>` : ''}</td>
      <td>${prioChip(j.prio)}</td>
      <td><div>${esc(j.shipper || '—')}</div><div class="small muted">${esc(j.group || '')}</div></td>
      ${p.projected ? `<td>${finish(j)}</td>` : ''}
    </tr>
    <tr class="pl-detail" data-pl-detail="${esc(j.key)}" hidden><td></td><td colspan="${p.projected ? 7 : 6}"><table class="log small"><thead><tr><th>Card article</th><th>Card</th><th>Type</th><th>Material</th><th>Print sides</th><th class="num">Cards</th><th class="num">Speed</th><th class="num">Time</th>${(p.machines || []).some((m) => m.active) ? '<th>Machine</th>' : ''}<th>Status</th></tr></thead>
      <tbody>${j.articles.map((a) => `<tr><td>${esc(a.article)}</td><td>${a.card ? esc(a.card.name || '') : '<span class="pl-warn">not in the card database</span>'}</td><td>${esc(a.card?.type || '')}</td><td>${esc(a.card?.material || '')}</td><td>${esc(a.card?.sides || '')}</td>
        <td class="num">${n(a.qty)}</td><td class="num">${a.speed ? `${n(a.speed)}/h${a.speed_from === 'fallback' ? ' <span class="muted" title="No speed for this kind of card — the flat rate">≈</span>' : a.speed_from === 'average' ? ' <span class="muted" title="No speed for this card — the average of the others">≈</span>' : ''}` : '<span class="pl-warn">no speed</span>'}</td>
        <td class="num">${a.minutes !== null ? fmtSpan(a.minutes) : '—'}</td>${(p.machines || []).some((m) => m.active) ? `<td>${a.machine ? `${esc(a.machine)} <span class="muted">${new Date(a.start_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}–${new Date(a.finish_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>` : '<span class="pl-warn">no machine</span>'}</td>` : ''}<td>${esc(a.status || '')}</td></tr>`).join('')}</tbody></table></td></tr>`;
  };
  const head = `<tr><th></th><th>Deadline</th><th>Work order / job</th><th>Customer</th><th class="num">Cards</th><th>Prio</th><th>Shipper</th>${p.projected ? '<th>Projected finish</th>' : ''}</tr>`;
  const runningShown = p.running.filter(match); const queueShown = p.queue.filter(match);
  const cap = p.capacity;
  const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const useMachines = (p.machines || []).some((m) => m.active);
  const activeMachines = (p.machines || []).filter((m) => m.active);
  const dayText = cap.start === cap.end ? 'round the clock' : `${hm(cap.start)}–${hm(cap.end)}${cap.end < cap.start ? ' (past midnight)' : ''}`;
  const capText = p.projected ? `${p.rules.length ? 'card speeds' : `${n(cap.rate)} cards/h`} × ${useMachines ? `${activeMachines.length} machine${activeMachines.length === 1 ? '' : 's'}` : `${cap.lines} line${cap.lines === 1 ? '' : 's'}`} · ${dayText}` : 'set speeds in ⚙ Setup';
  const machineRows = (p.machines || []).map((m) => `<tr data-pl-machine="${m.id}"><td><input type="text" name="name" value="${esc(m.name)}"></td>
      <td><input type="text" name="types" list="pl-types" value="${esc(m.types || '')}" placeholder="any type"></td>
      <td><label class="row small"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> running</label></td><td><button class="icon" data-pl-del-machine="${m.id}" title="Remove">✕</button></td></tr>`).join('');
  const loadOf = new Map((p.machine_load || []).map((l) => [l.id, l]));
  const capCard = (p.capacity_by_type || []).length && (useMachines || p.projected) ? `<div class="card"><h3 class="pl-h">Capacity <span class="muted small">— ${dayText}, ${cap.days.length} day${cap.days.length === 1 ? '' : 's'} a week</span></h3>
      <div class="kdb-grid"><div class="kdb-scroll"><table class="log pl-cap"><thead><tr><th>Product type</th><th>Machines</th><th class="num">Speed</th><th class="num">Max cards a day</th><th class="num">Cards open</th><th class="num">Days of work</th></tr></thead><tbody>
        ${p.capacity_by_type.map((t) => `<tr><td><b>${esc(t.type)}</b></td><td>${t.machines.length ? esc(t.machines.join(', ')) : useMachines ? '<span class="pl-warn">⚠ none runs it</span>' : '<span class="muted">—</span>'}</td>
          <td class="num">${t.speed ? `${n(t.speed)}/h` : '—'}</td><td class="num"><b>${t.max_per_day ? n(t.max_per_day) : '—'}</b></td><td class="num">${n(t.cards)}</td>
          <td class="num ${t.days_of_work > 2 ? 'pl-late' : ''}">${t.days_of_work ?? '—'}</td></tr>`).join('')}
      </tbody></table></div>
      ${useMachines ? `<div class="kdb-scroll"><table class="log pl-cap"><thead><tr><th>Machine</th><th>Runs</th><th class="num">Cards planned</th><th class="num">Work</th><th>Booked until</th></tr></thead><tbody>
        ${activeMachines.map((m) => { const l = loadOf.get(m.id) || {}; return `<tr><td><b>${esc(m.name)}</b></td><td class="small">${esc(m.types || 'any type')}</td><td class="num">${n(l.cards)}</td><td class="num">${l.minutes ? fmtSpan(l.minutes) : '—'}</td>
          <td>${l.until ? esc(new Date(l.until).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>` : ''}</div>
      <p class="small muted">Max cards a day: the machines able to run the type, for the working day, at the type's speed (the open cards' average). A machine running several types counts for each — the ceiling for that type on its own.</p></div>` : '';
  const cdb = p.cards_db;
  const speedRows = (p.combos || []).map((c) => {
    const exact = c.rule && (c.rule.type || '') === (c.type || '') && (c.rule.material || '') === (c.material || '') && (c.rule.sides || '') === (c.sides || '');
    return `<tr><td>${esc(c.type || '—')}</td><td>${esc(c.material || '—')}</td><td>${esc(c.sides || '—')}</td><td class="num">${n(c.qty)}</td><td class="num">${n(c.articles)}</td>
      <td><input type="number" min="1" step="1" class="pl-speed" data-type="${esc(c.type || '')}" data-material="${esc(c.material || '')}" data-sides="${esc(c.sides || '')}" value="${exact ? esc(c.rule.speed) : ''}"
        placeholder="${c.rule ? `${c.rule.speed} (${[c.rule.type, c.rule.material, c.rule.sides].filter(Boolean).join(' · ') || 'any'})` : cap.rate ? `flat ${cap.rate}` : 'cards/h'}"></td></tr>`;
  }).join('');
  const general = (p.rules || []).filter((r) => !(p.combos || []).some((c) => (r.type || '') === (c.type || '') && (r.material || '') === (c.material || '') && (r.sides || '') === (c.sides || '')));
  const src = p.source;

  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">🏭 Planning</h1>
      <div class="seg" title="FIFO: by deadline only. BAU: by due day, then High / Normal / Low, then cut-off">
        <button type="button" data-pl-mode="fifo" class="${mode === 'fifo' ? 'on' : ''}">FIFO</button><button type="button" data-pl-mode="bau" class="${mode === 'bau' ? 'on' : ''}">BAU</button></div>
      <div class="spacer"></div>
      <span class="small muted">${src.status === 'ok' ? `${esc(src.name)} · saved ${esc(fmtDateTime(src.modified))}${src.uploaded ? ' (uploaded copy)' : ''}` : ''}</span>
      <button data-pl="refresh" title="Read the export again if it has changed">🔄 Refresh</button>
      <label class="button" title="Try it with a copy of the export">📂 Load file…<input type="file" accept=".xlsx" hidden id="pl-file"></label>
      <button data-pl="setup" title="Where the export is, and the capacity">⚙ Setup</button>
    </div>
    <div class="card pl-setup" id="pl-setup" ${src.status === 'ok' && !store.get('planSetupOpen', false) ? 'hidden' : ''}>
      <h2 style="margin-top:0">Setup</h2>
      <div class="form-grid">
        <label class="f full">Open work orders export (where it's saved)<input type="text" name="plan_src" value="${esc(settings.plan_src || '')}" placeholder="e.g. S:\\…\\Source Data\\OpenPersoWorkorders_PerAx.xlsx">
          <span class="small muted">Read again whenever it's saved (e.g. the hourly SSRS export). Nothing in it is changed.</span></label>
        <label class="f full">Card database (Access) — the Cards table gives each card article's type, material and print sides<input type="text" name="plan_db" value="${esc(settings.plan_db || '')}" placeholder="e.g. S:\\…\\Cards.accdb">
          <span class="small ${cdb.status === 'error' || cdb.status === 'missing' ? 'pl-late' : 'muted'}">${cdb.status === 'ok' ? `✔ ${n(cdb.count)} cards in the ${esc(cdb.table)} table · saved ${esc(fmtDateTime(cdb.modified))} — read again whenever it's saved` : cdb.status === 'missing' ? '⚠ Can\'t find this file' : cdb.status === 'error' ? `⚠ ${esc(cdb.error)}` : 'Read only — nothing in the database is changed. It can stay open in Access.'}</span></label>
        <label class="f">Table<input type="text" name="plan_db_table" value="${esc(settings.plan_db_table || 'Cards')}"></label>
        <label class="f">Flat rate — cards per hour for cards without a speed<input type="number" min="0" step="1" name="plan_rate" value="${esc(settings.plan_rate || '')}" placeholder="optional"></label>
        ${useMachines ? '' : `<label class="f">Lines running <span class="muted small">(until machines are set)</span><input type="number" min="1" step="1" name="plan_lines" value="${esc(settings.plan_lines || '1')}"></label>`}
        <label class="f">Working day from<input type="time" name="plan_day_start" value="${esc(settings.plan_day_start || '06:00')}"></label>
        <label class="f">to <span class="muted small">(the same time = round the clock; earlier = past midnight)</span><input type="time" name="plan_day_end" value="${esc(settings.plan_day_end || '22:00')}"></label>
        <div class="f full"><span>Working days</span><div class="row">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<label class="row small"><input type="checkbox" data-pl-day="${i}" ${cap.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
      </div>
      <h3 class="pl-h" style="margin-top:14px">Machines <span class="muted small">— and the product types (card Type) each runs</span></h3>
      <datalist id="pl-types">${(p.product_types || []).map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <table class="log pl-speeds pl-machines"><thead><tr><th>Machine</th><th>Product types <span class="muted small">(e.g. DOD, Laser — blank: any)</span></th><th></th><th></th></tr></thead><tbody>${machineRows}
        <tr><td><input type="text" id="pl-new-machine" placeholder="Machine name"></td><td><input type="text" id="pl-new-machine-types" list="pl-types" placeholder="Product types"></td><td></td><td><button class="small" data-pl="add-machine">Add</button></td></tr></tbody></table>
      <p class="small muted">${useMachines ? 'Each card line is planned on the running machine able to run its type that comes free first.' : 'Until machines are set, the work is spread over the lines running.'}${(p.product_types || []).length ? ` Types in the card database: ${esc(p.product_types.join(', '))}.` : ''}</p>

      <h3 class="pl-h" style="margin-top:14px">Speeds — cards per hour for each kind of card</h3>
      ${cdb.status !== 'ok' ? '<p class="small muted">Link the card database above to see the kinds of card in the open work orders.</p>' : `
      <p class="small muted">The kinds of card in the open work orders (from the card database), most cards first. A speed typed here is for that exact kind; a general rule below (a blank field matches any) covers the rest.</p>
      <div class="kdb-scroll"><table class="log pl-speeds"><thead><tr><th>Type</th><th>Material</th><th>Print sides</th><th class="num">Cards open</th><th class="num">Card articles</th><th>Cards per hour</th></tr></thead>
        <tbody>${speedRows || '<tr><td colspan="6" class="muted">No open card lines found in the card database.</td></tr>'}</tbody></table></div>`}
      <div class="small" style="margin-top:8px"><b>General rules</b> <span class="muted">— e.g. every DOD card at one speed</span></div>
      <table class="log pl-speeds"><tbody>${general.map((r) => `<tr><td>${esc(r.type || 'any type')}</td><td>${esc(r.material || 'any material')}</td><td>${esc(r.sides || 'any sides')}</td><td class="num">${n(r.speed)}/h</td><td><button class="icon" data-pl-del-speed="${r.id}" title="Remove">✕</button></td></tr>`).join('')}
        <tr><td><input type="text" id="pl-new-type" placeholder="Type (blank = any)"></td><td><input type="text" id="pl-new-material" placeholder="Material (blank = any)"></td><td><input type="text" id="pl-new-sides" placeholder="Print sides (blank = any)"></td>
          <td><input type="number" min="1" id="pl-new-speed" placeholder="cards/h"></td><td><button class="small" data-pl="add-speed">Add</button></td></tr></tbody></table>
      <p class="small muted">Jobs are worked through in the list's order — what's running first — each card line at its speed ${useMachines ? 'on a machine that runs its type' : '(divided over the lines running)'}, and each job gets a projected finish against its deadline.</p>
    </div>
    ${src.status === 'ok' && cdb.status === 'ok' && (p.unknown_articles?.length || p.no_speed) ? `<div class="kc-note">⚠ ${[p.unknown_articles.length ? `${p.unknown_articles.length} card article${p.unknown_articles.length === 1 ? ' isn\'t' : 's aren\'t'} in the card database (${esc(p.unknown_articles.slice(0, 6).join(', '))}${p.unknown_articles.length > 6 ? ', …' : ''})` : '', p.no_speed ? `${p.no_speed} card line${p.no_speed === 1 ? ' has no speed of its own' : 's have no speed of their own'} — ${cap.rate ? 'the flat rate is used' : 'the average of the others is used (≈)'}` : ''].filter(Boolean).join(' · ')}. <button class="link small" data-pl="setup">⚙ Speeds</button></div>` : ''}
    ${src.status === 'missing' ? `<div class="kc-note">⚠ Can't find <code>${esc(src.file)}</code> — check the path in ⚙ Setup.</div>` : ''}
    ${src.status === 'error' ? `<div class="kc-note">⚠ Couldn't read <code>${esc(src.file)}</code>: ${esc(src.error)}</div>` : ''}
    ${src.status === 'none' ? '<div class="card lib-empty"><h2>Production planning</h2><p>Set where the open work orders export is saved in ⚙ Setup (or try it with 📂 Load file…). The work orders are put in order by their deadline — the due date at the shipper\'s cut-off — and, with a capacity, each one\'s finish is projected.</p></div>' : ''}
    ${src.status === 'ok' ? `
    <div class="kdb-tiles pl-tiles">
      <div class="kdb-tile"><div class="kdb-tile-l">Open jobs</div><div class="kdb-tile-v">${n(all.length)}</div><div class="kdb-tile-s">${n(sum(all))} cards · ${n(new Set(all.map((j) => j.wo)).size)} work orders</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Running</div><div class="kdb-tile-v">${n(p.running.length)}</div><div class="kdb-tile-s">${n(sum(p.running))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Due today</div><div class="kdb-tile-v ${dueToday.length ? 'kdb-warn' : ''}">${n(dueToday.length)}</div><div class="kdb-tile-s">${n(sum(dueToday))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Overdue</div><div class="kdb-tile-v ${overdue.length ? 'kdb-bad' : 'kdb-ok'}">${n(overdue.length)}</div><div class="kdb-tile-s">${n(sum(overdue))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Projected late</div><div class="kdb-tile-v ${late.length ? 'kdb-bad' : p.projected ? 'kdb-ok' : ''}">${p.projected ? n(late.length) : '—'}</div><div class="kdb-tile-s">${esc(capText)}</div></div>
    </div>
    ${capCard}
    <div class="card"><h3 class="pl-h">Cards due by each cut-off</h3>
      <div class="kdb-scroll"><table class="log pl-slots"><thead><tr><th>Deadline</th><th class="num">Jobs</th><th class="num">Cards</th><th class="num">Running total</th><th>Shippers</th>${p.projected ? '<th>Projected</th>' : ''}</tr></thead><tbody>
        ${p.slots.slice(0, 20).map((s) => `<tr class="${s.due === todayIso ? 'pl-today-row' : ''}"><td><b>${esc(dayLabel(s.due))}</b> ${esc(s.deadline.slice(11))}</td><td class="num">${n(s.jobs)}</td><td class="num">${n(s.qty)}</td><td class="num">${n(s.cumulative)}</td>
          <td class="small">${esc(s.shippers.join(', '))}</td>${p.projected ? `<td>${s.late ? `<span class="pl-late">${s.late} late</span>` : '<span class="pl-ok">✔ on time</span>'}</td>` : ''}</tr>`).join('')}
      </tbody></table></div></div>
    <div class="row pl-filters">
      <input type="search" id="pl-q" placeholder="Search work order, customer, article…" value="${esc(f.q || '')}">
      <select id="pl-customer"><option value="">All customers</option>${customers.map((c) => `<option ${f.customer === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="pl-shipper"><option value="">All shippers</option>${shippers.map((c) => `<option ${f.shipper === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="pl-prio"><option value="">All priorities</option>${['high', 'normal', 'low'].map((c) => `<option value="${c}" ${f.prio === c ? 'selected' : ''}>${c[0].toUpperCase()}${c.slice(1)}</option>`).join('')}</select>
      ${f.q || f.customer || f.shipper || f.prio ? '<button class="link small" data-pl="clear">Clear</button>' : ''}
    </div>
    ${runningShown.length ? `<div class="card"><h3 class="pl-h">▶ Running <span class="muted small">${runningShown.length} job${runningShown.length === 1 ? '' : 's'} · ${n(sum(runningShown))} cards</span></h3>
      <div class="kdb-scroll"><table class="log pl-table"><thead>${head}</thead><tbody>${runningShown.map((j) => row(j, null)).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h3 class="pl-h">Next to start — ${mode === 'fifo' ? 'FIFO: by deadline' : 'BAU: by due day, then priority, then cut-off'} <span class="muted small">${queueShown.length} job${queueShown.length === 1 ? '' : 's'} · ${n(sum(queueShown))} cards · click a job for its card articles</span></h3>
      <div class="kdb-scroll"><table class="log pl-table"><thead>${head}</thead><tbody>${queueShown.map((j) => row(j, p.queue.indexOf(j))).join('') || '<tr><td colspan="8" class="muted">Nothing matches.</td></tr>'}</tbody></table></div></div>` : ''}`;

  const setF = (k, v) => { f[k] = v || ''; store.set('planFilter', f); renderPlanning(); };
  $('#pl-q')?.addEventListener('change', (e) => setF('q', e.target.value.trim()));
  $('#pl-customer')?.addEventListener('change', (e) => setF('customer', e.target.value));
  $('#pl-shipper')?.addEventListener('change', (e) => setF('shipper', e.target.value));
  $('#pl-prio')?.addEventListener('change', (e) => setF('prio', e.target.value));
  $('#pl-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = await fetch('/api/plan/upload', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) toast(d.error || res.statusText, 'error'); else toast(`${file.name} loaded${settings.plan_src ? ' — the linked export is still used; clear its path to use this copy' : ''}`);
    renderPlanning();
  });
  $$('#pl-setup input[name]').forEach((el) => el.addEventListener('change', async () => {
    try { await api.patch('/settings', { [el.name]: el.value.trim().replace(/^"|"$/g, '') }); toast('Saved'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-pl-day]').forEach((el) => el.addEventListener('change', async () => {
    const days = $$('[data-pl-day]').filter((x) => x.checked).map((x) => x.dataset.plDay).join(',');
    try { await api.patch('/settings', { plan_days: days }); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('.pl-speed').forEach((el) => el.addEventListener('change', async () => {
    const speed = el.value.trim();
    const body = { type: el.dataset.type || null, material: el.dataset.material || null, sides: el.dataset.sides || null };
    try {
      if (speed) await api.post('/plan/speeds', { ...body, speed });
      else { const r = p.rules.find((x) => (x.type || '') === (body.type || '') && (x.material || '') === (body.material || '') && (x.sides || '') === (body.sides || '')); if (r) await api.del(`/plan/speeds/${r.id}`); }
      toast('Speed saved'); store.set('planSetupOpen', true); renderPlanning();
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-pl-machine] input').forEach((el) => el.addEventListener('change', async () => {
    const id = el.closest('[data-pl-machine]').dataset.plMachine;
    try { await api.patch(`/plan/machines/${id}`, { [el.name]: el.type === 'checkbox' ? el.checked : el.value }); toast('Saved'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  main().onclick = async (e) => {
    const delM = e.target.closest('[data-pl-del-machine]');
    if (delM) { if (!confirm('Remove this machine?')) return; try { await api.del(`/plan/machines/${delM.dataset.plDelMachine}`); renderPlanning(); } catch (err) { toast(err.message, 'error'); } return; }
    if (e.target.closest('[data-pl="add-machine"]')) {
      try { await api.post('/plan/machines', { name: $('#pl-new-machine').value, types: $('#pl-new-machine-types').value }); toast('Machine added'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const del = e.target.closest('[data-pl-del-speed]');
    if (del) { try { await api.del(`/plan/speeds/${del.dataset.plDelSpeed}`); renderPlanning(); } catch (err) { toast(err.message, 'error'); } return; }
    if (e.target.closest('[data-pl="add-speed"]')) {
      try {
        await api.post('/plan/speeds', { type: $('#pl-new-type').value, material: $('#pl-new-material').value, sides: $('#pl-new-sides').value, speed: $('#pl-new-speed').value });
        toast('Rule added'); store.set('planSetupOpen', true); renderPlanning();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const m = e.target.closest('[data-pl-mode]');
    if (m) { store.set('planMode', m.dataset.plMode); renderPlanning(); return; }
    const b = e.target.closest('[data-pl]');
    if (b?.dataset.pl === 'setup') { const s = $('#pl-setup'); s.hidden = !s.hidden; store.set('planSetupOpen', !s.hidden); if (!s.hidden) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (b?.dataset.pl === 'refresh') { renderPlanning(); return; }
    if (b?.dataset.pl === 'clear') { store.set('planFilter', {}); renderPlanning(); return; }
    const job = e.target.closest('[data-pl-job]');
    if (job) { const d = $(`[data-pl-detail="${CSS.escape(job.dataset.plJob)}"]`); if (d) d.hidden = !d.hidden; }
  };
}

// 95 → "1 h 35 min", 2000 → "1 d 9 h"
function fmtSpan(min) {
  if (min > 0 && min < 1) return '<1 min';
  min = Math.max(0, Math.round(min));
  if (min < 60) return `${min} min`;
  if (min < 24 * 60) return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
  const d = Math.floor(min / 1440); const h = Math.floor((min % 1440) / 60);
  return `${d} d${h ? ` ${h} h` : ''}`;
}
