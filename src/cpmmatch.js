'use strict';
// 📐 Capacity planning for Matching — a best guess from the history there is, as CPM Monthly and CPM Daily do
// for perso:
// - the volume: each customer's forecast cards (× flex, × a scenario's volume changes) × the share of its cards
//   that go through Matching — learned from history (items matched ÷ cards persoed, the last 4 months of the
//   timing reports), or typed on Configuration › Matching;
// - ÷ one Matching OEE (typed: the losses counted once, as for perso), and × the machines' usual speed ÷ the
//   customer's own Matching speed where Production sets one (a slower customer takes more machine time);
// - against the Matching machines (Production › Setup): their speed × the hours a shift counted × shifts ×
//   working days a month; by the hour, in the hours the shifts cover;
// - a day's items spread over the hours as the customer's Matching runs ended (else all Matching's, else evenly).
const db = require('./db');
const cpm = require('./cpm');

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const setting = (k, d) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value ?? d;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (s, d) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
const LOOKBACK = 120;
const since = () => { const d = new Date(); d.setDate(d.getDate() - LOOKBACK); return ymd(d); };

// the Matching OEE (typed; 60% if never set)
const oee = () => { const v = Number(setting('cpm_match_oee', '0.6')); return v > 0 && v <= 1 ? v : 0.6; };

// the Matching machines, as Production has them: active ones with a speed (items an hour); and the customers'
// own Matching speeds
function machines() {
  let ms = []; try { ms = db.all('SELECT name, speed, match, metal, metal_speed FROM plan_otto_machines WHERE active = 1 ORDER BY sort_order, id'); } catch { /* none */ }
  let cs = []; try { cs = db.all('SELECT customer, speed FROM plan_otto_speeds'); } catch { /* none */ }
  const elig = new Set(json(setting('cpm_match_oee_machines', '[]'), []).map((x) => String(x).toLowerCase()));
  const list = ms.map((m) => ({ name: m.name, speed: Number(m.speed) || 0, match: m.match || '', key: String(m.match || m.name || '').trim().toLowerCase(), measure: elig.has(String(m.name).toLowerCase()), metal: !!m.metal, metal_speed: m.metal ? Number(m.metal_speed) || 0 : 0 }));
  const fast = list.filter((m) => m.speed > 0); const mt = list.filter((m) => m.metal && m.metal_speed > 0);
  // metal cards: only on the machines ticked for metal, at their metal speed (Production › Setup)
  return { list, ref: fast.length ? fast.reduce((a, m) => a + m.speed, 0) / fast.length : 0, cust: new Map(cs.map((c) => [String(c.customer).toUpperCase(), Number(c.speed) || 0])),
    metal_ref: mt.length ? mt.reduce((a, m) => a + m.metal_speed, 0) / mt.length : 0, metal_cap: mt.reduce((a, m) => a + m.metal_speed, 0), metal_machines: list.filter((m) => m.metal).map((m) => m.name) };
}

// each customer's share of its persoed cards that went through Matching, the last 4 months: items matched ÷ cards
// persoed (from the two timing reports), at most 100% — an item is matched once at most; '*' everyone's. Customers with too little history fall back on '*'.
function learnedRatios() {
  const q = (src) => { try { return db.all(`SELECT upper(trigram) AS tri, SUM(qty) AS q FROM prod_runs WHERE source = ? AND remake = 0 AND trigram IS NOT NULL AND trigram <> '' AND start_at >= ? GROUP BY upper(trigram)`, [src, since()]); } catch { return []; } };
  const perso = new Map(q('perso').map((r) => [r.tri, r.q || 0])); const match = new Map(q('otto').map((r) => [r.tri, r.q || 0]));
  const out = new Map(); let P = 0; let M = 0;
  for (const [tri, p] of perso) { const m = match.get(tri) || 0; P += p; M += m; if (p >= 500) out.set(tri, { ratio: Math.min(1, m / p), perso: p, match: m }); }
  out.set('*', { ratio: P ? Math.min(1, M / P) : 0, perso: P, match: M });
  return out;
}
// each customer's share: typed (Configuration › Matching) wins, else learned, else everyone's
function ratios() {
  const typed = json(setting('cpm_match_ratio', '{}'), {}); const learned = learnedRatios(); const all = learned.get('*');
  return { of: (tri) => { const t = typed[tri]; if (t !== undefined && t !== null && t !== '') return { ratio: Math.min(1, Math.max(0, Number(t) || 0)), from: 'typed' }; const l = learned.get(tri); return l ? { ratio: l.ratio, from: 'learned' } : { ratio: all ? all.ratio : 0, from: 'everyone' }; },
    typed, learned };
}

