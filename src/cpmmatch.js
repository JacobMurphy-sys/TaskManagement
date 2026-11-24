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
  let ms = []; try { ms = db.all('SELECT name, speed, match FROM plan_otto_machines WHERE active = 1 ORDER BY sort_order, id'); } catch { /* none */ }
  let cs = []; try { cs = db.all('SELECT customer, speed FROM plan_otto_speeds'); } catch { /* none */ }
  const elig = new Set(json(setting('cpm_match_oee_machines', '[]'), []).map((x) => String(x).toLowerCase()));
  const list = ms.map((m) => ({ name: m.name, speed: Number(m.speed) || 0, match: m.match || '', key: String(m.match || m.name || '').trim().toLowerCase(), measure: elig.has(String(m.name).toLowerCase()) }));
  const fast = list.filter((m) => m.speed > 0);
  return { list, ref: fast.length ? fast.reduce((a, m) => a + m.speed, 0) / fast.length : 0, cust: new Map(cs.map((c) => [String(c.customer).toUpperCase(), Number(c.speed) || 0])) };
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

// each customer's OEE measured on the machines ticked for it (Configuration › Matching): items made ÷ (its run hours
// × the machine's rated speed), the last 4 months; '*' all of them. Only machines whose runs reflect the customer's
// own work are ticked — others (manual stations, mixed lines) would mislead. Run time only, so it's on the high side.
function measuredOee(M = machines()) {
  const elig = M.list.filter((m) => m.measure && m.speed > 0 && m.key); const out = new Map(); const runs = new Map(elig.map((m) => [m.name, 0]));
  if (!elig.length) return { by: out, runs };
  let rows = []; try { rows = db.all("SELECT upper(trigram) AS tri, machine, start_at, end_at, qty FROM prod_runs WHERE source = 'otto' AND remake = 0 AND end_at IS NOT NULL AND start_at >= ?", [since()]); } catch { /* none */ }
  const acc = new Map(); const add = (k, items, std, hrs) => { const a = acc.get(k) || acc.set(k, { items: 0, std: 0, hours: 0 }).get(k); a.items += items; a.std += std; a.hours += hrs; };
  for (const r of rows) {
    const mach = String(r.machine || '').toLowerCase(); const m = elig.find((x) => mach.includes(x.key)); if (!m) continue;
    const hrs = (new Date(r.end_at) - new Date(r.start_at)) / 3600000; if (!(hrs > 0) || hrs > 24) continue; const q = Number(r.qty) || 0; if (!q) continue;
    runs.set(m.name, runs.get(m.name) + 1); if (r.tri) add(r.tri, q, hrs * m.speed, hrs); add('*', q, hrs * m.speed, hrs);
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

// the customers' Matching items for a month of a plan (cpm.compute), with how they're worked out
function customersOf(plan, m, R, M, OE = oees(M)) {
  const by = new Map();
  for (const D of plan.detail) { const x = D.months[m]; if (!x) continue; const k = D.trigram || `~${D.name}`; const c = by.get(k) || by.set(k, { trigram: D.trigram || '', name: D.name, cards: 0, added: 0 }).get(k); c.cards += x.fc * x.split; c.added += (x.extra || 0) * x.split; }
  return [...by.values()].map((c) => {
    const r = R.of(c.trigram); const items = c.cards * r.ratio; const cs = M.cust.get(c.trigram) || 0; const slow = cs > 0 && M.ref > 0 ? M.ref / cs : 1; const e = OE.of(c.trigram);
    return { ...c, ratio: r.ratio, ratio_from: r.from, items, own_speed: cs || null, speed_factor: slow, oee: e.oee, oee_from: e.from, need: (items / e.oee) * slow, added_items: c.added * r.ratio };
  }).filter((c) => c.items > 0.5).sort((a, b) => b.need - a.need);
}

// 📊 the year by month: Matching's items, the machine time they need, against the machines' capacity
function monthly({ year, useFlex = true, cards = null, changes = [] }) {
  const plan = cpm.compute({ year, period: 'month', useFlex, cards, changes });
  const R = ratios(); const M = machines(); const o = oee(); const OE = oees(M); const capH = M.list.reduce((a, m) => a + m.speed, 0); const warnings = [];
  if (!M.list.length) warnings.push('No Matching machines in Production › Setup — there\'s no Matching capacity to plan against');
  else if (!capH) warnings.push('The Matching machines have no speed (Production › Setup) — their capacity can\'t be worked out');
  if (!R.learned.get('*')?.match) warnings.push('No Matching timing runs in the last 4 months — each customer\'s share through Matching can\'t be learned; type them on Configuration › Matching');
  const months = plan.periods.map((P, i) => {
    const custs = customersOf(plan, i + 1, R, M, OE); const items = custs.reduce((a, c) => a + c.items, 0); const need = custs.reduce((a, c) => a + c.need, 0);
    const capacity = capH * (P.hours || 0); // speed × (working days × shifts × hours a shift counted)
    return { key: P.key, label: P.label, workdays: P.workdays, hours: P.hours || 0, cards: custs.reduce((a, c) => a + c.cards, 0), items, need, capacity, load: capacity ? need / capacity : null,
      added: custs.reduce((a, c) => a + (c.added_items / c.oee) * c.speed_factor, 0), top: custs.slice(0, 8).map((c) => ({ trigram: c.trigram, name: c.name, items: c.items, need: c.need })) };
  });
  return { year, flex: !!useFlex, oee: o, machines: M.list, ref_speed: M.ref, capacity_hour: capH, months, warnings, forecast_as_of: plan.forecast_as_of };
}

// 🕐 a working day of a month, hour by hour
function day({ year, month, useFlex = true, cards = null, changes = [] }) {
  const plan = cpm.compute({ year, period: 'month', useFlex, cards, changes }); const P = plan.periods[month - 1] || {};
  const R = ratios(); const M = machines(); const o = oee(); const prof = profiles(); const warnings = [];
  const start = Math.floor(hm(setting('plan_day_start', '06:00'), 360) / 60) % 24; const H = Array.from({ length: 24 }, (_, i) => (start + i) % 24);
  const shifts = P.shifts ?? 3; const first = Math.floor(hm(setting('plan_shift_morning', '05:45'), 345) / 60 + 0.5) % 24;
  const worked = new Set(Array.from({ length: Math.min(24, Math.round(shifts * 8)) }, (_, i) => (first + i) % 24));
  const factor = Math.min(1, cpm.shiftHours() / 8); const days = P.workdays || 0;
  if (!M.list.length) warnings.push('No Matching machines in Production › Setup — there\'s no Matching capacity to plan against');
  if (!prof.runs) warnings.push('No Matching timing runs in the last 4 months — each day is spread evenly over the hours worked');
  const even = H.map((h) => (worked.has(h) ? 1 / worked.size : 0));
  const rows = customersOf(plan, month, R, M).map((c) => {
    const p = prof.by.get(c.trigram) || prof.by.get('*'); const from = prof.by.get(c.trigram) ? 'own' : p ? 'matching' : 'even';
    const shares = p ? H.map((h) => p[h]) : even; const itemsDay = days ? c.items / days : 0; const needDay = days ? c.need / days : 0;
    return { trigram: c.trigram, name: c.name, cards_day: days ? c.cards / days : 0, ratio: c.ratio, ratio_from: c.ratio_from, oee: c.oee, oee_from: c.oee_from, items_day: itemsDay, need_day: needDay, own_speed: c.own_speed, speed_factor: c.speed_factor, profile: from, shares,
      hours: shares.map((s) => needDay * s), items_hours: shares.map((s) => itemsDay * s), added_day: days ? ((c.added_items / c.oee) * c.speed_factor) / days : 0 };
  });
  const capacity = H.map((h) => (worked.has(h) ? M.list.reduce((a, m) => a + m.speed, 0) * factor : 0));
  const byMachine = M.list.map((m) => ({ name: m.name, per: H.map((h) => (worked.has(h) ? m.speed * factor : 0)) }));
  const need = H.map((_, i) => rows.reduce((a, r) => a + r.hours[i], 0)); const items = H.map((_, i) => rows.reduce((a, r) => a + r.items_hours[i], 0));
  const added = H.map((_, i) => rows.reduce((a, r) => a + r.added_day * r.shares[i], 0));
  let carry = 0; const backlog = need.map((v, i) => { carry = Math.max(0, carry + v - capacity[i]); return carry; });
  const tot = need.reduce((a, b) => a + b, 0); const capTot = capacity.reduce((a, b) => a + b, 0);
  return { year, month, label: new Date(year, month - 1, 15).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), workdays: days, hours: H, worked: H.map((h) => worked.has(h)), oee: o,
    machines: M.list, ref_speed: M.ref, rows, need, items, added, capacity, by_machine: byMachine, load: need.map((v, i) => (capacity[i] ? v / capacity[i] : v ? null : 0)), backlog,
    total: { need: tot, items: items.reduce((a, b) => a + b, 0), capacity: capTot, load: capTot ? tot / capTot : null, end_backlog: carry, hours_over: need.filter((v, i) => v > capacity[i] + 0.5).length },
    profile_runs: prof.runs, warnings };
}

// what Configuration › Matching shows: each customer's learned and typed share, the machines and the OEE
function config() {
  const R = ratios(); const M = machines(); const OE = oees(M); const names = new Map(cpm.customers().map((c) => [c.trigram, c.name || c.trigram]));
  const tris = [...new Set([...R.learned.keys(), ...Object.keys(R.typed), ...cpm.customers().filter((c) => c.active).map((c) => c.trigram)])].filter((t) => t && t !== '*').sort();
  return { oee: oee(), everyone: R.learned.get('*') || null, machines: M.list.map((m) => ({ ...m, runs: OE.measured.runs.get(m.name) ?? null })), ref_speed: M.ref, measured_all: OE.measured.by.get('*') || null, customer_speeds: [...M.cust].map(([customer, speed]) => ({ customer, speed })),
    customers: tris.map((t) => { const l = R.learned.get(t) || null; const ms = OE.measured.by.get(t) || null;
      return { trigram: t, name: names.get(t) || '', learned: l ? l.ratio : null, perso: l ? l.perso : 0, match: l ? l.match : 0, typed: R.typed[t] ?? null, own_speed: M.cust.get(t) || null,
        oee_measured: ms ? ms.oee : null, oee_raw: ms ? ms.raw : null, oee_hours: ms ? ms.hours : 0, oee_typed: OE.typed[t] ?? null }; }) };
}

module.exports = { monthly, day, config, learnedRatios, profiles, machines, oee, measuredOee, oees };
