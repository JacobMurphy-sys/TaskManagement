// 🧠 Planning › Learned: what the production runs say about the planning setup (src/planlearn.js),
// with the speeds and OEE ready to apply. Rendered by renderPlanning() when the view is 'learn'.
const PLL = {
  days: [[30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']],
  conf: { high: ['●●●', 'High: 30+ runs over 5+ days'], medium: ['●●○', 'Medium: 10+ runs over 2+ days'], low: ['●○○', 'Low: fewer runs — worth watching, not applying yet'] },
  icon: { deploy: '🛠', pattern: '🔍', trend: '📈', quality: '⚠' },
};
const pllN = (v, d = 0) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-GB', { maximumFractionDigits: d }));
const pllKind = (s) => [s.type, s.material, s.sides].filter(Boolean).map(esc).join(' · ') || '<span class="muted">any card</span>';
const pllConf = (c) => `<span class="pll-conf pll-${c}" title="${esc(PLL.conf[c][1])}">${PLL.conf[c][0]}</span>`;
const pllChange = (x) => (x === null || x === undefined ? '' : `<span class="${Math.abs(x) < 5 ? 'muted' : x > 0 ? 'pl-ok' : 'pl-late'}">${x > 0 ? '+' : ''}${pllN(x)}%</span>`);
// a pace as a bar around 100% (the usual for the cards)
function pllPace(p, scale = 130) {
  if (p === null || p === undefined) return '—';
  return `<div class="pll-pace" title="${pllN(p, 1)}% of the usual pace for these cards"><div class="pll-pace-bar ${p >= 95 ? 'ok' : p >= 80 ? 'mid' : 'low'}" style="width:${Math.min(100, (p / scale) * 100)}%"></div><span>${pllN(p)}%</span></div>`;
}
function pllPatternTable(title, rows, { label = '', names = false, note = '' } = {}) {
  if (!rows?.length) return '';
  return `<div class="card"><h3 class="pl-h">${title}</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>${label}</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Hours</th><th class="num">Cards/h</th><th>Pace</th></tr></thead><tbody>
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
      <span class="spacer"></span><button type="button" data-pll="xlsx">⬇ Excel</button></div>
    <div class="kdb-tiles">
      ${accTile(A.now, 'Planned within 25% — now', 'the setup as it is')}
      ${accTile(A.learned, 'With the learned values', A.tested_on === 'newest' ? `learned on older runs, tested on the newest ${pllN(A.runs)}` : 'all runs')}
      <div class="kdb-tile"><div class="kdb-tile-l">Runs vs plan</div><div class="kdb-tile-v ${A.now && Math.abs(A.now.bias) >= 15 ? 'kdb-bad' : ''}">${A.now?.bias === null || !A.now ? '—' : `${A.now.bias > 0 ? '+' : ''}${pllN(A.now.bias)}%`}</div><div class="kdb-tile-s">typical run, against its planned time</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Set-up a run</div><div class="kdb-tile-v">${L.setup.all === null ? '—' : `${pllN(L.setup.all)} min`}</div><div class="kdb-tile-s">before cards flow, usual</div></div>
      <div class="kdb-tile"><div class="kdb-tile-l">Remakes</div><div class="kdb-tile-v">${L.runs.cards ? `${pllN((L.runs.remade / L.runs.cards) * 100, 1)}%` : '—'}</div><div class="kdb-tile-s">${pllN(L.runs.remade)} cards</div></div>
    </div>
    ${L.findings.length ? `<div class="card"><h3 class="pl-h">What stands out</h3><ul class="pll-find">${L.findings.map((f) => `<li class="pll-${f.kind}"><span>${PLL.icon[f.kind] || '•'}</span> ${esc(f.text)}</li>`).join('')}</ul></div>` : ''}

    <div class="card"><h3 class="pl-h">Speeds by kind of card <span class="muted small">— running speed once a run is going (its machine's usual set-up taken off), the middle of its runs weighted by cards</span></h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Kind of card</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Learned</th><th class="num" title="Half the runs fall in this range">Usual range</th><th class="num">Planned now</th><th class="num">Change</th><th>Confidence</th><th></th></tr></thead><tbody>
      ${L.speeds.map((s) => `<tr><td>${pllKind(s)}</td><td class="num">${pllN(s.runs)}</td><td class="num">${pllN(s.cards)}</td><td class="num"><b>${pllN(s.speed)}/h</b></td>
        <td class="num small muted">${pllN(s.p25)}–${pllN(s.p75)}</td><td class="num">${s.current ? `${pllN(s.current)}/h` : '—'}${s.current_from && s.current_from !== 'rule' ? `<div class="small muted">${esc(s.current_from)}</div>` : ''}</td>
        <td class="num">${pllChange(s.change)}</td><td>${pllConf(s.confidence)}</td>
        <td>${s.suggest ? `<button type="button" class="small" data-pll-speed="${esc(JSON.stringify({ type: s.type, material: s.material, sides: s.sides, speed: s.speed }))}">Apply ${pllN(s.speed)}/h</button>` : '<span class="small pl-ok">✔ as planned</span>'}</td></tr>`).join('') || '<tr><td colspan="9" class="muted">No kind of card has 5 runs yet.</td></tr>'}
      </tbody></table></div>
      <div class="row" style="margin-top:6px">${toApply.length ? `<button type="button" class="primary" data-pll="speeds">Apply the ${toApply.length} confident speed${toApply.length === 1 ? '' : 's'}</button>` : ''}
        <span class="small muted">Applying adds (or updates) the speed rule for exactly that kind of card in ⚙ Setup › Speeds. Low-confidence rows are left for you to judge.</span></div></div>

    <div class="card"><h3 class="pl-h">Estimated OEE by customer <span class="muted small">— the time each customer's runs would take at the speeds planned now ÷ the time they took</span></h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Measured</th><th class="num">Planned now</th><th>Confidence</th><th></th></tr></thead><tbody>
      ${L.oee.map((o) => `<tr><td><b>${esc(o.customer)}</b> ${o.name ? `<span class="small muted">${esc(o.name)}</span>` : ''}</td><td class="num">${pllN(o.runs)}</td><td class="num">${pllN(o.cards)}</td>
        <td class="num"><b>${pllN(o.oee, 1)}%</b>${o.over ? '<div class="small muted">quicker than the speeds — they may be set low</div>' : ''}</td>
        <td class="num">${o.current === null ? '—' : `${pllN(o.current)}%`}${o.current_from === 'default' ? '<div class="small muted">default</div>' : ''}</td><td>${pllConf(o.confidence)}</td>
        <td>${o.suggest ? `<button type="button" class="small" data-pll-oee="${esc(o.customer)}" data-pct="${o.suggested}">Apply ${o.suggested}%</button>` : '<span class="small pl-ok">✔ as planned</span>'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No customer has 5 runs with a speed set yet.</td></tr>'}
      </tbody></table></div>
      <div class="row" style="margin-top:6px">${oeeApply.length ? `<button type="button" class="primary" data-pll="oees">Apply the ${oeeApply.length} confident OEE figure${oeeApply.length === 1 ? '' : 's'}</button>` : ''}
        <span class="small muted">${toApply.length ? '⚠ Apply the speeds first: OEE is measured against the speeds as they are now, and these figures change once the speeds do.' : 'The OEE takes in each customer\'s set-ups, stops and slower cards, so planned times match what runs.'}</span></div></div>

    <div class="grid two pll-grid">
      ${pllPatternTable('By shift', P.shift, { label: 'Shift', note: 'Shifts from the shift start times in ⚙ Setup › Modifiers. Pace: the time the cards would take at their kind\'s learned speed ÷ the time they took.' })}
      ${pllPatternTable('By job size', P.size, { label: 'Cards in the run', note: `Small runs carry the set-up${L.setup.all ? ` (about ${pllN(L.setup.all)} min)` : ''} on few cards.` })}
      ${pllPatternTable('By machine', P.machine, { label: 'Machine', note: L.setup.machines.length ? `Usual set-up: ${L.setup.machines.map((m) => `${esc(m.machine)} ${pllN(m.setup)} min`).join(' · ')}` : '' })}
      ${pllPatternTable('By weekday', P.weekday, { label: 'Day' })}
    </div>
    ${pllPatternTable('By customer', P.customer, { label: 'Customer', names: true })}
    ${P.week.length > 1 ? `<div class="card"><h3 class="pl-h">Week by week <span class="muted small">— cards an hour (bars) and pace</span></h3>
      <div class="pl-hist">${P.week.map((w) => `<div class="pl-hist-col" title="Week of ${esc(w.label)}: ${pllN(w.runs)} runs, ${pllN(w.cards)} cards, ${pllN(w.per_hour)} cards/h, pace ${pllN(w.pace)}%">
        <div class="pl-hist-n">${pllN(w.pace)}%</div><div class="pl-hist-bar" style="height:${Math.round(((w.per_hour || 0) / maxWeek) * 140)}px"></div><div class="pl-hist-d">${wk(w.label)}<br>${pllN(w.per_hour)}/h</div></div>`).join('')}</div></div>` : ''}

    ${L.cards.length ? `<div class="card"><h3 class="pl-h">Cards that run unlike their kind <span class="muted small">— 5+ runs, a quarter or more off the kind's speed</span></h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Card (AX)</th><th>Name</th><th>Customer</th><th>Kind</th><th class="num">Runs</th><th class="num">Cards</th><th class="num">Its speed</th><th class="num">Kind's speed</th><th class="num">Relative</th></tr></thead><tbody>
      ${L.cards.map((c) => `<tr><td><b>${esc(c.item)}</b></td><td class="small">${esc(c.name || '')}</td><td>${esc(c.customer || '')}</td><td class="small">${pllKind(c)}</td><td class="num">${pllN(c.runs)}</td><td class="num">${pllN(c.cards)}</td>
        <td class="num">${pllN(c.speed)}/h</td><td class="num">${pllN(c.kind_speed)}/h</td><td class="num ${c.ratio < 1 ? 'pl-late' : 'pl-ok'}"><b>${pllN(c.ratio * 100)}%</b></td></tr>`).join('')}
      </tbody></table></div><p class="small muted">Planning times a card by its kind (type · material · print sides). A card listed here is worth a look: a different material or process than the card database says, or a reason to give it a tag and a rule.</p></div>` : ''}

    ${L.overruns.length ? `<div class="card"><h3 class="pl-h">Jobs furthest over their usual time <span class="muted small">— all their runs together, against the set-up plus their cards at the customer's usual pace: 30 min or more over, and under 70% of it</span></h3>
      <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Job</th><th>Customer</th><th>Started</th><th class="num">Runs</th><th class="num">Cards</th><th>Machines</th><th class="num">Usual for them</th><th class="num">Took</th><th class="num">Over</th></tr></thead><tbody>
      ${L.overruns.map((o) => `<tr><td><b>${esc(o.job)}</b></td><td>${esc(o.customer || '')}</td><td class="small">${esc(fmtDateTime(o.first))}</td><td class="num">${pllN(o.runs)}</td><td class="num">${pllN(o.cards)}</td><td class="small">${esc(o.machines)}</td>
        <td class="num">${fmtSpan(o.expected)}</td><td class="num">${fmtSpan(o.actual)}</td><td class="num pl-late"><b>${fmtSpan(o.over)}</b></td></tr>`).join('')}
      </tbody></table></div></div>` : ''}

    <div class="grid two pll-grid">
      ${L.remakes.length ? `<div class="card"><h3 class="pl-h">Remakes by customer</h3><div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer</th><th class="num">Cards</th><th class="num">Remade</th><th class="num">Share</th></tr></thead><tbody>
        ${L.remakes.map((r) => `<tr><td><b>${esc(r.customer)}</b> <span class="small muted">${esc(r.name || '')}</span></td><td class="num">${pllN(r.cards)}</td><td class="num">${pllN(r.remade)}</td><td class="num ${r.pct >= 3 ? 'pl-late' : ''}">${pllN(r.pct, 1)}%</td></tr>`).join('')}
      </tbody></table></div></div>` : ''}
      ${L.lateness.jobs ? `<div class="card"><h3 class="pl-h">Late by customer and shipper <span class="muted small">— ${pllN(L.lateness.jobs)} jobs done, ${pllN(L.lateness.late_pct, 1)}% after the cut-off (plan history)</span></h3>
        <div class="kdb-scroll"><table class="log pll-t"><thead><tr><th>Customer / shipper</th><th class="num">Jobs</th><th class="num">Late</th><th class="num">Share</th><th class="num">Average late</th></tr></thead><tbody>
        ${[...L.lateness.customer.slice(0, 8).map((x) => ({ ...x, what: 'customer' })), ...L.lateness.shipper.slice(0, 6).map((x) => ({ ...x, what: 'shipper' }))].map((x) => `<tr><td>${x.what === 'shipper' ? '🚚 ' : ''}<b>${esc(x.label)}</b> <span class="small muted">${esc(x.name || '')}</span></td>
          <td class="num">${pllN(x.jobs)}</td><td class="num">${pllN(x.late)}</td><td class="num ${x.late_pct >= 10 ? 'pl-late' : ''}">${pllN(x.late_pct, 1)}%</td><td class="num">${x.avg_late ? fmtSpan(x.avg_late) : '—'}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
    </div>

    ${L.matching.runs ? `<div class="card"><h3 class="pl-h">Matching speeds by customer <span class="muted small">— ${pllN(L.matching.runs)} Matching runs; items an hour once running</span></h3>
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
  if (what === 'xlsx') { location.href = `/api/plan/learn.xlsx?days=${L.days}`; return true; }
  return false;
}