// each customer's OEE measured on the machines ticked for it (Configuration › Capacity, Matching picked): items
// made ÷ (the time its jobs took × the machine's rated speed), the last 4 months; '*' all of them. Only machines whose
// runs reflect the customer's own work are ticked — others (manual stations, mixed lines) would mislead.
function measuredOee(M = machines()) {
  const elig = M.list.filter((m) => m.measure && m.speed > 0 && m.key); const out = new Map(); const runs = new Map(elig.map((m) => [m.name, 0]));
  if (!elig.length) return { by: out, runs };
  // Operators needn't start a work order in the system when they start it on the machine, so a run's start
  // is often entered moments before its end: only the end is trusted. A machine runs one job at a time, so a
  // job took (at most) the time since the machine's previous finish. Jobs closed together (within 2 minutes)
  // count as one finish, their time shared by items; a gap over MAX_GAP hours since the previous finish
  // (idle, a shift change, the machine's first job of the day) tells nothing and is left out. Breaks inside it
  // count — losses the OEE carries, capacity being the whole shift.
  const MAX_GAP = 2; const CLOSE = 2 / 60;
  let rows = []; try { rows = db.all("SELECT upper(trigram) AS tri, machine, end_at, qty FROM prod_runs WHERE source = 'otto' AND remake = 0 AND end_at IS NOT NULL AND end_at >= ? ORDER BY end_at", [since()]); } catch { /* none */ }
  const acc = new Map(); const add = (k, items, std, hrs) => { const a = acc.get(k) || acc.set(k, { items: 0, std: 0, hours: 0 }).get(k); a.items += items; a.std += std; a.hours += hrs; };
  const byM = new Map(); // machine → its finishes in time order: [{ at (hours), jobs: [{ tri, q }] }]
  for (const r of rows) {
    const mach = String(r.machine || '').toLowerCase(); const m = elig.find((x) => mach.includes(x.key)); if (!m) continue;
    const at = new Date(r.end_at).getTime() / 3600000; const q = Number(r.qty) || 0; if (!Number.isFinite(at) || !q) continue;
    const list = byM.get(m) || byM.set(m, []).get(m); const last = list[list.length - 1];
    if (last && at - last.at <= CLOSE) last.jobs.push({ tri: r.tri, q }); else list.push({ at, jobs: [{ tri: r.tri, q }] });
  }
  for (const [m, list] of byM) for (let k = 1; k < list.length; k++) {
    const hrs = list[k].at - list[k - 1].at; if (!(hrs > 0) || hrs > MAX_GAP) continue;
    const tot = list[k].jobs.reduce((a, j) => a + j.q, 0);
    for (const j of list[k].jobs) { const h = (hrs * j.q) / tot; runs.set(m.name, runs.get(m.name) + 1); if (j.tri) add(j.tri, j.q, h * m.speed, h); add('*', j.q, h * m.speed, h); }
  }
  for (const [k, a] of acc) if (a.std > 0 && a.hours >= 2) out.set(k, { oee: Math.min(1, a.items / a.std), raw: a.items / a.std, hours: a.hours, items: a.items });
  return { by: out, runs };
}
// a customer's Matching OEE: typed for it wins, then measured, then the one Matching OEE
function oees(M = machines()) {
  const typed = json(setting('cpm_match_cust_oee', '{}'), {}); const meas = measuredOee(M); const all = oee();
  return { of: (tri) => { const t = typed[tri]; if (t !== undefined && t !== null && t !== '' && Number(t) > 0) return { oee: Math.min(1, Number(t)), from: 'typed' }; const m = tri ? meas.by.get(tri) : null; return m ? { oee: m.oee, from: 'measured' } : { oee: all, from: 'default' }; }, typed, measured: meas };
}

