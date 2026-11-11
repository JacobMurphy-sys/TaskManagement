'use strict';
// 🔎 Production › Insights › Optimisation (src/optimise.js): a customer's separate work orders that could be one —
// the same card (or kind of card, so the same personalisation method), shipper, shipping time and due-out day —
// in the open work orders now or the history of the past weeks. What must match is chosen on the page.

const optState = () => ({ source: 'open', days: 28, card: 'tech', shipper: true, time: true, due: 'day', prio: true, max: 2500, ...(store.get('optState', {}) || {}) });

async function renderPlanOptimise() {
  const st = optState();
  const q = new URLSearchParams({ source: st.source, days: st.days, card: st.card, shipper: st.shipper ? 1 : 0, time: st.time ? 1 : 0, due: st.due, prio: st.prio ? 1 : 0, max: st.max || 2500 });
  main().innerHTML = `${plInsightsHead('optimise')}<div class="pll-view"><p class="muted">Looking…</p></div>`;
  let d;
  try { d = await api.get(`/plan/optimise?${q}`); } catch (err) { $('.pll-view').innerHTML = `<div class="card">${esc(err.message)}</div>`; return; }
  const n = (v) => Number(v || 0).toLocaleString('en-GB');
  const pc = (v) => `${Math.round((v || 0) * 1000) / 10}%`;
  const T = d.total;
  const tile = (l, v, s = '') => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${v}</div>${s ? `<div class="kdb-tile-s">${s}</div>` : ''}</div>`;
  const seg = (name, val, opts) => `<div class="seg">${opts.map(([v, l, t]) => `<button type="button" data-opt="${name}" data-v="${v}" class="${String(val) === String(v) ? 'on' : ''}"${t ? ` title="${esc(t)}"` : ''}>${l}</button>`).join('')}</div>`;
  const tick = (name, val, label, t) => `<label class="opt-tick" title="${esc(t)}"><input type="checkbox" data-opt-tick="${name}" ${val ? 'checked' : ''}> ${label}</label>`;
  const where = d.source === 'history' ? `work orders due ${esc(fmtShortDate(d.from))} – ${esc(fmtShortDate(d.to))}` : 'the open work orders now';
  const note = d.source === 'open' && d.status !== 'ok' ? `<div class="kpi-action notice"><span>⚠ The open work orders export couldn't be read${d.error ? `: ${esc(d.error)}` : ''}. Set it in ⚙ Setup.</span></div>` : '';
  const cardsNote = d.cards_db !== 'ok' ? '<div class="kpi-action notice"><span>⚠ The card database isn\'t linked (⚙ Setup), so a card\'s technology isn\'t known: cards are matched on their Card AX only.</span></div>' : '';
  const method = (g) => (st.card === 'tech' ? g.method || '' : [g.method, g.card?.material, g.card?.sides].filter(Boolean).join(' · '));
  const timeOf = (t) => t || '<span class="muted">no time</span>';
  const custRows = d.customers.filter((c) => c.saving).map((c) => `<tr><td><b>${esc(c.customer)}</b>${c.name ? ` <span class="small muted">${esc(c.name)}</span>` : ''}</td>
    <td class="num">${n(c.wos)}</td><td class="num">${n(c.in_sets)}</td><td class="num">${n(c.sets)}</td><td class="num"><b>${n(c.could_be)}</b></td><td class="num"><b>${n(c.saving)}</b></td>
    <td><div class="pllx-share"><div class="pll-track"><div style="width:${Math.min(100, c.share * 100)}%"></div></div><span>${pc(c.share)}</span></div></td></tr>`).join('');
  const groupRows = d.groups.map((g, i) => `<tr class="opt-g" data-opt-more="${i}"><td><button type="button" class="icon small opt-more" aria-expanded="false" title="Its work orders">▸</button></td>
      <td><b>${esc(g.customer)}</b>${g.name ? `<div class="small muted">${esc(g.name)}</div>` : ''}</td>
      <td>${g.cards_n > 1 ? `<b>${g.cards_n} cards</b><div class="small muted" title="${esc(g.article)}">${esc(g.article.length > 40 ? `${g.article.slice(0, 40)}…` : g.article)}</div>` : `<b>${esc(g.article)}</b>${g.card?.name ? `<div class="small muted">${esc(g.card.name)}</div>` : ''}`}</td><td class="small">${esc(method(g)) || '<span class="muted">—</span>'}</td>
      <td class="small">${esc(g.shipper || '—')}<div>${timeOf(g.time)}</div></td>
      <td class="small nowrap">${esc(fmtShortDate(g.from))}${g.to !== g.from ? ` – ${esc(fmtShortDate(g.to))}` : ''}${g.renewal === null ? '' : `<div><span class="chip${g.renewal ? ' ops-renewal' : ''}">${g.renewal ? 'Renewal' : 'Daily'}</span></div>`}</td>
      <td class="num nowrap"><b>${n(g.wos)} → ${n(g.could_be)}</b><div class="small muted">work orders</div></td><td class="num">${n(g.cards)}</td></tr>
    <tr class="opt-lines" id="opt-l-${i}" hidden><td></td><td colspan="7">
      <div class="opt-merges">${g.merges.map((b, k) => `<div><b>Merged work order ${k + 1}</b>: ${b.wos.map((w) => esc(w)).join(' + ')} <span class="muted">· ${n(b.cards)} cards</span></div>`).join('')}
        ${g.unchanged.length ? `<div class="muted">Stay as they are (no room to add them without going over ${n(d.options.max)} cards): ${g.unchanged.map((w) => esc(w)).join(', ')}</div>` : ''}</div>
      <table class="log small"><thead><tr><th>Work order</th><th>PER</th><th>Card</th><th class="num">Cards</th><th>Due out</th><th>Shipping</th><th>Priority</th></tr></thead><tbody>
      ${g.lines.map((l) => `<tr><td><b>${esc(l.wo)}</b>${l.done ? ' <span class="muted small">done</span>' : ''}</td><td>${esc(l.per)}</td><td>${esc(l.article)}</td><td class="num">${n(l.qty)}</td><td class="nowrap">${esc(fmtShortDate(l.due))}</td><td class="small">${esc(l.shipper || '—')} ${l.time ? esc(l.time) : ''}</td><td class="small">${esc(l.prio || '')}</td></tr>`).join('')}</tbody></table></td></tr>`).join('');
  $('.pll-view').innerHTML = `
    <div class="card opt-card">
      <div class="row" style="gap:8px 14px;flex-wrap:wrap;align-items:center">
        <h3 class="pl-h" style="margin:0">🔎 Work orders that could be merged</h3>
        ${seg('source', d.source === 'history' ? `h${st.days}` : 'open', [['open', 'Open now', 'The open work orders export, as it is now'], ['h28', 'Last 4 weeks', 'Work orders due in the last 4 weeks (the planner\'s history)'], ['h90', 'Last 90 days']])}
      </div>
      <p class="small muted" style="margin:6px 0 10px">For each customer, separate work orders in ${where} whose cards are made with the same production technology (or, stricter, the same kind of card or the same card), so could be merged into fewer work orders, none over the maximum cards a work order. Fewer work orders: fewer set-ups, change-overs, paperwork and despatches. Choose what has to match:</p>
      <div class="opt-match">
        <span class="small muted">Card</span>${seg('card', st.card, [['tech', 'The same technology', 'DOD, Emboss or Laser (the card database\'s type): any cards made on the same kind of machine'], ['kind', 'The same kind of card', 'Stricter: the same type, material and print sides'], ['ax', 'The same card', 'Strictest: the same Card AX']])}
        <span class="small muted">Due out</span>${seg('due', st.due, [['day', 'Same day'], ['w1', 'Within 1 day'], ['w2', 'Within 2 days'], ['w5', 'Within 5 days'], ['any', 'Any day']])}
        ${tick('shipper', st.shipper, 'Same shipper', 'Only work orders going with the same shipper')}${tick('time', st.time, 'Same shipping time', 'Only work orders with the same shipping time (cut-off)')}${tick('prio', st.prio, 'Dailies and renewals apart', 'A renewal (Low priority) isn\'t put with a daily')}
        <label class="opt-tick" title="A merged work order is never bigger than this">Max cards a work order <input type="number" min="50" step="50" data-opt-max value="${esc(st.max || 2500)}" style="width:80px"></label>
      </div>
    </div>
    ${note}${cardsNote}
    <div class="kdb-tiles">${tile('Work orders looked at', n(T.wos), `${n(T.customers)} customers`)}${tile('Merge suggestions', n(T.sets), `${n(T.in_sets)} work orders could merge`)}
      ${tile('Fewer work orders', n(T.saving), `${pc(T.share)} of them`)}${T.no_card && d.cards_db === 'ok' ? tile('Cards not in the card database', n(T.no_card), 'matched on Card AX only') : ''}</div>
    ${T.sets ? `<div class="card"><h3 class="pl-h">Customers <span class="muted small">— where work orders could be merged, most saved first</span></h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer</th><th class="num">Work orders</th><th class="num" title="Work orders that one of the merge suggestions takes in">Can merge</th><th class="num">Suggestions</th><th class="num">After merging</th><th class="num">Fewer</th><th>Of their work orders</th></tr></thead><tbody>${custRows}</tbody></table></div></div>
    <div class="card"><h3 class="pl-h">Merge suggestions <span class="muted small">— ${n(d.groups.length)}${T.sets > d.groups.length ? ` of ${n(T.sets)}` : ''}, the most saved first · ▸ for which work orders to merge · a work order with cards of two technologies can be in two suggestions</span></h3>
      <div class="kdb-scroll"><table class="log pll-t opt-t"><thead><tr><th></th><th>Customer</th><th>Cards</th><th>Technology</th><th>Shipping</th><th>Due out</th><th class="num">Merge</th><th class="num">Cards</th></tr></thead><tbody>${groupRows}</tbody></table></div></div>`
    : `<div class="card"><div class="empty">Nothing found in ${where}: no customer has separate work orders that match on everything chosen above and fit together under the maximum. Loosen the match (e.g. "Within 2 days", or untick the shipping time) to look wider.</div></div>`}`;
  main().onclick = (e) => {
    if (plInsightsClick(e)) return;
    const b = e.target.closest('[data-opt]');
    if (b) {
      const s = optState(); const k = b.dataset.opt; const v = b.dataset.v;
      if (k === 'source') { if (v === 'open') s.source = 'open'; else { s.source = 'history'; s.days = Number(v.slice(1)); } } else s[k] = v;
      store.set('optState', s); renderPlanOptimise(); return;
    }
    const row = e.target.closest('[data-opt-more]');
    if (row && !e.target.closest('a, input')) {
      const l = document.getElementById(`opt-l-${row.dataset.optMore}`); if (!l) return;
      l.hidden = !l.hidden; const btn = row.querySelector('.opt-more'); btn.textContent = l.hidden ? '▸' : '▾'; btn.setAttribute('aria-expanded', String(!l.hidden));
    }
  };
  main().onchange = (e) => {
    const mx = e.target.closest('[data-opt-max]');
    if (mx) { const v = Math.round(Number(mx.value)); if (v >= 50) { const s = optState(); s.max = v; store.set('optState', s); renderPlanOptimise(); } return; }
    const t = e.target.closest('[data-opt-tick]'); if (!t) return;
    const s = optState(); s[t.dataset.optTick] = t.checked; store.set('optState', s); renderPlanOptimise();
  };
}
