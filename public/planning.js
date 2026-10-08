'use strict';
// 🏭 Planning: the open perso work orders (linked export), as a priority list — FIFO (by
// deadline: due date at the shipper's cut-off) or BAU (due day, then High/Normal/Low, then
// cut-off) — with what's running on top, the cards due by each cut-off, and, with a
// capacity set, each job's projected finish against its deadline. Loaded before app.js.

async function renderPlanning() {
  const mode = ['bau', 'score', 'mitigation'].includes(store.get('planMode', 'fifo')) ? store.get('planMode') : 'fifo';
  const half = store.get('planHalf', 'perso') === 'otto' ? 'otto' : 'perso';
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
  const finish = (j) => (!p.projected ? '' : (j.finish_at ? `<span class="${j.late_minutes > 0 ? 'pl-late' : 'pl-ok'}" title="Projected finish ${esc(fmtDateTime(j.finish_at))}${cap.buffer ? ` — must be ready ${fmtSpan(cap.buffer)} before the cut-off` : ''}">${new Date(j.finish_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${j.late_minutes > 0 ? ` · ${fmtSpan(j.late_minutes)} late` : ''}</span>`
    : j.unplanned ? `<span class="pl-warn">⚠ ${esc([
      j.unplanned_why?.includes('machine') ? `no running machine for ${[...new Set(j.articles.filter((a) => a.unplanned === 'machine').map((a) => a.card?.type))].join(', ')}` : '',
      j.unplanned_why?.includes('speed') ? 'no speed for a card' : '',
      j.unplanned_why?.includes('time') ? 'no working time — check the working day and days in ⚙ Setup' : ''].filter(Boolean).join(' · '))}</span>` : '<span class="muted">—</span>')
    + (j.machines?.length ? `<div class="small muted">${esc(j.machines.join(', '))}</div>` : ''));
  // the WO's Otto jobs, and whether perso is projected to finish after the first one's plan date
  const ottoTag = (j) => {
    const os = (j.otto || []).filter((o) => !o.done); if (!os.length) return '';
    const first = os.map((o) => o.deadline).filter(Boolean).sort()[0];
    const after = first && j.finish_at && deadlineAt({ deadline: first }) < new Date(j.finish_at);
    return ` · <span class="${after ? 'pl-late' : ''}" title="${esc(os.map((o) => `${o.name}: Otto plan ${o.deadline?.replace('T', ' ') || '—'} (${o.status || ''})`).join('\n'))}${after ? '\nPerso is projected to finish after Otto\'s plan date' : ''}">Otto ${first ? esc(dayLabel(first.slice(0, 10))) : ''}${after ? ' ⚠' : ''}</span>`;
  };
  // 🛟 mitigation groups: can still be on time, then late anyway (already overdue, or no room)
  const mitiGroup = (j) => (!j ? null : j.mitigation === 'pinned' ? 'pinned' : j.mitigation === 'on_time' ? 'on_time' : j.mitigation === 'later' ? 'later' : 'late');
  const mitiHead = (j) => {
    const g = mitiGroup(j); const list = p.queue.filter((x) => mitiGroup(x) === g);
    const days = Number(settings.plan_miti_days ?? 5) || 0;
    const text = { pinned: '📌 Pinned', on_time: `✔ Due ${days ? `within ${days} working day${days === 1 ? '' : 's'}` : 'and not yet overdue'}, can still be on time — ${list.length} job${list.length === 1 ? '' : 's'}, ${n(sum(list))} cards`,
      later: `↓ Due later than ${days} working day${days === 1 ? '' : 's'} — ${list.length} job${list.length === 1 ? '' : 's'}, ${n(sum(list))} cards · after the overdue, by deadline`,
      late: `⚠ Late anyway — ${list.filter((x) => x.mitigation === 'overdue').length} already overdue${list.some((x) => x.mitigation === 'late_anyway') ? `, ${list.filter((x) => x.mitigation === 'late_anyway').length} with no room before their deadline` : ''} · after the ones that can make it, oldest first` }[g];
    return `<tr class="pl-group pl-group-${g}"><td colspan="${(p.projected ? 8 : 7) + (mode === 'score' ? 1 : 0)}">${esc(text)}</td></tr>`;
  };
  const scoreFmt = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: 1 }));
  const row = (j, i) => {
    const l = left(j);
    return `<tr class="pl-job ${l.cls ? `${l.cls}-row` : ''} ${p.projected && j.late_minutes > 0 ? 'pl-late-row' : ''}" data-pl-job="${esc(j.key)}">
      <td class="num muted pl-n">${i === null ? '▶' : `${j.pinned ? '📌 ' : ''}${i + 1}<div><button class="icon pl-pin ${j.pinned ? 'on' : ''}" data-pl-pin="${esc(j.key)}" title="${j.pinned ? 'Unpin — back to its place in the order' : 'Pin to the front of the queue'}">📌</button></div>`}</td>
      <td><b>${esc(dayLabel(j.due))}</b> ${j.no_cutoff ? '<span class="pl-warn" title="No cut-off time in the export (UNDEFINED) — taken as the end of the day">end of day ⚠</span>' : esc(j.deadline?.slice(11) || '')}<div class="small ${l.cls}">${esc(l.text)}</div></td>
      <td><b>${esc(j.wo)}</b> <span class="muted">/ ${esc(j.per)}</span><div class="small muted">${j.articles.length} card article${j.articles.length === 1 ? '' : 's'}${ottoTag(j)}</div></td>
      <td>${esc(j.customer || '—')}${j.kind?.length ? `<div class="small muted" title="${esc(j.kind.join(', '))}">${esc(j.kind[0])}${j.kind.length > 1 ? ` +${j.kind.length - 1}` : ''}</div>` : j.no_card ? '<div class="small pl-warn">not in the card database</div>' : ''}</td>
      <td class="num"><b>${n(j.qty)}</b>${j.plan_minutes !== undefined && !j.unplanned ? `<div class="small muted" title="Production time${j.minutes === null ? ' (flat rate — not every card has a speed)' : ' from the card speeds'}">${fmtSpan(j.plan_minutes)}${j.minutes === null || j.articles.some((a) => a.speed_from !== null && !String(a.speed_from).startsWith('rule')) ? ' ≈' : ''}</div>` : ''}</td>
      ${mode === 'score' ? `<td class="num" title="${esc((j.score_parts || []).map((x) => `${x.module}${x.note ? ` (${x.note})` : ''}: ${x.value}`).join('\n'))}"><b>${scoreFmt(j.score)}</b><div class="small muted">${esc((j.score_parts || []).filter((x) => x.module !== 'Deadline' && x.value).map((x) => x.module).join(', '))}</div></td>` : ''}
      <td>${prioChip(j.prio)}</td>
      <td><div>${esc(j.shipper || '—')}</div><div class="small muted">${esc(j.group || '')}</div></td>
      ${p.projected ? `<td>${finish(j)}</td>` : ''}
    </tr>
    <tr class="pl-detail" data-pl-detail="${esc(j.key)}" hidden><td></td><td colspan="${(p.projected ? 7 : 6) + (mode === 'score' ? 1 : 0)}">${j.score_parts?.length ? `<div class="pl-score-parts small">⚖ ${j.score_parts.map((x) => `<span class="pl-chip" title="${esc([x.note, x.authoriser ? `authorised by ${x.authoriser}` : ''].filter(Boolean).join(' · '))}">${esc(x.module)}${x.note && x.module === 'Shift' ? ` (${esc(x.note)})` : ''} <b>${x.value > 0 ? '+' : ''}${scoreFmt(x.value)}</b></span>`).join(' ')} = <b>${scoreFmt(j.score)}</b>${j.tags?.length ? ` · tags ${esc(j.tags.join(', '))}` : ''}</div>` : ''}<table class="log small"><thead><tr><th>Card article</th><th>Card</th><th>Type</th><th>Material</th><th>Print sides</th><th class="num">Cards</th><th class="num">Speed</th><th class="num">Time</th>${(p.machines || []).some((m) => m.active) ? '<th>Machine</th>' : ''}<th>Status</th></tr></thead>
      <tbody>${j.articles.map((a) => `<tr><td>${esc(a.article)}</td><td>${a.card ? esc(a.card.name || '') : '<span class="pl-warn">not in the card database</span>'}</td><td>${esc(a.card?.type || '')}</td><td>${esc(a.card?.material || '')}</td><td>${esc(a.card?.sides || '')}</td>
        <td class="num">${n(a.qty)}</td><td class="num">${a.speed ? `${n(a.speed)}/h${a.speed_from === 'fallback' ? ' <span class="muted" title="No speed for this kind of card — the flat rate">≈</span>' : a.speed_from === 'average' ? ' <span class="muted" title="No speed for this card — the average of the others">≈</span>' : ''}${a.oee ? ` <span class="muted small" title="Estimated OEE for this customer — planned at ${n(Math.round(a.speed * a.oee))}/h">× ${Math.round(a.oee * 1000) / 10}%</span>` : ''}` : '<span class="pl-warn">no speed</span>'}</td>
        <td class="num">${a.minutes !== null ? fmtSpan(a.minutes) : '—'}</td>${(p.machines || []).some((m) => m.active) ? `<td>${a.machine ? `${esc(a.machine)} <span class="muted">${new Date(a.start_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}–${new Date(a.finish_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>` : '<span class="pl-warn">no machine</span>'}</td>` : ''}<td>${esc(a.status || '')}</td></tr>`).join('')}</tbody></table></td></tr>`;
  };
  const head = `<tr><th></th><th>Deadline</th><th>Work order / job</th><th>Customer</th><th class="num">Cards</th>${mode === 'score' ? '<th class="num">Score</th>' : ''}<th>Prio</th><th>Shipper</th>${p.projected ? '<th>Projected finish</th>' : ''}</tr>`;
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
      ${useMachines ? `<div class="kdb-scroll"><table class="log pl-cap"><thead><tr><th>Machine</th><th>Runs</th><th class="num">Cards planned</th><th class="num">Work</th>${cap.changeover ? '<th class="num">Change-overs</th>' : ''}<th>Booked until</th></tr></thead><tbody>
        ${activeMachines.map((m) => { const l = loadOf.get(m.id) || {}; return `<tr><td><b>${esc(m.name)}</b></td><td class="small">${esc(m.types || 'any type')}</td><td class="num">${n(l.cards)}</td><td class="num">${l.minutes ? fmtSpan(l.minutes) : '—'}</td>${cap.changeover ? `<td class="num">${n(l.setups)}</td>` : ''}
          <td>${l.until ? esc(new Date(l.until).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>` : ''}</div>
      <p class="small muted">Max cards a day: the machines able to run the type, for the working day, at the type's speed (the open cards' average). A machine running several types counts for each — the ceiling for that type on its own.</p></div>` : '';
  const cdb = p.cards_db;
  const withMachines = (p.machines || []).some((m) => m.active) && p.projected;
  const viewList = [['list', '☰ List'], ...(withMachines ? [['gantt', '▤ Gantt'], ['load', '▦ Load']] : []), ['history', '📈 History']];
  const view = viewList.some(([k]) => k === store.get('planView', 'list')) ? store.get('planView', 'list') : 'list';
  const hist = view === 'history' ? await api.get('/plan/history?days=14') : null;
  const historyHtml = () => {
    const h = hist; const max = Math.max(1, ...h.daily.map((d) => d.cards));
    const dshort = (d) => { const dt = new Date(`${d}T12:00`); return `${dt.toLocaleDateString('en-GB', { weekday: 'short' })}<br>${dt.getDate()}/${dt.getMonth() + 1}`; };
    return `<div class="kdb-tiles" style="margin-top:12px">
        <div class="kdb-tile"><div class="kdb-tile-l">Done — last 7 days</div><div class="kdb-tile-v">${n(h.week.jobs)}</div><div class="kdb-tile-s">${n(h.week.cards)} cards</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">On time — last 7 days</div><div class="kdb-tile-v ${h.week.on_time_pct === null ? '' : h.week.on_time_pct >= 98 ? 'kdb-ok' : 'kdb-bad'}">${h.week.on_time_pct === null ? '—' : `${h.week.on_time_pct}%`}</div><div class="kdb-tile-s">done by the cut-off</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">Lead time</div><div class="kdb-tile-v">${h.week.lead_hours === null ? '—' : fmtSpan(h.week.lead_hours * 60)}</div><div class="kdb-tile-s">first seen → done, average</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">History</div><div class="kdb-tile-v">${n(h.reads)}</div><div class="kdb-tile-s">${h.since ? `exports since ${esc(fmtDateTime(h.since))}` : 'exports recorded'}</div></div></div>
      ${h.reads < 2 ? '<div class="kc-note">The history builds up from now: each new version of the linked export is recorded (checked every 10 minutes), and a job is counted as done when it\'s gone from the next export — to within the export interval.</div>' : ''}
      <div class="card"><h3 class="pl-h">Cards done per day <span class="muted small">— last ${h.days} days · green on time · red after the cut-off</span></h3>
        <div class="pl-hist">${h.daily.map((d) => `<div class="pl-hist-col" title="${esc(d.date)}: ${n(d.jobs)} jobs, ${n(d.cards)} cards (${n(d.on_time_cards)} on time)">
          <div class="pl-hist-n">${d.cards ? n(Math.round(d.cards / 100) / 10) + 'k' : ''}</div>
          <div class="pl-hist-bar" style="height:${Math.round((d.cards / max) * 140)}px"><div class="pl-hist-late" style="height:${d.cards ? Math.round(((d.cards - d.on_time_cards) / d.cards) * 100) : 0}%"></div></div>
          <div class="pl-hist-d">${dshort(d.date)}</div></div>`).join('')}</div></div>
      <div class="card"><h3 class="pl-h">Latest done</h3>
        <div class="kdb-scroll"><table class="log"><thead><tr><th>Done</th><th>Work order / job</th><th>Customer</th><th class="num">Cards</th><th>Deadline</th><th>Result</th><th>Shipper</th></tr></thead><tbody>
        ${h.recent.map((j) => `<tr><td>${esc(new Date(j.done_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td><td><b>${esc(j.wo)}</b> <span class="muted">/ ${esc(j.per || '')}</span></td>
          <td>${esc(j.customer || '')}</td><td class="num">${n(j.qty)}</td><td>${esc(j.deadline?.replace('T', ' ') || '—')}</td>
          <td>${j.late_minutes === null ? '—' : j.late_minutes > 0 ? `<span class="pl-late">${fmtSpan(j.late_minutes)} late</span>` : '<span class="pl-ok">✔ on time</span>'}</td><td class="small">${esc(j.shipper || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing done yet since the history began.</td></tr>'}
        </tbody></table></div></div>`;
  };
  // ▦ Load: hours booked on each machine per day against its working hours
  const loadHtml = () => {
    const days = Object.keys(p.available || {}).filter((d) => p.available[d] > 0).sort().slice(0, 10);
    const hrs = (m) => `${(m / 60).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`;
    const cell = (booked, avail) => {
      const pct = avail ? Math.round((booked / avail) * 100) : 0;
      return `<td class="pl-load-cell" title="${hrs(booked)} booked of ${hrs(avail)}"><div class="pl-load-bar ${pct >= 95 ? 'full' : pct >= 70 ? 'busy' : ''}" style="width:${Math.min(100, pct)}%"></div><span>${booked ? `${pct}%` : ''}</span></td>`;
    };
    const loads = new Map((p.machine_load || []).map((l) => [l.id, l]));
    const ms = (p.machines || []).filter((m) => m.active);
    const dayHead = (d) => { const dt = new Date(`${d}T12:00`); return `${dt.toLocaleDateString('en-GB', { weekday: 'short' })}<div class="small muted">${dt.getDate()} ${dt.toLocaleDateString('en-GB', { month: 'short' })}</div>`; };
    return `<div class="card"><h3 class="pl-h">Load — hours booked on each machine per day <span class="muted small">of its working hours (${days[0] === Object.keys(p.available).sort()[0] ? 'today from now' : ''})</span></h3>
      <div class="kdb-scroll"><table class="log pl-load"><thead><tr><th>Machine</th>${days.map((d) => `<th class="num">${dayHead(d)}</th>`).join('')}<th class="num">Cards</th><th>Booked until</th></tr></thead><tbody>
      ${ms.map((m) => { const l = loads.get(m.id) || { days: {} }; return `<tr><td><b>${esc(m.name)}</b><div class="small muted">${esc(m.types || 'any type')}</div></td>
        ${days.map((d) => cell(l.days?.[d]?.minutes || 0, p.available[d])).join('')}<td class="num">${n(l.cards)}</td><td class="small">${l.until ? esc(new Date(l.until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      <tr class="pl-load-total"><td>All machines</td>${days.map((d) => cell(ms.reduce((t, m) => t + ((loads.get(m.id) || {}).days?.[d]?.minutes || 0), 0), p.available[d] * ms.length)).join('')}<td class="num">${n(ms.reduce((t, m) => t + ((loads.get(m.id) || {}).cards || 0), 0))}</td><td></td></tr>
      </tbody></table></div><p class="small muted">Green below 70% · amber from 70% · red from 95% of the working time. The plan books machines from now in the list's order, so the first days fill up first.</p></div>`;
  };
  const speedRows = (p.combos || []).map((c) => {
    const exact = c.rule && (c.rule.type || '') === (c.type || '') && (c.rule.material || '') === (c.material || '') && (c.rule.sides || '') === (c.sides || '');
    return `<tr><td>${esc(c.type || '—')}</td><td>${esc(c.material || '—')}</td><td>${esc(c.sides || '—')}</td><td class="num">${n(c.qty)}</td><td class="num">${n(c.articles)}</td>
      <td><input type="number" min="1" step="1" class="pl-speed" data-type="${esc(c.type || '')}" data-material="${esc(c.material || '')}" data-sides="${esc(c.sides || '')}" value="${exact ? esc(c.rule.speed) : ''}"
        placeholder="${c.rule ? `${c.rule.speed} (${[c.rule.type, c.rule.material, c.rule.sides].filter(Boolean).join(' · ') || 'any'})` : cap.rate ? `flat ${cap.rate}` : 'cards/h'}"></td></tr>`;
  }).join('');
  const general = (p.rules || []).filter((r) => !(p.combos || []).some((c) => (r.type || '') === (c.type || '') && (r.material || '') === (c.material || '') && (r.sides || '') === (c.sides || '')));
  const src = p.source;
  const ot = p.otto || { source: { status: 'none' }, running: [], queue: [] };
  // ⏳ Backlog: what's overdue, and how long catching up takes at the recent pace
  const backlogCard = (b, unit, otto) => {
    if (!b) return '';
    const c = b.catch_up; const dd = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const pace = c.basis_days ? `Last ${c.basis_days} working day${c.basis_days === 1 ? '' : 's'} (${dd(c.from)} – ${dd(c.to)}): <b>${n(c.rate)}</b> ${unit} done a day, <b>${n(c.demand)}</b> due a day.` : '';
    const est = {
      ok: `Overdue alone: about <b>${c.clear_days}</b> working day${c.clear_days === 1 ? '' : 's'} of output. Catching up while new work keeps coming: about <b>${c.catch_days}</b> working day${c.catch_days === 1 ? '' : 's'} — by <b>${c.catch_date ? dd(c.catch_date) : '—'}</b>.`,
      not_catching_up: `Overdue alone: about <b>${c.clear_days}</b> working day${c.clear_days === 1 ? '' : 's'} of output — but at this pace the backlog isn't shrinking: as much or more is due each day as is done.`,
      nothing_done: 'Nothing finished in that time to measure the pace.',
      no_record: otto ? 'No finished jobs with an End Date in the export to measure the pace.' : 'The pace comes from the plan history — it needs at least one full working day recorded.',
      none_overdue: '',
    }[c.status];
    return `<div class="card pl-backlog"><h3 class="pl-h">⏳ Backlog</h3>
      <div class="pl-backlog-row"><div class="pl-backlog-big ${b.overdue_qty ? 'pl-late' : 'pl-ok'}">${b.overdue_qty ? `${n(b.overdue_qty)} <span>${unit} overdue</span>` : '✔ <span>nothing overdue</span>'}</div>
        <div class="small">${b.overdue_qty ? `${n(b.overdue_jobs)} job${b.overdue_jobs === 1 ? '' : 's'} past ${otto ? 'the plan date' : 'the cut-off'}${b.oldest_due ? `, the oldest due ${esc(dd(b.oldest_due))}` : ''}.<br>` : ''}${pace}${est ? `<br>${est}` : ''}</div></div>
      ${b.hidden_jobs ? `<p class="small muted" style="margin:6px 0 0">${n(b.hidden_jobs)} job${b.hidden_jobs === 1 ? '' : 's'} (${n(b.hidden_qty)} ${unit}) due more than ${b.max_age} days ago ${b.hidden_jobs === 1 ? 'isn\'t' : 'aren\'t'} shown or counted — likely errors. <button class="link small" data-pl="setup">⚙ Change</button></p>` : ''}</div>`;
  };
  // ⚖ Modifiers: each module on or off; the deadline numbers; rule lists; the shift table; card tags
  const md = p.modifiers || { rules: [], shifts: [], tags: [], lists: [], off: [], shift_starts: {}, deadline: {} };
  const modsHtml = () => {
    const off = new Set((md.off || []).map((x) => x.toLowerCase()));
    const sw = (name) => `<label class="row small pl-mod-switch"><input type="checkbox" data-pl-mod-on="${esc(name)}" ${off.has(name.toLowerCase()) ? '' : 'checked'}> on</label>`;
    const hmS = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const custs = [...new Set([...all.map((j) => j.customer).filter(Boolean), ...(md.shifts || []).map((r) => r.customer)])].sort();
    const shiftBy = new Map((md.shifts || []).map((r) => [r.customer.toUpperCase(), r]));
    const listCard = (list) => {
      const rows = md.rules.filter((r) => r.list === list);
      return `<div class="pl-mod-list"><div class="row"><h4 style="margin:0">${esc(list)}</h4>${sw(list)}<span class="muted small">${rows.length} row${rows.length === 1 ? '' : 's'}</span></div>
        <table class="log pl-speeds"><thead><tr><th>Customer</th><th>Tag</th><th>Card type</th><th>Modifier</th><th>${list === 'Manual' ? 'Reason' : 'Note'}</th><th>Authoriser</th><th>Until</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr data-pl-mod="${r.id}"><td><input name="customer" value="${esc(r.customer || '')}" placeholder="any" list="pl-custs"></td><td><input name="tag" value="${esc(r.tag || '')}" placeholder="any" list="pl-tags"></td>
          <td><input name="type" value="${esc(r.type || '')}" placeholder="any" list="pl-types"></td><td><input name="value" type="number" step="0.5" value="${esc(r.value)}"></td>
          <td><input name="note" value="${esc(r.note || '')}"></td><td><input name="authoriser" value="${esc(r.authoriser || '')}"></td><td><input name="until" type="date" value="${esc(r.until || '')}"></td>
          <td><button class="icon" data-pl-del-mod="${r.id}" title="Remove">✕</button></td></tr>`).join('')}
        <tr data-pl-new-mod="${esc(list)}"><td><input name="customer" placeholder="Customer" list="pl-custs"></td><td><input name="tag" placeholder="any" list="pl-tags"></td><td><input name="type" placeholder="any" list="pl-types"></td>
          <td><input name="value" type="number" step="0.5" placeholder="+"></td><td><input name="note" placeholder="${list === 'Manual' ? 'Reason' : 'e.g. Sliders'}"></td><td><input name="authoriser" placeholder="${list === 'Manual' ? 'Who agreed' : ''}"></td><td><input name="until" type="date"></td>
          <td><button class="small" data-pl-add-mod="${esc(list)}">Add</button></td></tr></tbody></table></div>`;
    };
    const tagNames = [...new Set((md.tags || []).map((t) => t.tag))].sort();
    return `<div class="card pl-setup" id="pl-mods" ${store.get('planModsOpen', false) ? '' : 'hidden'}>
      <div class="row"><h2 style="margin:0">⚖ Priority modifiers</h2><div class="spacer"></div>
        <label class="button small" title="Bring over ShiftLookup, ManualLookup, MatchingLookup, DispatchLookup and the Cards sheet's AX / Tag list">📥 Import from the Production Planning workbook…<input type="file" accept=".xlsx,.xlsm" hidden id="pl-mods-file"></label></div>
      <p class="small muted">In <b>⚖ Score</b> mode each job's score is the sum of the modules switched on, highest first (📌 pinned jobs still go first). Right now it's the <b>${esc(md.current_shift || '—')}</b> shift.</p>
      <datalist id="pl-custs">${custs.map((c) => `<option value="${esc(c)}">`).join('')}</datalist><datalist id="pl-tags">${tagNames.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      <div class="pl-mod-list"><div class="row"><h4 style="margin:0">Deadline</h4>${sw('Deadline')}</div>
        <div class="form-grid pl-mod-dl">
          <label class="f">Overdue: base<input type="number" step="1" name="plan_dl_base" class="pl-mod-set" value="${esc(md.deadline.base)}"></label>
          <label class="f">+ per day overdue<input type="number" step="1" name="plan_dl_per_day" class="pl-mod-set" value="${esc(md.deadline.per_day)}"></label>
          <label class="f">up to + (max)<input type="number" step="1" name="plan_dl_max" class="pl-mod-set" value="${esc(md.deadline.max_extra)}"></label>
          <label class="f">Before the deadline: up to<input type="number" step="1" name="plan_dl_lead" class="pl-mod-set" value="${esc(md.deadline.lead)}"></label></div>
        <p class="small muted">Overdue: ${esc(md.deadline.base)} + ${esc(md.deadline.per_day)} a day overdue (at most +${esc(md.deadline.max_extra)}). Not yet due: ${esc(md.deadline.lead)} ÷ (1 + days left) — ${esc(md.deadline.lead)} at the cut-off, ${esc(Math.round(md.deadline.lead / 2 * 10) / 10)} a day before.</p></div>
      ${(md.lists || []).map(listCard).join('')}
      <div class="row small"><input id="pl-new-list" placeholder="New list, e.g. Inserts" style="max-width:220px"><button class="small" data-pl="new-list">+ Add a list</button>
        <span class="muted">A row matches a job by customer, card tag and card type (blank = any). In each list the most specific matching row counts.</span></div>
      <div class="pl-mod-list"><div class="row"><h4 style="margin:0">Shift</h4>${sw('Shift')}
        ${planning_shifts.map((k) => `<label class="small">${k[0].toUpperCase()}${k.slice(1)} from <input type="time" class="pl-mod-set" name="plan_shift_${k}" value="${hmS(md.shift_starts[k] ?? 0)}"></label>`).join(' ')}</div>
        <div class="kdb-scroll"><table class="log pl-speeds"><thead><tr><th>Customer</th>${planning_shifts.map((k) => `<th>${k[0].toUpperCase()}${k.slice(1)}${md.current_shift === k ? ' ◀ now' : ''}</th>`).join('')}</tr></thead><tbody>
        ${custs.map((c) => `<tr data-pl-shift="${esc(c)}"><td><b>${esc(c)}</b></td>${planning_shifts.map((k) => `<td><input type="number" step="0.5" name="${k}" value="${esc(shiftBy.get(c.toUpperCase())?.[k] ?? '')}" placeholder="0"></td>`).join('')}</tr>`).join('')}
        </tbody></table></div></div>
      <details class="pl-mod-list"><summary><b>Card tags</b> <span class="muted small">— ${(md.tags || []).length} card article${(md.tags || []).length === 1 ? '' : 's'} tagged (${esc(tagNames.join(', ') || 'none')})${cdb.columns?.tag ? '; the card database\'s Tag column is used too' : ''}</span></summary>
        <p class="small muted">A tag marks a kind of work order (e.g. PRIO, METAL) for the lists above. Paste two columns from Excel — card AX and tag — to add or change them.</p>
        <textarea id="pl-tags-paste" rows="3" placeholder="2267168&#9;PRIO"></textarea> <button class="small" data-pl="paste-tags">Save tags</button>
        <div class="kdb-scroll" style="max-height:240px"><table class="log small"><thead><tr><th>Card AX</th><th>Tag</th><th></th></tr></thead><tbody>
        ${(md.tags || []).map((t) => `<tr><td>${esc(t.ax)}</td><td>${esc(t.tag)}</td><td><button class="icon" data-pl-del-tag="${esc(t.ax)}" title="Remove">✕</button></td></tr>`).join('')}</tbody></table></div></details>
    </div>`;
  };
  const planning_shifts = ['night', 'morning', 'afternoon'];
  const ottoSetup = () => `
      <h3 class="pl-h" style="margin-top:14px">Otto machines <span class="muted small">— items per hour</span></h3>
      <table class="log pl-speeds pl-machines"><thead><tr><th>Machine</th><th>Named in the export as <span class="muted small">(optional, e.g. HMT PC#1)</span></th><th>Items per hour</th><th></th><th></th></tr></thead><tbody>
        ${(ot.machines || []).map((m) => `<tr data-plo-machine="${m.id}"><td><input type="text" name="name" value="${esc(m.name)}"></td><td><input type="text" name="match" value="${esc(m.match || '')}" placeholder="—"></td>
          <td><input type="number" min="1" step="1" name="speed" value="${m.speed ?? ''}" placeholder="items/h"></td><td><label class="row small"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> running</label></td>
          <td><button class="icon" data-plo-del-machine="${m.id}" title="Remove">✕</button></td></tr>`).join('')}
        <tr><td><input type="text" id="plo-new-machine" placeholder="Machine name"></td><td><input type="text" id="plo-new-match" placeholder="Named in the export as"></td><td><input type="number" min="1" id="plo-new-speed" placeholder="items/h"></td><td></td><td><button class="small" data-pl="add-otto-machine">Add</button></td></tr></tbody></table>
      <p class="small muted">Each Otto job goes on the running machine where it can finish first. A job whose Machine in the export contains a machine's "named as" text goes on that machine. A job never starts before its perso work order is projected to be done.</p>
      <h3 class="pl-h" style="margin-top:14px">Otto speeds by customer <span class="muted small">— items per hour, instead of the machine's speed</span></h3>
      <div class="kdb-scroll"><table class="log pl-speeds"><thead><tr><th>Customer</th><th>Name</th><th class="num">Jobs open</th><th class="num">Items open</th><th>Items per hour</th></tr></thead><tbody>
        ${(ot.customers || []).map((c) => `<tr><td><b>${esc(c.customer)}</b></td><td>${esc(c.name || '')}</td><td class="num">${c.jobs ? n(c.jobs) : '<span class="muted">none open</span>'}</td><td class="num">${n(c.items)}</td>
          <td><input type="number" min="1" step="1" class="plo-speed" data-customer="${esc(c.customer)}" value="${c.speed ?? ''}" placeholder="machine speed"></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Link the Otto export to see its customers.</td></tr>'}</tbody></table></div>
      <p class="small muted">The working day and days above are used for Otto too.</p>`;
  const finishO = (o) => (!ot.projected ? '' : o.finish_at ? `<span class="${o.late_minutes > 0 ? 'pl-late' : 'pl-ok'}" title="Projected ${esc(fmtDateTime(o.start_at))} → ${esc(fmtDateTime(o.finish_at))} at ${n(o.speed)} items/h">${new Date(o.finish_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${o.late_minutes > 0 ? ` · ${fmtSpan(o.late_minutes)} late` : ''}</span>
      <div class="small muted">${esc(o.machine_planned)}${o.waited_perso ? ' · after perso' : ''}</div>`
    : `<span class="pl-warn">⚠ ${o.unplanned === 'speed' ? 'no speed — ⚙ Setup' : 'no working time — check the working day'}</span>`);
  const ottoHtml = () => {
    const os = ot.source; const allO = [...ot.running, ...ot.queue];
    if (os.status === 'missing') return `<div class="kc-note">⚠ Can't find <code>${esc(os.file)}</code> — check the Otto path in ⚙ Setup.</div>`;
    if (os.status === 'error') return `<div class="kc-note">⚠ Couldn't read <code>${esc(os.file)}</code>: ${esc(os.error)}</div>`;
    if (os.status !== 'ok') return '<div class="card lib-empty"><h2>Otto</h2><p>Set where the Otto export is saved in ⚙ Setup (or try it with 📂 Load file…). Each Otto job is matched to its perso work order by the start of its Name, so you can see which are still waiting on perso.</p></div>';
    const of = store.get('planOttoFilter', {}) || {};
    const om = (o) => (!of.customer || o.customer === of.customer) && (!of.waiting || (of.waiting === 'perso' ? o.perso_open : !o.perso_open))
      && (!of.q || `${o.name} ${o.customer} ${o.customer_name || ''} ${o.group || ''} ${o.machine || ''}`.toLowerCase().includes(of.q.toLowerCase()));
    const oCust = [...new Set(allO.map((o) => o.customer).filter(Boolean))].sort();
    const behind = (o) => o.perso_finish_at && o.deadline && new Date(o.perso_finish_at) > deadlineAt(o);
    const oOver = allO.filter((o) => deadlineAt(o) && deadlineAt(o) < today);
    const oToday = allO.filter((o) => o.due === todayIso);
    const waiting = allO.filter((o) => o.perso_open);
    const persoCell = (o) => (!o.perso_open ? `<span class="pl-ok" title="No perso job open for ${esc(o.wo)} in the open work orders">✔ perso done</span>`
      : `<span class="${behind(o) ? 'pl-late' : 'pl-warn'}">⏳ ${o.perso.length} perso job${o.perso.length === 1 ? '' : 's'} open</span>${o.perso_finish_at ? `<div class="small ${behind(o) ? 'pl-late' : 'muted'}">ready ${esc(new Date(o.perso_finish_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}${behind(o) ? ' — after the plan date' : ''}</div>` : ''}`);
    const orow = (o, i) => { const l = left(o); return `<tr class="pl-job ${l.cls ? `${l.cls}-row` : ''} ${behind(o) ? 'pl-late-row' : ''}" data-pl-job="otto:${esc(o.key)}">
      <td class="num muted pl-n">${i === null ? '▶' : i + 1}</td>
      <td><b>${esc(o.due ? dayLabel(o.due) : '—')}</b> ${esc(o.deadline?.slice(11) || '')}<div class="small ${l.cls}">${esc(l.text)}</div></td>
      <td><b>${esc(o.wo)}</b><span class="muted">${esc(o.name.slice(o.wo.length))}</span><div class="small muted">${esc(o.group || '')}</div></td>
      <td>${esc(o.customer || '—')}<div class="small muted">${esc(o.customer_name || '')}</div></td>
      <td class="num"><b>${n(o.qty)}</b></td><td>${prioChip(o.prio)}</td><td>${esc(o.status || '')}<div class="small muted">${esc(o.machine || '')}</div></td><td>${persoCell(o)}</td>${ot.projected ? `<td>${finishO(o)}</td>` : ''}</tr>
      <tr class="pl-detail" data-pl-detail="otto:${esc(o.key)}" hidden><td></td><td colspan="${ot.projected ? 8 : 7}"><div class="small">${o.sub_customer ? `<b>${esc(o.sub_customer)}</b><br>` : ''}${o.comment ? esc(o.comment).replace(/\n/g, '<br>') : '<span class="muted">No comment.</span>'}</div>
        ${o.perso.length ? `<table class="log small" style="margin-top:6px"><thead><tr><th>Perso job</th><th class="num">Cards</th><th>Status</th><th>Perso deadline</th><th>Projected finish</th></tr></thead><tbody>${o.perso.map((pj) => `<tr><td>${esc(pj.key)}</td><td class="num">${n(pj.qty)}</td><td>${esc(pj.status || '')}</td><td>${esc(pj.deadline?.replace('T', ' ') || '—')}</td><td>${pj.finish_at ? esc(fmtDateTime(pj.finish_at)) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}</td></tr>`; };
    const ohead = `<tr><th></th><th>Plan date</th><th>Name</th><th>Customer</th><th class="num">Items</th><th>Priority</th><th>Status</th><th>Perso</th>${ot.projected ? '<th>Projected finish</th>' : ''}</tr>`;
    const rs = ot.running.filter(om); const qs = ot.queue.filter(om);
    return `<div class="kdb-tiles pl-tiles">
      <div class="kdb-tile"><div class="kdb-tile-l">Open Otto jobs</div><div class="kdb-tile-v">${n(allO.length)}</div><div class="kdb-tile-s">${n(sum(allO))} items${ot.done ? ` · ${n(ot.done)} finished not shown` : ''}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Running</div><div class="kdb-tile-v">${n(ot.running.length)}</div><div class="kdb-tile-s">${n(sum(ot.running))} items</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Due today</div><div class="kdb-tile-v ${oToday.length ? 'kdb-warn' : ''}">${n(oToday.length)}</div><div class="kdb-tile-s">${n(sum(oToday))} items</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Overdue items</div><div class="kdb-tile-v ${oOver.length ? 'kdb-bad' : 'kdb-ok'}">${n(sum(oOver))}</div><div class="kdb-tile-s">${n(oOver.length)} job${oOver.length === 1 ? '' : 's'}${ot.backlog?.catch_up?.catch_days ? ` · caught up in ~${ot.backlog.catch_up.catch_days} d` : ''}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Projected late</div><div class="kdb-tile-v ${allO.some((o) => o.late_minutes > 0) ? 'kdb-bad' : ot.projected ? 'kdb-ok' : ''}">${ot.projected ? n(allO.filter((o) => o.late_minutes > 0).length) : '—'}</div><div class="kdb-tile-s">${ot.projected ? `${(ot.machines || []).filter((m) => m.active).length} machine${(ot.machines || []).filter((m) => m.active).length === 1 ? '' : 's'} · ${esc(dayText)}` : 'set machines in ⚙ Setup'}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Waiting on perso</div><div class="kdb-tile-v ${allO.some(behind) ? 'kdb-bad' : ''}">${n(waiting.length)}</div><div class="kdb-tile-s">${allO.some(behind) ? `${n(allO.filter(behind).length)} perso ready after the plan date` : `${src.status === 'ok' ? 'perso work order still open' : 'link the perso export to match'}`}</div></div></div>
    ${backlogCard(ot.backlog, 'items', true)}
    <div class="row pl-filters">
      <input type="search" id="plo-q" placeholder="Search name, customer, plan group…" value="${esc(of.q || '')}">
      <select id="plo-customer"><option value="">All customers</option>${oCust.map((c) => `<option ${of.customer === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="plo-waiting"><option value="">Perso: any</option><option value="perso" ${of.waiting === 'perso' ? 'selected' : ''}>Waiting on perso</option><option value="ready" ${of.waiting === 'ready' ? 'selected' : ''}>Perso done</option></select>
      ${of.q || of.customer || of.waiting ? '<button class="link small" data-pl="oclear">Clear</button>' : ''}</div>
    ${ot.projected ? `<div class="card"><h3 class="pl-h">Otto capacity <span class="muted small">— ${esc(dayText)}, ${cap.days.length} day${cap.days.length === 1 ? '' : 's'} a week</span></h3>
      <div class="kdb-scroll"><table class="log pl-cap"><thead><tr><th>Machine</th><th class="num">Speed</th><th class="num">Max items a day</th><th class="num">Jobs</th><th class="num">Items planned</th><th class="num">Work</th><th>Booked until</th></tr></thead><tbody>
      ${(ot.machines || []).filter((m) => m.active).map((m) => { const l = (ot.load || []).find((x) => x.id === m.id) || {};
        return `<tr><td><b>${esc(m.name)}</b>${m.match ? `<div class="small muted">${esc(m.match)}</div>` : ''}</td><td class="num">${m.speed ? `${n(m.speed)}/h` : '—'}</td><td class="num"><b>${m.speed ? n(Math.round((m.speed * ((cap.start === cap.end ? 1440 : (cap.end - cap.start + 1440) % 1440))) / 60)) : '—'}</b></td>
          <td class="num">${n(l.jobs)}</td><td class="num">${n(l.items)}</td><td class="num">${l.minutes ? fmtSpan(l.minutes) : '—'}</td><td>${l.until ? esc(new Date(l.until).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      </tbody></table></div><p class="small muted">Max items a day: the machine's own speed for a full working day (a customer speed can be higher or lower).</p></div>` : ''}
    ${rs.length ? `<div class="card"><h3 class="pl-h">▶ Running <span class="muted small">${rs.length} job${rs.length === 1 ? '' : 's'} · ${n(sum(rs))} items</span></h3><div class="kdb-scroll"><table class="log pl-table"><thead>${ohead}</thead><tbody>${rs.map((o) => orow(o, null)).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h3 class="pl-h">Otto — by plan date, then priority <span class="muted small">${qs.length} job${qs.length === 1 ? '' : 's'} · ${n(sum(qs))} items · click a job for its comment and perso jobs</span></h3>
      <div class="kdb-scroll"><table class="log pl-table"><thead>${ohead}</thead><tbody>${qs.map((o) => orow(o, ot.queue.indexOf(o))).join('') || '<tr><td colspan="9" class="muted">Nothing matches.</td></tr>'}</tbody></table></div></div>
    ${os.skipped?.length ? `<p class="small muted">${os.skipped.length} row${os.skipped.length === 1 ? '' : 's'} with a plan date not understood.</p>` : ''}`;
  };

  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">🏭 Planning</h1>
      <div class="seg"><button type="button" data-pl-half="perso" class="${half === 'perso' ? 'on' : ''}">Perso</button><button type="button" data-pl-half="otto" class="${half === 'otto' ? 'on' : ''}">Otto</button></div>
${half === 'otto' ? '' : `      <div class="seg" title="FIFO: by deadline only. BAU: by due day, then High / Normal / Low, then cut-off">
        <button type="button" data-pl-mode="fifo" class="${mode === 'fifo' ? 'on' : ''}">FIFO</button><button type="button" data-pl-mode="bau" class="${mode === 'bau' ? 'on' : ''}">BAU</button><button type="button" data-pl-mode="score" class="${mode === 'score' ? 'on' : ''}" title="Highest score first: the deadline plus the ⚖ modifiers">⚖ Score</button><button type="button" data-pl-mode="mitigation" class="${mode === 'mitigation' ? 'on' : ''}" title="Save as many as possible: work orders due in the next few working days that can still make it first, then those already overdue or that would be late anyway, then those due later">🛟 Mitigation</button></div>`}
      <div class="spacer"></div>
      <span class="small muted">${(half === 'otto' ? ot.source : src).status === 'ok' ? `${esc((half === 'otto' ? ot.source : src).name)} · saved ${esc(fmtDateTime((half === 'otto' ? ot.source : src).modified))}${(half === 'otto' ? ot.source : src).uploaded ? ' (uploaded copy)' : ''}` : ''}</span>
      <button data-pl="refresh" title="Read the export again if it has changed">🔄 Refresh</button>
      <label class="button" title="Try it with a copy of the ${half === 'otto' ? 'Otto' : 'open work orders'} export">📂 Load file…<input type="file" accept=".xlsx" hidden id="pl-file"></label>
      ${half === 'perso' && src.status === 'ok' ? '<button data-pl="print" title="A simple sheet per cell (DOD, Emboss, Laser) of the work orders still open, to hand out">🖨 Print for cells</button>' : ''}
      ${half === 'otto' && ot.source.status === 'ok' ? '<button data-pl="print" title="Simple sheets of the Otto jobs: Incoming, In Progress and Ready, to hand out">🖨 Print lists</button>' : ''}
      ${half === 'perso' ? '<button data-pl="mods" title="Priority modifiers: customers and work order types that go first">⚖ Modifiers</button>' : ''}
      <button data-pl="setup" title="Where the export is, and the capacity">⚙ Setup</button>
    </div>
    ${half === 'perso' ? modsHtml() : ''}
    <div class="card pl-setup" id="pl-setup" ${src.status === 'ok' && !store.get('planSetupOpen', false) ? 'hidden' : ''}>
      <h2 style="margin-top:0">Setup</h2>
      <div class="form-grid">
        <label class="f full">Open work orders export (where it's saved)<input type="text" name="plan_src" value="${esc(settings.plan_src || '')}" placeholder="e.g. S:\\…\\Source Data\\OpenPersoWorkorders_PerAx.xlsx">
          <span class="small muted">Read again whenever it's saved (e.g. the hourly SSRS export). Nothing in it is changed.</span></label>
        <label class="f full">Otto export (where it's saved) — Name, Prod. Status, Items, Plan Date<input type="text" name="plan_otto_src" value="${esc(settings.plan_otto_src || '')}" placeholder="e.g. S:\\…\\Source Data\\Otto.xlsx">
          <span class="small ${ot.source.status === 'missing' || ot.source.status === 'error' ? 'pl-late' : 'muted'}">${ot.source.status === 'ok' ? `✔ ${n(ot.running.length + ot.queue.length)} open Otto jobs · saved ${esc(fmtDateTime(ot.source.modified))}` : ot.source.status === 'missing' ? '⚠ Can\'t find this file' : ot.source.status === 'error' ? `⚠ ${esc(ot.source.error)}` : 'Each Otto job is matched to its perso work order by the start of its Name.'}</span></label>
        <label class="f full">Card database (Access) — the Cards table gives each card article's type, material and print sides<input type="text" name="plan_db" value="${esc(settings.plan_db || '')}" placeholder="e.g. S:\\…\\Cards.accdb">
          <span class="small ${cdb.status === 'error' || cdb.status === 'missing' ? 'pl-late' : 'muted'}">${cdb.status === 'ok' ? `✔ ${n(cdb.count)} cards in the ${esc(cdb.table)} table · saved ${esc(fmtDateTime(cdb.modified))} — read again whenever it's saved` : cdb.status === 'missing' ? '⚠ Can\'t find this file' : cdb.status === 'error' ? `⚠ ${esc(cdb.error)}` : 'Read only — nothing in the database is changed. It can stay open in Access.'}</span></label>
        <label class="f">Table<input type="text" name="plan_db_table" value="${esc(settings.plan_db_table || 'Cards')}"></label>
        <label class="f">Flat rate — cards per hour for cards without a speed<input type="number" min="0" step="1" name="plan_rate" value="${esc(settings.plan_rate || '')}" placeholder="optional"></label>
        ${useMachines ? '' : `<label class="f">Lines running <span class="muted small">(until machines are set)</span><input type="number" min="1" step="1" name="plan_lines" value="${esc(settings.plan_lines || '1')}"></label>`}
        <label class="f">Ready before the cut-off (minutes) <span class="muted small">— packing and dispatch</span><input type="number" min="0" step="5" name="plan_buffer" value="${esc(settings.plan_buffer || '0')}"></label>
        <label class="f">Change-over (minutes) <span class="muted small">— when a machine switches card type or material</span><input type="number" min="0" step="1" name="plan_changeover" value="${esc(settings.plan_changeover || '0')}"></label>
        <label class="f">Hide anything due more than (days ago) <span class="muted small">— likely errors; 0 shows all</span><input type="number" min="0" step="1" name="plan_max_age" value="${esc(settings.plan_max_age ?? '30')}"></label>
        <label class="f">🛟 Mitigation: due within (working days) <span class="muted small">— go before the overdue; 0 = all</span><input type="number" min="0" step="1" name="plan_miti_days" value="${esc(settings.plan_miti_days ?? '5')}"></label>
        <label class="f">Working day from<input type="time" name="plan_day_start" value="${esc(settings.plan_day_start || '06:00')}"></label>
        <label class="f">to <span class="muted small">(the same time = round the clock; earlier = past midnight)</span><input type="time" name="plan_day_end" value="${esc(settings.plan_day_end || '22:00')}"></label>
        <div class="f full"><span>Working days</span><div class="row">${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => `<label class="row small"><input type="checkbox" data-pl-day="${i}" ${cap.days.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></div>
      </div>
${half === 'otto' ? ottoSetup() : `
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

      <h3 class="pl-h" style="margin-top:14px">Estimated OEE by customer</h3>
      <p class="small muted">The share of a machine's speed a customer's jobs really get (set-up, stops, rejects). A job at 1,000 cards/h with an OEE of 80% is planned at 800/h. Blank: the default below${p.oee_default ? ` (${Math.round(p.oee_default * 1000) / 10}%)` : ' — none: the full speed'}.</p>
      <label class="f" style="max-width:260px">Default OEE (%) <span class="muted small">— customers not filled in</span><input type="number" min="1" max="100" step="0.1" name="plan_oee_default" value="${esc(settings.plan_oee_default || '')}" placeholder="100"></label>
      <div class="kdb-scroll"><table class="log pl-speeds"><thead><tr><th>Customer</th><th>Name</th><th class="num">Cards open</th><th>OEE %</th></tr></thead><tbody>${(p.oee || []).map((o) => `<tr><td><b>${esc(o.customer)}</b></td><td>${esc(o.name || '')}</td><td class="num">${o.cards ? n(o.cards) : '<span class="muted">none open</span>'}</td>
        <td><input type="number" class="pl-oee" data-customer="${esc(o.customer)}" min="1" max="100" step="0.1" value="${o.oee ? Math.round(o.oee * 1000) / 10 : ''}" placeholder="${p.oee_default ? Math.round(p.oee_default * 1000) / 10 : '100'}"></td></tr>`).join('') || '<tr><td colspan="4" class="muted">No customers in the open work orders.</td></tr>'}</tbody></table></div>
      <p class="small muted">Jobs are worked through in the list's order — what's running first — each card line at its speed ${useMachines ? 'on a machine that runs its type' : '(divided over the lines running)'}, and each job gets a projected finish against its deadline.</p>
`}
    </div>
    ${half === 'otto' ? ottoHtml() : `
    ${src.status === 'ok' && cdb.status === 'ok' && (p.unknown_articles?.length || p.no_speed) ? `<div class="kc-note">⚠ ${[p.unknown_articles.length ? `${p.unknown_articles.length} card article${p.unknown_articles.length === 1 ? ' isn\'t' : 's aren\'t'} in the card database (${esc(p.unknown_articles.slice(0, 6).join(', '))}${p.unknown_articles.length > 6 ? ', …' : ''})` : '', p.no_speed ? `${p.no_speed} card line${p.no_speed === 1 ? ' has no speed of its own' : 's have no speed of their own'} — ${cap.rate ? 'the flat rate is used' : 'the average of the others is used (≈)'}` : ''].filter(Boolean).join(' · ')}. <button class="link small" data-pl="setup">⚙ Speeds</button></div>` : ''}
    ${src.status === 'missing' ? `<div class="kc-note">⚠ Can't find <code>${esc(src.file)}</code> — check the path in ⚙ Setup.</div>` : ''}
    ${src.status === 'error' ? `<div class="kc-note">⚠ Couldn't read <code>${esc(src.file)}</code>: ${esc(src.error)}</div>` : ''}
    ${src.status === 'none' ? '<div class="card lib-empty"><h2>Production planning</h2><p>Set where the open work orders export is saved in ⚙ Setup (or try it with 📂 Load file…). The work orders are put in order by their deadline — the due date at the shipper\'s cut-off — and, with a capacity, each one\'s finish is projected.</p></div>' : ''}
    ${src.status === 'ok' ? `
    <div class="kdb-tiles pl-tiles">
      <div class="kdb-tile"><div class="kdb-tile-l">Open jobs</div><div class="kdb-tile-v">${n(all.length)}</div><div class="kdb-tile-s">${n(sum(all))} cards · ${n(new Set(all.map((j) => j.wo)).size)} work orders</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Running</div><div class="kdb-tile-v">${n(p.running.length)}</div><div class="kdb-tile-s">${n(sum(p.running))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Due today</div><div class="kdb-tile-v ${dueToday.length ? 'kdb-warn' : ''}">${n(dueToday.length)}</div><div class="kdb-tile-s">${n(sum(dueToday))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Overdue cards</div><div class="kdb-tile-v ${overdue.length ? 'kdb-bad' : 'kdb-ok'}">${n(sum(overdue))}</div><div class="kdb-tile-s">${n(overdue.length)} job${overdue.length === 1 ? '' : 's'}${p.backlog?.catch_up?.catch_days ? ` · caught up in ~${p.backlog.catch_up.catch_days} d` : ''}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Projected late</div><div class="kdb-tile-v ${late.length ? 'kdb-bad' : p.projected ? 'kdb-ok' : ''}">${p.projected ? n(late.length) : '—'}</div><div class="kdb-tile-s">${esc(capText)}</div></div>
    </div>
    ${src.status === 'ok' ? `<div class="row pl-views"><div class="seg">${viewList.map(([k, l]) => `<button type="button" data-pl-view="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${view === 'gantt' ? `<div class="seg">${[[1, '1 day'], [3, '3 days'], [7, '1 week']].map(([d, l]) => `<button type="button" data-pl-span="${d}" class="${Number(store.get('planSpan', 3)) === d ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="small muted">Click a job to see its deadline; green on time · amber within 2 h of its cut-off · red late</span>` : ''}</div>` : ''}
    ${view === 'gantt' ? '<div class="card pl-gantt-card"><div id="pl-gantt-info" class="small"></div><div id="pl-gantt"></div></div>' : ''}
    ${view === 'load' ? `${loadHtml()}${capCard}` : ''}
    ${view === 'history' ? historyHtml() : ''}
    ${view !== 'list' ? '' : `${backlogCard(p.backlog, 'cards', false)}${capCard}
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
    <div class="card"><h3 class="pl-h">Next to start — ${mode === 'fifo' ? 'FIFO: by deadline' : mode === 'mitigation' ? '🛟 Mitigation: what can still be on time first' : mode === 'score' ? '⚖ Score: highest first (deadline + modifiers)' : 'BAU: by due day, then priority, then cut-off'} <span class="muted small">${queueShown.length} job${queueShown.length === 1 ? '' : 's'} · ${n(sum(queueShown))} cards · click a job for its card articles</span></h3>
      <div class="kdb-scroll"><table class="log pl-table"><thead>${head}</thead><tbody>${queueShown.map((j, k) => `${mode === 'mitigation' && mitiGroup(j) !== mitiGroup(queueShown[k - 1]) ? mitiHead(j) : ''}${row(j, p.queue.indexOf(j))}`).join('') || '<tr><td colspan="8" class="muted">Nothing matches.</td></tr>'}</tbody></table></div></div>`}` : ''}`}`;
  if (half === 'perso' && view === 'gantt' && $('#pl-gantt')) {
    const draw = () => drawPlanGantt($('#pl-gantt'), $('#pl-gantt-info'), p, match);
    draw();
    window.onresize = () => { if ($('#pl-gantt')) draw(); };
  }

  const setO = (k, v) => { const of = store.get('planOttoFilter', {}) || {}; of[k] = v || ''; store.set('planOttoFilter', of); renderPlanning(); };
  $('#plo-q')?.addEventListener('change', (e) => setO('q', e.target.value.trim()));
  $('#plo-customer')?.addEventListener('change', (e) => setO('customer', e.target.value));
  $('#plo-waiting')?.addEventListener('change', (e) => setO('waiting', e.target.value));
  const setF = (k, v) => { f[k] = v || ''; store.set('planFilter', f); renderPlanning(); };
  $('#pl-q')?.addEventListener('change', (e) => setF('q', e.target.value.trim()));
  $('#pl-customer')?.addEventListener('change', (e) => setF('customer', e.target.value));
  $('#pl-shipper')?.addEventListener('change', (e) => setF('shipper', e.target.value));
  $('#pl-prio')?.addEventListener('change', (e) => setF('prio', e.target.value));
  $('#pl-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const res = await fetch(`/api/plan/upload${half === 'otto' ? '?half=otto' : ''}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) toast(d.error || res.statusText, 'error'); else toast(`${file.name} loaded${(half === 'otto' ? settings.plan_otto_src : settings.plan_src) ? ' — the linked export is still used; clear its path to use this copy' : ''}`);
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
  $$('.pl-oee').forEach((el) => el.addEventListener('change', async () => {
    try { await api.put(`/plan/oee/${encodeURIComponent(el.dataset.customer)}`, { oee: el.value.trim() }); toast('OEE saved'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-plo-machine] input').forEach((el) => el.addEventListener('change', async () => {
    const id = el.closest('[data-plo-machine]').dataset.ploMachine;
    try { await api.patch(`/plan/otto/machines/${id}`, { [el.name]: el.type === 'checkbox' ? el.checked : el.value }); toast('Saved'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('.plo-speed').forEach((el) => el.addEventListener('change', async () => {
    try { await api.put(`/plan/otto/speeds/${encodeURIComponent(el.dataset.customer)}`, { speed: el.value.trim() }); toast('Speed saved'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  const reMods = () => { store.set('planModsOpen', true); renderPlanning(); };
  $$('[data-pl-mod] input').forEach((el) => el.addEventListener('change', async () => {
    try { await api.patch(`/plan/modifiers/${el.closest('[data-pl-mod]').dataset.plMod}`, { [el.name]: el.value }); toast('Saved'); reMods(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-pl-shift] input').forEach((el) => el.addEventListener('change', async () => {
    try { await api.put(`/plan/mod-shifts/${encodeURIComponent(el.closest('[data-pl-shift]').dataset.plShift)}`, { [el.name]: el.value }); toast('Saved'); reMods(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('.pl-mod-set').forEach((el) => el.addEventListener('change', async () => {
    try { await api.patch('/settings', { [el.name]: el.value }); toast('Saved'); reMods(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-pl-mod-on]').forEach((el) => el.addEventListener('change', async () => {
    const off = new Set(md.off || []); const name = el.dataset.plModOn;
    for (const x of [...off]) if (x.toLowerCase() === name.toLowerCase()) off.delete(x);
    if (!el.checked) off.add(name);
    try { await api.patch('/settings', { plan_mod_off: [...off].join(',') }); toast(el.checked ? `${name} on` : `${name} off`); reMods(); } catch (err) { toast(err.message, 'error'); }
  }));
  $('#pl-mods-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const res = await fetch('/api/plan/modifiers/import', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) toast(d.error || res.statusText, 'error');
    else toast(`Imported: ${Object.entries(d.lists).map(([k, v]) => `${k} ${v}`).join(', ')}${d.shifts ? `, shifts for ${d.shifts} customers` : ''}${d.tags ? `, ${d.tags} card tags` : ''}`);
    reMods();
  });
  $$('[data-pl-machine] input').forEach((el) => el.addEventListener('change', async () => {
    const id = el.closest('[data-pl-machine]').dataset.plMachine;
    try { await api.patch(`/plan/machines/${id}`, { [el.name]: el.type === 'checkbox' ? el.checked : el.value }); toast('Saved'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  main().onclick = async (e) => {
    const delM = e.target.closest('[data-pl-del-machine]');
    if (delM) { if (!confirm('Remove this machine?')) return; try { await api.del(`/plan/machines/${delM.dataset.plDelMachine}`); renderPlanning(); } catch (err) { toast(err.message, 'error'); } return; }
    const addMod = e.target.closest('[data-pl-add-mod]');
    if (addMod) {
      const tr = addMod.closest('tr'); const body = { list: addMod.dataset.plAddMod };
      tr.querySelectorAll('input').forEach((x) => { body[x.name] = x.value; });
      try { await api.post('/plan/modifiers', body); toast('Modifier added'); reMods(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const delMod = e.target.closest('[data-pl-del-mod]');
    if (delMod) { try { await api.del(`/plan/modifiers/${delMod.dataset.plDelMod}`); reMods(); } catch (err) { toast(err.message, 'error'); } return; }
    const delTag = e.target.closest('[data-pl-del-tag]');
    if (delTag) { try { await api.post('/plan/card-tags', { ax: delTag.dataset.plDelTag, tag: '' }); reMods(); } catch (err) { toast(err.message, 'error'); } return; }
    if (e.target.closest('[data-pl="paste-tags"]')) {
      try { const r = await api.post('/plan/card-tags', { text: $('#pl-tags-paste').value }); toast(`${r.saved} tag${r.saved === 1 ? '' : 's'} saved`); reMods(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (e.target.closest('[data-pl="new-list"]')) {
      const name = $('#pl-new-list').value.trim(); if (!name) return;
      md.lists.push(name); store.set('planModsOpen', true);
      const tmp = document.createElement('div'); tmp.innerHTML = modsHtml(); $('#pl-mods').replaceWith(tmp.firstElementChild);
      toast(`Add a row to keep the ${name} list`); return;
    }
    if (e.target.closest('[data-pl="print"]')) { printDialog(p, mode, settings, half); return; }
    if (e.target.closest('[data-pl="mods"]')) { const m = $('#pl-mods'); m.hidden = !m.hidden; store.set('planModsOpen', !m.hidden); if (!m.hidden) m.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const delO = e.target.closest('[data-plo-del-machine]');
    if (delO) { if (!confirm('Remove this Otto machine?')) return; try { await api.del(`/plan/otto/machines/${delO.dataset.ploDelMachine}`); renderPlanning(); } catch (err) { toast(err.message, 'error'); } return; }
    if (e.target.closest('[data-pl="add-otto-machine"]')) {
      try { await api.post('/plan/otto/machines', { name: $('#plo-new-machine').value, match: $('#plo-new-match').value, speed: $('#plo-new-speed').value }); toast('Machine added'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
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
    const v = e.target.closest('[data-pl-view]');
    if (v) { store.set('planView', v.dataset.plView); renderPlanning(); return; }
    const sp = e.target.closest('[data-pl-span]');
    if (sp) { store.set('planSpan', Number(sp.dataset.plSpan)); renderPlanning(); return; }
    const hf = e.target.closest('[data-pl-half]');
    if (hf) { store.set('planHalf', hf.dataset.plHalf); renderPlanning(); return; }
    if (e.target.closest('[data-pl="oclear"]')) { store.set('planOttoFilter', {}); renderPlanning(); return; }
    const m = e.target.closest('[data-pl-mode]');
    if (m) { store.set('planMode', m.dataset.plMode); renderPlanning(); return; }
    const b = e.target.closest('[data-pl]');
    if (b?.dataset.pl === 'setup') { const s = $('#pl-setup'); s.hidden = !s.hidden; store.set('planSetupOpen', !s.hidden); if (!s.hidden) s.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    if (b?.dataset.pl === 'refresh') { renderPlanning(); return; }
    if (b?.dataset.pl === 'clear') { store.set('planFilter', {}); renderPlanning(); return; }
    const pin = e.target.closest('[data-pl-pin]');
    if (pin) {
      e.stopPropagation();
      const k = pin.dataset.plPin; const on = pin.classList.contains('on');
      try { if (on) await api.del(`/plan/pins?key=${encodeURIComponent(k)}`); else await api.post('/plan/pins', { key: k }); toast(on ? 'Unpinned' : '📌 Pinned to the front'); } catch (err) { toast(err.message, 'error'); }
      renderPlanning(); return;
    }
    const job = e.target.closest('[data-pl-job]');
    if (job) { const d = $(`[data-pl-detail="${CSS.escape(job.dataset.plJob)}"]`); if (d) d.hidden = !d.hidden; }
  };
}

// 🖨 The operator sheet: for each cell (card type), the open work orders in the list's order —
// big, plain and colour-coded, with a box to tick. A job with cards of several types is on each
// of those cells' sheets with that type's cards.
const CELL_ORDER = ['dod', 'emboss', 'laser'];
function cellsOf(jobs) {
  const cells = new Map();
  for (const j of jobs) {
    const by = new Map();
    for (const a of j.articles) { const t = a.card?.type || 'Other'; by.set(t, (by.get(t) || 0) + a.qty); }
    for (const [t, qty] of by) { if (!cells.has(t)) cells.set(t, []); cells.get(t).push({ job: j, qty }); }
  }
  const rank = (t) => { const i = CELL_ORDER.indexOf(t.toLowerCase()); return i < 0 ? (t === 'Other' ? 99 : 50) : i; };
  return [...cells.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([type, rows]) => ({ type, rows }));
}
function operatorSheetHtml(jobs, { cells: pick, layout = 'pages', limit = 0, method = '', spec = '', splitOverdue = false, groups = null, now = new Date() } = {}) {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(now); const tm = new Date(now); tm.setDate(tm.getDate() + 1); const tomorrow = ymd(tm);
  const nowKey = `${today}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const when = (j) => {
    if (!j.deadline) return { cls: 'later', tag: '—', time: '' };
    const [d, t] = j.deadline.split('T');
    const time = j.no_cutoff ? (layout === 'side' ? 'eod' : 'end of day') : t;
    const day = layout === 'side' ? `${Number(d.slice(8))}/${Number(d.slice(5, 7))}` : new Date(`${d}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    if (j.deadline < nowKey) return { cls: 'late', tag: 'LATE', time: `${day} ${time}` };
    if (d === today) return { cls: 'today', tag: 'TODAY', time };
    if (d === tomorrow) return { cls: 'tomorrow', tag: 'TOMORROW', time };
    return { cls: 'later', tag: layout === 'side' ? day : new Date(`${d}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase(), time };
  };
  const n = (v) => Number(v || 0).toLocaleString('en-GB');
  const colour = () => '#7382e6'; // one colour for every cell
  const cells = (groups || cellsOf(jobs)).filter((c) => !pick || pick.includes(c.type));
  const stamp = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  // overdue (past its deadline, not running): on a list of its own when split off
  const isOver = (r) => !r.job.running && !r.job.keep && when(r.job).cls === 'late';
  const sheet = (c, all = c.rows, overdue = false) => {
    const rows = limit > 0 ? all.slice(0, limit) : all;
    return `<section class="cell${overdue ? ' over' : ''}" style="--c:${colour(c.type)}">
      <header><div class="name">${esc(c.type)}${overdue ? ' <span class="od">Overdue</span>' : ''}</div>${method ? `<div class="method">${esc(method)}${spec ? ' · TEST' : ''}</div>` : ''}</header>
      ${rows.length ? '' : `<p class="none">${overdue ? 'Nothing overdue.' : 'Nothing open.'}</p>`}
      <table><tbody>${rows.map((r, i) => { const w = when(r.job); const hot = /high|urgent/i.test(r.job.prio || ''); return `<tr class="${w.cls}${r.job.running ? ' run' : ''}">
        <td class="box"></td><td class="no">${r.job.running ? '▶' : i + 1}</td>
        <td class="wo">${esc(r.job.wo)}<span>${r.job.is_otto ? esc(r.job.name.slice(r.job.wo.length)) : `/${esc(r.job.per)}`}</span>${r.note ? `<div class="nt">${esc(r.note)}</div>` : ''}</td>
        <td class="cu">${esc(r.job.customer || '')}${hot ? ' <span class="hot">!</span>' : ''}${r.job.pinned ? ' <span class="pin">📌</span>' : ''}</td>
        <td class="qty">${n(r.qty)}</td>
        <td class="due"><span class="tag">${esc(w.tag)}</span> ${esc(w.time)}</td></tr>`; }).join('')}</tbody></table>
      ${layout === 'side' ? '' : legend}
    </section>`;
  };
  const legend = `<footer><span><span class="sw late"></span> late</span><span><span class="sw today"></span> due today</span><span><span class="sw tomorrow"></span> tomorrow</span>${groups ? '' : '<span>▶ running</span>'}<span><span class="hot">!</span> high priority</span><span>☐ tick when done</span><span class="st">Printed ${esc(stamp)}</span></footer>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Open work orders — ${esc(stamp)}</title><style>
    @page { size: A4 ${layout === 'side' ? 'landscape' : 'portrait'}; margin: 10mm; }
    * { box-sizing: border-box; } body { font-family: Arial, Helvetica, sans-serif; margin: 0; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .wrap { display: ${layout === 'side' ? 'grid' : 'block'}; grid-template-columns: repeat(${Math.max(1, cells.length)}, 1fr); gap: 6mm; }
    .cell { ${layout === 'side' ? '' : 'page-break-after: always; break-after: page;'} border-top: 10px solid var(--c); padding-top: 3mm; }
    .cell:last-child { page-break-after: auto; break-after: auto; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; border-bottom: 2px solid #111; padding-bottom: 2mm; margin-bottom: 2mm; }
    .name { font-size: ${layout === 'side' ? 28 : 44}px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; color: var(--c); }
    .nt { font-family: Arial, sans-serif; font-weight: 400; font-size: .7em; color: #555; }
    .od { font-size: .45em; vertical-align: middle; background: #c62828; color: #fff; border-radius: 4px; padding: 2px 8px; letter-spacing: 1px; }
    .brk { page-break-before: always; break-before: page; }
    .none { font-size: 18px; color: #555; padding: 4mm 0; }
    .method { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; border: 1px solid #999; border-radius: 3px; padding: 1px 6px; white-space: nowrap; align-self: flex-start; }
    table { width: 100%; border-collapse: collapse; font-size: ${layout === 'side' ? 12 : 17}px; }
    tr { border-bottom: 1px solid #bbb; page-break-inside: avoid; } td { padding: ${layout === 'side' ? '3px 3px' : '5px 6px'}; vertical-align: middle; }
    .box { width: 26px; } .box::before { content: ''; display: inline-block; width: ${layout === 'side' ? 14 : 20}px; height: ${layout === 'side' ? 14 : 20}px; border: 2px solid #111; border-radius: 3px; }
    .no { width: 28px; color: #666; text-align: right; font-weight: 700; }
    .wo { font-family: Consolas, 'Courier New', monospace; font-weight: 800; white-space: nowrap; } .wo span { font-weight: 400; color: #555; }
    .cu { font-weight: 700; white-space: nowrap; } .qty { text-align: right; font-weight: 700; white-space: nowrap; }
    .due { white-space: nowrap; text-align: right; } .tag { display: inline-block; min-width: ${layout === 'side' ? 44 : 76}px; text-align: center; font-weight: 800; font-size: .8em; padding: 2px 6px; border-radius: 4px; border: 2px solid #999; }
    tr.late { background: #fde2e2; } tr.late .tag { background: #c62828; border-color: #c62828; color: #fff; }
    tr.today { background: #fff4d6; } tr.today .tag { background: #f9a825; border-color: #f9a825; color: #111; }
    tr.tomorrow .tag { border-color: #1f6feb; color: #1f6feb; }
    tr.run .no { color: #111; }
    .hot { display: inline-block; background: #111; color: #fff; border-radius: 50%; width: 1.2em; height: 1.2em; line-height: 1.2em; text-align: center; font-size: .8em; }
    footer { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4mm; font-size: 11px; color: #333; align-items: center; } footer .st { margin-left: auto; color: #777; }
    .sw { display: inline-block; width: 12px; height: 12px; border: 1px solid #999; vertical-align: middle; } .sw.late { background: #fde2e2; } .sw.today { background: #fff4d6; } .sw.tomorrow { border: 2px solid #1f6feb; }
    .empty { font-size: 24px; padding: 20mm; text-align: center; }
    .legend footer { margin-top: 3mm; }
    .spec { page-break-before: always; break-before: page; font-size: 13px; line-height: 1.45; }
    .spec h1 { font-size: 22px; margin: 0 0 2mm; } .spec h2 { font-size: 15px; margin: 5mm 0 1mm; border-bottom: 1px solid #999; }
    .spec ol, .spec ul { margin: 1mm 0 0 5mm; padding-left: 4mm; } .spec .note { color: #555; font-size: 11px; } .spec code { font-family: Consolas, monospace; }
    @media screen { .spec { background: #fff; max-width: ${layout === 'side' ? '297mm' : '210mm'}; margin: 10px auto; padding: 10mm; } }
    @media screen { body { background: #e8e8e8; } .legend { max-width: ${layout === 'side' ? '297mm' : '210mm'}; margin: 0 auto; } .wrap { background: #fff; max-width: ${layout === 'side' ? '297mm' : '210mm'}; margin: 10px auto; padding: 10mm; } .cell { margin-bottom: 12mm; } }
  </style></head><body>${!cells.length ? '<div class="wrap"><p class="empty">No open work orders.</p></div>'
    : !splitOverdue ? `<div class="wrap">${cells.map((c) => sheet(c)).join('')}</div>`
      : layout === 'side' ? `<div class="wrap">${cells.map((c) => sheet(c, c.rows.filter((r) => !isOver(r)))).join('')}</div><div class="wrap brk">${cells.map((c) => sheet(c, c.rows.filter(isOver), true)).join('')}</div>`
        : `<div class="wrap">${cells.flatMap((c) => [sheet(c, c.rows.filter((r) => !isOver(r))), sheet(c, c.rows.filter(isOver), true)]).join('')}</div>`}${layout === 'side' && cells.length ? `<div class="legend">${legend}</div>` : ''}${spec ? `<section class="spec">${spec}</section>` : ''}</body></html>`;
}
// 🧪 Testing mode: a last page explaining, in general terms, how each kind of list is put in order.
function orderSpecHtml(p, mode, { split = false } = {}, now = new Date()) {
  const days = p.mitigation?.days ?? 5;
  const byMode = {
    fifo: `<h2>FIFO — by deadline</h2><ol><li>Earliest deadline first, so overdue work orders (oldest first) are at the top.</li><li>Same deadline: priority High, then Normal, then Low.</li><li>Still the same: by work order / job number.</li></ol>`,
    bau: `<h2>BAU — by due day, then priority</h2><ol><li>Earliest due <b>day</b> first.</li><li>Within a day: priority High, then Normal, then Low.</li><li>Then the earliest cut-off time, then work order / job number.</li></ol>`,
    score: `<h2>Score — highest score first</h2><p>Each work order gets a score; the highest goes first (same score: earliest deadline first). The score adds up:</p><ul>
      <li><b>Deadline</b> — overdue work orders score highest, more the longer they're overdue; others score more the closer their deadline.</li>
      <li><b>Modifier lists</b> (e.g. Matching, Dispatch, Manual) — extra points for particular customers, card tags or card types, e.g. work orders that need extra steps later on.</li>
      <li><b>Shift</b> — extra points for particular customers during particular shifts.</li></ul>`,
    mitigation: `<h2>Mitigation — as many on time as possible</h2><ol>
      <li><b>Due within the next ${days} working day${days === 1 ? '' : 's'}</b> and still able to make their deadline — earliest deadline first.</li>
      <li><b>Late anyway</b> — work orders that will miss their deadline whatever we do, oldest first. They come after the ones that can still be saved.</li>
      <li><b>Due later</b> than that — earliest deadline first.</li></ol>`,
  };
  return `<h1>🧪 How this list was ordered</h1>
    <p class="note">Testing mode · printed ${esc(now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</p>
    <h2>Every list</h2><ul>
      <li>Each cell's sheet lists the open work orders with cards of that type (DOD, Emboss, Laser, …), in the same order on every sheet.</li>
      <li>A work order's deadline is its due date at the shipper's cut-off time.</li>
      <li><b>▶ Running</b> work orders come first, then any <b>📌 pinned</b> by the planner, then the rest as below.</li>
      ${split ? '<li>Overdue work orders (past their deadline and not running) are taken off each cell\'s list and put on a separate <b>Overdue</b> sheet for that cell, in the same order.</li>' : ''}</ul>
    ${byMode[mode] || ''}
    <h2>The sheet</h2><ul><li>Row colours: red <b>LATE</b> = past its deadline when printed; amber <b>TODAY</b>; blue <b>TOMORROW</b>; otherwise the date.</li>
      <li><b>!</b> = High / Urgent priority; 📌 = pinned; the number is the place in the order.</li></ul>`;
}
// 🖨 Otto: Incoming (its perso work order still open), In Progress (started at Otto), Ready (perso
// done, not started at Otto) — each in the Otto list's order (plan date, then Urgent / High first).
function ottoGroups(ot) {
  const fmt = (iso) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const row = (o, extra = {}) => ({ job: { ...o, is_otto: true, running: false, pinned: false, ...extra }, qty: o.qty });
  const all = [...ot.running, ...ot.queue];
  return [
    { type: 'Incoming', rows: ot.queue.filter((o) => o.perso_open).map((o) => ({ ...row(o), note: o.perso_finish_at ? `perso ready ≈ ${fmt(o.perso_finish_at)}` : `${o.perso.length} perso job${o.perso.length === 1 ? '' : 's'} open` })) },
    { type: 'In Progress', rows: all.filter((o) => o.running).map((o) => row(o, { keep: true })) },
    { type: 'Ready', rows: ot.queue.filter((o) => !o.perso_open).map((o) => row(o)) },
  ];
}
function ottoSpecHtml({ split = false } = {}, now = new Date()) {
  return `<h1>🧪 How this list was ordered</h1>
    <p class="note">Testing mode · printed ${esc(now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</p>
    <h2>The three lists</h2><ul>
      <li><b>Incoming</b> — Otto jobs whose perso work order is still being made. They can't start yet; the note shows when perso is expected to be ready.</li>
      <li><b>In Progress</b> — Otto jobs already started.</li>
      <li><b>Ready</b> — Otto jobs whose perso work is finished and that haven't been started yet: these can be picked up now.</li>
      ${split ? '<li>Overdue Incoming and Ready jobs (past their plan date) are put on a separate <b>Overdue</b> sheet for that list.</li>' : ''}</ul>
    <h2>Order — in every list</h2><ol><li>Earliest plan date and time first.</li><li>Same time: Urgent, then High, then the rest.</li><li>Still the same: by name.</li></ol>
    <h2>The sheet</h2><ul><li>Row colours: red <b>LATE</b> = past its plan date when printed; amber <b>TODAY</b>; blue <b>TOMORROW</b>; otherwise the date.</li>
      <li><b>!</b> = Urgent / High priority; the number is the place in the list.</li></ul>`;
}
function printDialog(p, mode, settings = {}, half = 'perso') {
  if (half === 'otto') return printOttoDialog(p);
  const jobs = [...p.running, ...p.queue];
  const cells = cellsOf(jobs);
  const saved = store.get('planPrint', {}) || {};
  const modeText = { fifo: 'order: FIFO (by deadline)', bau: 'order: BAU', score: 'order: ⚖ score', mitigation: 'order: 🛟 mitigation (can still be on time first)' }[mode] || '';
  openModal(`<div class="modal-head"><h2 style="margin:0">🖨 Print for cells</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="pl-print" class="form-grid">
      <div class="f full"><span>Cells</span><div class="row">${cells.map((c) => `<label class="row small"><input type="checkbox" name="cell" value="${esc(c.type)}" ${!saved.cells || saved.cells.includes(c.type) ? 'checked' : ''}> <b>${esc(c.type)}</b> <span class="muted">${c.rows.length}</span></label>`).join('') || '<span class="muted">No open work orders.</span>'}</div></div>
      <label class="f">Layout<select name="layout"><option value="pages" ${saved.layout !== 'side' ? 'selected' : ''}>A page per cell (portrait)</option><option value="side" ${saved.layout === 'side' ? 'selected' : ''}>Side by side on one page (landscape)</option></select></label>
      <label class="f">Work orders per cell<select name="limit">${[[0, 'all'], [10, 'first 10'], [20, 'first 20'], [30, 'first 30']].map(([v, l]) => `<option value="${v}" ${Number(saved.limit || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="row small full"><input type="checkbox" name="split" ${saved.split ? 'checked' : ''}> <b>Overdue on a separate list</b> — each cell's overdue work orders on a sheet of their own, after its main list</label>
      <label class="row small full"><input type="checkbox" name="testing" ${saved.testing ? 'checked' : ''}> 🧪 <b>Testing mode</b> — a last page explaining how the list was ordered (and TEST on each sheet)</label>
      <p class="small muted full">In the planning list's order (${esc(modeText.replace('order: ', ''))}), running first. Each cell gets the work orders with cards of its type, and that type's cards.</p>
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">🖨 Print</button></div>
    </form>`);
  $('#pl-print').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const opts = { cells: fd.getAll('cell'), layout: fd.get('layout'), limit: Number(fd.get('limit')), testing: fd.get('testing') === 'on', split: fd.get('split') === 'on' };
    store.set('planPrint', opts);
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for CI Manager to print', 'error'); return; }
    w.document.open(); w.document.write(operatorSheetHtml(jobs, { ...opts, splitOverdue: opts.split, spec: opts.testing ? orderSpecHtml(p, mode, { split: opts.split }) : '', method: { fifo: 'FIFO', bau: 'BAU', score: 'Score', mitigation: 'Mitigation' }[mode] || '' })); w.document.close();
    closeModal();
    w.focus(); setTimeout(() => w.print(), 300);
  });
}

function printOttoDialog(p) {
  const ot = p.otto || { running: [], queue: [] };
  const groups = ottoGroups(ot);
  const saved = store.get('planPrintOtto', {}) || {};
  openModal(`<div class="modal-head"><h2 style="margin:0">🖨 Print Otto lists</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="pl-print" class="form-grid">
      <div class="f full"><span>Lists</span><div class="row">${groups.map((c) => `<label class="row small"><input type="checkbox" name="cell" value="${esc(c.type)}" ${!saved.cells || saved.cells.includes(c.type) ? 'checked' : ''}> <b>${esc(c.type)}</b> <span class="muted">${c.rows.length}</span></label>`).join('')}</div></div>
      <label class="f">Layout<select name="layout"><option value="pages" ${saved.layout !== 'side' ? 'selected' : ''}>A page per list (portrait)</option><option value="side" ${saved.layout === 'side' ? 'selected' : ''}>Side by side on one page (landscape)</option></select></label>
      <label class="f">Jobs per list<select name="limit">${[[0, 'all'], [10, 'first 10'], [20, 'first 20'], [30, 'first 30']].map(([v, l]) => `<option value="${v}" ${Number(saved.limit || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="row small full"><input type="checkbox" name="split" ${saved.split ? 'checked' : ''}> <b>Overdue on a separate list</b> — overdue Incoming and Ready jobs on a sheet of their own</label>
      <label class="row small full"><input type="checkbox" name="testing" ${saved.testing ? 'checked' : ''}> 🧪 <b>Testing mode</b> — a last page explaining the lists (and TEST on each sheet)</label>
      <p class="small muted full"><b>Incoming</b>: perso work order still open · <b>In Progress</b>: started at Otto · <b>Ready</b>: perso done, not yet started. Each by plan date, then Urgent / High first.</p>
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">🖨 Print</button></div>
    </form>`);
  $('#pl-print').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const opts = { cells: fd.getAll('cell'), layout: fd.get('layout'), limit: Number(fd.get('limit')), testing: fd.get('testing') === 'on', split: fd.get('split') === 'on' };
    store.set('planPrintOtto', opts);
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for CI Manager to print', 'error'); return; }
    w.document.open(); w.document.write(operatorSheetHtml([], { ...opts, groups, splitOverdue: opts.split, spec: opts.testing ? ottoSpecHtml({ split: opts.split }) : '', method: 'Otto' })); w.document.close();
    closeModal();
    w.focus(); setTimeout(() => w.print(), 300);
  });
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

// ▤ Gantt: one row per running machine, a bar per job on it (its card lines merged), from now
// over 1 day / 3 days / a week; non-working time shaded. A click picks a job: its bars stay
// bright and its deadline is drawn.
let planSel = null;
function drawPlanGantt(el, info, p, match) {
  const span = Number(store.get('planSpan', 3)) || 3;
  const from = new Date(p.now); const to = new Date(from.getTime() + span * 86400000);
  const LBL = 96; const W = Math.max(400, el.clientWidth - LBL - 4); const ROW = 34;
  const x = (t) => LBL + ((new Date(t) - from) / (to - from)) * W;
  const machines = (p.machines || []).filter((m) => m.active);
  const jobs = [...p.running, ...p.queue];
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  // bars: a job's lines on one machine, merged where they follow on
  const bars = [];
  for (const j of jobs) {
    const slots = j.articles.filter((a) => a.machine && a.start_at).map((a) => ({ m: a.machine, s: new Date(a.start_at), f: new Date(a.finish_at) }))
      .sort((a, b) => (a.m < b.m ? -1 : a.m > b.m ? 1 : a.s - b.s));
    for (const sl of slots) {
      const last = bars[bars.length - 1];
      if (last && last.key === j.key && last.m === sl.m && sl.s - last.f < 60000) last.f = sl.f > last.f ? sl.f : last.f;
      else bars.push({ key: j.key, m: sl.m, s: sl.s, f: sl.f });
    }
  }
  const state = (j) => (j.late_minutes > 0 ? 'late' : j.late_minutes > -120 ? 'tight' : 'ok');
  const H = machines.length * ROW + 30;
  // axis: day starts and hour ticks
  const step = span <= 1 ? 2 : span <= 3 ? 6 : 12;
  let ticks = '';
  for (let t = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours() - (from.getHours() % step)); t <= to; t = new Date(t.getTime() + step * 3600000)) {
    if (t < from) continue;
    const day = t.getHours() === 0;
    ticks += `<div class="pg-tick ${day ? 'day' : ''}" style="left:${x(t)}px;height:${H}px"><span>${day || t.getTime() === from.getTime() ? t.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' }) + ' ' : ''}${String(t.getHours()).padStart(2, '0')}:00</span></div>`;
  }
  // non-working time: the gaps between working windows
  let shade = ''; let cur = from;
  for (const w of (p.windows || []).map((w) => ({ s: new Date(w.start), e: new Date(w.end) })).filter((w) => w.e > from && w.s < to)) {
    if (w.s > cur) shade += `<div class="pg-off" style="left:${x(cur)}px;width:${x(w.s) - x(cur)}px;height:${H - 22}px"></div>`;
    if (w.e > cur) cur = w.e;
  }
  if (cur < to) shade += `<div class="pg-off" style="left:${x(cur)}px;width:${x(to) - x(cur)}px;height:${H - 22}px"></div>`;
  const rows = machines.map((m, i) => `<div class="pg-row" style="top:${22 + i * ROW}px;width:${LBL + W}px;height:${ROW}px"><div class="pg-name" style="width:${LBL - 8}px" title="${esc(m.types || 'any type')}">${esc(m.name)}<div class="small muted">${esc(m.types || 'any')}</div></div></div>`).join('');
  const sel = planSel && byKey.get(planSel);
  const barHtml = bars.filter((b) => b.f > from && b.s < to).map((b) => {
    const j = byKey.get(b.key); const i = machines.findIndex((m) => m.name === b.m); if (i < 0) return '';
    const l = Math.max(LBL, x(b.s)); const r = Math.min(LBL + W, x(b.f)); const w = Math.max(2, r - l);
    const dim = (sel && sel.key !== j.key) || (match && !match(j));
    return `<div class="pg-bar pg-${state(j)} ${j.running ? 'pg-run' : ''} ${String(j.prio).toLowerCase() === 'high' ? 'pg-high' : ''} ${dim ? 'pg-dim' : ''} ${sel && sel.key === j.key ? 'pg-sel' : ''}" data-pg-job="${esc(j.key)}"
      style="left:${l}px;width:${w}px;top:${22 + i * ROW + 5}px;height:${ROW - 10}px" title="${esc(`${j.wo} / ${j.per} · ${j.customer || ''} · ${j.qty.toLocaleString('en-GB')} cards\n${b.m}: ${b.s.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} – ${b.f.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}\nDeadline ${j.deadline?.replace('T', ' ')}${j.late_minutes > 0 ? ` — ${fmtSpan(j.late_minutes)} late` : ''}`)}">${w > 70 ? `<span>${j.pinned ? '📌' : ''}${esc(j.customer || '')} ${esc(j.wo.slice(-6))}</span>` : ''}</div>`;
  }).join('');
  const dl = sel?.deadline ? (() => { const [d, t] = sel.deadline.split('T'); const [y, mo, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(y, mo - 1, dd, hh, mm); })() : null;
  const dlHtml = dl && dl > from && dl < to ? `<div class="pg-deadline" style="left:${x(dl)}px;height:${H}px"><span>due ${esc(sel.deadline.slice(11))}</span></div>` : '';
  el.style.height = `${H + 6}px`;
  el.innerHTML = `<div class="pg" style="width:${LBL + W}px;height:${H}px">${rows}${shade}${ticks}<div class="pg-now" style="left:${x(from)}px;height:${H}px"><span>now</span></div>${barHtml}${dlHtml}</div>`;
  const unplanned = jobs.filter((j) => j.unplanned).length;
  info.innerHTML = sel ? `<b>${esc(sel.wo)} / ${esc(sel.per)}</b> · ${esc(sel.customer || '')} · ${sel.qty.toLocaleString('en-GB')} cards · ${esc(sel.prio || '')} · ${esc(sel.shipper || '')}
      · due <b>${esc(sel.deadline?.replace('T', ' ') || '—')}</b> · finishes ${sel.finish_at ? esc(new Date(sel.finish_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : '—'}
      ${sel.late_minutes > 0 ? `<span class="pl-late">· ${fmtSpan(sel.late_minutes)} late</span>` : ''}${dl && (dl <= from || dl >= to) ? ` <span class="muted">(deadline outside this view)</span>` : ''} <button class="link small" data-pg-clear>✕</button>`
    : `<span class="muted">${bars.length ? 'Click a bar to pick a job.' : 'Nothing planned.'}${unplanned ? ` ⚠ ${unplanned} job${unplanned === 1 ? '' : 's'} can't be planned — see the list.` : ''}</span>`;
  el.onclick = (e) => { const b = e.target.closest('[data-pg-job]'); planSel = b ? b.dataset.pgJob : null; drawPlanGantt(el, info, p, match); };
  info.onclick = (e) => { if (e.target.closest('[data-pg-clear]')) { planSel = null; drawPlanGantt(el, info, p, match); } };
}