// when in the day Matching's runs ended, per customer and for all: 'TRI' / '*' → [24 shares by the clock hour]
function profiles() {
  let rows = []; try { rows = db.all("SELECT upper(trigram) AS tri, end_at, qty FROM prod_runs WHERE source = 'otto' AND remake = 0 AND end_at IS NOT NULL AND start_at >= ?", [since()]); } catch { /* none */ }
  const by = new Map(); const add = (k, h, q) => { const a = by.get(k) || by.set(k, Array(24).fill(0)).get(k); a[h] += q; };
  for (const r of rows) { const d = new Date(r.end_at); if (Number.isNaN(d.getTime())) continue; const q = Number(r.qty) || 0; if (r.tri) add(r.tri, d.getHours(), q); add('*', d.getHours(), q); }
  const out = new Map(); for (const [k, a] of by) { const t = a.reduce((x, y) => x + y, 0); if (t >= (k === '*' ? 1 : 200)) out.set(k, a.map((x) => x / t)); }
  return { by: out, runs: rows.length };
}

// 🧪 a scenario's Matching changes, for a month ('YYYY-MM'): Matching machines added, removed (downtime) or
// sped up / slowed, a customer's (or everyone's) Matching OEE in points, its share through Matching set, and
// Matching's renewal window. The rest of a scenario (volumes, new customers, shifts) comes through the plan.
const inRange = (ymKey, c) => (!c.from || ymKey >= c.from) && (!c.to || ymKey <= c.to);
const MCH = ['m_add', 'm_remove', 'm_speed', 'm_oee', 'm_share', 'm_rnw_window'];
function scenarioAt(changes, ymKey, M, R, OE) {
  const cs = (changes || []).filter((c) => MCH.includes(c.type) && inRange(ymKey, c));
  if (!cs.length) return { M, R, OE, window: null, any: false };
  const list = [...M.list.filter((m) => !cs.some((c) => c.type === 'm_remove' && c.machine === m.name)),
    ...cs.filter((c) => c.type === 'm_add').map((c) => ({ name: c.name || 'New Matching machine', speed: Number(c.speed) || 0, match: '', key: '', measure: false, added: true }))]
    .map((m) => { let s = m.speed; for (const c of cs) if (c.type === 'm_speed' && (!c.machine || c.machine === m.name)) s *= 1 + (Number(c.pct) || 0) / 100; return { ...m, speed: s }; });
  const share = (tri) => { let v = null; for (const c of cs) if (c.type === 'm_share' && (!c.customer || c.customer === tri) && c.share !== undefined && c.share !== '') v = Math.min(1, Math.max(0, Number(c.share) / 100)); return v; };
  const pts = (tri) => cs.filter((c) => c.type === 'm_oee' && (!c.customer || c.customer === tri)).reduce((a, c) => a + (Number(c.points) || 0) / 100, 0);
  const win = cs.filter((c) => c.type === 'm_rnw_window').pop();
  return { any: true, M: { ...M, list }, window: win ? (win.hours || []).map(Number) : null,
    R: { ...R, of: (tri) => { const v = share(tri); return v === null ? R.of(tri) : { ratio: v, from: 'scenario' }; } },
    OE: { ...OE, of: (tri) => { const e = OE.of(tri); const p = pts(tri); return p ? { oee: Math.max(0.05, Math.min(1, e.oee + p)), from: 'scenario' } : e; } } };
}

// 🥈 each customer's share of metal cards, from its work orders' lines the last 4 months (a card is metal when
// its material or tag in the card database, or its tag in the priority modifiers, says so); typed on
// Configuration › Customers (Matching picked) wins. No history: none.
function metalShares(cards) {
  const typed = json(setting('cpm_match_metal', '{}'), {}); const learned = new Map();
  try {
    const planning = require('./planning'); const tagBy = new Map(db.all('SELECT ax, tag FROM plan_card_tags').map((t) => [planning.axKey(t.ax), t.tag]));
    const memo = new Map(); const isMetal = (ax) => { const k = planning.axKey(ax); if (!memo.has(k)) { const c = cards?.get?.(k); memo.set(k, /metal/i.test([c?.material, c?.tag, tagBy.get(k)].filter(Boolean).join(' '))); } return memo.get(k); };
    const acc = new Map(); const add = (k, q, m) => { const a = acc.get(k) || acc.set(k, { qty: 0, metal: 0 }).get(k); a.qty += q; if (m) a.metal += q; };
    for (const l of db.all('SELECT upper(j.customer) AS tri, l.article, l.qty FROM plan_history_lines l JOIN plan_history_jobs j ON j.key = l.key WHERE j.first_seen >= ? AND j.customer IS NOT NULL', [since()])) {
      const q = Number(l.qty) || 0; if (!q) continue; const m = isMetal(l.article); add(l.tri, q, m); add('*', q, m);
    }
    for (const [k, a] of acc) if (a.qty > 0) learned.set(k, { share: a.metal / a.qty, qty: a.qty, metal: a.metal });
  } catch { /* no history */ }
  return { typed, learned, of: (tri) => { const t = typed[tri]; if (t !== undefined && t !== null && t !== '') return { share: Math.min(1, Math.max(0, Number(t) || 0)), from: 'typed' }; const l = learned.get(tri); return l ? { share: l.share, from: 'learned' } : { share: 0, from: 'none' }; } };
}

