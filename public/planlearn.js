// 🧠 Planning › Learned: what the production runs say about the planning setup (src/planlearn.js),
// with the speeds and OEE ready to apply. Rendered by renderPlanning() when the view is 'learn'.
const PLL = {
  days: [[30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']],
  conf: { high: ['●●●', 'High: 30+ runs over 5+ days'], medium: ['●●○', 'Medium: 10+ runs over 2+ days'], low: ['●○○', 'Low: fewer runs — worth watching, not applying yet'] },
  icon: { deploy: '🛠', pattern: '🔍', trend: '📈', quality: '⚠' },
};
// ⤢ on a table: opens it up in the 🔎 Explode window (pllExplode), grouped by `by`
const pllX = (by, opts = {}) => `<button type="button" class="icon pll-x" title="Explode: open this up with any dates, % of total and drill-down" data-pll-explode="${esc(JSON.stringify({ by, ...opts }))}">⤢</button>`;
const pllN = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: d }));
const pllKind = (s) => [s.type, s.material, s.sides].filter(Boolean).map(esc).join(' · ') || '<span class="muted">any card</span>';
const pllConf = (c) => `<span class="pll-conf pll-${c}" title="${esc(PLL.conf[c][1])}">${PLL.conf[c][0]}</span>`;
const pllChange = (x) => (x === null || x === undefined ? '' : `<span class="${Math.abs(x) < 5 ? 'muted' : x > 0 ? 'pl-ok' : 'pl-late'}">${x > 0 ? '+' : ''}${pllN(x)}%</span>`);
// a pace as a bar around 100% (the usual for the cards)
function pllPace(p, scale = 130) {
  if (p === null || p === undefined) return '—';
  return `<div class="pll-pace" title="${pllN(p, 1)}% of the usual pace for these cards"><div class="pll-pace-bar ${p >= 95 ? 'ok' : p >= 80 ? 'mid' : 'low'}" style="width:${Math.min(100, (p / scale) * 100)}%"></div><span>${pllN(p)}%</span></div>`;
}
function pllPatternTable(title, rows, { label = '', names = false, note = '', by = null } = {}) {
  if (!rows?.length) return '';
  return `<div class="card"><h3 class="pl-h">${title}${by ? pllX(by) : ''}</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>${label}</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Hours</th><th class="num">Cards/h</th><th>Pace</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td><b>${esc(r.label)}</b>${names && r.name ? ` <span class="small muted">${esc(r.name)}</span>` : ''}</td><td class="num">${pllN(r.runs)}</td><td class="num">${pllN(r.cards)}</td>
      <td class="num">${pllN(r.hours)}</td><td class="num">${pllN(r.per_hour)}</td><td>${pllPace(r.pace)}</td></tr>`).join('')}
  </tbody></table></div>${note ? `<p class="small muted">${note}</p>` : ''}</div>`;
}

function planLearnHtml(L) {
  const days = L.days;
  const pick = `<div class="seg">${PLL.days.map(([d, l]) => `<button type="button" data-pll-days="${d}" class="${d === days ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  if (!L.runs.used) {
    return `<div class="row pl-views">${pick}</div><div class="card lib-empty"><h2>🧠 Nothing to learn from yet</h2>
      <p>This learns from the runs in the ⏱ Production timing reports (KPIs › ⏱ Production): link the perso report there, and the planning setup is compared with what really ran.
      ${L.runs.total ? `There ${L.runs.total === 1 ? 'is 1 run' : `are ${pllN(L.runs.total)} runs`} in this window, all set aside as anomalies.` : 'There are no runs in this window — try a longer one.'}</p></div>`;
  }
  const A = L.accuracy;
  const accTile = (a, label, sub) => `<div class="kdb-tile"><div class="kdb-tile-l">${label}</div><div class="kdb-tile-v ${a ? (a.within >= 70 ? 'kdb-ok' : a.within >= 50 ? 'kdb-warn' : 'kdb-bad') : ''}">${a ? `${pllN(a.within)}%` : '—'}</div>
    <div class="kdb-tile-s">${a ? `${sub} · typical miss ${pllN(a.typical_miss)}%` : 'no speeds set'}</div></div>`;
  const toApply = L.speeds.filter((s) => s.suggest && s.confidence !== 'low');
  const oeeApply = L.oee.filter((o) => o.suggest && o.confidence !== 'low');
  const mApply = L.matching.customers.filter((c) => c.suggest && c.confidence !== 'low');
  const P = L.patterns;
  const maxWeek = Math.max(1, ...P.week.map((w) => w.per_hour || 0));
  const wk = (d) => { const dt = new Date(`${d}T12:00`); return `${dt.getDate()}/${dt.getMonth() + 1}`; };
  return `<div class="row pl-views">${pick}<span class="small muted">${pllN(L.runs.used)} runs · ${pllN(L.runs.cards)} cards over ${pllN(L.runs.days)} days${L.runs.anomalies ? ` · ${pllN(L.runs.anomalies)} anomalies left out` : ''}${L.cards_status === 'ok' ? '' : ' · no card database: kinds come from the report\'s product type'}</span>
      <span class="spacer"></span><button type="button" data-pll-explode='{"by":"customer"}' title="Any dates, grouped by anything, % of total and drill-down">🔎 Explode</button><button type="button" data-pll="xlsx">⬇ Excel</button></div>
    <div class="kdb-tiles">
      ${accTile(A.now, 'Planned within 25% — now', 'the setup as it is')}
      ${accTile(A.learned, 'With learned speeds + OEE', A.tested_on === 'newest' ? `learned on older runs, tested on the newest ${pllN(A.runs)}` : 'all runs')}
      ${accTile(A.items, `🧠 Card by card${L.learned_on ? ' — in use' : ''}`, 'each card\'s own time + set-up')}
      <div class="kdb-tile"><div class="kdb-tile-l">Runs vs plan</div><div class="kdb-tile-v ${A.now && Math.abs(A.now.bias) >= 15 ? 'kdb-bad' : ''}">${A.now?.bias === null || !A.now ? '—' : `${A.now.bias > 0 ? '+' : ''}${pllN(A.now.bias)}%`}</div><div class="kdb-tile-s">typical run, against its planned time</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Set-up a run</div><div class="kdb-tile-v">${L.setup.all === null ? '—' : `${pllN(L.setup.all)} min`}</div><div class="kdb-tile-s">before cards flow, usual</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Remakes</div><div class="kdb-tile-v">${L.runs.cards ? `${pllN((L.runs.remade / L.runs.cards) * 100, 1)}%` : '—'}</div><div class="kdb-tile-s">${pllN(L.runs.remade)} cards</div></div>
    </div>
    <div class="kc-note pll-switch">${L.learned_on ? `🧠 Planning is timing each card line from its card's own runs. <button type="button" class="small" data-pll="learned-off">Go back to the speeds and OEE</button>`
      : `🧠 <b>Card by card</b>: time each card line in a work order from that card's own runs (and its kind's, while it has few), plus the set-up — so a work order is timed by what's actually in it.${A.items && A.learned && A.items.within > A.learned.within ? ` It has been the closest of the three (${pllN(A.items.within)}% within 25%).` : ''} <button type="button" class="primary small" data-pll="learned-on">Use it in the plan</button>`}</div>
    ${L.findings.length ? `<div class="card"><h3 class="pl-h">What stands out</h3><ul class="pll-find">${L.findings.map((f) => `<li class="pll-${f.kind}"><span>${PLL.icon[f.kind] || '•'}</span> ${esc(f.text)}</li>`).join('')}</ul></div>` : ''}

    <div class="card"><h3 class="pl-h">Speeds by kind of card <span class="muted small">— running speed once a run is going (its machine's usual set-up taken off), the middle of its runs weighted by cards</span>${pllX('kind')}</h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Kind of card</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Learned</th><th class="num" title="Half the runs fall in this range">Usual range</th><th class="num">Planned now</th><th class="num">Change</th><th>Confidence</th><th></th></tr></thead><tbody>
      ${L.speeds.map((s) => `<tr><td>${pllKind(s)}</td><td class="num">${pllN(s.runs)}</td><td class="num">${pllN(s.cards)}</td><td class="num"><b>${pllN(s.speed)}/h</b></td>
        <td class="num small muted">${pllN(s.p25)}–${pllN(s.p75)}</td><td class="num">${s.current ? `${pllN(s.current)}/h` : '—'}${s.current_from && s.current_from !== 'rule' ? `<div class="small muted">${esc(s.current_from)}</div>` : ''}</td>
        <td class="num">${pllChange(s.change)}</td><td>${pllConf(s.confidence)}</td>
        <td>${s.suggest ? `<button type="button" class="small" data-pll-speed="${esc(JSON.stringify({ type: s.type, material: s.material, sides: s.sides, speed: s.speed }))}">Apply ${pllN(s.speed)}/h</button>` : '<span class="small pl-ok">✔ as planned</span>'}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No kind of card has 5 runs yet.</td></tr>'}
      </tbody></table></div>
      <div class="row" style="margin-top:6px">${toApply.length ? `<button type="button" class="primary" data-pll="speeds">Apply the ${toApply.length} confident speed${toApply.length === 1 ? '' : 's'}</button>` : ''}
        <span class="small muted">Applying adds (or updates) the speed rule for exactly that kind of card in ⚙ Setup › Speeds. Low-confidence rows are left for you to judge.</span></div></div>

    <div class="card"><h3 class="pl-h">Estimated OEE by customer <span class="muted small">— the time each customer's runs would take at the speeds planned now ÷ the time they took</span>${pllX('customer')}</h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Measured</th><th class="num">Planned now</th><th>Confidence</th><th></th></tr></thead><tbody>
      ${L.oee.map((o) => `<tr><td><b>${esc(o.customer)}</b> ${o.name ? `<span class="small muted">${esc(o.name)}</span>` : ''}</td><td class="num">${pllN(o.runs)}</td><td class="num">${pllN(o.cards)}</td>
        <td class="num"><b>${pllN(o.oee, 1)}%</b>${o.over ? '<div class="small muted">quicker than the speeds — they may be set low</div>' : ''}</td>
        <td class="num">${o.current === null ? '—' : `${pllN(o.current)}%`}${o.current_from === 'default' ? '<div class="small muted">default</div>' : ''}</td><td>${pllConf(o.confidence)}</td>
        <td>${o.suggest ? `<button type="button" class="small" data-pll-oee="${esc(o.customer)}" data-pct="${o.suggested}">Apply ${o.suggested}%</button>` : '<span class="small pl-ok">✔ as planned</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No customer has 5 runs with a speed set yet.</td></tr>'}
      </tbody></table></div>
      <div class="row" style="margin-top:6px">${oeeApply.length ? `<button type="button" class="primary" data-pll="oees">Apply the ${oeeApply.length} confident OEE figure${oeeApply.length === 1 ? '' : 's'}</button>` : ''}
        <span class="small muted">${toApply.length ? '⚠ Apply the speeds first: OEE is measured against the speeds as they are now, and these figures change once the speeds do.' : 'The OEE takes in each customer\'s set-ups, stops and slower cards, so planned times match what runs.'}</span></div></div>

    <div class="grid two pll-grid">
      ${pllPatternTable('By shift', P.shift, { label: 'Shift', by: 'shift', note: 'Shifts from the shift start times in ⚙ Setup › Modifiers. Pace: the time the cards would take at their kind\'s learned speed ÷ the time they took.' })}
      ${pllPatternTable('By job size', P.size, { label: 'Cards in the run', by: 'size', note: `Small runs carry the set-up${L.setup.all ? ` (about ${pllN(L.setup.all)} min)` : ''} on few cards.` })}
      ${pllPatternTable('By machine', P.machine, { label: 'Machine', by: 'machine', note: L.setup.machines.length ? `Usual set-up: ${L.setup.machines.map((m) => `${esc(m.machine)} ${pllN(m.setup)} min`).join(' · ')}` : '' })}
      ${pllPatternTable('By weekday', P.weekday, { label: 'Day', by: 'weekday' })}
    </div>
    ${pllPatternTable('By customer', P.customer, { label: 'Customer', names: true, by: 'customer' })}
    ${P.week.length > 1 ? `<div class="card"><h3 class="pl-h">Week by week <span class="muted small">— cards an hour (bars) and pace</span>${pllX('week')}</h3>
      <div class="pl-hist">${P.week.map((w) => `<div class="pl-hist-col" title="Week of ${esc(w.label)}: ${pllN(w.runs)} runs, ${pllN(w.cards)} cards, ${pllN(w.per_hour)} cards/h, pace ${pllN(w.pace)}%">
        <div class="pl-hist-n">${pllN(w.pace)}%</div><div class="pl-hist-bar" style="height:${Math.round(((w.per_hour || 0) / maxWeek) * 140)}px"></div><div class="pl-hist-d">${wk(w.label)}<br>${pllN(w.per_hour)}/h</div></div>`).join('')}</div></div>` : ''}

    ${L.cards.length ? `<div class="card"><h3 class="pl-h">Cards that run unlike their kind <span class="muted small">— 5+ runs, a quarter or more off the kind's speed</span>${pllX('card')}</h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Card (AX)</th><th>Name</th><th>Customer</th><th>Kind</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Its speed</th><th class="num">Kind's speed</th><th class="num">Relative</th></tr></thead><tbody>
      ${L.cards.map((c) => `<tr><td><b>${esc(c.item)}</b></td><td class="small">${esc(c.name || '')}</td><td>${esc(c.customer || '')}</td><td class="small">${pllKind(c)}</td><td class="num">${pllN(c.runs)}</td><td class="num">${pllN(c.cards)}</td>
        <td class="num">${pllN(c.speed)}/h</td><td class="num">${pllN(c.kind_speed)}/h</td><td class="num ${c.ratio < 1 ? 'pl-late' : 'pl-ok'}"><b>${pllN(c.ratio * 100)}%</b></td></tr>`).join('')}
      </tbody></table></div><p class="small muted">Planning times a card by its kind (type · material · print sides). A card listed here is worth a look: a different material or process than the card database says, or a reason to give it a tag and a rule.</p></div>` : ''}

    ${L.overruns.length ? `<div class="card"><h3 class="pl-h">Jobs furthest over their usual time <span class="muted small">— all their runs together, against the set-up plus their cards at the customer's usual pace: 30 min or more over, and under 70% of it</span>${pllX('job')}</h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Job</th><th>Customer</th><th>Started</th><th class="num">Runs</th><th class="num">Cards</th><th>Machines</th><th class="num">Usual for them</th><th class="num">Took</th><th class="num">Over</th></tr></thead><tbody>
      ${L.overruns.map((o) => `<tr><td><b>${esc(o.job)}</b></td><td>${esc(o.customer || '')}</td><td class="small">${esc(fmtDateTime(o.first))}</td><td class="num">${pllN(o.runs)}</td><td class="num">${pllN(o.cards)}</td><td class="small">${esc(o.machines)}</td>
        <td class="num">${fmtSpan(o.expected)}</td><td class="num">${fmtSpan(o.actual)}</td><td class="num pl-late"><b>${fmtSpan(o.over)}</b></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}

    <div class="grid two pll-grid">
      ${L.remakes.length ? `<div class="card"><h3 class="pl-h">Remakes by customer${pllX('customer', { share: 'remade' })}</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer</th><th class="num">Cards</th><th class="num">Remade</th><th class="num">Share</th></tr></thead><tbody>
        ${L.remakes.map((r) => `<tr><td><b>${esc(r.customer)}</b> <span class="small muted">${esc(r.name || '')}</span></td><td class="num">${pllN(r.cards)}</td><td class="num">${pllN(r.remade)}</td><td class="num ${r.pct >= 3 ? 'pl-late' : ''}">${pllN(r.pct, 1)}%</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
      ${L.lateness.jobs ? `<div class="card"><h3 class="pl-h">Late by customer and shipper <span class="muted small">— ${pllN(L.lateness.jobs)} jobs done, ${pllN(L.lateness.late_pct, 1)}% after the cut-off (plan history)</span></h3>
        <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer / shipper</th><th class="num">Jobs</th><th class="num">Late</th><th class="num">Share</th><th class="num">Average late</th></tr></thead><tbody>
        ${[...L.lateness.customer.slice(0, 8).map((x) => ({ ...x, what: 'customer' })), ...L.lateness.shipper.slice(0, 6).map((x) => ({ ...x, what: 'shipper' }))].map((x) => `<tr><td>${x.what === 'shipper' ? '🚚 ' : ''}<b>${esc(x.label)}</b> <span class="small muted">${esc(x.name || '')}</span></td>
          <td class="num">${pllN(x.jobs)}</td><td class="num">${pllN(x.late)}</td><td class="num ${x.late_pct >= 10 ? 'pl-late' : ''}">${pllN(x.late_pct, 1)}%</td><td class="num">${x.avg_late ? fmtSpan(x.avg_late) : '—'}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
    </div>

    ${L.matching.runs ? `<div class="card"><h3 class="pl-h">Matching speeds by customer <span class="muted small">— ${pllN(L.matching.runs)} Matching runs; items an hour once running</span>${pllX('customer', { source: 'otto' })}</h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer</th><th class="num">Runs</th><th class="num">Items</th><th class="num">Learned</th><th class="num">Planned now</th><th class="num">Change</th><th>Confidence</th><th></th></tr></thead><tbody>
      ${L.matching.customers.map((c) => `<tr><td><b>${esc(c.customer)}</b> <span class="small muted">${esc(c.name || '')}</span></td><td class="num">${pllN(c.runs)}</td><td class="num">${pllN(c.items)}</td><td class="num"><b>${pllN(c.speed)}/h</b></td>
        <td class="num">${c.current ? `${pllN(c.current)}/h` : c.machine_avg ? `${pllN(c.machine_avg)}/h<div class="small muted">machines</div>` : '—'}</td><td class="num">${pllChange(c.change)}</td><td>${pllConf(c.confidence)}</td>
        <td>${c.suggest ? `<button type="button" class="small" data-pll-otto="${esc(c.customer)}" data-speed="${c.speed}">Apply ${pllN(c.speed)}/h</button>` : '<span class="small pl-ok">✔ as planned</span>'}</td></tr>`).join('') || '<tr><td colspan="8" class="muted">No customer has 5 Matching runs yet.</td></tr>'}
      </tbody></table></div>
      ${mApply.length ? `<div class="row" style="margin-top:6px"><button type="button" class="primary" data-pll="ottos">Apply the ${mApply.length} confident Matching speed${mApply.length === 1 ? '' : 's'}</button><span class="small muted">Sets the customer's speed in ⚙ Setup › Matching speeds by customer.</span></div>` : ''}</div>` : ''}
    <p class="small muted">Learned from the ⏱ Production runs between ${esc(fmtDateTime(L.runs.first))} and ${esc(fmtDateTime(L.runs.last))}, anomalies (Normal) left out. Nothing changes in ⚙ Setup until you apply it; each change is in the audit log and can be set back in ⚙ Setup.</p>`;
}

// Clicks in the Learned view; true if handled.
async function planLearnClick(e, L, rerender) {
  const xb = e.target.closest('[data-pll-explode]');
  if (xb) { pllExplode({ ...JSON.parse(xb.dataset.pllExplode), days: L?.days || 90 }); return true; }
  const d = e.target.closest('[data-pll-days]');
  if (d) { store.set('planLearnDays', Number(d.dataset.pllDays)); rerender(); return true; }
  const run = async (fn, msg) => { try { await fn(); toast(msg); rerender(); } catch (err) { toast(err.message, 'error'); } };
  const sp = e.target.closest('[data-pll-speed]');
  if (sp) { const s = JSON.parse(sp.dataset.pllSpeed); await run(() => api.post('/plan/speeds', s), `Speed set: ${s.speed}/h`); return true; }
  const oe = e.target.closest('[data-pll-oee]');
  if (oe) { await run(() => api.put(`/plan/oee/${encodeURIComponent(oe.dataset.pllOee)}`, { oee: oe.dataset.pct }), `OEE for ${oe.dataset.pllOee} set to ${oe.dataset.pct}%`); return true; }
  const ot = e.target.closest('[data-pll-otto]');
  if (ot) { await run(() => api.put(`/plan/otto/speeds/${encodeURIComponent(ot.dataset.pllOtto)}`, { speed: ot.dataset.speed }), `Matching speed for ${ot.dataset.pllOtto} set`); return true; }
  const all = e.target.closest('[data-pll]');
  if (!all || !L) return false;
  const what = all.dataset.pll;
  if (what === 'speeds') {
    const list = L.speeds.filter((s) => s.suggest && s.confidence !== 'low');
    await run(async () => { for (const s of list) await api.post('/plan/speeds', { type: s.type, material: s.material, sides: s.sides, speed: s.speed }); }, `${list.length} speed${list.length === 1 ? '' : 's'} applied — the OEE figures are now measured against them`);
    return true;
  }
  if (what === 'oees') {
    const list = L.oee.filter((o) => o.suggest && o.confidence !== 'low');
    await run(async () => { for (const o of list) await api.put(`/plan/oee/${encodeURIComponent(o.customer)}`, { oee: o.suggested }); }, `${list.length} OEE figure${list.length === 1 ? '' : 's'} applied`);
    return true;
  }
  if (what === 'ottos') {
    const list = L.matching.customers.filter((c) => c.suggest && c.confidence !== 'low');
    await run(async () => { for (const c of list) await api.put(`/plan/otto/speeds/${encodeURIComponent(c.customer)}`, { speed: c.speed }); }, `${list.length} Matching speed${list.length === 1 ? '' : 's'} applied`);
    return true;
  }
  if (what === 'learned-on' || what === 'learned-off') {
    await run(async () => { state.settings = await api.patch('/settings', { plan_learned_times: what === 'learned-on' ? '1' : '0' }); }, what === 'learned-on' ? 'Planning now times each card line from its history' : 'Planning uses the speeds and OEE again');
    return true;
  }
  if (what === 'xlsx') { location.href = `/api/plan/learn.xlsx?days=${L.days}`; return true; }
  return false;
}

// ---- 🔎 Explode -------------------------------------------------------------------------------------
// One table opened up in a window: any dates, grouped by anything (src/planlearn.js explode()), each
// row's % of the total, sortable, and a row clicked to filter down to it (shown as chips to step back).
const PLX = {
  quick: [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['180', '6 months'], ['365', '1 year'], ['month', 'This month'], ['lastmonth', 'Last month'], ['year', 'This year']],
  share: { cards: 'Cards', runs: 'Runs', hours: 'Hours', remade: 'Remakes' },
  // the next way to look at a row once filtered to it
  next: { customer: 'card', card: 'job', job: 'day', machine: 'customer', shift: 'machine', weekday: 'shift', hour: 'machine', size: 'customer', kind: 'card', day: 'job', week: 'day', month: 'week' },
};
let plx = null; // { q: { source, from, to, by, filter, share }, sort: { col, dir }, data }
const plxDay = (d) => dateKey(d);
function plxRange(q) {
  const t = new Date(); t.setHours(12, 0, 0, 0);
  if (q === 'month') return [plxDay(new Date(t.getFullYear(), t.getMonth(), 1)), plxDay(t)];
  if (q === 'lastmonth') return [plxDay(new Date(t.getFullYear(), t.getMonth() - 1, 1)), plxDay(new Date(t.getFullYear(), t.getMonth(), 0))];
  if (q === 'year') return [plxDay(new Date(t.getFullYear(), 0, 1)), plxDay(t)];
  const f = new Date(t); f.setDate(f.getDate() - Number(q) + 1); return [plxDay(f), plxDay(t)];
}
async function pllExplode({ by = 'customer', source = 'perso', share = 'cards', days = 90, filter = {} } = {}) {
  const [from, to] = plxRange(String(days));
  plx = { q: { source, from, to, by, filter, share, compare: !!store.get('plxCompare', false) }, sort: null, data: null };
  openModal('<div id="pllx" class="pllx"><p class="muted">Loading…</p></div>', { wide: true });
  $('#pllx').addEventListener('click', plxClick);
  $('#pllx').addEventListener('change', plxChange);
  await plxLoad();
}
async function plxLoad() {
  const q = plx.q;
  try {
    plx.data = await api.get(`/plan/learn/explode?source=${q.source}&from=${q.from}&to=${q.to}&by=${q.by}${q.compare ? '&compare=1' : ''}&filter=${encodeURIComponent(JSON.stringify(q.filter))}`);
  } catch (err) { toast(err.message, 'error'); return; }
  q.from = plx.data.from; q.to = plx.data.to;
  plxDraw();
}
// the columns; comparing, the table shows the change in cards, cards/h and pace in place of the
// averages (all of them go in the CSV)
const plxCols = (otto, D, all = false) => {
  const cmp = D?.prev && D.rows.some((r) => r.chg);
  const chg = cmp ? Object.keys(PLX_CHG).filter((k) => (all || ['cards', 'per_hour', 'pace'].includes(k)) && (!otto || !['pace', 'remade_pct'].includes(k)))
    .map((k) => [`chg.${k}`, `${otto ? PLX_CHG[k][0].replace('Cards', 'Items') : PLX_CHG[k][0]} ±`]) : [];
  return [...plxBase(otto).filter(([k]) => all || !cmp || !['avg_cards', 'avg_run'].includes(k)), ...chg];
};
const plxBase = (otto) => [
  ['runs', 'Runs'], ['runs_pct', '% runs', 1], [otto ? 'cards' : 'cards', otto ? 'Items' : 'Cards'], ['cards_pct', otto ? '% items' : '% cards', 1], ['hours', 'Hours', 1], ['hours_pct', '% hours', 1],
  ['per_hour', otto ? 'Items/h' : 'Cards/h'], ['avg_cards', otto ? 'Avg items' : 'Avg cards'], ['avg_run', 'Avg run'], ...(otto ? [] : [['pace', 'Pace'], ['remade_pct', 'Remade', 1]]),
];
// against the period before: % change (runs, cards, hours, a speed) or points (pace, remakes); `good` is the
// direction that's better (1 up, -1 down, 0 neither)
const PLX_CHG = { runs: ['Runs', '%', 0], cards: ['Cards', '%', 0], hours: ['Hours', '%', 0], per_hour: ['Cards/h', '%', 1], pace: ['Pace', 'pts', 1], remade_pct: ['Remade', 'pts', -1] };
const plxVal = (r, k) => (k.startsWith('chg.') ? r.chg?.[k.slice(4)] : r[k]);
function plxChg(r, k) {
  const c = r.chg; if (!c) return '';
  if (c.new) return '<span class="small pllx-new">new</span>';
  const [, unit, good] = PLX_CHG[k]; const v = c[k];
  if (v === null || v === undefined) return '<span class="muted">—</span>';
  const tone = !good || Math.abs(v) < (unit === 'pts' ? 1 : 3) ? 'muted' : v * good > 0 ? 'pl-ok' : 'pl-late';
  const was = r.prev ? `before: ${pllN(r.prev[k], k === 'remade_pct' ? 1 : 0)}${unit === 'pts' ? '%' : ''}` : '';
  return `<span class="${tone}" title="${esc(was)}">${v > 0 ? '▲' : v < 0 ? '▼' : ''}${pllN(Math.abs(v), 1)}${unit === 'pts' ? ' pts' : '%'}</span>`;
}
function plxRowsSorted() {
  const rows = [...plx.data.rows];
  const s = plx.sort; if (!s) return rows;
  const v = (r) => (s.col === 'label' ? r.label : plxVal(r, s.col) ?? -Infinity);
  return rows.sort((a, b) => { const x = v(a); const y = v(b); return (x < y ? -1 : x > y ? 1 : 0) * s.dir; });
}
function plxDraw() {
  const D = plx.data; const q = plx.q; const otto = D.source === 'otto';
  const dim = D.dims.find((d) => d.key === D.by);
  const shareKey = { cards: 'cards_pct', runs: 'runs_pct', hours: 'hours_pct', remade: 'remade_share' }[q.share] || 'cards_pct';
  const maxShare = Math.max(1, ...D.rows.map((r) => r[shareKey] || 0));
  const cols = plxCols(otto, D);
  const cell = (r, k) => (k.startsWith('chg.') ? plxChg(r, k.slice(4)) : k === 'pace' ? pllPace(r.pace) : k === 'avg_run' ? (r.avg_run === null ? '—' : fmtSpan(r.avg_run)) : k.endsWith('_pct') ? (r[k] === null || r[k] === undefined ? '—' : `${pllN(r[k], 1)}%`) : pllN(r[k], k === 'hours' ? 1 : 0));
  const arrow = (k) => (plx.sort?.col === k ? (plx.sort.dir > 0 ? ' ▲' : ' ▼') : '');
  const T = D.total;
  const tile = (l, v, sub = '', k = null) => `<div class="kdb-tile"><div class="kdb-tile-l">${l}</div><div class="kdb-tile-v">${v}</div>${sub ? `<div class="kdb-tile-s">${sub}</div>` : ''}${k && T.chg ? `<div class="kdb-tile-s">${plxChg(T, k)} <span class="muted">vs before</span></div>` : ''}</div>`;
  const tr = D.trend; const trMax = Math.max(1, ...tr.map((t) => t.per_hour || 0));
  const trLabel = (l) => (D.trend_step === 'day' ? `${Number(l.slice(8))}/${Number(l.slice(5, 7))}` : `w/c ${Number(l.slice(8))}/${Number(l.slice(5, 7))}`);
  $('#pllx').innerHTML = `
    <div class="modal-head"><h2 style="margin:0">🔎 ${otto ? 'Matching' : 'Production'} runs by ${esc(dim.label.toLowerCase())}</h2><button class="icon" data-action="close-modal">✕</button></div>
    <div class="pllx-bar">
      <label class="f"><span>From</span><input type="date" name="from" value="${esc(q.from)}"></label>
      <label class="f"><span>To</span><input type="date" name="to" value="${esc(q.to)}"></label>
      <label class="f"><span>Quick</span><select name="quick"><option value="">—</option>${PLX.quick.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></label>
      <label class="f"><span>Group by</span><select name="by">${D.dims.filter((d) => !(d.key in q.filter)).filter((d) => !otto || !['kind', 'card', 'size'].includes(d.key)).map((d) => `<option value="${d.key}" ${d.key === D.by ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select></label>
      <label class="pllx-cmp"><input type="checkbox" name="compare" ${q.compare ? 'checked' : ''}> Compare with the period before</label>
      <label class="f"><span>Runs from</span><select name="source"><option value="perso" ${otto ? '' : 'selected'}>Perso (cards)</option><option value="otto" ${otto ? 'selected' : ''}>Matching (items)</option></select></label>
      <div class="f"><span>% bar shows</span><div class="seg">${Object.entries(PLX.share).filter(([k]) => !otto || k !== 'remade').map(([k, l]) => `<button type="button" data-plx-share="${k}" class="${q.share === k ? 'on' : ''}">${otto && k === 'cards' ? 'Items' : l}</button>`).join('')}</div></div>
    </div>
    <div class="pllx-crumbs"><button type="button" class="pllx-chip ${D.filter_labels.length ? '' : 'on'}" data-plx-clear>All runs</button>
      ${D.filter_labels.map((f) => `<span class="pllx-chip on">${esc(f.dim_label)}: <b>${esc(f.label)}</b>${f.name ? ` <span class="muted">${esc(f.name)}</span>` : ''} <button type="button" class="link" data-plx-unfilter="${esc(f.dim)}" title="Take this filter off">✕</button></span>`).join(' › ')}
      <span class="small muted">${D.days} day${D.days === 1 ? '' : 's'} · click a row to look inside it</span></div>
    <div class="kdb-tiles">${tile('Runs', pllN(T.runs), `${pllN(T.days)} days with runs`, 'runs')}${tile(otto ? 'Items' : 'Cards', pllN(T.cards), `${pllN(T.avg_cards)} a run`, 'cards')}${tile('Hours', pllN(T.hours, 1), T.avg_run ? `${fmtSpan(T.avg_run)} a run` : '', 'hours')}
      ${tile(otto ? 'Items/h' : 'Cards/h', pllN(T.per_hour), '', 'per_hour')}${otto ? '' : tile('Pace', T.pace === null ? '—' : `${pllN(T.pace)}%`, 'against the kinds\' learned speeds', 'pace') + tile('Remakes', T.remade_pct === null ? '—' : `${pllN(T.remade_pct, 1)}%`, `${pllN(T.remade)} cards`, 'remade_pct')}</div>
    ${D.prev ? `<p class="small muted" style="margin:4px 0 8px">± against the ${D.days} day${D.days === 1 ? '' : 's'} before: ${esc(fmtDate(`${D.prev.from}T12:00`))} to ${esc(fmtDate(`${D.prev.to}T12:00`))}${['day', 'week', 'month'].includes(D.by) ? ' (totals only: by day, week or month the two periods share no rows)' : ''}. Pace and remakes in points.</p>` : ''}
    ${D.rows.length ? `<div class="kdb-scroll pllx-scroll"><table class="log pll-t pllx-t"><thead><tr><th data-plx-sort="label">${esc(dim.label)}${arrow('label')}</th><th>Share of ${esc((otto && q.share === 'cards' ? 'Items' : PLX.share[q.share]).toLowerCase())}</th>
        ${cols.map(([k, l]) => `<th class="num" data-plx-sort="${k}">${l}${arrow(k)}</th>`).join('')}</tr></thead><tbody>
      ${plxRowsSorted().map((r) => `<tr data-plx-row="${esc(r.key)}" class="${r.gone ? 'pllx-gone' : ''}" title="Look inside: filter to ${esc(r.label)}"><td><b>${esc(r.label)}</b>${r.gone ? ' <span class="small muted">none now</span>' : ''}${r.name ? ` <span class="small muted">${esc(r.name)}</span>` : ''}</td>
        <td><div class="pllx-share"><div style="width:${((r[shareKey] || 0) / maxShare) * 100}%"></div><span>${r[shareKey] === null || r[shareKey] === undefined ? '—' : `${pllN(r[shareKey], 1)}%`}</span></div></td>
        ${cols.map(([k]) => `<td class="num">${cell(r, k)}</td>`).join('')}</tr>`).join('')}
      </tbody><tfoot><tr><td><b>Total</b> <span class="small muted">${pllN(D.rows.length)} rows</span></td><td></td>${cols.map(([k]) => `<td class="num"><b>${k.endsWith('_pct') && !k.startsWith('chg.') ? (k === 'remade_pct' ? cell(T, k) : '100%') : cell(T, k)}</b></td>`).join('')}</tr></tfoot></table></div>`
      : `<p class="muted">No runs ${D.window.runs ? 'match these filters' : 'in these dates'}.</p>`}
    ${tr.length > 1 ? `<h4 style="margin:14px 0 4px">Over time <span class="muted small">— ${otto ? 'items' : 'cards'} an hour by ${D.trend_step}${otto ? '' : ', pace above'}</span></h4>
      <div class="pl-hist pllx-hist">${tr.map((t) => `<div class="pl-hist-col" title="${esc(trLabel(t.label))}: ${pllN(t.runs)} runs, ${pllN(t.cards)} ${otto ? 'items' : 'cards'}, ${pllN(t.hours, 1)} h, ${pllN(t.per_hour)}/h${t.pace === null ? '' : `, pace ${pllN(t.pace)}%`}">
        <div class="pl-hist-n">${t.pace === null ? '' : `${pllN(t.pace)}%`}</div><div class="pl-hist-bar" style="height:${Math.round(((t.per_hour || 0) / trMax) * 110)}px"></div><div class="pl-hist-d">${esc(trLabel(t.label))}<br>${pllN(t.per_hour)}</div></div>`).join('')}</div>` : ''}
    <div class="row" style="margin-top:10px"><span class="small muted">Shares are of the runs shown (after the filters).${otto ? '' : ' Pace: the time the cards would take at their kind\'s speed learned over these dates (at least 180 days) ÷ the time they took.'} Anomalies are left out.</span>
      <span class="spacer"></span><button type="button" data-plx-csv>⬇ CSV</button></div>`;
  const hist = $('#pllx .pllx-hist'); if (hist) hist.scrollLeft = hist.scrollWidth; // the latest at hand
}
function plxClick(e) {
  if (!plx?.data) return;
  const q = plx.q;
  const sh = e.target.closest('[data-plx-share]');
  if (sh) { q.share = sh.dataset.plxShare; plxDraw(); return; }
  const so = e.target.closest('[data-plx-sort]');
  if (so) { const col = so.dataset.plxSort; plx.sort = plx.sort?.col === col ? (plx.sort.dir < 0 ? { col, dir: 1 } : null) : { col, dir: col === 'label' ? 1 : -1 }; plxDraw(); return; }
  if (e.target.closest('[data-plx-clear]')) { q.filter = {}; plx.sort = null; plxLoad(); return; }
  const un = e.target.closest('[data-plx-unfilter]');
  if (un) { delete q.filter[un.dataset.plxUnfilter]; plxLoad(); return; }
  const row = e.target.closest('[data-plx-row]');
  if (row) {
    q.filter = { ...q.filter, [q.by]: row.dataset.plxRow };
    let next = PLX.next[q.by] || 'day';
    const taken = (k) => k in q.filter || (q.source === 'otto' && ['kind', 'card', 'size'].includes(k));
    if (taken(next)) next = ['customer', 'machine', 'job', 'day', 'week', 'shift', 'weekday', 'hour'].find((k) => !taken(k)) || 'day';
    q.by = next; plx.sort = null; plxLoad(); return;
  }
  if (e.target.closest('[data-plx-csv]')) {
    const D = plx.data; const cols = plxCols(D.source === 'otto', D, true);
    const cell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const lines = [[D.dims.find((d) => d.key === D.by).label, 'Name', ...cols.map(([, l]) => l)].map(cell).join(','),
      ...plxRowsSorted().map((r) => [r.label, r.name, ...cols.map(([k]) => (r.chg?.new && k.startsWith('chg.') ? 'new' : plxVal(r, k)))].map(cell).join(','))];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`${lines.join('\r\n')}\r\n`], { type: 'text/csv' }));
    a.download = `explode-${D.by}-${D.from}-to-${D.to}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
}
function plxChange(e) {
  const q = plx.q; const t = e.target;
  if (t.name === 'quick' && t.value) [q.from, q.to] = plxRange(t.value);
  else if (t.name === 'from' || t.name === 'to') { if (!t.value) return; q[t.name] = t.value; }
  else if (t.name === 'by') { q.by = t.value; plx.sort = null; }
  else if (t.name === 'compare') { q.compare = t.checked; store.set('plxCompare', t.checked); }
  else if (t.name === 'source') { q.source = t.value; q.filter = {}; if (t.value === 'otto' && ['kind', 'card', 'size'].includes(q.by)) q.by = 'customer'; if (t.value === 'otto' && q.share === 'remade') q.share = 'cards'; }
  else return;
  plxLoad();
}
