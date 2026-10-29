'use strict';
// 🏭 Planning: the open perso work orders (linked export), as a priority list — FIFO (by
// deadline: due date at the shipper's cut-off) or BAU (due day, then High/Normal/Low, then
// cut-off) — with what's running on top, the cards due by each cut-off, and, with a
// capacity set, each job's projected finish against its deadline. Loaded before app.js.

// Date and number formats made once: making one per row is what made long lists slow to draw.
const PLF = {
  wkHm: new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  hm: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
  num: new Intl.NumberFormat('en-GB'),
  one: new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }),
};
// Long lists show this many rows at first, with "Show more" for the rest.
const PL_PAGE = 150;

// 🏭 Production's three tabs: Perso (with its order — FIFO, BAU, Score, Mitigation — in a drop-down on
// the tab), Matching, 🚚 Dispatch and 🧠 Insights (🔬 Learned and 📆 D+ due out, in dplus.js).
const PL_MODES = [['fifo', 'FIFO', 'By deadline only'], ['bau', 'BAU', 'By due day, then High / Normal / Low, then cut-off'], ['score', '⚖ Score', 'Highest score first: the deadline plus the ⚖ modifiers'],
  ['mitigation', '🛟 Mitigation', 'Save as many as possible: work orders due in the next few working days that can still make it first, then those already overdue or that would be late anyway, then those due later']];