// the customers' Matching items for a month of a plan (cpm.compute), with how they're worked out
// each customer's Matching work by priority, learned from Matching's work orders (an average day): its own with
// 3 days or more, else everyone's, else all Normal
const PRIOS = ['urgent', 'high', 'normal', 'low'];
function prios() {
  const pm = require('./cpmday').prioMix('plan_otto_jobs'); const all = pm.get('*');
  return { of: (tri) => { const o = tri ? pm.get(tri) : null; const p = o && o.days >= 3 ? o : all && all.days ? all : null;
    return { mix: p ? { urgent: p.urgent, high: p.high, normal: p.normal, low: p.low } : { urgent: 0, high: 0, normal: 1, low: 0 }, from: p === o && o ? 'learned' : p ? 'everyone' : 'none', days: o ? o.days : 0 }; }, all: all || null, map: pm };
}
function customersOf(plan, m, R, M, OE = oees(M), PR = prios(), MS = metalShares(null)) {
  const by = new Map();
  for (const D of plan.detail) { const x = D.months[m]; if (!x) continue; const k = D.trigram || `~${D.name}`; const c = by.get(k) || by.set(k, { trigram: D.trigram || '', name: D.name, cards: 0, added: 0 }).get(k); c.cards += x.fc * x.split; c.added += (x.extra || 0) * x.split; }
  return [...by.values()].map((c) => {
    const r = R.of(c.trigram); const items = c.cards * r.ratio; const cs = M.cust.get(c.trigram) || 0; const slow = cs > 0 && M.ref > 0 ? M.ref / cs : 1; const e = OE.of(c.trigram);
    const pr = PR.of(c.trigram);
    // metal items at the metal machines' speed (none ticked or no metal speed: as the rest, with a warning)
    const ms = MS.of(c.trigram); const metalItems = items * ms.share; const mf = M.metal_ref > 0 && M.ref > 0 ? M.ref / M.metal_ref : 1;
    const need = ((items - metalItems) / e.oee) * slow + (metalItems / e.oee) * mf;
    return { ...c, prio: pr.mix, prio_from: pr.from, ratio: r.ratio, ratio_from: r.from, items, own_speed: cs || null, own_factor: slow, speed_factor: items > 0 ? (need * e.oee) / items : slow, oee: e.oee, oee_from: e.from, need, added_items: c.added * r.ratio,
      metal_share: ms.share, metal_from: ms.from, metal_items: metalItems, metal_load: M.metal_ref > 0 ? metalItems / e.oee : 0 };
  }).filter((c) => c.items > 0.5).sort((a, b) => b.need - a.need);
}

// 📊 the year by month: Matching's items, the machine time they need, against the machines' capacity
function monthly({ year, useFlex = true, cards = null, changes = [] }) {
  const plan = cpm.compute({ year, period: 'month', useFlex, cards, changes });
  const R = ratios(); const M = machines(); const o = oee(); const OE = oees(M); const PR = prios(); const MS = metalShares(cards); const capH = M.list.reduce((a, m) => a + m.speed, 0); const warnings = [];
  if (!M.list.length) warnings.push('No Matching machines in Production › Setup — there\'s no Matching capacity to plan against');
  else if (!capH) warnings.push('The Matching machines have no speed (Production › Setup) — their capacity can\'t be worked out');
  if (!R.learned.get('*')?.match) warnings.push('No Matching timing runs in the last 4 months — each customer\'s share through Matching can\'t be learned; type them on Configuration › Matching');
  const months = plan.periods.map((P, i) => {
    const X = scenarioAt(changes, `${year}-${pad(i + 1)}`, M, R, OE); const capHm = X.M.list.reduce((a, m) => a + m.speed, 0);
    const custs = customersOf(plan, i + 1, X.R, M, X.OE, PR, MS); const items = custs.reduce((a, c) => a + c.items, 0); const need = custs.reduce((a, c) => a + c.need, 0);
    const capacity = capHm * (P.hours || 0); // speed × (working days × shifts × hours a shift counted)
    return { key: P.key, label: P.label, workdays: P.workdays, hours: P.hours || 0, cards: custs.reduce((a, c) => a + c.cards, 0), items, need, capacity, load: capacity ? need / capacity : null,
      prio: Object.fromEntries(PRIOS.map((k) => [k, custs.reduce((a, c) => a + c.need * c.prio[k], 0)])),
      metal: (() => { const it = custs.reduce((a, c) => a + c.metal_items, 0); const ld = custs.reduce((a, c) => a + c.metal_items / c.oee, 0); const cap = M.metal_cap * (P.hours || 0); return { items: it, load: cap ? ld / cap : null }; })(),
      added: custs.reduce((a, c) => a + (c.added_items / c.oee) * c.speed_factor, 0), top: custs.slice(0, 8).map((c) => ({ trigram: c.trigram, name: c.name, items: c.items, need: c.need })) };
  });
  const metalAny = months.some((x) => x.metal.items > 0.5);
  if (metalAny && !M.metal_machines.length) warnings.push('Some customers have metal cards, but no Matching machine is ticked for metal (Production › Setup) — they\'re counted at the usual speed');
  else if (metalAny && !(M.metal_ref > 0)) warnings.push('The Matching machines ticked for metal have no metal speed (Production › Setup) — metal cards are counted at the usual speed');
  for (const x of months) if (x.metal.load > 1) warnings.push(`${x.label}: the metal cards need ${Math.round(x.metal.load * 100)}% of the metal machines' time (${M.metal_machines.join(', ')}) — more than they have, even running nothing else`);
  return { year, flex: !!useFlex, oee: o, metal_machines: M.metal_machines, metal_ref: M.metal_ref, machines: M.list, ref_speed: M.ref, capacity_hour: capH, months, warnings, forecast_as_of: plan.forecast_as_of };
}