function plHalvesHtml(half, mode = store.get('planMode', 'fifo')) {
  const tab = (k, label, extra = '') => `<div class="pl-half ${half === k ? 'on' : ''}"><button type="button" data-pl-half="${k}">${label}</button>${extra}</div>`;
  return `<div class="pl-halves">
    ${tab('perso', '💳 Perso', half === 'perso' ? `<select id="pl-mode" title="The order the work orders are taken in — ${esc(PL_MODES.map(([, l, w]) => `${l}: ${w}`).join(' · '))}">${PL_MODES.map(([k, l]) => `<option value="${k}" ${mode === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : '')}
    ${tab('otto', '✉️ Matching')}${tab('disp', '🚚 Dispatch')}${tab('insights', '🧠 Insights')}</div>`;
}

// 🔎 The card lines without a speed of their own, for putting right: those whose card isn't in the card
// database (no kind, so no rule can reach them), and the rest by kind of card — one speed rule (type ·
// material · print sides) covers a whole group; the 🔬 learned speed for the kind is offered where known.
async function plNoSpeed() {
  const p = planNow; if (!p) return;
  const lines = [];
  for (const j of [...p.running, ...p.queue]) for (const a of j.articles) if (a.speed === null || a.speed_from === 'average' || !a.card) lines.push({ ...a, wo: j.wo, per: j.per, key: j.key, customer: j.customer, due: j.due });
  const unknown = lines.filter((l) => !l.card);
  const noSpeed = lines.filter((l) => l.card && (l.speed === null || l.speed_from === 'average'));
  const kindOf = (c) => [c.type, c.material, c.sides];
  const kindKey = (c) => kindOf(c).map((v) => String(v ?? '').trim().toLowerCase()).join('|');
  const groups = new Map();
  for (const l of noSpeed) { const k = kindKey(l.card); const g = groups.get(k) || groups.set(k, { kind: kindOf(l.card), lines: [] }).get(k); g.lines.push(l); }
  const byArticle = new Map();
  for (const l of unknown) { const g = byArticle.get(l.article) || byArticle.set(l.article, []).get(l.article); g.push(l); }
  // the learned speeds, where the runs know the kind (best effort)
  let learned = new Map();
  try { const L = await api.get(`/plan/learn?days=${store.get('planLearnDays', 90)}`); learned = new Map(L.speeds.map((x) => [[x.type, x.material, x.sides].map((v) => String(v ?? '').trim().toLowerCase()).join('|'), x])); } catch { /* none */ }
  const n = (v) => PLF.num.format(Math.round(Number(v || 0)));
  const sum = (l) => l.reduce((t, x) => t + (x.qty || 0), 0);
  const wos = (l) => [...new Set(l.map((x) => x.wo))];
  const woLinks = (l) => { const w = wos(l); return `${w.slice(0, 4).map((x) => `<a href="#" data-pf-open-wo="${esc(x)}">${esc(x)}</a>`).join(', ')}${w.length > 4 ? ` <span class="muted">+${w.length - 4}</span>` : ''}`; };
  const kindText = (k) => k.filter(Boolean).map(esc).join(' · ') || '<span class="muted">no type, material or sides</span>';
  const canSet = acctAdmin();
  const groupsSorted = [...groups.values()].sort((a, b) => sum(b.lines) - sum(a.lines));
  openModal(`<div class="modal-head"><h2 style="margin:0">🔎 Card lines without a speed <span class="muted small">${n(lines.length)} line${lines.length === 1 ? '' : 's'}</span></h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted">These lines are timed at ${p.capacity?.rate ? 'the flat rate' : 'the average of the others (≈)'}, so their planned times are a guess. Put them right in the order below — biggest first.</p>
    ${groupsSorted.length ? `<h3 class="pl-h">No speed for their kind of card <span class="muted small">${groupsSorted.length} kind${groupsSorted.length === 1 ? '' : 's'} · ${n(noSpeed.length)} lines · ${n(sum(noSpeed))} cards</span></h3>
      <p class="small muted">Each is a type · material · print sides with no speed rule. ${canSet ? 'Type a speed and press <b>Save</b> to add the rule — every line of that kind is then timed with it.' : 'Someone with the setup right can add a speed rule for each in ⚙ Setup › Speeds.'}</p>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Kind of card</th><th class="num">Lines</th><th class="num">Cards</th><th>Cards (AX)</th><th>Work orders</th><th class="num">🔬 Learned</th>${canSet ? '<th>Speed (cards/h)</th>' : ''}</tr></thead><tbody>
      ${groupsSorted.map((g, i) => { const lk = learned.get(kindKey({ type: g.kind[0], material: g.kind[1], sides: g.kind[2] })); const arts = [...new Set(g.lines.map((l) => l.article))];
        return `<tr><td><b>${kindText(g.kind)}</b></td><td class="num">${n(g.lines.length)}</td><td class="num">${n(sum(g.lines))}</td>
        <td class="small">${arts.slice(0, 5).map((a) => `<a href="#" data-pf-open-item="${esc(a)}">${esc(a)}</a>`).join(', ')}${arts.length > 5 ? ` <span class="muted">+${arts.length - 5}</span>` : ''}</td><td class="small">${woLinks(g.lines)}</td>
        <td class="num">${lk ? `<b>${n(lk.speed)}/h</b><div class="small muted">${n(lk.runs)} runs</div>` : '<span class="muted">—</span>'}</td>
        ${canSet ? `<td class="nowrap"><input type="number" min="1" step="1" style="width:90px" data-ns-speed="${i}" value="${lk ? Math.round(lk.speed) : ''}" placeholder="cards/h"> <button class="small primary" data-ns-save="${i}">Save</button></td>` : ''}</tr>`; }).join('')}
      </tbody></table></div>` : ''}
    ${byArticle.size ? `<h3 class="pl-h">Not in the card database <span class="muted small">${byArticle.size} card${byArticle.size === 1 ? '' : 's'} · ${n(unknown.length)} lines · ${n(sum(unknown))} cards</span></h3>
      <p class="small muted">Their kind isn't known, so no speed rule can reach them: add them to the card database (Access, the Cards table), or correct the Card AX in the work order if it's wrong.</p>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Card (AX)</th><th class="num">Lines</th><th class="num">Cards</th><th>Work orders</th><th>Customers</th></tr></thead><tbody>
      ${[...byArticle].sort((a, b) => sum(b[1]) - sum(a[1])).map(([a, l]) => `<tr><td><b><a href="#" data-pf-open-item="${esc(a)}">${esc(a)}</a></b></td><td class="num">${n(l.length)}</td><td class="num">${n(sum(l))}</td><td class="small">${woLinks(l)}</td><td class="small">${esc([...new Set(l.map((x) => x.customer).filter(Boolean))].join(', '))}</td></tr>`).join('')}
      </tbody></table></div>` : ''}
    <div class="row" style="margin-top:10px"><span class="small muted">Every line, with its work order, job, card, kind and cards, as a CSV — to hand on.</span><span class="spacer"></span><button data-ns-csv>⬇ CSV</button></div>`, { wide: true });
  const box = $('#modal-body');
  box.onclick = async (e) => {
    const w = e.target.closest('[data-pf-open-wo], [data-pf-open-item]');
    if (w) { e.preventDefault(); closeModal(); pfBack.length = 0; pfOpen(w.dataset.pfOpenWo ? 'wo' : 'item', w.dataset.pfOpenWo || w.dataset.pfOpenItem); return; }
    const sv = e.target.closest('[data-ns-save]');
    if (sv) {
      const g = groupsSorted[Number(sv.dataset.nsSave)]; const speed = $(`[data-ns-speed="${sv.dataset.nsSave}"]`, box).value;
      try { await api.post('/plan/speeds', { type: g.kind[0], material: g.kind[1], sides: g.kind[2], speed }); toast(`Speed set: ${speed}/h for ${g.kind.filter(Boolean).join(' · ') || 'that kind'}`); await renderPlanning(); plNoSpeed(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (e.target.closest('[data-ns-csv]')) {
      const cell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
      const rows = [['Work order', 'Job', 'Card (AX)', 'Type', 'Material', 'Print sides', 'Cards', 'Customer', 'Due', 'Why'],
        ...lines.map((l) => [l.wo, l.per, l.article, l.card?.type, l.card?.material, l.card?.sides, l.qty, l.customer, l.due, l.card ? 'no speed for its kind' : 'not in the card database'])];
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`], { type: 'text/csv' }));
      a.download = `card-lines-without-a-speed-${new Date().toISOString().slice(0, 10)}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
  };
}

async function renderPlanning() {
  if (['insights', 'dplus'].includes(store.get('planHalf', 'perso'))) return renderPlanInsights(); // 🧠 Insights (dplus.js)
  const mode = ['bau', 'score', 'mitigation'].includes(store.get('planMode', 'fifo')) ? store.get('planMode') : 'fifo';
  const half = ['otto', 'disp'].includes(store.get('planHalf', 'perso')) ? store.get('planHalf') : 'perso';
  // redrawn after a change on the same tab: stay where you were (the page and each scrolling table)
  const scrollY = main().querySelector('.pl-halves') ? main().scrollTop : null;
  const scrollBoxes = scrollY === null ? [] : [...main().querySelectorAll('.kdb-scroll')].map((el) => el.scrollTop);
  // …and in the field you'd moved on to (⏱ Delays: its row and kind of field)
  const act = document.activeElement; const actRow = act?.closest?.('[data-pld-g], [data-pld-job]');
  const refocus = actRow && act.className ? `[${actRow.dataset.pldG !== undefined ? 'data-pld-g' : 'data-pld-job'}="${CSS.escape(actRow.dataset.pldG ?? actRow.dataset.pldJob)}"] .${act.className.split(' ')[0]}` : null;
  const [p, settings] = await Promise.all([api.get(`/plan?mode=${mode}`), api.get('/settings')]);
  const f = store.get('planFilter', {}) || {};
  const all = [...p.running, ...p.queue];
  planNow = p; // for 🔍 search (planfind.js)
  const byKey = new Map(all.map((j) => [j.key, j]));
  const qIndex = new Map(p.queue.map((j, i) => [j.key, i]));
  const plDetail = {}; // perso / otto: key → the job's detail row, built when it's opened
  const today = new Date(); const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = ymd(today); const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const deadlineAt = (j) => { if (!j.deadline) return null; const [d, t] = j.deadline.split('T'); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(y, m - 1, dd, hh, mm); };
  const dayCache = new Map();
  const dayLabel = (iso) => (iso === todayIso ? 'Today' : iso === ymd(tomorrow) ? 'Tomorrow' : dayCache.get(iso) || dayCache.set(iso, PLF.day.format(new Date(`${iso}T12:00`))).get(iso));
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
  const n = (v) => PLF.num.format(Number(v || 0));
  const overdue = all.filter((j) => deadlineAt(j) && deadlineAt(j) < today);
  const dueToday = all.filter((j) => j.due === todayIso);
  const late = p.projected ? all.filter((j) => j.late_minutes > 0) : [];
  const prioChip = (pr) => `<span class="pl-prio pl-${esc(String(pr || '').toLowerCase())}">${esc(pr || '—')}</span>`;
  const finish = (j) => (!p.projected ? '' : (j.finish_at ? `<span class="${j.late_minutes > 0 ? 'pl-late' : 'pl-ok'}" title="Projected finish ${esc(fmtDateTime(j.finish_at))}${cap.buffer ? ` — must be ready ${fmtSpan(cap.buffer)} before the cut-off` : ''}">${PLF.wkHm.format(new Date(j.finish_at))}${j.late_minutes > 0 ? ` · ${fmtSpan(j.late_minutes)} late` : ''}</span>`
    : j.unplanned ? `<span class="pl-warn">⚠ ${esc([
      j.unplanned_why?.includes('machine') ? `no running machine for ${[...new Set(j.articles.filter((a) => a.unplanned === 'machine').map((a) => a.card?.type))].join(', ')}` : '',
      j.unplanned_why?.includes('speed') ? 'no speed for a card' : '',
      j.unplanned_why?.includes('time') ? 'no working time — check the working day and days in ⚙ Setup' : ''].filter(Boolean).join(' · '))}</span>` : '<span class="muted">—</span>')
    + (j.machines?.length ? `<div class="small muted">${esc(j.machines.join(', '))}</div>` : ''));
  // the WO's Matching jobs, and whether perso is projected to finish after the first one's plan date
  const ottoTag = (j) => {
    const os = (j.otto || []).filter((o) => !o.done); if (!os.length) return '';
    const first = os.map((o) => o.deadline).filter(Boolean).sort()[0];
    const after = first && j.finish_at && deadlineAt({ deadline: first }) < new Date(j.finish_at);
    return ` · <span class="${after ? 'pl-late' : ''}" title="${esc(os.map((o) => `${o.name}: Matching plan ${o.deadline?.replace('T', ' ') || '—'} (${o.status || ''})`).join('\n'))}${after ? '\nPerso is projected to finish after Matching\'s plan date' : ''}">Matching ${first ? esc(dayLabel(first.slice(0, 10))) : ''}${after ? ' ⚠' : ''}</span>`;
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
  const scoreFmt = (v) => (v === null || v === undefined ? '—' : PLF.one.format(Number(v)));
  const row = (j, i) => {
    const l = left(j);
    return `<tr class="pl-job ${l.cls ? `${l.cls}-row` : ''} ${p.projected && j.late_minutes > 0 ? 'pl-late-row' : ''}" data-pl-job="${esc(j.key)}">
      <td class="num muted pl-n">${i === null ? '▶' : `${j.pinned ? '📌 ' : ''}${i + 1}<div><button class="icon pl-pin ${j.pinned ? 'on' : ''}" data-pl-pin="${esc(j.key)}" title="${j.pinned ? 'Unpin — back to its place in the order' : 'Pin to the front of the queue'}">📌</button></div>`}</td>
      <td><b>${esc(dayLabel(j.due))}</b> ${j.no_cutoff ? '<span class="pl-warn" title="No cut-off time in the export (UNDEFINED) — taken as the end of the day">end of day ⚠</span>' : esc(j.deadline?.slice(11) || '')}<div class="small ${l.cls}">${esc(l.text)}</div></td>
      <td><b>${esc(j.wo)}</b> <span class="muted">/ ${esc(j.per)}</span><div class="small muted">${j.articles.length} card article${j.articles.length === 1 ? '' : 's'}${ottoTag(j)}</div></td>
      <td>${esc(j.customer || '—')}${j.kind?.length ? `<div class="small muted" title="${esc(j.kind.join(', '))}">${esc(j.kind[0])}${j.kind.length > 1 ? ` +${j.kind.length - 1}` : ''}</div>` : j.no_card ? '<div class="small pl-warn">not in the card database</div>' : ''}</td>
      <td class="num"><b>${n(j.qty)}</b>${j.plan_minutes !== undefined && !j.unplanned ? `<div class="small muted" title="Production time${j.minutes === null ? ' (flat rate — not every card has a speed)' : ' from the card speeds'}">${fmtSpan(j.plan_minutes)}${j.minutes === null || j.articles.some((a) => a.speed_from !== null && !/^(rule|learned)/.test(String(a.speed_from))) ? ' ≈' : ''}</div>` : ''}</td>
      ${mode === 'score' ? `<td class="num" title="${esc((j.score_parts || []).map((x) => `${x.module}${x.note ? ` (${x.note})` : ''}: ${x.value}`).join('\n'))}"><b>${scoreFmt(j.score)}</b><div class="small muted">${esc((j.score_parts || []).filter((x) => x.module !== 'Deadline' && x.value).map((x) => x.module).join(', '))}</div></td>` : ''}
      <td>${prioChip(j.prio)}</td>
      <td><div>${esc(j.shipper || '—')}</div><div class="small muted">${esc(j.group || '')}</div></td>
      ${p.projected ? `<td>${finish(j)}</td>` : ''}
    </tr>`;
  };
  // a job's card articles: built when it's opened, not for every row up front
  const detailRow = (j) => `<tr class="pl-detail" data-pl-detail="${esc(j.key)}"><td></td><td colspan="${(p.projected ? 7 : 6) + (mode === 'score' ? 1 : 0)}">${j.score_parts?.length ? `<div class="pl-score-parts small">⚖ ${j.score_parts.map((x) => `<span class="pl-chip" title="${esc([x.note, x.authoriser ? `authorised by ${x.authoriser}` : ''].filter(Boolean).join(' · '))}">${esc(x.module)}${x.note && x.module === 'Shift' ? ` (${esc(x.note)})` : ''} <b>${x.value > 0 ? '+' : ''}${scoreFmt(x.value)}</b></span>`).join(' ')} = <b>${scoreFmt(j.score)}</b>${j.tags?.length ? ` · tags ${esc(j.tags.join(', '))}` : ''}</div>` : ''}<table class="log small"><thead><tr><th>Card article</th><th>Card</th><th>Type</th><th>Material</th><th>Print sides</th><th class="num">Cards</th><th class="num">Speed</th><th class="num">Time</th>${(p.machines || []).some((m) => m.active) ? '<th>Machine</th>' : ''}<th>Status</th></tr></thead>
      <tbody>${j.articles.map((a) => `<tr><td>${esc(a.article)}</td><td>${a.card ? esc(a.card.name || '') : '<span class="pl-warn">not in the card database</span>'}</td><td>${esc(a.card?.type || '')}</td><td>${esc(a.card?.material || '')}</td><td>${esc(a.card?.sides || '')}</td>
        <td class="num">${n(a.qty)}</td><td class="num">${a.speed ? `${n(a.speed)}/h${String(a.speed_from).startsWith('learned') ? ` <span title="${esc(learnedTitle(a))}">🔬</span>` : a.speed_from === 'fallback' ? ' <span class="muted" title="No speed for this kind of card — the flat rate">≈</span>' : a.speed_from === 'average' ? ' <span class="muted" title="No speed for this card — the average of the others">≈</span>' : ''}${a.oee ? ` <span class="muted small" title="Estimated OEE for this customer — planned at ${n(Math.round(a.speed * a.oee))}/h">× ${Math.round(a.oee * 1000) / 10}%</span>` : ''}` : '<span class="pl-warn">no speed</span>'}</td>
        <td class="num">${a.minutes !== null ? fmtSpan(a.minutes) : '—'}</td>${(p.machines || []).some((m) => m.active) ? `<td>${a.machine ? `${esc(a.machine)} <span class="muted">${PLF.wkHm.format(new Date(a.start_at))}–${PLF.hm.format(new Date(a.finish_at))}</span>` : '<span class="pl-warn">no machine</span>'}</td>` : ''}<td>${esc(a.status || '')}</td></tr>`).join('')}</tbody></table></td></tr>`;
  plDetail.perso = (key) => (byKey.has(key) ? detailRow(byKey.get(key)) : '');
  const head = `<tr><th></th><th>Deadline</th><th>Work order / job</th><th>Customer</th><th class="num">Cards</th>${mode === 'score' ? '<th class="num">Score</th>' : ''}<th>Prio</th><th>Shipper</th>${p.projected ? '<th>Projected finish</th>' : ''}</tr>`;
  const runningShown = p.running.filter(match); const queueShown = p.queue.filter(match);
  // long lists: the first PL_PAGE rows, then "Show more" (drawing thousands of rows at once is slow)
  let qShown = Math.min(PL_PAGE, queueShown.length);
  const queueRow = (j, k) => `${mode === 'mitigation' && mitiGroup(j) !== mitiGroup(queueShown[k - 1]) ? mitiHead(j) : ''}${row(j, qIndex.get(j.key))}`;
  const moreRow = () => (qShown >= queueShown.length ? '' : `<tr class="pl-more"><td colspan="9"><button class="small" data-pl-more="${PL_PAGE * 2}">Show ${n(Math.min(PL_PAGE * 2, queueShown.length - qShown))} more</button>
    <button class="link small" data-pl-more="all">Show all ${n(queueShown.length)}</button> <span class="muted small">showing ${n(qShown)} of ${n(queueShown.length)} — the search box above finds any job</span></td></tr>`);
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
      ${useMachines ? `<div class="kdb-scroll"><table class="log pl-cap"><thead><tr><th>Machine</th><th>Runs</th><th class="num">Cards planned</th><th class="num">Work</th><th class="num" title="Work orders planned on the machine">Work orders</th>${cap.changeover ? '<th class="num" title="One each time the machine moves on to another work order">Change-overs</th>' : ''}<th>Booked until</th></tr></thead><tbody>
        ${activeMachines.map((m) => { const l = loadOf.get(m.id) || {}; return `<tr><td><b>${esc(m.name)}</b></td><td class="small">${esc(m.types || 'any type')}</td><td class="num">${n(l.cards)}</td><td class="num">${l.minutes ? fmtSpan(l.minutes) : '—'}</td><td class="num">${n(l.wos)}</td>${cap.changeover ? `<td class="num" title="${n(l.setups)} × ${n(cap.changeover)} min">${n(l.setups)}</td>` : ''}
          <td>${l.until ? esc(new Date(l.until).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>` : ''}</div>
      <p class="small muted">Max cards a day: the machines able to run the type, for the working day, at the type's speed (the open cards' average). A machine running several types counts for each — the ceiling for that type on its own.</p></div>` : '';
  const cdb = p.cards_db;
  // ☰ List / ▤ Gantt / ▦ Load / 📈 History on each tab (its own choice kept): Gantt and Load need machines
  // (perso: ⚙ Setup's machines; Matching: its machines with a speed); 🚚 Dispatch has no machines, so its Load is pieces due a day
  const withMachines = half === 'otto' ? !!p.otto?.projected : half === 'perso' ? (p.machines || []).some((m) => m.active) && p.projected : false;
  const noMachines = half === 'disp' ? 'The Dispatch export has no machines to plan on' : half === 'otto' ? 'Add Matching machines with a speed in ⚙ Setup to plan them' : 'Add machines in ⚙ Setup to plan them';
  const viewKey = half === 'perso' ? 'planView' : `planView_${half}`;
  const viewList = [['list', '☰ List'], ['gantt', '▤ Gantt', withMachines], ['load', '▦ Load', withMachines || half === 'disp'], ['history', '📈 History'], ...(half === 'disp' ? [['delays', '⏱ Delays']] : [])]; // 🔬 Learned: in 🧠 Insights
  const view = viewList.some(([k, , ok]) => ok !== false && k === store.get(viewKey, 'list')) ? store.get(viewKey, 'list') : 'list';
  const unitOf = { perso: 'cards', otto: 'items', disp: 'pieces' }[half];
  const viewsRow = () => `<div class="row pl-views"><div class="seg">${viewList.map(([k, l, ok]) => `<button type="button" data-pl-view="${k}" class="${view === k ? 'on' : ''}" ${ok === false ? `disabled title="${esc(noMachines)}"` : ''}>${l}</button>`).join('')}</div>
      ${view === 'gantt' ? `<div class="seg">${[[1, '1 day'], [3, '3 days'], [7, '1 week']].map(([d, l]) => `<button type="button" data-pl-span="${d}" class="${Number(store.get('planSpan', 3)) === d ? 'on' : ''}">${l}</button>`).join('')}</div>
        <span class="small muted">Click a job to see its deadline; green on time · amber within 2 h of its cut-off · red late</span>` : ''}</div>`;
  const hist = view === 'history' ? await api.get(`/plan/history?days=14&half=${half}`) : null;
  const historyHtml = () => {
    const h = hist; const max = Math.max(1, ...h.daily.map((d) => d.cards));
    const kfmt = (x) => (x >= 1000 ? `${n(Math.round(x / 100) / 10)}k` : n(x));
    const dshort = (d) => { const dt = new Date(`${d}T12:00`); return `${dt.toLocaleDateString('en-GB', { weekday: 'short' })}<br>${dt.getDate()}/${dt.getMonth() + 1}`; };
    if (h.from === 'runs') return runsHistoryHtml(h, max, kfmt, dshort);
    return `<div class="kdb-tiles" style="margin-top:12px">
        <div class="kdb-tile"><div class="kdb-tile-l">Done — last 7 days</div><div class="kdb-tile-v">${n(h.week.jobs)}</div><div class="kdb-tile-s">${n(h.week.cards)} ${unitOf}</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">On time — last 7 days</div><div class="kdb-tile-v ${h.week.on_time_pct === null ? '' : h.week.on_time_pct >= 98 ? 'kdb-ok' : 'kdb-bad'}">${h.week.on_time_pct === null ? '—' : `${h.week.on_time_pct}%`}</div><div class="kdb-tile-s">done by the cut-off</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">Lead time</div><div class="kdb-tile-v">${h.week.lead_hours === null ? '—' : fmtSpan(h.week.lead_hours * 60)}</div><div class="kdb-tile-s">first seen → done, average</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">History</div><div class="kdb-tile-v">${n(h.reads)}</div><div class="kdb-tile-s">${h.since ? `exports since ${esc(fmtDateTime(h.since))}` : 'exports recorded'}</div></div></div>
      ${h.reads < 2 ? '<div class="kc-note notice notice-info">The history builds up from now: each new version of the linked export is recorded (checked every 10 minutes), and a job is counted as done when it\'s gone from the next export — to within the export interval.</div>' : ''}
      <div class="card"><h3 class="pl-h">${unitOf[0].toUpperCase()}${unitOf.slice(1)} done per day <span class="muted small">— last ${h.days} days · green on time · red after the cut-off${h.daily.some((d) => d.unknown_cards) ? ' · grey: not known whether on time' : ''}</span></h3>
        ${h.done_by ? `<p class="small muted" style="margin:0 0 6px">${(() => { const b = h.done_by; const all = b.runs + b.export + b.gap; return all ? `Done times: <b>${Math.round((b.runs / all) * 100)}%</b> from the ⏱ timing report (the end of the job's last run)${b.export ? `, ${n(b.export)} job${b.export === 1 ? '' : 's'} from when ${b.export === 1 ? 'it' : 'they'} left the export (no runs)` : ''}${b.gap ? `, ${n(b.gap)} done while the export wasn't being read (no runs) — on time only where that's certain, and left out of the pace` : ''}.` : ''; })()}</p>` : ''}
        <div class="pl-hist">${h.daily.map((d) => `<div class="pl-hist-col" title="${esc(d.date)}: ${n(d.jobs)} jobs, ${n(d.cards)} ${unitOf} (${n(d.on_time_cards)} on time)">
          <div class="pl-hist-n">${d.cards ? kfmt(d.cards) : ''}</div>
          <div class="pl-hist-bar" style="height:${Math.round((d.cards / max) * 140)}px"><div class="pl-hist-unknown" style="height:${d.cards ? Math.round(((d.unknown_cards || 0) / d.cards) * 100) : 0}%"></div><div class="pl-hist-late" style="height:${d.cards ? Math.round(((d.cards - d.on_time_cards - (d.unknown_cards || 0)) / d.cards) * 100) : 0}%"></div></div>
          <div class="pl-hist-d">${dshort(d.date)}</div></div>`).join('')}</div></div>
      <div class="card"><h3 class="pl-h">Latest done</h3>
        <div class="kdb-scroll"><table class="log"><thead><tr><th>Done</th><th>Work order / job</th><th>Customer</th><th class="num">${unitOf[0].toUpperCase()}${unitOf.slice(1)}</th><th>Deadline</th><th>Result</th><th>${{ perso: 'Shipper', otto: 'Machine', disp: 'Group' }[half]}</th></tr></thead><tbody>
        ${h.recent.map((j) => `<tr><td>${esc(new Date(j.done_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</td><td><b>${esc(j.wo || j.key)}</b> <span class="muted">${j.per ? `/ ${esc(j.per)}` : esc(j.wo && j.key.startsWith(j.wo) ? j.key.slice(j.wo.length) : '')}</span></td>
          <td>${esc(j.customer || '')}</td><td class="num">${n(j.qty)}</td><td>${esc(j.deadline?.replace('T', ' ') || '—')}</td>
          <td>${j.late_minutes === null ? '—' : j.late_minutes > 0 ? `<span class="pl-late">${fmtSpan(j.late_minutes)} late</span>` : '<span class="pl-ok">✔ on time</span>'}</td><td class="small">${esc(j.shipper ?? j.machine ?? '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nothing done yet since the history began.</td></tr>'}
        </tbody></table></div></div>`;
  };
  // 📈 Perso from the ⏱ timing report alone: the same on every PC that has read it
  const runsHistoryHtml = (h, max, kfmt, dshort) => {
    const when = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
    const dayOnly = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—');
    const data = h.report === 'data'; const at = data ? dayOnly : when;
    const rep = data ? '📊 DailyPersoData' : '⏱ timing report';
    // 🔎 every way of counting the cards, day by day, to set the count to match Power BI's
    const chk = h.check?.length ? (() => { const counted = new Map(h.daily.map((d) => [d.date, d.cards]));
      return `<details class="card pl-check"><summary><b>🔎 Compare with Power BI</b> <span class="muted small">— each day's cards, counted every way the report allows</span></summary>
        <div class="kdb-scroll"><table class="log small"><thead><tr><th>Production date</th><th class="num">All rows</th><th class="num">of which remakes</th><th class="num">not LIVE</th><th class="num">M work orders</th><th class="num">Job waste</th><th class="num"><b>Counted here</b></th></tr></thead><tbody>
        ${h.check.map((c) => `<tr><td>${esc(dayOnly(c.day))}</td><td class="num">${n(c.all_rows)}</td><td class="num">${n(c.remakes)}</td><td class="num">${n(c.not_live)}</td><td class="num">${n(c.m_jobs)}</td><td class="num">${n(c.waste)}</td><td class="num"><b>${n(counted.get(c.day) ?? 0)}</b></td></tr>`).join('')}</tbody></table></div>
        <div class="row small admin-only" style="gap:16px;flex-wrap:wrap;margin-top:6px"><span class="muted">Count as Power BI does:</span>
          <label class="row"><input type="checkbox" data-pdata-set="kpi_pdata_remakes" ${settings.kpi_pdata_remakes === '0' ? '' : 'checked'}> remakes</label>
          <label class="row"><input type="checkbox" data-pdata-set="kpi_pdata_live" data-inv ${settings.kpi_pdata_live === '1' ? '' : 'checked'}> other production modes than LIVE</label>
          <label class="row"><input type="checkbox" data-pdata-set="kpi_pdata_m" ${settings.kpi_pdata_m === '0' ? '' : 'checked'}> M work orders</label></div></details>`; })() : '';
    return `<div class="kdb-tiles" style="margin-top:12px">
        <div class="kdb-tile"><div class="kdb-tile-l">Persoed — last 7 days</div><div class="kdb-tile-v">${n(h.week.cards)}</div><div class="kdb-tile-s">cards · ${n(h.week.jobs)} job${h.week.jobs === 1 ? '' : 's'} finished</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">On time — last 7 days</div><div class="kdb-tile-v ${h.week.on_time_pct === null ? '' : h.week.on_time_pct >= 98 ? 'kdb-ok' : 'kdb-bad'}">${h.week.on_time_pct === null ? '—' : `${h.week.on_time_pct}%`}</div><div class="kdb-tile-s">of the cards, persoed by their due date</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">Lead time</div><div class="kdb-tile-v">${h.week.lead_hours === null ? '—' : fmtSpan(h.week.lead_hours * 60)}</div><div class="kdb-tile-s">imported → last ${data ? 'produced' : 'run'}, average</div></div>
        <div class="kdb-tile"><div class="kdb-tile-l">${rep}</div><div class="kdb-tile-v">${n(h.reads)}</div><div class="kdb-tile-s">${data ? `rows · newest production date ${esc(dayOnly(h.last))}` : `runs · newest ended ${esc(when(h.last))}`}</div></div></div>
      <p class="small muted pl-same">🟰 Built only from the ${rep}${data ? ' — the report Power BI uses' : ' (every run since 1 January)'}, so it's the same on every PC that has read it — compare the newest ${data ? 'production date' : 'run'} above to check you're on the same report. Last read here ${esc(when(h.read_at))}.</p>
      ${chk}${data ? '' : `<div class="kc-note notice notice-info admin-only">📊 For the same cards persoed as Power BI, link <b>DailyPersoData</b> (the report it uses) in <button class="link" data-pl="setup-pdata">⚙ Setup</button>.</div>`}
      <div class="card"><h3 class="pl-h">Cards persoed per day <span class="muted small">— last ${h.days} days, by ${data ? 'Production Date' : 'the day each run ended'} · green by the due date · red after it${h.daily.some((d) => d.unknown_cards) ? ' · grey: no due date in the report' : ''}</span></h3>
        <div class="pl-hist">${h.daily.map((d) => `<div class="pl-hist-col" title="${esc(d.date)}: ${n(d.cards)} cards persoed (${n(d.on_time_cards)} by their due date), ${n(d.jobs)} jobs">
          <div class="pl-hist-n">${d.cards ? kfmt(d.cards) : ''}</div>
          <div class="pl-hist-bar" style="height:${Math.round((d.cards / max) * 140)}px"><div class="pl-hist-unknown" style="height:${d.cards ? Math.round(((d.unknown_cards || 0) / d.cards) * 100) : 0}%"></div><div class="pl-hist-late" style="height:${d.cards ? Math.round(((d.cards - d.on_time_cards - (d.unknown_cards || 0)) / d.cards) * 100) : 0}%"></div></div>
          <div class="pl-hist-d">${dshort(d.date)}</div></div>`).join('')}</div></div>
      <div class="card"><h3 class="pl-h">Latest finished <span class="muted small">— jobs whose runs reached their quantity</span></h3>
        <div class="kdb-scroll"><table class="log"><thead><tr><th>${data ? 'Last produced' : 'Last run ended'}</th><th>Work order / job</th><th>Customer</th><th class="num">Cards</th><th>Due</th><th>Result</th><th>Machines</th></tr></thead><tbody>
        ${h.recent.map((j) => `<tr><td>${esc(at(j.done_at))}</td><td><button class="link" data-pf-wo-open="${esc(j.wo)}" title="Everything about this work order"><b>${esc(j.wo)}</b></button> <span class="muted">${j.per ? `/ ${esc(j.per)}` : ''}</span></td>
          <td>${esc(j.customer || '')}</td><td class="num">${n(j.qty)}</td><td>${esc(j.deadline ? dayLabel(j.deadline) : '—')}</td>
          <td>${j.late_days === null ? '—' : j.late_days > 0 ? `<span class="pl-late">${j.late_days} day${j.late_days === 1 ? '' : 's'} late</span>` : '<span class="pl-ok">✔ on time</span>'}</td><td class="small">${esc(j.machines || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No job finished in these days.</td></tr>'}
        </tbody></table></div></div>`;
  };
  // ▦ Load: hours booked on each machine per day against its working hours
  const loadHtml = (ms = (p.machines || []).filter((m) => m.active), list = p.machine_load, unit = 'cards') => {
    const days = Object.keys(p.available || {}).filter((d) => p.available[d] > 0).sort().slice(0, 10);
    const hrs = (m) => `${(m / 60).toLocaleString('en-GB', { maximumFractionDigits: 1 })} h`;
    const cell = (booked, avail) => {
      const pct = avail ? Math.round((booked / avail) * 100) : 0;
      return `<td class="pl-load-cell" title="${hrs(booked)} booked of ${hrs(avail)}"><div class="pl-load-bar ${pct >= 95 ? 'full' : pct >= 70 ? 'busy' : ''}" style="width:${Math.min(100, pct)}%"></div><span>${booked ? `${pct}%` : ''}</span></td>`;
    };
    const loads = new Map((list || []).map((l) => [l.id, l]));
    const dayHead = (d) => { const dt = new Date(`${d}T12:00`); return `${dt.toLocaleDateString('en-GB', { weekday: 'short' })}<div class="small muted">${dt.getDate()} ${dt.toLocaleDateString('en-GB', { month: 'short' })}</div>`; };
    return `<div class="card"><h3 class="pl-h">Load — hours booked on each machine per day <span class="muted small">of its working hours (${days[0] === Object.keys(p.available).sort()[0] ? 'today from now' : ''})</span></h3>
      <div class="kdb-scroll"><table class="log pl-load"><thead><tr><th>Machine</th>${days.map((d) => `<th class="num">${dayHead(d)}</th>`).join('')}<th class="num">${unit[0].toUpperCase()}${unit.slice(1)}</th><th>Booked until</th></tr></thead><tbody>
      ${ms.map((m) => { const l = loads.get(m.id) || { days: {} }; return `<tr><td><b>${esc(m.name)}</b><div class="small muted">${esc(m.types || m.match || 'any type')}</div></td>
        ${days.map((d) => cell(l.days?.[d]?.minutes || 0, p.available[d])).join('')}<td class="num">${n(l.cards ?? l.items)}</td><td class="small">${l.until ? esc(PLF.wkHm.format(new Date(l.until))) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      <tr class="pl-load-total"><td>All machines</td>${days.map((d) => cell(ms.reduce((t, m) => t + ((loads.get(m.id) || {}).days?.[d]?.minutes || 0), 0), p.available[d] * ms.length)).join('')}<td class="num">${n(ms.reduce((t, m) => t + (((x) => x.cards ?? x.items)(loads.get(m.id) || {}) || 0), 0))}</td><td></td></tr>
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
  const dp = p.disp || { source: { status: 'none' }, jobs: [], hidden: 0 };
  // ⏳ Backlog: what's overdue, and how long catching up takes at the recent pace
  const backlogCard = (b, unit, otto) => {
    if (!b) return '';
    const c = b.catch_up; const dd = (iso) => new Date(`${iso}T12:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const wd = (v) => `≈ ${v < 10 ? PLF.one.format(v) : n(Math.round(v))} <span>working day${v === 1 ? '' : 's'}</span>`;
    // four blocks side by side: what's overdue, the recent pace, clearing it, catching up
    const block = (label, value, sub, cls = '') => `<div class="pl-bl-block"><div class="pl-bl-l">${label}</div><div class="pl-bl-v ${cls}">${value}</div><div class="pl-bl-s">${sub}</div></div>`;
    const net = c.basis_days ? (c.rate || 0) - (c.demand || 0) : null;
    const blocks = [
      block('Overdue', b.overdue_qty ? `${n(b.overdue_qty)} <span>${unit}</span>` : '✔ none', b.overdue_qty
        ? `${n(b.overdue_jobs)} job${b.overdue_jobs === 1 ? '' : 's'} past ${otto ? 'the plan date' : 'the cut-off'}${b.oldest_due ? ` · oldest due <b>${esc(dd(b.oldest_due))}</b>` : ''}` : 'nothing past its deadline', b.overdue_qty ? 'pl-late' : 'pl-ok'),
      c.basis_days ? block(`Pace · last ${c.basis_days} working day${c.basis_days === 1 ? '' : 's'}`, `${n(c.rate)} <span>${unit} done a day</span>`,
        `${n(c.demand)} due a day · <b class="${net >= 0 ? 'pl-ok' : 'pl-late'}">${net >= 0 ? '+' : '−'}${n(Math.abs(net))}</b> a day<br><span class="muted">${esc(dd(c.from))} – ${esc(dd(c.to))}${b.pace_from === 'runs' ? ' · from the ⏱ timing report' : ''}</span>`) : '',
      b.overdue_qty && c.clear_days !== null && c.clear_days !== undefined && ['ok', 'not_catching_up'].includes(c.status)
        ? block('Clear the overdue', wd(c.clear_days), 'of output, if nothing new came in') : '',
      !b.overdue_qty ? '' : c.status === 'ok' ? block('Catch up', wd(c.catch_days), `with new work still coming · caught up by <b>${c.catch_date ? esc(dd(c.catch_date)) : '—'}</b>`, c.catch_days > 20 ? 'pl-warn' : '')
        : c.status === 'not_catching_up' ? block('Catch up', 'not at this pace', 'as much or more is due each day as is done', 'pl-late')
          : block('Catching up', '—', c.status === 'nothing_done' ? 'nothing finished lately to measure the pace' : otto ? 'no finished jobs with an End Date in the export to measure the pace' : 'the pace comes from the plan history — it needs a full working day recorded'),
    ].filter(Boolean).join('');
    return `<div class="card pl-backlog"><h3 class="pl-h">⏳ Backlog</h3>
      <div class="pl-bl-blocks">${blocks}</div>
      ${b.hidden_jobs ? `<p class="small muted" style="margin:8px 0 0">${n(b.hidden_jobs)} job${b.hidden_jobs === 1 ? '' : 's'} (${n(b.hidden_qty)} ${unit}) due more than ${b.max_age} days ago ${b.hidden_jobs === 1 ? 'isn\'t' : 'aren\'t'} shown or counted — likely errors. <a class="button small" href="/api/plan/hidden.xlsx" download title="Each hidden work order, with when it first appeared, whether it ran and how much, and columns for the investigation">⬇ Export them to Excel</a> <button class="link small admin-only" data-pl="setup">⚙ Change</button></p>` : ''}</div>`;
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
    return `<div class="card pl-setup admin-only" id="pl-mods" ${store.get('planModsOpen', false) ? '' : 'hidden'}>
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
      <h3 class="pl-h" style="margin-top:14px">Matching machines <span class="muted small">— items per hour</span></h3>
      <table class="log pl-speeds pl-machines"><thead><tr><th>Machine</th><th>Named in the export as <span class="muted small">(optional, e.g. HMT PC#1)</span></th><th>Items per hour</th><th></th><th></th></tr></thead><tbody>
        ${(ot.machines || []).map((m) => `<tr data-plo-machine="${m.id}"><td><input type="text" name="name" value="${esc(m.name)}"></td><td><input type="text" name="match" value="${esc(m.match || '')}" placeholder="—"></td>
          <td><input type="number" min="1" step="1" name="speed" value="${m.speed ?? ''}" placeholder="items/h"></td><td><label class="row small"><input type="checkbox" name="active" ${m.active ? 'checked' : ''}> running</label></td>
          <td><button class="icon" data-plo-del-machine="${m.id}" title="Remove">✕</button></td></tr>`).join('')}
        <tr><td><input type="text" id="plo-new-machine" placeholder="Machine name"></td><td><input type="text" id="plo-new-match" placeholder="Named in the export as"></td><td><input type="number" min="1" id="plo-new-speed" placeholder="items/h"></td><td></td><td><button class="small" data-pl="add-otto-machine">Add</button></td></tr></tbody></table>
      <p class="small muted">Each Matching job goes on the running machine where it can finish first. A job whose Machine in the export contains a machine's "named as" text goes on that machine. A job never starts before its perso work order is projected to be done.</p>
      <h3 class="pl-h" style="margin-top:14px">Matching speeds by customer <span class="muted small">— items per hour, instead of the machine's speed</span></h3>
      <div class="kdb-scroll"><table class="log pl-speeds"><thead><tr><th>Customer</th><th>Name</th><th class="num">Jobs open</th><th class="num">Items open</th><th>Items per hour</th></tr></thead><tbody>
        ${(ot.customers || []).map((c) => `<tr><td><b>${esc(c.customer)}</b></td><td>${esc(c.name || '')}</td><td class="num">${c.jobs ? n(c.jobs) : '<span class="muted">none open</span>'}</td><td class="num">${n(c.items)}</td>
          <td><input type="number" min="1" step="1" class="plo-speed" data-customer="${esc(c.customer)}" value="${c.speed ?? ''}" placeholder="machine speed"></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Link the Matching export to see its customers.</td></tr>'}</tbody></table></div>
      <p class="small muted">The working day and days above are used for Matching too.</p>`;
  const finishO = (o) => (!ot.projected ? '' : o.finish_at ? `<span class="${o.late_minutes > 0 ? 'pl-late' : 'pl-ok'}" title="Projected ${esc(fmtDateTime(o.start_at))} → ${esc(fmtDateTime(o.finish_at))} at ${n(o.speed)} items/h">${PLF.wkHm.format(new Date(o.finish_at))}${o.late_minutes > 0 ? ` · ${fmtSpan(o.late_minutes)} late` : ''}</span>
      <div class="small muted">${esc(o.machine_planned)}${o.waited_perso ? ' · after perso' : ''}</div>`
    : `<span class="pl-warn">⚠ ${o.unplanned === 'speed' ? 'no speed — ⚙ Setup' : 'no working time — check the working day'}</span>`);
  // 🚚 Dispatch: the open dispatch jobs by due date, and where each work order is in the chain
  const dispHtml = () => {
    if (dp.source.status !== 'ok') return `<div class="card lib-empty"><h2>🚚 Dispatch</h2><p>Set where the Dispatch export (OpenDespatchWorkorders) is saved in ⚙ Setup, or try it with 📂 Load file…. Each dispatch job is linked to its work order's perso and Matching jobs, so you can see what's ready to go and what's holding the rest up.</p>
      ${dp.source.status === 'missing' ? `<p class="pl-late">⚠ Can't find <code>${esc(dp.source.file)}</code>.</p>` : dp.source.status === 'error' ? `<p class="pl-late">⚠ ${esc(dp.source.error)}</p>` : ''}</div>`;
    const df = store.get('planDispFilter', {}) || {};
    const all = dp.jobs;
    const dm = (d) => (!df.customer || d.customer === df.customer) && (!df.stage || d.stage === df.stage)
      && (!df.q || `${d.name} ${d.customer} ${d.customer_name || ''} ${d.group || ''} ${d.status || ''}`.toLowerCase().includes(df.q.toLowerCase()));
    const dCust = [...new Set(all.map((d) => d.customer).filter(Boolean))].sort();
    const over = all.filter((d) => d.due && d.due < todayIso); const today_ = all.filter((d) => d.due === todayIso);
    const st = (k) => all.filter((d) => d.stage === k);
    const STAGE = { perso: ['⏳ Waiting on perso', 'pl-late'], matching: ['✉️ Waiting on Matching', 'pl-warn'], ready: ['✔ Ready to dispatch', 'pl-ok'] };
    const chain = (d) => {
      const pc = d.perso_open ? `<span class="pl-warn">⏳ ${d.perso.length} perso job${d.perso.length === 1 ? '' : 's'} open</span>` : '<span class="pl-ok">✔ perso</span>';
      const mc = !d.matching.length ? '<span class="muted">no Matching job</span>' : d.matching_open ? `<span class="pl-warn">⏳ Matching: ${esc(d.matching.filter((m) => !m.done).map((m) => m.status || 'open').join(', '))}</span>` : '<span class="pl-ok">✔ Matching</span>';
      return `${pc} → ${mc}${d.ready_at ? `<div class="small muted">ready about ${esc(PLF.wkHm.format(new Date(d.ready_at)))}</div>` : ''}`;
    };
    const drow = (d, i) => { const late = d.due && d.due < todayIso; return `<tr class="pl-job ${late ? 'pl-over-row' : d.due === todayIso ? 'pl-today-row' : ''}" data-pl-job="disp:${esc(d.key)}">
      <td class="num muted pl-n">${i + 1}</td>
      <td><b>${esc(d.due ? dayLabel(d.due) : '—')}</b>${late ? '<div class="small pl-over">overdue</div>' : ''}${d.delay?.new_date ? `<div class="small ${d.delay.new_date < todayIso ? 'pl-late' : 'pl-warn'}" title="${esc(d.delay.reason || 'New expected date (⏱ Delays)')}">⏱ expected ${esc(dayLabel(d.delay.new_date))}</div>` : ''}</td>
      <td><b>${esc(d.wo)}</b><span class="muted">${esc(d.name.slice(d.wo.length))}</span>${d.live ? ` <span class="pf-chip">${esc(d.live)}</span>` : ''}<div class="small muted">${esc(d.group || '')}</div></td>
      <td>${esc(d.customer || '—')}<div class="small muted">${esc(d.customer_name || '')}</div></td>
      <td class="num"><b>${n(d.qty)}</b></td><td>${prioChip(d.prio)}</td><td class="small">${esc(d.status || '')}</td>
      <td><span class="${STAGE[d.stage][1]}"><b>${STAGE[d.stage][0]}</b></span><div class="small">${chain(d)}</div></td></tr>`; };
    const ddetail = (d) => `<tr class="pl-detail" data-pl-detail="disp:${esc(d.key)}"><td></td><td colspan="7"><div class="row" style="gap:16px;flex-wrap:wrap;align-items:flex-start">
      <div><b>Perso</b>${d.perso.length ? `<table class="log small"><thead><tr><th>Job</th><th class="num">Cards</th><th>Status</th><th>Projected finish</th></tr></thead><tbody>${d.perso.map((j) => `<tr><td>${esc(j.key)}</td><td class="num">${n(j.qty)}</td><td>${esc(j.status || '')}</td><td>${j.finish_at ? esc(PLF.wkHm.format(new Date(j.finish_at))) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="small pl-ok">✔ no perso job open</div>'}</div>
      <div><b>Matching</b>${d.matching.length ? `<table class="log small"><thead><tr><th>Job</th><th class="num">Items</th><th>Status</th><th>Plan date</th><th>Projected finish</th></tr></thead><tbody>${d.matching.map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${n(m.qty)}</td><td>${m.done ? '✔ ' : ''}${esc(m.status || '')}</td><td>${esc(m.due || '')}</td><td>${m.finish_at ? esc(PLF.wkHm.format(new Date(m.finish_at))) : '—'}</td></tr>`).join('')}</tbody></table>` : '<div class="small muted">no Matching job in its export</div>'}</div>
      <div><button class="small" data-pf-wo-open="${esc(d.wo)}">🔍 Everything about ${esc(d.wo)}</button></div></div></td></tr>`;
    // ▦ Load: pieces due out each day, by where they are in the chain
    const dLoad = () => {
      const days = [...new Set(all.map((d) => d.due).filter((d) => d && d >= todayIso))].sort().slice(0, 10);
      const later = all.filter((d) => d.due && d.due > (days[days.length - 1] || todayIso) && !days.includes(d.due));
      const cols = [['over', 'Overdue', (d) => d.due && d.due < todayIso], ...days.map((x) => [x, dayLabel(x), (d) => d.due === x]), ...(later.length ? [['later', 'Later', (d) => later.includes(d)]] : []), ['none', 'No date', (d) => !d.due]].filter(([k, , f]) => k !== 'none' || all.some(f));
      const rows = Object.entries(STAGE).map(([k, [l, cls]]) => [k, l, cls, all.filter((d) => d.stage === k)]);
      const max = Math.max(1, ...rows.flatMap(([, , , l]) => cols.map(([, , f]) => sum_(l.filter(f)))));
      const cell = (l, cls) => { const q = sum_(l); return `<td class="pl-load-cell" title="${n(l.length)} job${l.length === 1 ? '' : 's'}, ${n(q)} pieces"><div class="pl-load-bar ${cls}" style="width:${Math.round((q / max) * 100)}%"></div><span>${q ? n(q) : ''}</span></td>`; };
      const barCls = { perso: 'full', matching: 'busy', ready: '' };
      return `<div class="card"><h3 class="pl-h">Load — pieces due out each day <span class="muted small">by where they are: red still in perso · amber in Matching · green ready to dispatch</span></h3>
        <div class="kdb-scroll"><table class="log pl-load"><thead><tr><th>Stage</th>${cols.map(([k, l]) => `<th class="num">${esc(l)}</th>`).join('')}<th class="num">Pieces</th><th class="num">Jobs</th></tr></thead><tbody>
        ${rows.map(([k, l, cls, list]) => `<tr><td><span class="${cls}"><b>${l}</b></span></td>${cols.map(([, , f]) => cell(list.filter(f), barCls[k])).join('')}<td class="num">${n(sum_(list))}</td><td class="num">${n(list.length)}</td></tr>`).join('')}
        <tr class="pl-load-total"><td>All dispatch jobs</td>${cols.map(([, , f]) => { const l = all.filter(f); return `<td class="num"><b>${n(sum_(l))}</b><div class="small muted">${n(l.length)} job${l.length === 1 ? '' : 's'}</div></td>`; }).join('')}<td class="num">${n(sum_(all))}</td><td class="num">${n(all.length)}</td></tr>
        </tbody></table></div><p class="small muted">The Dispatch export has no machines, so there's no Gantt: this shows how much is due out each day and how much of it is still waiting on perso or Matching.</p></div>`;
    };
    // ⏱ Delays: the late (or about to be) work orders by customer and original due date, each group given a new
    // expected date and reason together; a work order can have its own
    const dDelays = () => {
      const pf = store.get('planDelayFilter', {}) || {};
      const late = all.filter((d) => d.delayed);
      const missed = (d) => d.delay?.new_date && d.delay.new_date < todayIso;
      const list = late.filter((d) => (!pf.customer || d.customer === pf.customer) && (pf.show !== 'unset' || !d.delay?.new_date) && (pf.show !== 'missed' || missed(d)));
      const gk = (d) => `${d.customer || ''}|${d.due || ''}`;
      const groups = new Map(); for (const d of list) (groups.get(gk(d)) || groups.set(gk(d), []).get(gk(d))).push(d);
      const byCust = new Map(); for (const [k, l] of [...groups].sort((a, b) => String(a[1][0].customer).localeCompare(String(b[1][0].customer)) || String(a[1][0].due).localeCompare(String(b[1][0].due)))) (byCust.get(l[0].customer) || byCust.set(l[0].customer, []).get(l[0].customer)).push([k, l]);
      for (const k of [...plDelaySel]) if (!groups.has(k)) plDelaySel.delete(k);
      const daysLate = (due) => Math.round((new Date(`${todayIso}T12:00`) - new Date(`${due}T12:00`)) / 86400000);
      const SHORT = { perso: 'in perso', matching: 'in Matching', ready: 'ready' };
      const chips = (l) => Object.entries(STAGE).map(([k, [lb, cls]]) => [l.filter((d) => d.stage === k).length, k, lb, cls]).filter(([x]) => x).map(([x, k, lb, cls]) => `<span class="${cls} small" title="${esc(lb)}">${x} ${SHORT[k]}</span>`).join(' · ');
      const wos = (x) => `${n(x)} work order${x === 1 ? '' : 's'}`;
      // where a set of work orders stands: ✖ a new date has passed · ⚠ some still need one · ✔ all have one
      const standing = (l) => { const unset = l.filter((d) => !d.delay?.new_date).length;
        return l.some(missed) ? ['bad', `✖ ${l.filter(missed).length} past the new date`] : unset ? ['warn', unset === l.length ? '⚠ needs a new date' : `⚠ ${unset} still need a date`] : ['ok', '✔ planned']; };
      const pill = (l) => { const [cls, t] = standing(l); return `<span class="pld-pill ${cls}">${t}</span>`; };
      const flash = (k) => (plDelayFlash === k ? 'pld-flash' : '');
      const gRow = (k, l) => { const d0 = l[0]; const g = d0.delay; const open = plDelayOpen.has(k); const own = l.filter((d) => d.delay?.from === 'job').length;
        return `<tr class="pld-group ${open ? 'open' : ''} ${flash(`g:${k}`)}" data-pld-g="${esc(k)}" data-customer="${esc(d0.customer || '')}" data-due="${esc(d0.due || '')}">
          <td class="pld-check"><input type="checkbox" class="pld-sel" ${plDelaySel.has(k) ? 'checked' : ''} title="Select to give several due dates the same new date"></td>
          <td><b>${esc(d0.due ? dayLabel(d0.due) : '—')}</b> <span class="pld-late">${daysLate(d0.due)} d late</span></td>
          <td><button class="link pld-toggle" data-pld-open="${esc(k)}" title="${open ? 'Hide' : 'Show'} its work orders, to give one its own date">${open ? '▾' : '▸'} ${wos(l.length)}</button>${own ? `<div class="small muted">${own} with ${own === 1 ? 'its' : 'their'} own date</div>` : ''}</td>
          <td class="num">${n(sum_(l))}</td><td>${chips(l)}</td>
          <td><input type="date" class="pld-gdate" value="${esc(g?.group_date || '')}" min="${todayIso}" title="The new expected date for all of these work orders"></td>
          <td><input type="text" class="pld-greason" value="${esc(g?.group_reason || '')}" placeholder="Reason (e.g. waiting on stock)" maxlength="300"></td>
          <td>${pill(l)}</td></tr>
        ${open ? l.map((d) => `<tr class="pld-job ${flash(`j:${d.key}`)}" data-pld-job="${esc(d.key)}" data-customer="${esc(d.customer || '')}" data-due="${esc(d.due || '')}"><td></td>
          <td colspan="2" class="small"><span class="pld-indent">↳</span> <b>${esc(d.wo)}</b><span class="muted">${esc(d.name.slice(d.wo.length))}</span>${d.status ? ` <span class="muted">· ${esc(d.status)}</span>` : ''}</td>
          <td class="num small">${n(d.qty)}</td><td class="small"><span class="${STAGE[d.stage][1]}">${STAGE[d.stage][0]}</span></td>
          <td><input type="date" class="pld-jdate" value="${esc(d.delay?.job_date || '')}" min="${todayIso}" title="A date for this work order only">${d.delay?.job_date ? '' : `<div class="small muted">${g?.group_date ? `uses ${esc(dayLabel(g.group_date))} from above` : 'uses the date above'}</div>`}</td>
          <td><input type="text" class="pld-jreason" value="${esc(d.delay?.job_reason || '')}" placeholder="${esc(g?.group_reason ? `Above: ${g.group_reason}` : 'Reason for this work order')}" maxlength="300"></td>
          <td class="small">${d.delay?.from === 'job' ? `<button class="link small" data-pld-follow="${esc(d.key)}" title="Clear this work order's own date and reason">↺ use the date above</button>` : ''}${missed(d) ? '<div><span class="pld-pill bad">✖ past the new date</span></div>' : ''}</td></tr>`).join('') : ''}`; };
      const custCard = (c, gs) => { const l = gs.flatMap(([, x]) => x); const allSel = gs.every(([k]) => plDelaySel.has(k)); const closed = plDelayClosed.has(c);
        return `<section class="card pld-card ${closed ? 'closed' : ''}" id="pld-c-${esc(c || '')}">
          <div class="pld-card-head">
            <input type="checkbox" class="pld-csel" data-keys="${esc(JSON.stringify(gs.map(([k]) => k)))}" ${allSel ? 'checked' : ''} title="Select all of ${esc(c || '')}'s due dates">
            <button class="link pld-cust-toggle" data-pld-cust="${esc(c || '')}" title="${closed ? 'Show' : 'Hide'} this customer">${closed ? '▸' : '▾'} <b>${esc(c || '—')}</b></button>
            <span class="muted">${esc(l[0].customer_name || '')}</span>
            <span class="small muted">${gs.length} due date${gs.length === 1 ? '' : 's'} · ${wos(l.length)} · ${n(sum_(l))} cards</span>
            <div class="spacer"></div>${pill(l)}</div>
          ${closed ? '' : `<div class="pld-wrap"><table class="log pld-table"><colgroup><col class="c-check"><col class="c-due"><col class="c-wos"><col class="c-cards"><col class="c-where"><col class="c-date"><col><col class="c-status"></colgroup><thead><tr><th class="pld-check"></th><th>Original due out</th><th>Work orders</th><th class="num">Cards</th><th>Where they are</th><th>New expected date</th><th>Reason</th><th>Status</th></tr></thead>
            <tbody>${gs.map(([k, x]) => gRow(k, x)).join('')}</tbody></table></div>`}</section>`; };
      const tileD = (lb, v, sub, cls = '', show = null) => `<div class="kdb-tile ${show !== null ? 'pl-tile-click' : ''} ${show !== null && (pf.show || '') === show ? 'pld-tile-on' : ''}" ${show !== null ? `data-pld-show="${show}" title="Show only these"` : ''}><div class="kdb-tile-l">${lb}</div><div class="kdb-tile-v ${cls}">${v}</div><div class="kdb-tile-s">${sub}</div></div>`;
      const unset = late.filter((d) => !d.delay?.new_date); const gone = late.filter(missed);
      const lCust = [...new Set(late.map((d) => d.customer).filter(Boolean))].sort();
      plDelayCusts = lCust.map((c) => { const l = late.filter((d) => d.customer === c); return { code: c, name: l[0].customer_name || '', wos: l.length }; });
      const jump = [...byCust].map(([c, gs]) => { const l = gs.flatMap(([, x]) => x); const [cls] = standing(l);
        return `<button type="button" class="pld-chip ${cls}" data-pld-jump="${esc(c || '')}" title="${esc(`${l[0].customer_name || c}: ${standing(l)[1].replace(/^\S+ /, '')}`)}">${esc(c || '—')} <span>${l.length}</span></button>`; }).join('');
      const sel = plDelaySel.size;
      return `<div class="kdb-tiles pl-tiles" style="margin-top:12px">
          ${tileD('Overdue work orders', n(late.length), `${n(sum_(late))} cards · ${n(new Set(late.map(gk)).size)} customer / due date groups`, late.length ? 'kdb-warn' : 'kdb-ok', '')}
          ${tileD('Still need a new date', n(unset.length), `${n(sum_(unset))} cards to plan`, unset.length ? 'kdb-bad' : 'kdb-ok', 'unset')}
          ${tileD('Past their new date', n(gone.length), 'still open after it', gone.length ? 'kdb-bad' : 'kdb-ok', 'missed')}
          ${tileD('Customers', n(lCust.length), 'with overdue work orders')}</div>
        <ol class="pld-steps">
          <li><b>1</b> Give each customer's overdue due date a <b>new expected date</b> — all its work orders take it.</li>
          <li><b>2</b> One work order different? Click <b>▸ work orders</b> and give it its own.</li>
          <li><b>3</b> Send it on: <b>⬇ Excel report</b> or <b>📋 Copy summary</b>.</li></ol>
        <div class="row pl-filters">
          <select id="pldl-show"><option value="">All overdue</option><option value="unset" ${pf.show === 'unset' ? 'selected' : ''}>Still need a new date</option><option value="missed" ${pf.show === 'missed' ? 'selected' : ''}>Past their new date</option></select>
          <select id="pldl-customer"><option value="">All customers</option>${lCust.map((c) => `<option ${pf.customer === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
          ${pf.show || pf.customer ? '<button class="link small" data-pld="fclear">Show all</button>' : ''}
          <button class="link small" data-pld="expand">Expand all</button><button class="link small" data-pld="collapse">Collapse all</button>
          <div class="spacer"></div>
          <button class="small" data-pld="copy" title="A short summary to paste into an email or report">📋 Copy summary</button>
          <label class="button small" title="Fill in the new expected dates from the delays workbook kept so far (Name, Trigram, Due Date, Expected due date)">⬆ Import from Excel<input type="file" accept=".xlsx,.xlsm" hidden id="pld-import"></label>
          <button class="small primary" data-pld="xlsx" title="For all customers or the ones you choose">⬇ Excel report</button></div>
        ${byCust.size > 1 ? `<div class="pld-jump"><span class="small muted">Go to</span>${jump}</div>` : ''}
        ${sel ? `<div class="pld-bulk">
          <b>${sel} due date${sel === 1 ? '' : 's'} selected</b><span class="small">give ${sel === 1 ? 'it' : 'them all'}</span>
          <input type="date" id="pld-bdate" min="${todayIso}"><input type="text" id="pld-breason" placeholder="Reason (optional)" maxlength="300">
          <button class="small primary" data-pld="bulk">Set new date</button><button class="small" data-pld="bulkclear">Clear their dates</button>
          <div class="spacer"></div><button class="link small" data-pld="none">✕ Unselect</button></div>` : '<p class="small muted pld-hint">Tip: tick several due dates (or a whole customer) to give them the same new date in one go.</p>'}
        ${[...byCust].map(([c, gs]) => custCard(c, gs)).join('') || `<div class="card lib-empty"><p>${late.length ? 'Nothing matches — <button class="link" data-pld="fclear">show all</button>.' : '✔ Nothing overdue: no dispatch job is past its due-out day.'}</p></div>`}
        <p class="small muted">Listed: past its due-out day and still open (one due today can still go today, so it isn't listed until tomorrow). A work order drops off once it's gone from the Dispatch export. Dates and reasons save as you leave the field, and are kept in the database (and the backups).</p>`;
    };
    plDelayText = () => {
      const late = all.filter((d) => d.delayed); const groups = new Map();
      for (const d of late) { const k = `${d.customer}|${d.due}`; (groups.get(k) || groups.set(k, []).get(k)).push(d); }
      const fd = (iso) => (iso ? PLF.day.format(new Date(`${iso}T12:00`)) : 'not set yet');
      const lines = [`Dispatch delays — ${PLF.day.format(new Date())}`, ''];
      let cust = null;
      for (const l of [...groups.values()].sort((a, b) => String(a[0].customer).localeCompare(String(b[0].customer)) || String(a[0].due).localeCompare(String(b[0].due)))) {
        const d0 = l[0];
        if (d0.customer !== cust) { cust = d0.customer; lines.push(`${cust}${d0.customer_name ? ` (${d0.customer_name})` : ''}`); }
        const g = d0.delay?.group_date || (new Set(l.map((d) => d.delay?.new_date || '')).size === 1 ? d0.delay?.new_date : null);
        lines.push(`  Due ${fd(d0.due)}: ${l.length} work order${l.length === 1 ? '' : 's'}, ${n(sum_(l))} cards → expected ${fd(g)}${d0.delay?.group_reason ? ` — ${d0.delay.group_reason}` : ''}`);
        for (const d of l.filter((x) => x.delay?.from === 'job')) lines.push(`    ${d.wo}: expected ${fd(d.delay.new_date)}${d.delay.job_reason ? ` — ${d.delay.job_reason}` : ''}`);
      }
      return late.length ? lines.join('\n') : 'No dispatch delays.';
    };
    plDetail.disp = (key) => { const d = all.find((x) => `disp:${x.key}` === key); return d ? ddetail(d) : ''; };
    const shown = all.filter(dm);
    const sum_ = (l) => l.reduce((t, d) => t + (d.qty || 0), 0);
    const tile = (l, v, sub, cls = '', stage = null) => `<div class="kdb-tile ${stage ? 'pl-tile-click' : ''}" ${stage ? `data-pl-dstage="${stage}" title="Show only these"` : ''}><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v ${cls}">${v}</div><div class="kdb-tile-s">${sub}</div></div>`;
    return `<div class="pl-tiles-row"><div class="kdb-tiles pl-tiles">
        ${tile('Open dispatch jobs', n(all.length), `${n(sum_(all))} pieces${dp.done ? ` · ${n(dp.done)} done not shown` : ''}`)}
        ${tile('Due today', n(today_.length), `${n(sum_(today_))} pieces`, today_.length ? 'kdb-warn' : '')}
        ${tile('Overdue', n(over.length), `${n(sum_(over))} pieces`, over.length ? 'kdb-bad' : 'kdb-ok')}
        ${tile('Waiting on perso', n(st('perso').length), `${n(sum_(st('perso')))} pieces`, st('perso').length ? 'kdb-bad' : '', 'perso')}
        ${tile('Waiting on Matching', n(st('matching').length), `${n(sum_(st('matching')))} pieces`, st('matching').length ? 'kdb-warn' : '', 'matching')}
        ${tile('Ready to dispatch', n(st('ready').length), `${n(sum_(st('ready')))} pieces`, 'kdb-ok', 'ready')}
      </div></div>
      ${viewsRow()}
      ${view === 'load' ? dLoad() : view === 'history' ? historyHtml() : view === 'delays' ? dDelays() : `
      ${dp.hidden ? `<p class="small muted">${n(dp.hidden)} dispatch job${dp.hidden === 1 ? '' : 's'} (${n(dp.hidden_qty)} pieces) due more than ${dp.max_age} days ago ${dp.hidden === 1 ? 'isn\'t' : 'aren\'t'} shown — likely errors. <a class="button small" href="/api/plan/hidden.xlsx" download>⬇ Export them to Excel</a></p>` : ''}
      <div class="row pl-filters">
        <input type="search" id="pld-q" placeholder="Search WO, customer, group, status…" value="${esc(df.q || '')}">
        <select id="pld-customer"><option value="">All customers</option>${dCust.map((c) => `<option ${df.customer === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
        <select id="pld-stage"><option value="">Any stage</option>${Object.entries(STAGE).map(([k, [l]]) => `<option value="${k}" ${df.stage === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${df.q || df.customer || df.stage ? '<button class="link small" data-pl="dclear">Clear</button>' : ''}</div>
      <div class="card"><h3 class="pl-h">🚚 Dispatch — by due date, then priority <span class="muted small">${shown.length} job${shown.length === 1 ? '' : 's'} · ${n(sum_(shown))} pieces · click a job for its perso and Matching jobs</span></h3>
        <div class="kdb-scroll"><table class="log pl-table"><thead><tr><th></th><th>Due out</th><th>Work order</th><th>Customer</th><th class="num">Qty</th><th>Priority</th><th>Status (export)</th><th>Where it is</th></tr></thead>
        <tbody>${shown.map((d) => drow(d, all.indexOf(d))).join('') || '<tr><td colspan="8" class="muted">Nothing matches.</td></tr>'}</tbody></table></div></div>
      ${dp.source.skipped?.length ? `<p class="small muted">${dp.source.skipped.length} row${dp.source.skipped.length === 1 ? '' : 's'} with a due date not understood.</p>` : ''}`}`;
  };
  const ottoHtml = () => {
    const os = ot.source; const allO = [...ot.running, ...ot.queue];
    if (os.status === 'missing') return `<div class="kc-note notice">Can't find <code>${esc(os.file)}</code> — check the Matching path in ⚙ Setup.</div>`;
    if (os.status === 'error') return `<div class="kc-note notice">Couldn't read <code>${esc(os.file)}</code>: ${esc(os.error)}</div>`;
    if (os.status !== 'ok') return '<div class="card lib-empty"><h2>Matching</h2><p>Set where the Matching export is saved in ⚙ Setup (or try it with 📂 Load file…). Each Matching job is matched to its perso work order by the start of its Name, so you can see which are still waiting on perso.</p></div>';
    const of = store.get('planOttoFilter', {}) || {};
    const om = (o) => (!of.customer || o.customer === of.customer) && (!of.waiting || (of.waiting === 'perso' ? o.perso_open : !o.perso_open))
      && (!of.q || `${o.name} ${o.customer} ${o.customer_name || ''} ${o.group || ''} ${o.machine || ''}`.toLowerCase().includes(of.q.toLowerCase()));
    const oCust = [...new Set(allO.map((o) => o.customer).filter(Boolean))].sort();
    const behind = (o) => o.perso_finish_at && o.deadline && new Date(o.perso_finish_at) > deadlineAt(o);
    const oOver = allO.filter((o) => deadlineAt(o) && deadlineAt(o) < today);
    const oToday = allO.filter((o) => o.due === todayIso);
    const waiting = allO.filter((o) => o.perso_open);
    const carriersLine = (o) => { const c = ottoReadiness(o).carriers; return c ? `<div class="small ${c === 'ready' ? 'pl-ok' : c === 'not ready' ? 'pl-warn' : 'muted'}" title="From the CPS status: ${esc(o.status || '')}">✉️ carriers ${esc(c)}</div>` : ''; };
    const persoCell = (o) => (!o.perso_open ? `<span class="pl-ok" title="No perso job open for ${esc(o.wo)} in the open work orders">✔ perso done</span>${carriersLine(o)}`
      : `<span class="${behind(o) ? 'pl-late' : 'pl-warn'}">⏳ ${ottoReadiness(o).cards === 'in progress' ? 'cards in progress' : `${o.perso.length} perso job${o.perso.length === 1 ? '' : 's'} open`}</span>${o.perso_finish_at ? `<div class="small ${behind(o) ? 'pl-late' : 'muted'}">ready ${esc(PLF.wkHm.format(new Date(o.perso_finish_at)))}${behind(o) ? ' — after the plan date' : ''}</div>` : ''}${carriersLine(o)}`);
    const orow = (o, i) => { const l = left(o); return `<tr class="pl-job ${l.cls ? `${l.cls}-row` : ''} ${behind(o) ? 'pl-late-row' : ''}" data-pl-job="otto:${esc(o.key)}">
      <td class="num muted pl-n">${i === null ? '▶' : i + 1}</td>
      <td><b>${esc(o.due ? dayLabel(o.due) : '—')}</b> <span ${o.time_from ? 'title="The cut-off of the perso work order\'s shipper — the matching export has no time of its own"' : ''}>${esc(o.deadline?.slice(11) || '')}</span><div class="small ${l.cls}">${esc(l.text)}</div></td>
      <td><b>${esc(o.wo)}</b><span class="muted">${esc(o.name.slice(o.wo.length))}</span><div class="small muted">${o.shipper ? `🚚 ${esc(o.shipper)}${o.group ? ' · ' : ''}` : ''}${esc(o.group || '')}</div></td>
      <td>${esc(o.customer || '—')}<div class="small muted">${esc(o.customer_name || '')}</div></td>
      <td class="num"><b>${n(o.qty)}</b></td><td>${prioChip(o.prio)}</td><td>${esc(o.status || '')}<div class="small muted">${esc(o.machine || '')}</div></td><td>${persoCell(o)}</td>${ot.projected ? `<td>${finishO(o)}</td>` : ''}</tr>`; };
    const odetailRow = (o) => `<tr class="pl-detail" data-pl-detail="otto:${esc(o.key)}"><td></td><td colspan="${ot.projected ? 8 : 7}"><div class="small">${o.sub_customer ? `<b>${esc(o.sub_customer)}</b><br>` : ''}${o.comment ? esc(o.comment).replace(/\n/g, '<br>') : '<span class="muted">No comment.</span>'}</div>
        ${o.perso.length ? `<table class="log small" style="margin-top:6px"><thead><tr><th>Perso job</th><th class="num">Cards</th><th>Status</th><th>Perso deadline</th><th>Projected finish</th></tr></thead><tbody>${o.perso.map((pj) => `<tr><td>${esc(pj.key)}</td><td class="num">${n(pj.qty)}</td><td>${esc(pj.status || '')}</td><td>${esc(pj.deadline?.replace('T', ' ') || '—')}</td><td>${pj.finish_at ? esc(fmtDateTime(pj.finish_at)) : '—'}</td></tr>`).join('')}</tbody></table>` : ''}</td></tr>`;
    plDetail.otto = (key) => { const o = [...ot.running, ...ot.queue].find((x) => `otto:${x.key}` === key); return o ? odetailRow(o) : ''; };
    const ohead = `<tr><th></th><th>Plan date</th><th>Name</th><th>Customer</th><th class="num">Items</th><th>Priority</th><th>Status</th><th>Perso</th>${ot.projected ? '<th>Projected finish</th>' : ''}</tr>`;
    const rs = ot.running.filter(om); const qs = ot.queue.filter(om);
    return `<div class="pl-tiles-row"><div class="kdb-tiles pl-tiles">
      <div class="kdb-tile"><div class="kdb-tile-l">Open Matching jobs</div><div class="kdb-tile-v">${n(allO.length)}</div><div class="kdb-tile-s">${n(sum(allO))} items${ot.done ? ` · ${n(ot.done)} finished not shown` : ''}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Running</div><div class="kdb-tile-v">${n(ot.running.length)}</div><div class="kdb-tile-s">${n(sum(ot.running))} items</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Due today</div><div class="kdb-tile-v ${oToday.length ? 'kdb-warn' : ''}">${n(oToday.length)}</div><div class="kdb-tile-s">${n(sum(oToday))} items</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Overdue items</div><div class="kdb-tile-v ${oOver.length ? 'kdb-bad' : 'kdb-ok'}">${n(sum(oOver))}</div><div class="kdb-tile-s">${n(oOver.length)} job${oOver.length === 1 ? '' : 's'}${ot.backlog?.catch_up?.catch_days ? ` · caught up in ~${ot.backlog.catch_up.catch_days} d` : ''}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Projected late</div><div class="kdb-tile-v ${allO.some((o) => o.late_minutes > 0) ? 'kdb-bad' : ot.projected ? 'kdb-ok' : ''}">${ot.projected ? n(allO.filter((o) => o.late_minutes > 0).length) : '—'}</div><div class="kdb-tile-s">${ot.projected ? `${(ot.machines || []).filter((m) => m.active).length} machine${(ot.machines || []).filter((m) => m.active).length === 1 ? '' : 's'} · ${esc(dayText)}` : 'set machines in ⚙ Setup'}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Waiting on perso</div><div class="kdb-tile-v ${allO.some(behind) ? 'kdb-bad' : ''}">${n(waiting.length)}</div><div class="kdb-tile-s">${allO.some(behind) ? `${n(allO.filter(behind).length)} perso ready after the plan date` : `${src.status === 'ok' ? 'perso work order still open' : 'link the perso export to match'}`}</div></div></div><button class="primary pl-generate" data-pl="print" title="A plan of the Matching jobs — Incoming, In Progress and Ready — as a PDF to print and hand out">📄 Generate plan</button></div>
    ${viewsRow()}
    ${view === 'gantt' ? '<div class="card pl-gantt-card"><div id="pl-gantt-info" class="small"></div><div id="pl-gantt"></div></div>' : ''}
    ${view === 'load' ? loadHtml((ot.machines || []).filter((m) => m.active), ot.load, 'items') : ''}
    ${view === 'history' ? historyHtml() : ''}
    ${view !== 'list' ? '' : `${backlogCard(ot.backlog, 'items', true)}
    <div class="row pl-filters">
      <input type="search" id="plo-q" placeholder="Search name, customer, plan group…" value="${esc(of.q || '')}">
      <select id="plo-customer"><option value="">All customers</option>${oCust.map((c) => `<option ${of.customer === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
      <select id="plo-waiting"><option value="">Perso: any</option><option value="perso" ${of.waiting === 'perso' ? 'selected' : ''}>Waiting on perso</option><option value="ready" ${of.waiting === 'ready' ? 'selected' : ''}>Perso done</option></select>
      ${of.q || of.customer || of.waiting ? '<button class="link small" data-pl="oclear">Clear</button>' : ''}</div>
    ${ot.projected ? `<div class="card"><h3 class="pl-h">Matching capacity <span class="muted small">— ${esc(dayText)}, ${cap.days.length} day${cap.days.length === 1 ? '' : 's'} a week</span></h3>
      <div class="kdb-scroll"><table class="log pl-cap"><thead><tr><th>Machine</th><th class="num">Speed</th><th class="num">Max items a day</th><th class="num">Jobs</th><th class="num">Items planned</th><th class="num">Work</th><th>Booked until</th></tr></thead><tbody>
      ${(ot.machines || []).filter((m) => m.active).map((m) => { const l = (ot.load || []).find((x) => x.id === m.id) || {};
        return `<tr><td><b>${esc(m.name)}</b>${m.match ? `<div class="small muted">${esc(m.match)}</div>` : ''}</td><td class="num">${m.speed ? `${n(m.speed)}/h` : '—'}</td><td class="num"><b>${m.speed ? n(Math.round((m.speed * ((cap.start === cap.end ? 1440 : (cap.end - cap.start + 1440) % 1440))) / 60)) : '—'}</b></td>
          <td class="num">${n(l.jobs)}</td><td class="num">${n(l.items)}</td><td class="num">${l.minutes ? fmtSpan(l.minutes) : '—'}</td><td>${l.until ? esc(new Date(l.until).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })) : '<span class="muted">free</span>'}</td></tr>`; }).join('')}
      </tbody></table></div><p class="small muted">Max items a day: the machine's own speed for a full working day (a customer speed can be higher or lower).</p></div>` : ''}
    ${rs.length ? `<div class="card"><h3 class="pl-h">▶ Running <span class="muted small">${rs.length} job${rs.length === 1 ? '' : 's'} · ${n(sum(rs))} items</span></h3><div class="kdb-scroll"><table class="log pl-table"><thead>${ohead}</thead><tbody>${rs.map((o) => orow(o, null)).join('')}</tbody></table></div></div>` : ''}
    <div class="card"><h3 class="pl-h">Matching — by plan date, then priority <span class="muted small">${qs.length} job${qs.length === 1 ? '' : 's'} · ${n(sum(qs))} items · click a job for its comment and perso jobs</span></h3>
      <div class="kdb-scroll"><table class="log pl-table"><thead>${ohead}</thead><tbody>${qs.map((o) => orow(o, ot.queue.indexOf(o))).join('') || '<tr><td colspan="9" class="muted">Nothing matches.</td></tr>'}</tbody></table></div></div>
    ${os.skipped?.length ? `<p class="small muted">${os.skipped.length} row${os.skipped.length === 1 ? '' : 's'} with a plan date not understood.</p>` : ''}`}`;
  };

  main().innerHTML = `
    <div class="kanban-tools"><h1 style="margin:0">🏭 Production</h1>
      ${plHalvesHtml(half, mode)}
      <div class="spacer"></div>
      ${state.mode === 'planner' ? '<span id="pl-presence" class="pl-presence" title="Others with the planner open">👤 just you</span>' : ''}
      <span class="small muted">${(half === 'otto' ? ot.source : half === 'disp' ? dp.source : src).status === 'ok' ? `${esc((half === 'otto' ? ot.source : half === 'disp' ? dp.source : src).name)} · saved ${esc(fmtDateTime((half === 'otto' ? ot.source : half === 'disp' ? dp.source : src).modified))}${(half === 'otto' ? ot.source : half === 'disp' ? dp.source : src).uploaded ? ' (uploaded copy)' : ''}` : ''}</span>
      <button data-pl="refresh" title="Read the export again if it has changed">🔄</button>
      ${half === 'perso' && src.status === 'ok' ? '<button class="primary" data-pl="print" title="A plan per cell (DOD, Emboss, Laser) of the work orders still open, as a PDF to print and hand out">📄 Generate plan</button>' : ''}
      ${ddMenu('⋯', `
        <label title="Try it with a copy of the ${half === 'otto' ? 'Matching' : 'open work orders'} export">📂 Load a file…<input type="file" accept=".xlsx" hidden id="pl-file"></label>
        ${half === 'perso' ? '<button class="admin-only" data-pl="mods">⚖ Priority modifiers</button>' : ''}
        <button class="admin-only" data-pl="setup">⚙ Setup — the export, machines and capacity</button>`, { title: 'Load a file, priority modifiers, setup' })}
    </div>
    <div id="pl-changed" class="pl-changed" hidden></div>
    ${half === 'perso' ? modsHtml() : ''}
    ${src.status === 'ok' ? '' : '<div class="card only-not-admin"><p>🏭 Planning isn\'t set up yet: an admin links the open work orders export in ⚙ Setup.</p></div>'}
    <div class="card pl-setup admin-only" id="pl-setup" ${src.status === 'ok' && !store.get('planSetupOpen', false) ? 'hidden' : ''}>
      <div class="row"><h2 style="margin:0">Setup</h2><div class="spacer"></div>
        <a class="button small" href="/api/plan/setup" download title="Machines, speeds, OEE, modifiers, card tags, pins and these settings — to move them to the shared planner (or back)">⬇ Export setup</a>
        <a class="button small" href="/api/plan/setup?history=1" download title="The setup plus the history built up from the exports (the pace, catch-up and on-time figures) and the ⏱ Production runs — so a new install starts where this one is">⬇ Export setup + history</a>
        <label class="button small" title="Replace this setup with one exported before">⬆ Import setup…<input type="file" accept=".json" hidden id="pl-setup-file"></label></div>
      ${p.shared_setup ? `<p class="small muted" style="margin:6px 0 0">📦 From the network: <span title="${esc(p.shared_setup.file)}">${esc(p.shared_setup.file.split(/[\\/]/).pop())}</span>, ${esc(fmtDateTime(p.shared_setup.at))} —
        ${p.shared_setup.setup ? 'setup applied' : 'this install\'s own setup kept'}${p.shared_setup.history ? `; history added: ${n(p.shared_setup.history.reads)} exports, ${n(p.shared_setup.history.jobs + p.shared_setup.history.jobs_updated)} jobs, ${n(p.shared_setup.history.prod_runs)} production runs` : ''}.
        A newer planning-setup file next to CIManager-Setup.bat is picked up by itself.</p>` : ''}
      ${state.mode === 'planner' ? '' : `<label class="f full" style="margin:10px 0">Shared planner address <span class="muted small">(optional) — when Planning runs on a server for everyone, its address, e.g. http://servername:3100. The Planning tab then opens it.</span>
        <input type="url" name="planner_url" class="pl-setting-any" value="${esc(settings.planner_url || '')}" placeholder="http://servername:3100"></label>`}
      <div class="form-grid">
        <label class="f full">Open work orders export (where it's saved)<input type="text" name="plan_src" value="${esc(settings.plan_src || '')}" placeholder="e.g. S:\\…\\Source Data\\OpenPersoWorkorders_PerAx.xlsx">
          <span class="small muted">Read again whenever it's saved (e.g. the hourly SSRS export). Nothing in it is changed.</span></label>
        <label class="f full">Matching export (where it's saved) — Name, Prod. Status, Items, Plan Date<input type="text" name="plan_otto_src" value="${esc(settings.plan_otto_src || '')}" placeholder="e.g. S:\\…\\Source Data\\Matching.xlsx">
          <span class="small ${ot.source.status === 'missing' || ot.source.status === 'error' ? 'pl-late' : 'muted'}">${ot.source.status === 'ok' ? `✔ ${n(ot.running.length + ot.queue.length)} open Matching jobs · saved ${esc(fmtDateTime(ot.source.modified))}` : ot.source.status === 'missing' ? '⚠ Can\'t find this file' : ot.source.status === 'error' ? `⚠ ${esc(ot.source.error)}` : 'Each Matching job is matched to its perso work order by the start of its Name.'}</span></label>
        <label class="f full">Dispatch export (where it's saved) — WO, QNY, Due Out, Status<input type="text" name="plan_disp_src" value="${esc(settings.plan_disp_src || '')}" placeholder="e.g. S:\\…\\Source Data\\OpenDespatchWorkorders.xlsx">
          <span class="small ${dp.source.status === 'missing' || dp.source.status === 'error' ? 'pl-late' : 'muted'}">${dp.source.status === 'ok' ? `✔ ${n(dp.jobs.length)} open dispatch jobs · saved ${esc(fmtDateTime(dp.source.modified))}` : dp.source.status === 'missing' ? '⚠ Can\'t find the file there' : dp.source.status === 'error' ? `⚠ ${esc(dp.source.error)}` : 'Each dispatch job is linked to its perso and Matching jobs by its work order (the start of its WO).'}</span></label>
        <label class="f full">📊 DailyPersoData (the report Power BI uses) — Production Date, job, Qty Persoed<input type="text" name="kpi_perso_data" value="${esc(settings.kpi_perso_data || '')}" placeholder="e.g. S:\\…\\DailyPersoData.xlsx">
          <span class="small ${p.pdata?.status === 'missing' || p.pdata?.status === 'error' ? 'pl-late' : 'muted'}">${p.pdata?.rows ? `✔ ${n(p.pdata.rows)} rows, ${esc(p.pdata.first)} to ${esc(p.pdata.last)} — 📈 History and the backlog pace add up its Qty Persoed by Production Date, as Power BI does` : p.pdata?.status === 'missing' ? '⚠ Can\'t find the file there' : p.pdata?.status === 'error' ? `⚠ ${esc(p.pdata.error)}` : 'Link it so 📈 History and the backlog pace show the same cards persoed as Power BI. Read every 10 minutes; nothing in it is changed.'}</span></label>
        <label class="f full">⏱ Perso timing report (DailyPersoTiming) — each run's start and end, for the ⏱ Gantt, speeds and anomalies<input type="text" name="kpi_time_perso" value="${esc(settings.kpi_time_perso || '')}" placeholder="e.g. S:\\…\\DailyPersoTiming.xlsx"></label>
        <label class="f full">Card database (Access) — the Cards table gives each card article's type, material and print sides<input type="text" name="plan_db" value="${esc(settings.plan_db || '')}" placeholder="e.g. S:\\…\\Cards.accdb">
          <span class="small ${cdb.status === 'error' || cdb.status === 'missing' ? 'pl-late' : 'muted'}">${cdb.status === 'ok' ? `✔ ${n(cdb.count)} cards in the ${esc(cdb.table)} table · saved ${esc(fmtDateTime(cdb.modified))} — read again whenever it's saved` : cdb.status === 'missing' ? '⚠ Can\'t find this file' : cdb.status === 'error' ? `⚠ ${esc(cdb.error)}` : 'Read only — nothing in the database is changed. It can stay open in Access.'}</span></label>
        <label class="f">Table<input type="text" name="plan_db_table" value="${esc(settings.plan_db_table || 'Cards')}"></label>
        <label class="f">Flat rate — cards per hour for cards without a speed<input type="number" min="0" step="1" name="plan_rate" value="${esc(settings.plan_rate || '')}" placeholder="optional"></label>
        ${useMachines ? '' : `<label class="f">Lines running <span class="muted small">(until machines are set)</span><input type="number" min="1" step="1" name="plan_lines" value="${esc(settings.plan_lines || '1')}"></label>`}
        <label class="f">Ready before the cut-off (minutes) <span class="muted small">— packing and dispatch</span><input type="number" min="0" step="5" name="plan_buffer" value="${esc(settings.plan_buffer || '0')}"></label>
        <label class="f">Change-over (minutes) <span class="muted small">— each time a machine moves on to another work order</span><input type="number" min="0" step="1" name="plan_changeover" value="${esc(settings.plan_changeover || '0')}"></label>
        <div class="f full"><span>Run times</span><div class="row">
          <label class="row small"><input type="radio" name="pl-learned" data-pl-learned="0" ${settings.plan_learned_times === '1' ? '' : 'checked'}> From the speeds and OEE below</label>
          <label class="row small"><input type="radio" name="pl-learned" data-pl-learned="1" ${settings.plan_learned_times === '1' ? 'checked' : ''}> 🔬 Learned from what ran — each card's own time, with the set-up</label></div>
          <span class="small muted">${p.learned_times?.on ? `${n(p.learned_times.card)} of ${n(p.learned_times.lines)} card lines timed from their card's own runs, ${n(p.learned_times.kind + p.learned_times.all)} from their kind's or all runs${p.learned_times.setup !== null ? `, each with ${n(p.learned_times.setup)} min set-up` : ''}; the rest from the speeds and OEE. Learned from the last 180 days of ⏱ Production runs (${n(p.learned_times.runs)}).` : 'Learned run times come from the ⏱ Production runs: see 🧠 Insights › 🔬 Learned for how close each way has been.'}</span></div>
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
    ${half === 'otto' ? ottoHtml() : half === 'disp' ? dispHtml() : `
    ${src.status === 'ok' && cdb.status === 'ok' && (p.unknown_articles?.length || p.no_speed) ? `<div class="kc-note notice">${[p.unknown_articles.length ? `${p.unknown_articles.length} card article${p.unknown_articles.length === 1 ? ' isn\'t' : 's aren\'t'} in the card database (${esc(p.unknown_articles.slice(0, 6).join(', '))}${p.unknown_articles.length > 6 ? ', …' : ''})` : '', p.no_speed ? `${p.no_speed} card line${p.no_speed === 1 ? ' has no speed of its own' : 's have no speed of their own'} — ${cap.rate ? 'the flat rate is used' : 'the average of the others is used (≈)'}` : ''].filter(Boolean).join(' · ')}. <button class="small" data-pl="nospeed">🔎 Show which</button> <button class="link small admin-only" data-pl="setup">⚙ Speeds</button></div>` : ''}
    ${src.status === 'missing' ? `<div class="kc-note notice">Can't find <code>${esc(src.file)}</code> — check the path in ⚙ Setup.</div>` : ''}
    ${src.status === 'error' ? `<div class="kc-note notice">Couldn't read <code>${esc(src.file)}</code>: ${esc(src.error)}</div>` : ''}
    ${src.status === 'none' ? '<div class="card lib-empty"><h2>Production planning</h2><p>Set where the open work orders export is saved in ⚙ Setup (or try it with 📂 Load file…). The work orders are put in order by their deadline — the due date at the shipper\'s cut-off — and, with a capacity, each one\'s finish is projected.</p></div>' : ''}
    ${src.status === 'ok' ? `
    <div class="pl-tiles-row"><div class="kdb-tiles pl-tiles">
      <div class="kdb-tile"><div class="kdb-tile-l">Open jobs</div><div class="kdb-tile-v">${n(all.length)}</div><div class="kdb-tile-s">${n(sum(all))} cards · ${n(new Set(all.map((j) => j.wo)).size)} work orders</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Running</div><div class="kdb-tile-v">${n(p.running.length)}</div><div class="kdb-tile-s">${n(sum(p.running))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Due today</div><div class="kdb-tile-v ${dueToday.length ? 'kdb-warn' : ''}">${n(dueToday.length)}</div><div class="kdb-tile-s">${n(sum(dueToday))} cards</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Overdue cards</div><div class="kdb-tile-v ${overdue.length ? 'kdb-bad' : 'kdb-ok'}">${n(sum(overdue))}</div><div class="kdb-tile-s">${n(overdue.length)} job${overdue.length === 1 ? '' : 's'}${p.backlog?.catch_up?.catch_days ? ` · caught up in ~${p.backlog.catch_up.catch_days} d` : ''}</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Projected late</div><div class="kdb-tile-v ${late.length ? 'kdb-bad' : p.projected ? 'kdb-ok' : ''}">${p.projected ? n(late.length) : '—'}</div><div class="kdb-tile-s">${esc(capText)}</div></div>
    </div></div>
    ${src.status === 'ok' ? viewsRow() : ''}
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
      <div class="kdb-scroll"><table class="log pl-table"><thead>${head}</thead><tbody>${queueShown.slice(0, qShown).map(queueRow).join('')}${moreRow()}${queueShown.length ? '' : '<tr><td colspan="8" class="muted">Nothing matches.</td></tr>'}</tbody></table></div></div>`}` : ''}`}`;
  const keepScroll = plLastTab === `${half}|${store.get(half === 'perso' ? 'planView' : `planView_${half}`, 'list')}`;
  plLastTab = `${half}|${store.get(half === 'perso' ? 'planView' : `planView_${half}`, 'list')}`;
  if (keepScroll && scrollY !== null) {
    main().scrollTop = scrollY;
    main().querySelectorAll('.kdb-scroll').forEach((el, i) => { if (scrollBoxes[i]) el.scrollTop = scrollBoxes[i]; });
  }
  if (keepScroll && refocus) main().querySelector(refocus)?.focus({ preventScroll: true });
  plDelayFlash = null; // highlighted once
  if (half !== 'disp' && view === 'gantt' && $('#pl-gantt')) {
    const draw = () => drawPlanGantt($('#pl-gantt'), $('#pl-gantt-info'), p, half === 'otto' ? null : match, half);
    draw();
    window.onresize = () => { if ($('#pl-gantt')) draw(); };
  }

  const setO = (k, v) => { const of = store.get('planOttoFilter', {}) || {}; of[k] = v || ''; store.set('planOttoFilter', of); renderPlanning(); };
  $$('[data-pdata-set]').forEach((el) => el.addEventListener('change', async () => {
    const k = el.dataset.pdataSet; const v = el.hasAttribute('data-inv') ? (el.checked ? '0' : '1') : (el.checked ? '1' : '0');
    try { await api.patch('/settings', { [k]: v }); toast('Counting changed'); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $('#pl-mode')?.addEventListener('change', (e) => { store.set('planMode', e.target.value); renderPlanning(); });
  $('#plo-q')?.addEventListener('change', (e) => setO('q', e.target.value.trim()));
  const setD = (k, v) => { const df = store.get('planDispFilter', {}) || {}; df[k] = v || ''; store.set('planDispFilter', df); renderPlanning(); };
  $('#pld-q')?.addEventListener('change', (e) => setD('q', e.target.value.trim()));
  // ⏱ Delays
  const setDl = (k, v) => { const f = store.get('planDelayFilter', {}) || {}; f[k] = v || ''; store.set('planDelayFilter', f); renderPlanning(); };
  $('#pld-import')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const send = async (apply) => {
      const r = await fetch(`/api/plan/disp/delays/import${apply ? '?apply=1' : ''}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || r.statusText); return d;
    };
    try {
      const d = await send(false);
      if (!d.rows) { toast(`Nothing to import: ${d.read} row${d.read === 1 ? '' : 's'} read, none with a new expected date`, 'error'); e.target.value = ''; return; }
      const msg = `From "${d.sheet}": ${d.rows} of ${d.read} work orders have a new expected date (${d.open} still open in the Dispatch export).\n\n`
        + `• ${d.groups} customer + due date group${d.groups === 1 ? '' : 's'} (${d.group_rows} work orders) get one date together\n• ${d.jobs} work order${d.jobs === 1 ? '' : 's'} get their own date\n`
        + `${d.skipped ? `• ${d.skipped} row${d.skipped === 1 ? '' : 's'} with nothing to bring in are skipped\n` : ''}\nDates already set for these are replaced; reasons are left as they are. Import?`;
      if (!confirm(msg)) { e.target.value = ''; return; }
      await send(true); toast('Delays imported'); renderPlanning();
    } catch (err) { toast(err.message, 'error'); e.target.value = ''; }
  });
  $('#pldl-show')?.addEventListener('change', (e) => setDl('show', e.target.value));
  $('#pldl-customer')?.addEventListener('change', (e) => setDl('customer', e.target.value));
  $$('.pld-sel').forEach((el) => el.addEventListener('change', () => { const k = el.closest('[data-pld-g]').dataset.pldG; if (el.checked) plDelaySel.add(k); else plDelaySel.delete(k); renderPlanning(); }));
  $$('.pld-csel').forEach((el) => el.addEventListener('change', () => { for (const k of JSON.parse(el.dataset.keys)) { if (el.checked) plDelaySel.add(k); else plDelaySel.delete(k); } renderPlanning(); }));
  $$('.pld-gdate, .pld-greason').forEach((el) => el.addEventListener('change', async () => {
    const tr = el.closest('[data-pld-g]');
    try { await api.put('/plan/disp/delay', { customer: tr.dataset.customer, due: tr.dataset.due, new_date: tr.querySelector('.pld-gdate').value, reason: tr.querySelector('.pld-greason').value }); plDelayFlash = `g:${tr.dataset.pldG}`; toast('Saved'); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('.pld-jdate, .pld-jreason').forEach((el) => el.addEventListener('change', async () => {
    const tr = el.closest('[data-pld-job]');
    try { await api.put('/plan/disp/delay/job', { key: tr.dataset.pldJob, customer: tr.dataset.customer, due: tr.dataset.due, new_date: tr.querySelector('.pld-jdate').value, reason: tr.querySelector('.pld-jreason').value }); plDelayFlash = `j:${tr.dataset.pldJob}`; toast('Saved'); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $('#pld-customer')?.addEventListener('change', (e) => setD('customer', e.target.value));
  $('#pld-stage')?.addEventListener('change', (e) => setD('stage', e.target.value));
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
    const res = await fetch(`/api/plan/upload${half !== 'perso' ? `?half=${half}` : ''}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager' } });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) toast(d.error || res.statusText, 'error'); else toast(`${file.name} loaded${({ otto: settings.plan_otto_src, disp: settings.plan_disp_src }[half] ?? settings.plan_src) ? ' — the linked export is still used; clear its path to use this copy' : ''}`);
    renderPlanning();
  });
  $('#pl-setup-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    let body; try { body = JSON.parse(await file.text()); } catch { toast('That isn\'t a planning setup file', 'error'); return; }
    if (!confirm(`Replace this planner's setup (machines, speeds, OEE, modifiers, card tags, pins and settings) with the one in ${file.name}?${body.history ? '\n\nIts history (exports read, jobs seen, Production runs) is added to this one\'s — nothing here is lost.' : ''}`)) return;
    try {
      const r = await api.post('/plan/setup', body);
      const hh = r.history;
      toast(`Setup imported — ${Object.values(r.tables).reduce((a, b) => a + b, 0)} rows, ${r.settings} settings${hh ? ` · history: ${hh.reads} exports, ${hh.jobs + hh.jobs_updated} jobs, ${hh.prod_runs} production runs added` : ''}`);
      renderPlanning();
    } catch (err) { toast(err.message, 'error'); }
  });
  if (state.mode === 'planner') startPlanPresence();
  $$('#pl-setup input[name]').forEach((el) => el.addEventListener('change', async () => {
    // the production reports: read straight away
    const report = { kpi_perso_data: 'pdata', kpi_time_perso: 'perso' }[el.name];
    if (report) {
      try {
        await api.patch('/settings', { [el.name]: el.value.trim().replace(/^"|"$/g, '') });
        const r = el.value.trim() ? await api.post('/prod/read', { source: report }) : null;
        toast(!r ? 'Saved' : r.status === 'read' ? `Read ${n(r.rows)} ${report === 'pdata' ? 'rows' : 'runs'}` : r.status === 'missing' ? 'Saved — but the file can\'t be found there' : r.error || 'Saved', r && r.status !== 'read' ? 'error' : '');
      } catch (err) { toast(err.message, 'error'); }
      store.set('planSetupOpen', true); renderPlanning(); return;
    }
    try { state.settings = await api.patch('/settings', { [el.name]: el.value.trim().replace(/^"|"$/g, '') }); toast('Saved'); if (el.name === 'planner_url' && typeof plannerLink === 'function') plannerLink(); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
  }));
  $$('[data-pl-learned]').forEach((el) => el.addEventListener('change', async () => {
    try { state.settings = await api.patch('/settings', { plan_learned_times: el.dataset.plLearned }); toast(el.dataset.plLearned === '1' ? 'Planning now uses the learned run times' : 'Planning uses the speeds and OEE'); store.set('planSetupOpen', true); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
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
    if (delO) { if (!confirm('Remove this Matching machine?')) return; try { await api.del(`/plan/otto/machines/${delO.dataset.ploDelMachine}`); renderPlanning(); } catch (err) { toast(err.message, 'error'); } return; }
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
    if (v) { store.set(viewKey, v.dataset.plView); renderPlanning(); return; }
    const sp = e.target.closest('[data-pl-span]');
    if (sp) { store.set('planSpan', Number(sp.dataset.plSpan)); renderPlanning(); return; }
    const hf = e.target.closest('[data-pl-half]');
    if (hf) { store.set('planHalf', hf.dataset.plHalf); renderPlanning(); return; }
    if (e.target.closest('[data-pl="oclear"]')) { store.set('planOttoFilter', {}); renderPlanning(); return; }
    const pldCust = e.target.closest('[data-pld-cust]');
    if (pldCust) { const c = pldCust.dataset.pldCust; if (plDelayClosed.has(c)) plDelayClosed.delete(c); else plDelayClosed.add(c); renderPlanning(); return; }
    const pldJump = e.target.closest('[data-pld-jump]');
    if (pldJump) { const c = pldJump.dataset.pldJump; const go = () => { const el = document.getElementById(`pld-c-${c}`); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('pld-flash'); } };
      if (plDelayClosed.delete(c)) await renderPlanning(); go(); return; }
    const pldOpen = e.target.closest('[data-pld-open]');
    if (pldOpen) { const k = pldOpen.dataset.pldOpen; if (plDelayOpen.has(k)) plDelayOpen.delete(k); else plDelayOpen.add(k); renderPlanning(); return; }
    const pldShow = e.target.closest('[data-pld-show]');
    if (pldShow) { store.set('planDelayFilter', { ...(store.get('planDelayFilter', {}) || {}), show: pldShow.dataset.pldShow }); renderPlanning(); return; }
    const pldFollow = e.target.closest('[data-pld-follow]');
    if (pldFollow) { try { await api.put('/plan/disp/delay/job', { key: pldFollow.dataset.pldFollow, new_date: '', reason: '' }); toast('Follows its group again'); renderPlanning(); } catch (err) { toast(err.message, 'error'); } return; }
    const pld = e.target.closest('[data-pld]')?.dataset.pld;
    if (pld === 'copy') { const t = plDelayText(); try { await navigator.clipboard.writeText(t); toast('Summary copied — paste it into your email or report'); } catch { prompt('Copy the summary:', t); } return; }
    if (pld === 'xlsx') {
      const pre = (store.get('planDelayFilter', {}) || {}).customer;
      openModal(`<div class="modal-head"><h2 style="margin:0">⬇ Delays report</h2><button class="icon" data-action="close-modal">✕</button></div>
        <form id="pld-xlsx" class="form-grid">
          <div class="f full"><label class="row"><input type="radio" name="who" value="all" ${pre ? '' : 'checked'}> All customers</label>
            <label class="row"><input type="radio" name="who" value="some" ${pre ? 'checked' : ''}> Only these customers:</label>
            <div class="row" style="flex-wrap:wrap;gap:6px 16px;margin:6px 0 0 24px">${plDelayCusts.map((c) => `<label class="row small"><input type="checkbox" name="cust" value="${esc(c.code)}" ${pre === c.code ? 'checked' : ''}> <b>${esc(c.code)}</b> <span class="muted">${esc(c.name)} · ${c.wos}</span></label>`).join('') || '<span class="muted small">No customer has delayed work orders.</span>'}</div></div>
          <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">⬇ Download</button></div>
        </form>`);
      const form = $('#pld-xlsx');
      form.querySelectorAll('[name=cust]').forEach((x) => x.addEventListener('change', () => { if (x.checked) form.querySelector('[name=who][value=some]').checked = true; }));
      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const some = form.querySelector('[name=who][value=some]').checked; const picked = [...form.querySelectorAll('[name=cust]:checked')].map((x) => x.value);
        if (some && !picked.length) { toast('Choose at least one customer', 'error'); return; }
        const a = document.createElement('a'); a.href = `/api/plan/disp/delays.xlsx${some ? `?customers=${encodeURIComponent(picked.join(','))}` : ''}`; a.download = ''; document.body.append(a); a.click(); a.remove();
        closeModal();
      });
      return;
    }
    if (pld === 'fclear') { store.set('planDelayFilter', {}); renderPlanning(); return; }
    if (pld === 'expand' || pld === 'collapse') { plDelayClosed.clear(); if (pld === 'collapse') for (const c of plDelayCusts) plDelayClosed.add(c.code); renderPlanning(); return; }
    if (pld === 'none') { plDelaySel.clear(); renderPlanning(); return; }
    if (pld === 'bulk' || pld === 'bulkclear') {
      const groups = [...plDelaySel].map((k) => { const [customer, due] = k.split('|'); return { customer, due }; });
      const body = pld === 'bulk' ? { groups, new_date: $('#pld-bdate').value, reason: $('#pld-breason').value } : { groups, new_date: '', reason: '' };
      if (pld === 'bulk' && !body.new_date) { toast('Choose the new date', 'error'); return; }
      if (pld === 'bulkclear' && !confirm(`Clear the new date and reason of ${groups.length} group${groups.length === 1 ? '' : 's'}?`)) return;
      try { await api.put('/plan/disp/delays', body); toast(pld === 'bulk' ? `New date set for ${groups.length} group${groups.length === 1 ? '' : 's'}` : 'Cleared'); plDelaySel.clear(); renderPlanning(); } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (e.target.closest('[data-pl="dclear"]')) { store.set('planDispFilter', {}); renderPlanning(); return; }
    const ds = e.target.closest('[data-pl-dstage]');
    if (ds) { const df = store.get('planDispFilter', {}) || {}; df.stage = df.stage === ds.dataset.plDstage ? '' : ds.dataset.plDstage; store.set('planDispFilter', df); renderPlanning(); return; }
    const wo = e.target.closest('[data-pf-wo-open]');
    if (wo) { pfBack.length = 0; pfOpen('wo', wo.dataset.pfWoOpen); return; }
    const m = e.target.closest('[data-pl-mode]');
    if (m) { store.set('planMode', m.dataset.plMode); renderPlanning(); return; }
    const b = e.target.closest('[data-pl]');
    if (b?.dataset.pl === 'nospeed') { plNoSpeed(); return; }
    if (b?.dataset.pl === 'setup-pdata') { const st = $('#pl-setup'); st.hidden = false; store.set('planSetupOpen', true); const inp = st.querySelector('[name="kpi_perso_data"]'); inp?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => inp?.focus(), 300); return; }
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
    const more = e.target.closest('[data-pl-more]');
    if (more) {
      const to = more.dataset.plMore === 'all' ? queueShown.length : Math.min(queueShown.length, qShown + Number(more.dataset.plMore));
      const tr = more.closest('tr');
      tr.insertAdjacentHTML('beforebegin', queueShown.slice(qShown, to).map((j, i) => queueRow(j, qShown + i)).join(''));
      qShown = to;
      tr.insertAdjacentHTML('afterend', moreRow()); tr.remove();
      return;
    }
    // a job's details: built the first time it's opened, then shown / hidden
    const job = e.target.closest('[data-pl-job]');
    if (job) {
      const key = job.dataset.plJob; const next = job.nextElementSibling;
      if (next?.classList.contains('pl-detail') && next.dataset.plDetail === key) { next.hidden = !next.hidden; return; }
      const html = (key.startsWith('otto:') ? plDetail.otto : key.startsWith('disp:') ? plDetail.disp : plDetail.perso)?.(key);
      if (html) job.insertAdjacentHTML('afterend', html);
    }
  };
}

// 👥 The shared planner: who else has it open, and a note when someone else changes the setup
// after this page was drawn (so changes aren't overwritten unawares).
let planPresence = null;
function startPlanPresence() {
  const loadedAt = new Date().toISOString();
  if (planPresence) clearInterval(planPresence.timer);
  const tick = async () => {
    if (state.view !== 'planning' || !$('#pl-presence')) { clearInterval(planPresence.timer); planPresence = null; return; }
    let r; try { r = await api.post('/presence', { id: me.id, name: me.name, view: 'planning' }); } catch { return; }
    const chip = $('#pl-presence');
    const names = [...new Set(r.others.map((o) => o.name))];
    if (chip) { chip.textContent = names.length ? `👥 also here: ${names.join(', ')}` : '👤 just you'; chip.title = r.others.map((o) => `${o.name} — since ${PLF.hm.format(new Date(o.since))}`).join('\n') || 'Nobody else has the planner open'; }
    const lc = r.last_change; const box = $('#pl-changed');
    if (box && lc && lc.client !== me.id && lc.at > loadedAt) {
      box.hidden = false;
      box.innerHTML = `✏ <b>${esc(lc.by || 'Someone')}</b> changed the planning setup at ${esc(PLF.hm.format(new Date(lc.at)))} — refresh before changing it yourself. <button class="small" data-pl="refresh">🔄 Refresh</button>`;
    }
  };
  planPresence = { timer: setInterval(tick, 20000) };
  tick();
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
// The plan as data: which sheets go on which page, and each row's text and colour. The server draws
// it as a PDF (src/plansheet.js); planSheetHtml() draws the same as a web page.
function planSheetModel(jobs, { cells: pick, layout = 'pages', limit = 0, method = '', test = false, spec = null, splitOverdue = false, groups = null, title = 'Production plan', fileLabel = 'Plan', now = new Date() } = {}) {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(now); const tm = new Date(now); tm.setDate(tm.getDate() + 1); const tomorrow = ymd(tm);
  const nowKey = `${today}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const side = layout === 'side';
  const when = (j) => {
    if (!j.deadline) return { cls: 'later', tag: '—', time: '', day: '' };
    const [d, t] = j.deadline.split('T');
    const time = j.no_cutoff ? (side ? 'eod' : 'end of day') : t;
    const short = `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`; // 8/10: the date in the side-by-side pill
    const day = side ? short : PLF.day.format(new Date(`${d}T12:00`));
    if (j.deadline < nowKey) return { cls: 'late', tag: 'LATE', time: `${day} ${time}`, day: short };
    if (d === today) return { cls: 'today', tag: 'TODAY', time, day: short };
    if (d === tomorrow) return { cls: 'tomorrow', tag: 'TOMORROW', time, day: short };
    return { cls: 'later', tag: side ? day : PLF.day.format(new Date(`${d}T12:00`)).toUpperCase(), time, day: short };
  };
  const n = (v) => PLF.num.format(Number(v || 0));
  const cells = (groups || cellsOf(jobs)).filter((c) => !pick || pick.includes(c.type));
  // overdue (past its deadline, not running): on a list of its own when split off
  const isOver = (r) => !r.job.running && !r.job.keep && when(r.job).cls === 'late';
  const section = (c, all, overdue = false) => ({
    name: c.type, overdue, empty: overdue ? 'Nothing overdue.' : 'Nothing open.',
    rows: (limit > 0 ? all.slice(0, limit) : all).map((r, i) => {
      const w = when(r.job);
      return { no: r.job.running ? '' : String(i + 1), running: !!r.job.running, wo: r.job.wo, suffix: r.job.is_otto ? r.job.name.slice(r.job.wo.length) : `/${r.job.per}`,
        note: r.note || '', customer: r.job.customer || '', hot: /high|urgent/i.test(r.job.prio || ''), pinned: !!r.job.pinned, qty: n(r.qty), cls: w.cls, tag: w.tag, time: w.time, day: w.day };
    }),
  });
  const main = (c) => section(c, splitOverdue ? c.rows.filter((r) => !isOver(r)) : c.rows);
  const over = (c) => section(c, c.rows.filter(isOver), true);
  const overCells = cells.filter((c) => !c.noOverdue); // In Progress: nothing moves, so no overdue sheet
  let pages;
  if (side) pages = [{ sections: cells.map(main) }, ...(splitOverdue && overCells.length ? [{ sections: overCells.map(over) }] : [])];
  else pages = cells.flatMap((c) => [{ sections: [main(c)] }, ...(splitOverdue && !c.noOverdue ? [{ sections: [over(c)] }] : [])]);
  const stamp = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return { layout, method, test, stamp, title: `${title} — ${stamp}`, file_label: fileLabel, running_legend: !groups, pages, spec };
}
// **bold** in the explanation's text → <b>
const specInline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
function planSheetHtml(m) {
  const side = m.layout === 'side';
  const sheet = (s, cont) => `<section class="cell${s.overdue ? ' over' : ''}">
      <header><div><div class="name">${esc(s.name)}</div>${s.overdue ? '<div class="od">Overdue</div>' : ''}</div>${m.method ? `<div class="method">${esc(m.method)}${m.test ? ' · TEST' : ''}</div>` : ''}</header>
      ${s.rows.length ? '' : `<p class="none">${esc(s.empty)}</p>`}
      <table>${s.rows.map((r) => `<tbody class="it ${r.cls}${r.running ? ' run' : ''}"><tr>
        <td class="box"></td><td class="no">${r.running ? '▶' : esc(r.no)}</td>
        <td class="wo">${esc(r.wo)}<span>${esc(r.suffix)}</span></td>
        <td class="cu">${esc(r.customer)}${r.hot ? ' <span class="hot">!</span>' : ''}${r.pinned ? ' <span class="pin">📌</span>' : ''}</td>
        <td class="qty">${esc(r.qty)}</td>
        <td class="due"><span class="tag">${esc(r.tag)}</span> ${esc(r.time)}</td></tr>
        ${r.note ? `<tr class="ntr"><td></td><td></td><td colspan="4" class="nt">${esc(r.note)}</td></tr>` : ''}</tbody>`).join('')}</table>
      ${side ? '' : legend}
    </section>`;
  const legend = `<footer><span><span class="sw late"></span> late</span><span><span class="sw today"></span> due today</span><span><span class="sw tomorrow"></span> tomorrow</span>${m.running_legend ? '<span>▶ running</span>' : ''}<span><span class="hot">!</span> high priority</span><span>☐ tick when done</span><span class="st">Printed ${esc(m.stamp)}</span></footer>`;
  const spec = (m.spec || []).map((b) => (b.h1 ? `<h1>${specInline(b.h1)}</h1>` : b.h2 ? `<h2>${specInline(b.h2)}</h2>` : b.note ? `<p class="note">${specInline(b.note)}</p>` : b.p ? `<p>${specInline(b.p)}</p>`
    : b.ul ? `<ul>${b.ul.map((t) => `<li>${specInline(t)}</li>`).join('')}</ul>` : b.ol ? `<ol>${b.ol.map((t) => `<li>${specInline(t)}</li>`).join('')}</ol>` : '')).join('');
  const any = m.pages.some((p) => p.sections.length);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(m.title)}</title><style>
    @page { size: A4 ${side ? 'landscape' : 'portrait'}; margin: 10mm; }
    * { box-sizing: border-box; } body { font-family: Arial, Helvetica, sans-serif; margin: 0; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .wrap { display: ${side ? 'grid' : 'block'}; gap: 6mm; } .wrap + .wrap { page-break-before: always; break-before: page; }
    .cell { ${side ? '' : 'page-break-after: always; break-after: page;'} border-top: 10px solid #7382e6; padding-top: 3mm; }
    .cell:last-child { page-break-after: auto; break-after: auto; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; border-bottom: 2px solid #111; padding-bottom: 2mm; margin-bottom: 2mm; }
    .name { font-size: ${side ? 28 : 44}px; font-weight: 900; letter-spacing: 1px; text-transform: uppercase; color: #7382e6; white-space: nowrap; }
    .nt { font-family: Arial, sans-serif; font-weight: 400; font-size: .7em; color: #444; white-space: normal; padding-top: 0 !important; line-height: 1.25; }
    .od { display: inline-block; margin-top: 1mm; font-size: ${side ? 11 : 15}px; font-weight: 800; text-transform: uppercase; background: #c62828; color: #fff; border-radius: 4px; padding: 2px 8px; letter-spacing: 1px; }
    .none { font-size: 18px; color: #555; padding: 4mm 0; }
    .method { font-size: 10px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: #555; border: 1px solid #999; border-radius: 3px; padding: 1px 6px; white-space: nowrap; align-self: flex-start; }
    table { width: 100%; border-collapse: collapse; font-size: ${side ? 12 : 17}px; }
    tbody.it { border-bottom: 1px solid #bbb; page-break-inside: avoid; break-inside: avoid; } td { padding: ${side ? '3px 3px' : '5px 6px'}; vertical-align: middle; }
    .box { width: 26px; } .box::before { content: ''; display: inline-block; width: ${side ? 14 : 20}px; height: ${side ? 14 : 20}px; border: 2px solid #111; border-radius: 3px; }
    .no { width: 28px; color: #666; text-align: right; font-weight: 700; }
    .wo { font-family: Consolas, 'Courier New', monospace; font-weight: 800; white-space: nowrap; } .wo span { font-weight: 400; color: #555; }
    .cu { font-weight: 700; white-space: nowrap; } .qty { text-align: right; font-weight: 700; white-space: nowrap; }
    .due { white-space: nowrap; text-align: right; } .tag { display: inline-block; min-width: ${side ? 44 : 76}px; text-align: center; font-weight: 800; font-size: .8em; padding: 2px 6px; border-radius: 4px; border: 2px solid #999; }
    tbody.late { background: #fde2e2; } tbody.late .tag { background: #c62828; border-color: #c62828; color: #fff; }
    tbody.today { background: #fff4d6; } tbody.today .tag { background: #f9a825; border-color: #f9a825; color: #111; }
    tbody.tomorrow .tag { border-color: #1f6feb; color: #1f6feb; } tbody.run .no { color: #111; }
    .hot { display: inline-block; background: #111; color: #fff; border-radius: 50%; width: 1.2em; height: 1.2em; line-height: 1.2em; text-align: center; font-size: .8em; }
    footer { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 4mm; font-size: 11px; color: #333; align-items: center; } footer .st { margin-left: auto; color: #777; }
    .sw { display: inline-block; width: 12px; height: 12px; border: 1px solid #999; vertical-align: middle; } .sw.late { background: #fde2e2; } .sw.today { background: #fff4d6; } .sw.tomorrow { border: 2px solid #1f6feb; }
    .empty { font-size: 24px; padding: 20mm; text-align: center; }
    .spec { page-break-before: always; break-before: page; font-size: 13px; line-height: 1.45; }
    .spec h1 { font-size: 22px; margin: 0 0 2mm; } .spec h2 { font-size: 15px; margin: 5mm 0 1mm; border-bottom: 1px solid #999; }
    .spec ol, .spec ul { margin: 1mm 0 0 5mm; padding-left: 4mm; } .spec .note { color: #555; font-size: 11px; }
    @media screen { body { background: #e8e8e8; } .wrap, .legend, .spec { background: #fff; max-width: ${side ? '297mm' : '210mm'}; margin: 10px auto; padding: 10mm; } .cell { margin-bottom: 12mm; } }
  </style></head><body>${!any ? '<div class="wrap"><p class="empty">No open work orders.</p></div>'
    : m.pages.filter((p) => p.sections.length).map((p) => `<div class="wrap" style="grid-template-columns: repeat(${p.sections.length}, 1fr)">${p.sections.map((x) => sheet(x)).join('')}</div>`).join('')}
    ${side && any ? `<div class="legend">${legend}</div>` : ''}${spec ? `<section class="spec">${spec}</section>` : ''}</body></html>`;
}
// 🧪 Testing mode: a last page explaining, in general terms, how each kind of list is put in order.
function orderSpec(p, mode, { split = false } = {}, now = new Date()) {
  const days = p.mitigation?.days ?? 5;
  const byMode = {
    fifo: [{ h2: 'FIFO — by deadline' }, { ol: ['Earliest deadline first, so overdue work orders (oldest first) are at the top.', 'Same deadline: priority High, then Normal, then Low.', 'Still the same: by work order / job number.'] }],
    bau: [{ h2: 'BAU — by due day, then priority' }, { ol: ['Earliest due **day** first.', 'Within a day: priority High, then Normal, then Low.', 'Then the earliest cut-off time, then work order / job number.'] }],
    score: [{ h2: 'Score — highest score first' }, { p: 'Each work order gets a score; the highest goes first (same score: earliest deadline first). The score adds up:' },
      { ul: ['**Deadline** — overdue work orders score highest, more the longer they\'re overdue; others score more the closer their deadline.', '**Modifier lists** (e.g. Matching, Dispatch, Manual) — extra points for particular customers, card tags or card types, e.g. work orders that need extra steps later on.', '**Shift** — extra points for particular customers during particular shifts.'] }],
    mitigation: [{ h2: 'Mitigation — as many on time as possible' }, { ol: [`**Due within the next ${days} working day${days === 1 ? '' : 's'}** and still able to make their deadline — earliest deadline first.`, '**Late anyway** — work orders that will miss their deadline whatever we do, oldest first. They come after the ones that can still be saved.', '**Due later** than that — earliest deadline first.'] }],
  };
  return [{ h1: 'How this list was ordered' }, { note: `Testing mode · printed ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` },
    { h2: 'Every list' }, { ul: ['Each cell\'s sheet lists the open work orders with cards of that type (DOD, Emboss, Laser, …), in the same order on every sheet.', 'A work order\'s deadline is its due date at the shipper\'s cut-off time.',
      '**Running** work orders come first (marked with a triangle), then any **pinned** by the planner, then the rest as below.',
      ...(split ? ['Overdue work orders (past their deadline and not running) are taken off each cell\'s list and put on a separate **Overdue** sheet for that cell, in the same order.'] : [])] },
    ...(byMode[mode] || []),
    { h2: 'The sheet' }, { ul: ['Colours: **red** = past its deadline when printed (LATE); **amber** = due today; **blue** = due tomorrow; otherwise the date is shown.', '**!** = High / Urgent priority; **PIN** = pinned; the number is the place in the order.'] }];
}
// Matching, in the order the work moves: Incoming (its perso work order still open), Ready (perso done,
// not started at Matching), In Progress (started at Matching) — each in the Matching list's order (plan date, then Urgent / High first).
// 💳 Cards and ✉️ carriers of a Matching job. The cards from its perso work order (done when none is
// open; in progress when one is being made); the carriers from the CPS status in the Matching export:
//   Waiting — both not ready, or both in progress · Waiting carrier — cards ready or in progress, carriers not
//   Waiting cards — carriers ready or in progress, cards not · Ready — both ready
// { cards: 'ready' | 'in progress' | 'not started', carriers: 'ready' | 'in progress' | 'not ready' | 'ready or in progress' | null }
function ottoReadiness(o) {
  const cards = !o.perso_open ? 'ready' : (o.perso || []).some((p) => /progress|running|started/i.test(p.status || '')) ? 'in progress' : 'not started';
  const st = String(o.status || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const carriers = /^waiting (for )?carriers?$/.test(st) ? 'not ready' : /^waiting (for )?cards?$/.test(st) ? 'ready or in progress'
    : st === 'waiting' ? (cards === 'in progress' ? 'in progress' : 'not ready') : st === 'ready' ? 'ready' : null;
  return { cards, carriers };
}
// The Incoming note: where the cards and carriers are, and when perso expects the cards to be ready.
function ottoIncomingNote(o) {
  const r = ottoReadiness(o);
  const when = r.cards !== 'ready' && o.perso_finish_at ? ` (ready ~ ${PLF.wkHm.format(new Date(o.perso_finish_at))})` : '';
  const cards = r.cards === 'not started' ? `cards not started — ${o.perso.length} perso job${o.perso.length === 1 ? '' : 's'} open` : `cards ${r.cards}`;
  return `${cards[0].toUpperCase()}${cards.slice(1)}${when}${r.carriers ? ` · carriers ${r.carriers}` : ''}`;
}

function ottoGroups(ot) {
  const row = (o, extra = {}) => ({ job: { ...o, is_otto: true, running: false, pinned: false, ...extra }, qty: o.qty });
  const all = [...ot.running, ...ot.queue];
  return [
    { type: 'Incoming', rows: ot.queue.filter((o) => o.perso_open).map((o) => ({ ...row(o), note: ottoIncomingNote(o) })) },
    { type: 'Ready', rows: ot.queue.filter((o) => !o.perso_open).map((o) => row(o)) },
    { type: 'In Progress', noOverdue: true, rows: all.filter((o) => o.running).map((o) => row(o, { keep: true })) },
  ];
}
function ottoSpec({ split = false } = {}, now = new Date()) {
  return [{ h1: 'How this list was ordered' }, { note: `Testing mode · printed ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` },
    { h2: 'The three lists' }, { ul: ['**Incoming** — Matching jobs whose perso work order is still being made. They can\'t start yet; the note says where the **cards** are (not started / in progress, and when perso expects them ready) and the **carriers** (from the CPS status: Waiting carrier → not ready, Waiting cards → ready or in progress, Waiting → as the cards).', '**Ready** — Matching jobs whose perso work is finished and that haven\'t been started yet: these can be picked up now.',
      '**In Progress** — Matching jobs already started.', ...(split ? ['Overdue Incoming and Ready jobs (past their plan date) are put on a separate **Overdue** sheet for that list.'] : [])] },
    { h2: 'Order — in every list' }, { ol: ['Earliest plan date and time first.', 'Same time: Urgent, then High, then the rest.', 'Still the same: by name.'] },
    { h2: 'The sheet' }, { ul: ['Colours: **red** = past its plan date when printed (LATE); **amber** = due today; **blue** = due tomorrow; otherwise the date is shown.', '**!** = Urgent / High priority; the number is the place in the list.'] }];
}
// 📄 Generate plan — Perso (a sheet per cell) or Matching (Incoming / Ready / In Progress): as a PDF to
// print, or as a web page.
const SIDE_ROWS = 20; // rows per sheet side by side that keep it to one page
function printDialog(p, mode, settings = {}, half = 'perso') {
  const otto = half === 'otto';
  const jobs = otto ? [] : [...p.running, ...p.queue];
  const groups = otto ? ottoGroups(p.otto || { running: [], queue: [] }) : cellsOf(jobs);
  const key = otto ? 'planPrintOtto' : 'planPrint';
  const saved = store.get(key, {}) || {};
  const word = otto ? 'list' : 'cell';
  const modeText = otto ? 'plan date, then Urgent / High first' : ({ fifo: 'FIFO, by deadline', bau: 'BAU', score: 'Score', mitigation: 'Mitigation: what can still be on time first' }[mode] || '');
  const limit = Number(saved.limit) || 0;
  openModal(`<div class="modal-head"><h2 style="margin:0">📄 Generate plan${otto ? ' — Matching' : ''}</h2><button class="icon" data-action="close-modal">✕</button></div>
    <form id="pl-print" class="form-grid">
      <div class="f full"><span>${otto ? 'Lists' : 'Cells'}</span><div class="row">${groups.map((c) => `<label class="row small"><input type="checkbox" name="cell" value="${esc(c.type)}" ${!saved.cells || saved.cells.includes(c.type) ? 'checked' : ''}> <b>${esc(c.type)}</b> <span class="muted">${c.rows.length}</span></label>`).join('') || '<span class="muted">Nothing open.</span>'}</div></div>
      <label class="f">Layout<select name="layout"><option value="pages" ${saved.layout !== 'side' ? 'selected' : ''}>A page per ${word} (portrait)</option><option value="side" ${saved.layout === 'side' ? 'selected' : ''}>Side by side (landscape)</option></select></label>
      <div class="f"><span>Rows per ${word}</span><div class="row small">
        <label class="row"><input type="radio" name="limitMode" value="all" ${limit ? '' : 'checked'}> All</label>
        <label class="row"><input type="radio" name="limitMode" value="n" ${limit ? 'checked' : ''}> First <input type="number" name="limitN" min="1" step="1" value="${limit || SIDE_ROWS}" style="width:70px"></label></div></div>
      <p class="small muted full" id="pl-side-note" ${saved.layout === 'side' ? '' : 'hidden'}>Side by side: ${SIDE_ROWS} rows per ${word} fits every ${word} on one page${otto ? '' : ' (with overdue on a separate list, a second page for those)'}.</p>
      <label class="row small full"><input type="checkbox" name="split" ${saved.split ? 'checked' : ''}> <b>Overdue on a separate list</b> — ${otto ? 'overdue Incoming and Ready jobs' : 'each cell\'s overdue work orders'} on a sheet of their own</label>
      <label class="row small full"><input type="checkbox" name="testing" ${saved.testing ? 'checked' : ''}> 🧪 <b>Testing mode</b> — a last page explaining how the list was ordered (and TEST on each sheet)</label>
      <label class="f">Output<select name="output"><option value="pdf" ${saved.output !== 'html' ? 'selected' : ''}>PDF — open, save or print</option><option value="html" ${saved.output === 'html' ? 'selected' : ''}>Web page — print from the browser</option></select></label>
      <p class="small muted full">In the planning list's order (${esc(modeText)})${otto ? '' : ', running first. Each cell gets the work orders with cards of its type, and that type\'s cards'}.</p>
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">📄 Generate</button></div>
    </form>`);
  const form = $('#pl-print');
  // side by side: the first 20 rows (one page), with a note why
  form.layout.addEventListener('change', () => {
    const sideOn = form.layout.value === 'side';
    $('#pl-side-note').hidden = !sideOn;
    if (sideOn) { form.querySelector('[name=limitMode][value=n]').checked = true; form.limitN.value = SIDE_ROWS; }
  });
  form.limitN.addEventListener('focus', () => { form.querySelector('[name=limitMode][value=n]').checked = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const n = Math.max(1, Math.round(Number(fd.get('limitN')) || SIDE_ROWS));
    const opts = { cells: fd.getAll('cell'), layout: fd.get('layout'), limit: fd.get('limitMode') === 'n' ? n : 0, testing: fd.get('testing') === 'on', split: fd.get('split') === 'on', output: fd.get('output') };
    store.set(key, opts);
    const model = planSheetModel(jobs, { cells: opts.cells, layout: opts.layout, limit: opts.limit, splitOverdue: opts.split, groups: otto ? groups : null, test: opts.testing,
      method: otto ? 'Matching' : ({ fifo: 'FIFO', bau: 'BAU', score: 'Score', mitigation: 'Mitigation' }[mode] || ''),
      spec: opts.testing ? (otto ? ottoSpec({ split: opts.split }) : orderSpec(p, mode, { split: opts.split })) : null,
      title: otto ? 'Matching plan' : 'Production plan', fileLabel: otto ? 'Matching plan' : 'Production plan' });
    // the window opens now (a click), the PDF follows when it's ready
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups for CI Manager to open the plan', 'error'); return; }
    closeModal();
    if (opts.output === 'html') { w.document.open(); w.document.write(planSheetHtml(model)); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); return; }
    w.document.write('<p style="font:16px Arial,sans-serif;margin:40px">Making the plan…</p>');
    try { const r = await api.post('/plan/sheet', model); w.location.href = r.url; } catch (err) { w.close(); toast(err.message, 'error'); }
  });
}

// 95 → "1 h 35 min", 2000 → "1 d 9 h"
// The 🔬 mark's explanation on a card line timed from history.
function learnedTitle(a) {
  const from = a.speed_from === 'learned:card' ? `${a.learned.runs} run${a.learned.runs === 1 ? '' : 's'} of this card${a.learned.runs < 10 ? ', leaning on its kind of card' : ''}`
    : a.speed_from === 'learned:kind' ? `${a.learned.runs} runs of this kind of card (none of this card yet)` : `all runs (no history for this card or its kind yet)`;
  return `Learned from ${from}: ${a.speed}/h once running, plus ${a.learned.setup} min set-up`;
}
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
let plLastTab = null; // the tab and view drawn last (a redraw of the same one keeps its scroll)
const plDelaySel = new Set(); const plDelayOpen = new Set(); // ⏱ Delays: groups selected / opened (customer|due)
let plDelayText = () => '';
const plDelayClosed = new Set(); // ⏱ Delays: customers folded away
let plDelayFlash = null; // the row just saved (g:customer|due or j:key), highlighted once
let plDelayCusts = []; // the customers with delayed work orders: [{ code, name, wos }]
function drawPlanGantt(el, info, p, match, half = 'perso') {
  const otto = half === 'otto'; const G = otto ? p.otto : p; const unit = otto ? 'items' : 'cards';
  const label = (j) => (otto ? j.name : `${j.wo} / ${j.per}`);
  const span = Number(store.get('planSpan', 3)) || 3;
  const from = new Date(p.now); const to = new Date(from.getTime() + span * 86400000);
  const LBL = 96; const W = Math.max(400, el.clientWidth - LBL - 4); const ROW = 34;
  const x = (t) => LBL + ((new Date(t) - from) / (to - from)) * W;
  const machines = (G.machines || []).filter((m) => m.active);
  const jobs = [...G.running, ...G.queue];
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  // bars: a job's lines on one machine, merged where they follow on
  const bars = [];
  for (const j of jobs) {
    const slots = otto ? (j.start_at && j.machine_planned ? [{ m: j.machine_planned, s: new Date(j.start_at), f: new Date(j.finish_at) }] : []) : j.articles.filter((a) => a.machine && a.start_at).map((a) => ({ m: a.machine, s: new Date(a.start_at), f: new Date(a.finish_at) }))
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
  const rows = machines.map((m, i) => `<div class="pg-row" style="top:${22 + i * ROW}px;width:${LBL + W}px;height:${ROW}px"><div class="pg-name" style="width:${LBL - 8}px" title="${esc(m.types || m.match || 'any type')}">${esc(m.name)}<div class="small muted">${esc(m.types || m.match || 'any')}</div></div></div>`).join('');
  const sel = planSel && byKey.get(planSel);
  const barHtml = bars.filter((b) => b.f > from && b.s < to).map((b) => {
    const j = byKey.get(b.key); const i = machines.findIndex((m) => m.name === b.m); if (i < 0) return '';
    const l = Math.max(LBL, x(b.s)); const r = Math.min(LBL + W, x(b.f)); const w = Math.max(2, r - l);
    const dim = (sel && sel.key !== j.key) || (match && !match(j));
    return `<div class="pg-bar pg-${state(j)} ${j.running ? 'pg-run' : ''} ${String(j.prio).toLowerCase() === 'high' ? 'pg-high' : ''} ${dim ? 'pg-dim' : ''} ${sel && sel.key === j.key ? 'pg-sel' : ''}" data-pg-job="${esc(j.key)}"
      style="left:${l}px;width:${w}px;top:${22 + i * ROW + 5}px;height:${ROW - 10}px" title="${esc(`${label(j)} · ${j.customer || ''} · ${PLF.num.format(j.qty)} ${unit}\n${b.m}: ${b.s.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} – ${b.f.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}\nDeadline ${j.deadline?.replace('T', ' ')}${j.late_minutes > 0 ? ` — ${fmtSpan(j.late_minutes)} late` : ''}`)}">${w > 70 ? `<span>${j.pinned ? '📌' : ''}${esc(j.customer || '')} ${esc(j.wo.slice(-6))}</span>` : ''}</div>`;
  }).join('');
  const dl = sel?.deadline ? (() => { const [d, t] = sel.deadline.split('T'); const [y, mo, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return new Date(y, mo - 1, dd, hh, mm); })() : null;
  const dlHtml = dl && dl > from && dl < to ? `<div class="pg-deadline" style="left:${x(dl)}px;height:${H}px"><span>due ${esc(sel.deadline.slice(11))}</span></div>` : '';
  el.style.height = `${H + 6}px`;
  el.innerHTML = `<div class="pg" style="width:${LBL + W}px;height:${H}px">${rows}${shade}${ticks}<div class="pg-now" style="left:${x(from)}px;height:${H}px"><span>now</span></div>${barHtml}${dlHtml}</div>`;
  const unplanned = jobs.filter((j) => j.unplanned).length;
  info.innerHTML = sel ? `<b>${esc(label(sel))}</b> · ${esc(sel.customer || '')} · ${sel.qty.toLocaleString('en-GB')} ${unit} · ${esc(sel.prio || '')} · ${esc(sel.shipper || sel.machine_planned || '')}
      · due <b>${esc(sel.deadline?.replace('T', ' ') || '—')}</b> · finishes ${sel.finish_at ? esc(PLF.wkHm.format(new Date(sel.finish_at))) : '—'}
      ${sel.late_minutes > 0 ? `<span class="pl-late">· ${fmtSpan(sel.late_minutes)} late</span>` : ''}${dl && (dl <= from || dl >= to) ? ` <span class="muted">(deadline outside this view)</span>` : ''} <button class="link small" data-pg-clear>✕</button>`
    : `<span class="muted">${bars.length ? 'Click a bar to pick a job.' : 'Nothing planned.'}${unplanned ? ` ⚠ ${unplanned} job${unplanned === 1 ? '' : 's'} can't be planned — see the list.` : ''}</span>`;
  el.onclick = (e) => { const b = e.target.closest('[data-pg-job]'); planSel = b ? b.dataset.pgJob : null; drawPlanGantt(el, info, p, match, half); };
  info.onclick = (e) => { if (e.target.closest('[data-pg-clear]')) { planSel = null; drawPlanGantt(el, info, p, match, half); } };
}