// 🕐 a working day of a month, hour by hour — laid out as perso's CPM Daily is (a technology of its own,
// 'Matching'), so the same views work on it: as it comes in, smoothed, as work orders, the drill-down.
// Each customer's items a day split into daily work (Urgent / High / Normal) and renewals (Low), by its Matching
// work orders; the daily work spread as its Matching runs ended, the renewals over Matching's renewal window
// (Configuration › Matching; none: every hour worked); campaigns ticked for Matching added in their own colour.
// "cards" in the shared fields are Matching's items here.
const MT = 'Matching';
// each customer's typical Matching work order (items, the median lately): daily (D) and renewals (R) apart
function orderSizes() {
  let jobs = []; try { jobs = db.all('SELECT customer, qty, prio FROM plan_otto_jobs WHERE first_seen >= ? AND customer IS NOT NULL AND qty > 0', [since()]); } catch { return new Map(); }
  const by = new Map(); const add = (k, q) => (by.get(k) || by.set(k, []).get(k)).push(q);
  for (const j of jobs) { const kind = /^low/i.test(String(j.prio || '')) ? 'R' : 'D'; const tri = String(j.customer).toUpperCase(); add(`${kind}|${tri}|${MT}`, Number(j.qty)); add(`${kind}|*|${MT}`, Number(j.qty)); }
  const out = new Map(); for (const [k, a] of by) if (a.length >= (k.includes('|*|') ? 1 : 3)) { a.sort((x, y) => x - y); out.set(k, a[Math.floor(a.length / 2)]); }
  return out;
}
function day({ year, month, useFlex = true, cards = null, changes = [] }) {
  const CD = require('./cpmday');
  const plan = cpm.compute({ year, period: 'month', useFlex, cards, changes }); const P = plan.periods[month - 1] || {};
  const R0 = ratios(); const M0 = machines(); const o = oee(); const OE0 = oees(M0); const PR = prios(); const prof = profiles(); const warnings = [];
  const X = scenarioAt(changes, `${year}-${pad(month)}`, M0, R0, OE0); const R = X.R; const OE = X.OE; const M = X.M;
  const start = Math.floor(hm(setting('plan_day_start', '06:00'), 360) / 60) % 24; const H = Array.from({ length: 24 }, (_, i) => (start + i) % 24);
  const shifts = P.shifts ?? 3; const first = Math.floor(hm(setting('plan_shift_morning', '05:45'), 345) / 60 + 0.5) % 24;
  const worked = new Set(Array.from({ length: Math.min(24, Math.round(shifts * 8)) }, (_, i) => (first + i) % 24));
  const factor = Math.min(1, cpm.shiftHours() / 8); const days = P.workdays || 0;
  const bonus = Number(setting('cpm_rnw_bonus', '0.05')) || 0;
  if (!M.list.length) warnings.push('No Matching machines in Production › Setup — there\'s no Matching capacity to plan against');
  if (!prof.runs) warnings.push('No Matching timing runs in the last 4 months — each day is spread evenly over the hours worked');
  const even = H.map((h) => (worked.has(h) ? 1 / worked.size : 0));
  // the shipping cut-offs: as perso's (the customer's, typed or learned, else the default)
  const cuts = CD.customerCutoffs(); const typedCut = json(setting('cpm_cutoff_cust', '{}'), {}); const hrs = (t) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60; const defCut = CD.defaultCutoff();
  const cutoffOf = (tri) => (tri && /^\d{2}:\d{2}$/.test(typedCut[tri] || '') ? hrs(typedCut[tri]) : tri && cuts.has(tri) ? cuts.get(tri) : hrs(defCut));
  const rows = [];
  // a line: v items a month (its share of a customer), e its OEE, the customer's priorities and timing
  const line = (c, v, added, extra = {}) => {
    if (!(v > 0)) return null;
    const pr = c.prio; const low = extra.kind === 'renewal' ? 1 : extra.kind === 'daily' ? 0 : pr.low; const dmix = 1 - pr.low > 1e-9 ? { urgent: pr.urgent / (1 - pr.low), high: pr.high / (1 - pr.low), normal: pr.normal / (1 - pr.low) } : { urgent: 0, high: 0, normal: 1 };
    const pp = prof.by.get(c.trigram) || prof.by.get('*'); const from = prof.by.get(c.trigram) ? 'own' : pp ? 'technology' : 'even';
    const shares = pp ? H.map((h) => pp[h]) : even;
    const eff = c.oee / c.speed_factor; const effR = Math.min(1, c.oee + bonus) / c.speed_factor; // items per unit of capacity needed (the customer's OEE, its speed)
    const daily = days ? (v * (1 - low)) / days : 0; const renew = days ? (v * low) / days : 0;
    const r = { trigram: c.trigram, name: c.name, added: added || null, tech: MT, month_volume: v, daily_pct: 1 - low, rnw_pct: low, rnw_learned: pr.low, rnw_learned_days: c.prio_days || null, rnw_learned_whole: null, rnw_typed: null,
      prio: dmix, prio_from: c.prio_from === 'none' ? 'none' : c.prio_from, prio_learned: c.prio_from === 'learned' ? dmix : null, prio_days: c.prio_days || 0,
      oee: eff, oee_rnw: effR, oee_match: c.oee, oee_from: c.oee_from, ratio: c.ratio, ratio_from: c.ratio_from, own_speed: c.own_speed, speed_factor: c.speed_factor,
      workdays: days, daily, renew, need_daily: daily / eff, need_rnw: renew / effR, profile: from, peak: null, learned_shares: shares, learned_from: from, produced_shares: shares, arrive_avg: pp ? CD.meanHour(pp) : null, arrive_seen: null, shares,
      hours: shares.map((s) => (daily / eff) * s), cards_hours: shares.map((s) => daily * s), cutoff: cutoffOf(c.trigram), cutoff_typed: (c.trigram && typedCut[c.trigram]) || null,
      cutoff_learned: c.trigram && cuts.has(c.trigram) ? cuts.get(c.trigram) : null, ...extra };
    r.cutoff_default = !r.cutoff_typed && r.cutoff_learned === null; r.metal_share = c.metal_share || 0; r.metal_from = c.metal_from || 'none'; r.cards_day = days ? (v / (c.ratio || 1)) / days : 0; r.items_day = daily + renew; r.need_day = r.need_daily + r.need_rnw;
    rows.push(r); return r;
  };
  const MS = metalShares(cards); const custs = customersOf(plan, month, R, M0, OE, PR, MS); // (the speed factor against the machines as they are)
  const metalIt = custs.reduce((a, c) => a + c.metal_items, 0); const metalLd = custs.reduce((a, c) => a + c.metal_items / c.oee, 0); const metalCapDay = M0.metal_cap * (worked.size * factor) * (days || 0);
  if (metalIt > 0.5 && !M0.metal_machines.length) warnings.push('Some customers have metal cards, but no Matching machine is ticked for metal (Production › Setup) — they\'re counted at the usual speed');
  else if (metalIt > 0.5 && !(M0.metal_ref > 0)) warnings.push('The Matching machines ticked for metal have no metal speed (Production › Setup) — metal cards are counted at the usual speed');
  else if (metalCapDay && metalLd > metalCapDay) warnings.push(`The metal cards need ${Math.round((metalLd / metalCapDay) * 100)}% of the metal machines' time (${M0.metal_machines.join(', ')}) — more than they have, even running nothing else`);
  const byTri = new Map();
  for (const c of custs) {
    const pr = PR.of(c.trigram); const cc = { ...c, prio_days: pr.days }; byTri.set(c.trigram, cc);
    const extra = Math.min(c.items, c.added_items || 0);
    line(cc, c.items - extra, null); if (extra > 0.5) line({ ...cc, name: `${c.name} — scenario +` }, extra, 'scenario');
  }
  // 📣 campaigns ticked for Matching: the cards a working day × its share through Matching, daily or renewals as set
  const camps = json(setting('cpm_campaigns', '[]'), []); const ymOf = `${year}-${pad(month)}`;
  for (const c of Array.isArray(camps) ? camps : []) {
    if (!c || c.off || c.match === false || !(Number(c.qty) > 0) || !c.customer || !/^\d{4}-\d{2}-\d{2}$/.test(c.from || '')) continue;
    const from = c.from; const to = /^\d{4}-\d{2}-\d{2}$/.test(c.to || '') ? c.to : from; if (to.slice(0, 7) < ymOf || from.slice(0, 7) > ymOf) continue;
    let all = 0; let here = 0;
    for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) for (const dd of cpm.calendarOf(y)) if (dd.work && dd.day >= from && dd.day <= to) { all++; if (dd.month === ymOf) here++; }
    if (!all || !here) continue;
    const tri = String(c.customer).toUpperCase(); const r = R.of(tri); const e = OE.of(tri); const pr = PR.of(tri); const cs = M.cust.get(tri) || 0;
    const base = byTri.get(tri) || { trigram: tri, name: tri, prio: pr.mix, prio_from: pr.from, prio_days: pr.days, ratio: r.ratio, ratio_from: r.from, oee: e.oee, oee_from: e.from, own_speed: cs || null, speed_factor: cs > 0 && M.ref > 0 ? M.ref / cs : 1 };
    const asRnw = c.kind === 'renewal'; const items = (Number(c.qty) / all) * days * base.ratio; // this month's working days' worth
    line({ ...base, name: `${c.name || 'Campaign'}${asRnw ? ' (renewals)' : ''}` }, items, 'campaign', { kind: asRnw ? 'renewal' : 'daily', campaign: c.name || 'Campaign', campaign_kind: asRnw ? 'renewal' : 'daily' });
  }
  for (const r of rows) delete r.kind;
  rows.sort((a, b) => (a.added ? 1 : 0) - (b.added ? 1 : 0) || b.need_day - a.need_day);
  // the renewals: over Matching's window (none set: every hour worked)
  const win = (X.window || json(setting('cpm_rnw_hours', '{}'), {})[MT] || []).map(Number).filter((h) => h >= 0 && h < 24);
  const rHours = win.length ? win : [...worked]; const rNeed = rows.reduce((a, r) => a + r.need_rnw, 0);
  const rnwT = { need: rNeed, hours: rHours, window: !!win.length, per: H.map((h) => (rHours.includes(h) ? rNeed / rHours.length : 0)) };
  const cap = H.map((h) => (worked.has(h) ? M.list.reduce((a, m) => a + m.speed, 0) * factor : 0));
  const tech = CD.techDay({ t: MT, H, rows, rnw: rnwT, cap, cutoffOf });
  // by priority, as it comes in: each hour's capacity to the Urgent work waiting first, then High, Normal and Low
  const prio = { urgent: tech.prio.urgent, high: tech.prio.high, normal: tech.prio.normal, low: rnwT.per };
  const left = Object.fromEntries(PRIOS.map((k) => [k, 0])); const waiting = Object.fromEntries(PRIOS.map((k) => [k, Array(24).fill(0)]));
  H.forEach((_, i) => { let free = cap[i]; for (const k of PRIOS) { const want = left[k] + prio[k][i]; const done = Math.min(want, free); free -= done; left[k] = want - done; waiting[k][i] = left[k]; } });
  // as work orders: each customer's day cut into Matching work orders of its usual size, on the first free machine
  const mach = M.list.filter((m) => m.speed > 0).map((m) => ({ name: m.name, techs: [MT], speed: { [MT]: m.speed }, avail: 1 }));
  let blocks = null;
  try { blocks = CD.runBlocks({ H, rows, machines: mach, workedAt: (i) => worked.has(H[i]), factor, rnwHours: { [MT]: win }, sizes: orderSizes(), allowed: () => 1, cutoffOf }); } catch (err) { warnings.push(`The work-order run couldn't be worked out: ${err.message}`); }
  const ship = CD.shipTimes(); const T = tech.total;
  return { line: 'match', unit: 'items', year, month, label: new Date(year, month - 1, 15).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), workdays: days, hours: H, worked: H.map((h) => worked.has(h)), shifts, hph: P.hph, full: true, hour_share: factor,
    techs: [MT], rows, renewals: { [MT]: rnwT }, windows: { [MT]: win }, bonus, profile_source: 'produced', day_shape: 'typical', peak_source: null, arrivals_seen: null, actual: { days: 0 },
    capacity_machines: mach.map((m) => ({ ...m, share: H.map(() => ({ [MT]: 1 })) })), capacity_by_machine: { [MT]: mach.map((m) => ({ name: m.name, per: H.map((h) => (worked.has(h) ? m.speed[MT] * factor : 0)) })) },
    tech: { [MT]: tech }, blocks, cutoffs: ship.times.map((x) => x.time), cutoff_labels: ship.times.map((x) => x.label), ship_times: ship, cutoff_typed: typedCut, cutoff_default: defCut,
    rnw_share_typed: {}, prio_typed: {}, prio_all: PR.all, campaigns: Array.isArray(camps) ? camps : [], manual: {}, learned: { runs: prof.runs, renewals: 0 }, forecast_as_of: plan.forecast_as_of, flex: useFlex, warnings,
    // Matching's own: the OEE, the machines, the day by priority and what's left of it
    oee: o, machines: M.list, ref_speed: M.ref, profile_runs: prof.runs, need: tech.need, capacity: cap, backlog: tech.backlog, load: tech.load, added: H.map((_, i) => tech.added[i] + tech.added_rnw[i]), prio, waiting_prio: waiting,
    total: { need: T.need, items: rows.reduce((a, r) => a + r.items_day, 0), capacity: T.capacity, load: T.load, end_backlog: T.end_backlog, end_prio: left, hours_over: T.hours_over } };
}

// what Configuration › Matching shows: each customer's learned and typed share, the machines and the OEE
function config(cards = null) {
  const R = ratios(); const M = machines(); const OE = oees(M); const PR = prios(); const MS = metalShares(cards); const names = new Map(cpm.customers().map((c) => [c.trigram, c.name || c.trigram]));
  const tris = [...new Set([...R.learned.keys(), ...Object.keys(R.typed), ...cpm.customers().filter((c) => c.active).map((c) => c.trigram)])].filter((t) => t && t !== '*').sort();
  return { oee: oee(), everyone: R.learned.get('*') || null, machines: M.list.map((m) => ({ ...m, runs: OE.measured.runs.get(m.name) ?? null })), ref_speed: M.ref, measured_all: OE.measured.by.get('*') || null, customer_speeds: [...M.cust].map(([customer, speed]) => ({ customer, speed })),
    customers: tris.map((t) => { const l = R.learned.get(t) || null; const ms = OE.measured.by.get(t) || null;
      return { trigram: t, name: names.get(t) || '', learned: l ? l.ratio : null, perso: l ? l.perso : 0, match: l ? l.match : 0, typed: R.typed[t] ?? null, own_speed: M.cust.get(t) || null,
        oee_measured: ms ? ms.oee : null, oee_raw: ms ? ms.raw : null, oee_hours: ms ? ms.hours : 0, oee_typed: OE.typed[t] ?? null, prio: PR.of(t), metal_learned: MS.learned.get(t)?.share ?? null, metal_typed: MS.typed[t] ?? null }; }), prio_all: PR.all, metal_machines: M.metal_machines, metal_ref: M.metal_ref,
    rnw_hours: json(setting('cpm_rnw_hours', '{}'), {}), window: (json(setting('cpm_rnw_hours', '{}'), {}).Matching || []).map(Number), hours: Array.from({ length: 24 }, (_, i) => (Math.floor(hm(setting('plan_day_start', '06:00'), 360) / 60) + i) % 24) };
}

module.exports = { metalShares, monthly, day, config, learnedRatios, profiles, machines, oee, measuredOee, oees };
