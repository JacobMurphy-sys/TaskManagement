'use strict';
// 🧠 Planning that learns from what really ran: the ⏱ Production runs (the daily timing reports)
// over a window, anomalies taken out, matched to the card database. From them:
// - speeds: each kind of card's running speed (cards an hour once a run is going, its machine's
//   usual set-up taken off), against the speed Planning uses now → suggested speed rules;
// - OEE: each customer's runs against the time they'd take at the speeds as they are now
//   → suggested estimated OEE;
// - accuracy: how close Planning's times are to what ran, now and with the learned values
//   (learned on the older runs, tested on the newest, so it isn't marking its own homework);
// - patterns: pace by machine, shift, weekday, job size and week; cards that run unlike their
//   kind; the runs furthest over; remakes; lateness by customer and shipper; Matching speeds;
// - findings: the few things worth acting on, in words.
// Pace: the time the cards would take at their kind's learned running speed ÷ the time they took
// (100% = as usual for that kind of card, so the card mix doesn't colour the comparison).
const db = require('./db');
const prod = require('./prodactual');
const planning = require('./planning');

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lc = (v) => String(v ?? '').trim().toLowerCase();
const kindKey = (k) => [k.type, k.material, k.sides].map(lc).join('|');
const r1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const r3 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
const WITHIN = Math.log(1.25); // "close": within 25% either way

// The median weighted by w (each run counts by its cards).
function wmedian(xs, ws) {
  const idx = xs.map((_, i) => i).filter((i) => Number.isFinite(xs[i]) && ws[i] > 0).sort((a, b) => xs[a] - xs[b]);
  const total = idx.reduce((t, i) => t + ws[i], 0);
  if (!total) return null;
  let acc = 0;
  for (const i of idx) { acc += ws[i]; if (acc >= total / 2) return xs[i]; }
  return xs[idx[idx.length - 1]];
}
const quantile = (xs, q) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const p = (a.length - 1) * q; const lo = Math.floor(p); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (p - lo); };
const confidence = (n, days) => (n >= 30 && days >= 5 ? 'high' : n >= 10 && days >= 2 ? 'medium' : 'low');
const groupBy = (xs, fn) => { const m = new Map(); for (const x of xs) { const k = fn(x); if (k === null || k === undefined) continue; (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };

// Speeds (by kind) and OEE (by customer, against `speedOf`) learned from a set of runs.
function speedsOf(runs) {
  const out = new Map();
  for (const [k, list] of groupBy(runs.filter((r) => r.kind), (r) => r.kindKey)) {
    if (list.length < 5) continue;
    const days = new Set(list.map((r) => r.start_at.slice(0, 10))).size;
    out.set(k, { kind: list[0].kind, speed: wmedian(list.map((r) => r.rate), list.map((r) => r.qty)), runs: list.length, days,
      cards: list.reduce((t, r) => t + r.qty, 0), p25: quantile(list.map((r) => r.rate), 0.25), p75: quantile(list.map((r) => r.rate), 0.75) });
  }
  return out;
}
const overallRate = (runs) => wmedian(runs.map((r) => r.rate), runs.map((r) => r.qty));
function oeeOf(runs, idealOf) {
  const out = new Map();
  for (const [c, list] of groupBy(runs, (r) => r.customer)) {
    const used = list.map((r) => ({ r, ideal: idealOf(r) })).filter((x) => x.ideal > 0);
    if (used.length < 5) continue;
    const ideal = used.reduce((t, x) => t + x.ideal, 0); const actual = used.reduce((t, x) => t + x.r.minutes, 0);
    out.set(c, { oee: ideal / actual, runs: used.length, days: new Set(used.map((x) => x.r.start_at.slice(0, 10))).size, cards: used.reduce((t, x) => t + x.r.qty, 0), minutes: actual });
  }
  return out;
}
// How close planned times are to what ran: share within 25%, and the typical miss.
function closeness(pairs) {
  const ok = pairs.filter(([p, a]) => p > 0 && a > 0);
  if (!ok.length) return null;
  const logs = ok.map(([p, a]) => Math.log(a / p));
  return { runs: ok.length, within: r1((logs.filter((x) => Math.abs(x) <= WITHIN).length / ok.length) * 100),
    typical_miss: r1((Math.exp(quantile(logs.map(Math.abs), 0.5)) - 1) * 100),
    bias: r1((Math.exp(quantile(logs, 0.5)) - 1) * 100) }; // + : runs take longer than planned
}

// The perso runs over the window, judged and matched to their card. Each kept run:
// { …run, minutes, qty, kind, kindKey, customer, rate (running cards/h), setup }
function runsFor(source, days, now, cards) {
  const to = now; const from = new Date(now.getTime() - days * DAY);
  const raw = db.all(`SELECT * FROM prod_runs WHERE source = ? AND ${prod.KEEP} AND start_at >= ? AND start_at < ? ORDER BY start_at`, [source, stamp(from), stamp(to)]);
  const base = prod.baselines(raw);
  const judged = prod.judge(raw, base);
  const kept = []; let anomalies = 0;
  for (const r of judged) {
    if (r.anomaly) { anomalies++; continue; }
    if (!(r.minutes > 0) || !(r.qty > 0)) continue;
    const card = cards && r.item ? cards.get(planning.axKey(r.item)) || null : null;
    const kind = card && (card.type || card.material || card.sides) ? { type: card.type || null, material: card.material || null, sides: card.sides || null }
      : r.product ? { type: r.product, material: null, sides: null } : null;
    const b = base.get(r.machine) || base.all;
    const setup = b ? b.setup : 0;
    const net = Math.max(r.minutes - setup, r.minutes * 0.25);
    kept.push({ ...r, card, kind, kindKey: kind ? kindKey(kind) : null, customer: prod.trigramOf(r.job, r.trigram), setup, rate: (r.qty / net) * 60 });
  }
  return { runs: kept, anomalies, total: raw.length, base, from, to };
}

function shiftOf(d, starts) {
  const t = d.getHours() * 60 + d.getMinutes();
  const { night, morning, afternoon } = starts;
  if (morning < afternoon && t >= morning && t < afternoon) return 'morning';
  if (afternoon < night && t >= afternoon && t < night) return 'afternoon';
  return 'night';
}
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SIZES = [[0, 100, 'Under 100'], [100, 500, '100–499'], [500, 2000, '500–1,999'], [2000, Infinity, '2,000 and over']];
const mondayOf = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };

// ---- item-level run times ------------------------------------------------------------------------
// A card line's time = the usual set-up + its cards at its own running speed. The speed is learned
// for each card (AX) from its runs, leaning on what's known about it when it has few:
//   prior  = its kind's speed (type · material · sides; else all runs') × its customer's factor
//   speed  = the card's own speed blended with the prior: n runs of its own count against K_ITEM
//            (1 run: mostly the prior; 10 runs: mostly its own). Blended on the log scale.
// The customer factor (how their cards run against their kind) is blended to 1 the same way.
const K_ITEM = 3; const K_CUST = 10;
const logMean = (xs) => xs.reduce((t, x) => t + Math.log(x), 0) / xs.length;
function buildModel(runs) {
  if (!runs.length) return null;
  const kinds = speedsOf(runs);
  const fleet = overallRate(runs);
  const kindRate = (r) => kinds.get(r.kindKey)?.speed || fleet;
  const cust = new Map();
  for (const [c, l] of groupBy(runs, (r) => r.customer)) {
    const m = l.reduce((t, r) => t + Math.log(r.rate / kindRate(r)), 0) / l.length;
    cust.set(c, { factor: Math.exp((l.length / (l.length + K_CUST)) * m), runs: l.length });
  }
  const items = new Map();
  for (const [it, l] of groupBy(runs.filter((r) => r.item), (r) => planning.axKey(r.item))) items.set(it, { lr: logMean(l.map((r) => r.rate)), runs: l.length });
  const setups = runs.map((r) => r.setup).filter((x) => x > 0);
  return { kinds, fleet, cust, items, setup: setups.length ? quantile(setups, 0.5) : 0, runs: runs.length };
}
// → { minutes, rate, setup, from: 'card' | 'kind' | 'all', runs } or null when the model has nothing for it
// line: { article|item, qty, kindKey, customer }. withRule: a speed rule covers it — then only the
// card's own or its kind's history is used, never the all-runs average.
function predict(model, line, { withRule = false } = {}) {
  if (!model || !(line.qty > 0)) return null;
  const kind = model.kinds.get(line.kindKey);
  if (withRule && !kind && !model.items.has(planning.axKey(line.article ?? line.item))) return null;
  const c = model.cust.get(line.customer);
  const prior = (kind?.speed || model.fleet) * (c ? c.factor : 1);
  const own = model.items.get(planning.axKey(line.article ?? line.item));
  const rate = own ? Math.exp((own.runs * own.lr + K_ITEM * Math.log(prior)) / (own.runs + K_ITEM)) : prior;
  if (!(rate > 0)) return null;
  return { minutes: model.setup + (line.qty / rate) * 60, rate, setup: model.setup, from: own ? 'card' : kind ? 'kind' : 'all', runs: own ? own.runs : kind ? kind.runs : model.runs };
}
// The model from the last `days` of perso runs (cached until the runs or the cards change).
let modelCache = null;
function modelFor({ days = 180, now = new Date(), cards = null, cardsKey = '' } = {}) {
  const sig = `${days}|${ymd(now)}|${cardsKey}|${JSON.stringify(db.get("SELECT count(*) AS n, max(id) AS m, max(read_at) AS r FROM prod_runs WHERE source = 'perso'"))}`;
  if (!modelCache || modelCache.sig !== sig) modelCache = { sig, model: buildModel(runsFor('perso', days, now, cards).runs) };
  return modelCache.model;
}

/**
 * opts: { days, now, cards (Map|null), rules, oee: { by: Map, fallback }, rate (flat cards/h),
 *         custNames: Map, shiftStarts, ottoSpeeds: Map(customer → items/h), ottoMachines: [{ name, speed }] }
 */
function learn(opts) {
  const { days = 90, now = new Date(), cards = null, rules = [], oee = { by: new Map(), fallback: null }, rate = null, custNames = new Map(),
    shiftStarts = { night: 1305, morning: 345, afternoon: 825 }, ottoSpeeds = new Map(), ottoMachines = [] } = opts;
  const P = runsFor('perso', days, now, cards);
  const runs = P.runs;
  const nameOf = (c) => custNames.get(String(c || '').toUpperCase()) || null;

  // what Planning uses now for a run: the speed rule for its card (or the flat rate) and the OEE
  const currentSpeed = (r) => { const rule = r.kind ? planning.speedFor(r.kind, rules) : null; return rule ? Number(rule.speed) : Number(rate) > 0 ? Number(rate) : null; };
  const currentOee = (c) => { const f = oee.by.get(String(c || '').toUpperCase()) ?? oee.fallback ?? null; return f > 0 && f <= 1 ? f : null; };

  // ---- speeds by kind of card
  const learned = speedsOf(runs);
  const fleetRate = overallRate(runs);
  const speeds = [...learned.entries()].map(([k, s]) => {
    const rule = planning.speedFor(s.kind, rules);
    const now_ = rule ? Number(rule.speed) : Number(rate) > 0 ? Number(rate) : null;
    const exact = rule && kindKey(rule) === k;
    const speed = Math.round(s.speed);
    return { key: k, ...s.kind, runs: s.runs, days: s.days, cards: s.cards, speed, p25: Math.round(s.p25), p75: Math.round(s.p75),
      current: now_, current_from: rule ? (exact ? 'rule' : `rule for ${[rule.type, rule.material, rule.sides].filter(Boolean).join(' · ') || 'any card'}`) : now_ ? 'flat rate' : null,
      change: now_ ? r1(((speed - now_) / now_) * 100) : null, confidence: confidence(s.runs, s.days),
      suggest: !now_ || Math.abs((speed - now_) / now_) >= 0.05 };
  }).sort((a, b) => b.cards - a.cards);

  // ---- OEE by customer, against the speeds as they are now
  const oees = [...oeeOf(runs, (r) => { const s = currentSpeed(r); return s ? (r.qty / s) * 60 : null; }).entries()].map(([c, o]) => {
    const cur = currentOee(c); const pct = Math.round(Math.min(1, o.oee) * 100);
    return { customer: c, name: nameOf(c), runs: o.runs, days: o.days, cards: o.cards, oee: r1(o.oee * 100), suggested: pct, current: cur ? r1(cur * 100) : null,
      current_from: oee.by.has(String(c).toUpperCase()) ? 'customer' : cur ? 'default' : null, confidence: confidence(o.runs, o.days),
      suggest: !cur || Math.abs(pct - cur * 100) >= 3, over: o.oee > 1 };
  }).sort((a, b) => b.cards - a.cards);

  // ---- accuracy: Planning's times now vs with values learned on the older runs, on the newest
  const split = runs.length >= 40 ? Math.floor(runs.length * 0.7) : 0;
  const train = split ? runs.slice(0, split) : runs; const test = split ? runs.slice(split) : runs;
  const tSpeeds = speedsOf(train); const tFleet = overallRate(train);
  const tSpeed = (r) => tSpeeds.get(r.kindKey)?.speed || tFleet;
  const tOee = oeeOf(train, (r) => (tSpeed(r) ? (r.qty / tSpeed(r)) * 60 : null));
  const plannedNow = (r) => { const s = currentSpeed(r); if (!s) return null; return ((r.qty / s) * 60) / (currentOee(r.customer) || 1); };
  const plannedLearned = (r) => { const s = tSpeed(r); if (!s) return null; const o = tOee.get(r.customer)?.oee; return ((r.qty / s) * 60) / (o > 0 ? Math.min(o, 1.5) : 1); };
  const tModel = buildModel(train);
  const accuracy = { tested_on: split ? 'newest' : 'all', runs: test.length,
    now: closeness(test.map((r) => [plannedNow(r), r.minutes])), learned: closeness(test.map((r) => [plannedLearned(r), r.minutes])),
    items: closeness(test.map((r) => [predict(tModel, r)?.minutes, r.minutes])) };

  // ---- pace: against each kind's learned running speed
  const expOf = (r) => { const s = learned.get(r.kindKey)?.speed || fleetRate; return s ? (r.qty / s) * 60 : null; };
  for (const r of runs) r.expected = expOf(r);
  const paceRow = (label, list, extra = {}) => {
    const used = list.filter((r) => r.expected > 0);
    const exp = used.reduce((t, r) => t + r.expected, 0); const act = used.reduce((t, r) => t + r.minutes, 0);
    const cardsN = list.reduce((t, r) => t + r.qty, 0); const mins = list.reduce((t, r) => t + r.minutes, 0);
    return { label, runs: list.length, cards: cardsN, hours: r1(mins / 60), pace: act ? r1((exp / act) * 100) : null, per_hour: mins ? Math.round((cardsN / mins) * 60) : null,
      days: new Set(list.map((r) => r.start_at.slice(0, 10))).size, ...extra };
  };
  const overall = paceRow('All runs', runs);
  const by = (fn, order) => [...groupBy(runs, fn)].map(([k, list]) => paceRow(k, list)).sort(order || ((a, b) => b.cards - a.cards));
  const shiftLabel = { morning: 'Morning', afternoon: 'Afternoon', night: 'Night' };
  const patterns = {
    machine: by((r) => r.machine || '—', (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })),
    shift: by((r) => shiftLabel[shiftOf(new Date(r.start_at), shiftStarts)], (a, b) => ['Morning', 'Afternoon', 'Night'].indexOf(a.label) - ['Morning', 'Afternoon', 'Night'].indexOf(b.label)),
    weekday: by((r) => WEEKDAYS[new Date(r.start_at).getDay()], (a, b) => ((WEEKDAYS.indexOf(a.label) + 6) % 7) - ((WEEKDAYS.indexOf(b.label) + 6) % 7)),
    size: SIZES.map(([lo, hi, label]) => paceRow(label, runs.filter((r) => r.qty >= lo && r.qty < hi))).filter((x) => x.runs),
    customer: by((r) => r.customer || '—').map((x) => ({ ...x, name: nameOf(x.label) })),
    week: by((r) => mondayOf(new Date(r.start_at)), (a, b) => a.label.localeCompare(b.label)).slice(-16),
  };
  // set-up: the machines' usual time a run takes before cards flow
  const setups = [...P.base].filter(([, b]) => b).map(([m, b]) => ({ machine: m, setup: r1(b.setup), runs: b.n }));
  const setupAll = P.base.all ? r1(P.base.all.setup) : null;

  // ---- cards that run unlike their kind (5+ runs, a quarter or more off)
  const cardsOff = [...groupBy(runs.filter((r) => r.item && learned.get(r.kindKey)), (r) => r.item)].filter(([, l]) => l.length >= 5).map(([item, l]) => {
    const own = wmedian(l.map((r) => r.rate), l.map((r) => r.qty)); const kindSpeed = learned.get(l[0].kindKey).speed;
    return { item, name: l[0].card?.name || l[0].item_name || null, customer: l[0].customer, ...l[0].kind, runs: l.length, cards: l.reduce((t, r) => t + r.qty, 0),
      speed: Math.round(own), kind_speed: Math.round(kindSpeed), ratio: r3(own / kindSpeed) };
  }).filter((c) => c.ratio < 0.8 || c.ratio > 1.25).sort((a, b) => Math.abs(Math.log(b.ratio)) * b.cards - Math.abs(Math.log(a.ratio)) * a.cards).slice(0, 25);

  // ---- work orders furthest over their usual time (all their runs together): the usual being the
  // set-up plus the cards at their kind's speed, at the customer's own usual pace — so a customer
  // that's always slower doesn't fill the list, only the jobs slow even for them
  const custPace = new Map(patterns.customer.map((x) => [x.label, x.pace && overall.pace ? x.pace / 100 : null]));
  const usualOf = (r) => (r.expected ? (r.setup || 0) + r.expected / (custPace.get(r.customer || '—') || 1) : 0);
  const overruns = [...groupBy(runs, (r) => r.job)].map(([job, l]) => {
    const exp = l.reduce((t, r) => t + usualOf(r), 0); const act = l.reduce((t, r) => t + r.minutes, 0);
    return { job, customer: l[0].customer, name: nameOf(l[0].customer), runs: l.length, cards: l.reduce((t, r) => t + r.qty, 0), machines: [...new Set(l.map((r) => r.machine))].join(', '),
      first: l[0].start_at, expected: Math.round(exp), actual: Math.round(act), over: Math.round(act - exp), pace: exp && act ? r1((exp / act) * 100) : null };
  }).filter((x) => x.expected > 0 && x.over >= 30 && x.pace < 70).sort((a, b) => b.over - a.over).slice(0, 15);

  // ---- remakes by customer
  const remakes = [...groupBy(runs, (r) => r.customer || '—')].map(([c, l]) => {
    const total = l.reduce((t, r) => t + r.qty, 0); const re = l.filter((r) => r.remake).reduce((t, r) => t + r.qty, 0);
    return { customer: c, name: nameOf(c), cards: total, remade: re, pct: total ? r1((re / total) * 100) : null };
  }).filter((x) => x.remade > 0).sort((a, b) => b.remade - a.remade).slice(0, 15);
  const remadeAll = runs.filter((r) => r.remake).reduce((t, r) => t + r.qty, 0);

  // ---- lateness (the plan history: jobs gone from the export, against their deadline)
  const since = new Date(now.getTime() - days * DAY).toISOString();
  const done = db.all('SELECT customer, shipper, qty, late_minutes, first_seen, done_at FROM plan_history_jobs WHERE done_at IS NOT NULL AND done_at >= ?', [since]);
  const lateRow = (label, l) => { const late = l.filter((j) => j.late_minutes > 0); return { label, jobs: l.length, cards: l.reduce((t, j) => t + j.qty, 0), late: late.length,
    late_pct: l.length ? r1((late.length / l.length) * 100) : null, avg_late: late.length ? Math.round(late.reduce((t, j) => t + j.late_minutes, 0) / late.length) : null }; };
  const lateness = {
    jobs: done.length, late_pct: done.length ? r1((done.filter((j) => j.late_minutes > 0).length / done.length) * 100) : null,
    customer: [...groupBy(done, (j) => j.customer || '—')].map(([c, l]) => ({ ...lateRow(c, l), name: nameOf(c) })).filter((x) => x.jobs >= 3).sort((a, b) => b.late - a.late || b.jobs - a.jobs).slice(0, 15),
    shipper: [...groupBy(done, (j) => j.shipper || '—')].map(([s, l]) => lateRow(s, l)).filter((x) => x.jobs >= 3).sort((a, b) => b.late - a.late || b.jobs - a.jobs).slice(0, 15),
  };

  // ---- Matching: items an hour by customer, against its customer speed (or the machines' average)
  const O = runsFor('otto', days, now, null);
  const machineAvg = ottoMachines.filter((m) => Number(m.speed) > 0); const ottoDefault = machineAvg.length ? machineAvg.reduce((t, m) => t + Number(m.speed), 0) / machineAvg.length : null;
  const matching = { runs: O.runs.length, anomalies: O.anomalies, rate: O.runs.length ? Math.round(overallRate(O.runs)) : null,
    customers: [...groupBy(O.runs, (r) => r.customer)].filter(([, l]) => l.length >= 5).map(([c, l]) => {
      const sp = Math.round(wmedian(l.map((r) => r.rate), l.map((r) => r.qty))); const cur = ottoSpeeds.get(c) ?? null; const ref = cur ?? ottoDefault;
      const dys = new Set(l.map((r) => r.start_at.slice(0, 10))).size;
      return { customer: c, name: nameOf(c), runs: l.length, days: dys, items: l.reduce((t, r) => t + r.qty, 0), speed: sp, current: cur, machine_avg: ottoDefault ? Math.round(ottoDefault) : null,
        change: ref ? r1(((sp - ref) / ref) * 100) : null, confidence: confidence(l.length, dys), suggest: !ref || Math.abs((sp - ref) / ref) >= 0.05 };
    }).sort((a, b) => b.items - a.items) };

  // ---- findings: what stands out, biggest first
  const findings = [];
  const pct = (x) => `${Math.round(Math.abs(x))}%`;
  const off = (row, base) => (row.pace && base ? row.pace / base - 1 : 0);
  if (accuracy.now && accuracy.learned && accuracy.learned.within - accuracy.now.within >= 5) {
    findings.push({ kind: 'deploy', weight: 100, text: `With the learned speeds and OEE, ${accuracy.learned.within}% of runs would have been planned within 25% of what they took, against ${accuracy.now.within}% with the setup as it is (tested on the newest ${accuracy.runs} runs).` });
  } else if (accuracy.now && accuracy.now.bias !== null && Math.abs(accuracy.now.bias) >= 15) {
    findings.push({ kind: 'deploy', weight: 90, text: `Runs typically take ${pct(accuracy.now.bias)} ${accuracy.now.bias > 0 ? 'longer' : 'less time'} than Planning gives them.` });
  }
  if (accuracy.items && accuracy.learned && accuracy.items.within - Math.max(accuracy.learned.within, accuracy.now?.within ?? 0) >= 5) {
    findings.push({ kind: 'deploy', weight: 95, text: `Timing each card from its own runs, plus the set-up, would have planned ${accuracy.items.within}% of runs within 25% — the closest of the three ways. Switch it on with "Use it in the plan".` });
  }
  const toApply = speeds.filter((s) => s.suggest && s.confidence !== 'low');
  if (toApply.length) findings.push({ kind: 'deploy', weight: 80, text: `${toApply.length} kind${toApply.length === 1 ? '' : 's'} of card run${toApply.length === 1 ? 's' : ''} at a different speed from the one planned — biggest: ${toApply.slice(0, 3).map((s) => `${[s.type, s.material, s.sides].filter(Boolean).join(' · ')} ${s.speed}/h (now ${s.current ?? 'none'})`).join('; ')}.` });
  for (const c of oees.filter((o) => o.confidence !== 'low' && o.current && Math.abs(o.suggested - o.current) >= 10).slice(0, 3)) {
    findings.push({ kind: 'deploy', weight: 60 + Math.abs(c.suggested - c.current), text: `${c.customer}${c.name ? ` (${c.name})` : ''} runs at ${c.oee}% of the planned speed, but is planned at ${c.current}% OEE.` });
  }
  const spread = (list, what) => {
    const ok = list.filter((x) => x.runs >= 10 && x.pace);
    if (ok.length < 2) return;
    const best = ok.reduce((a, b) => (b.pace > a.pace ? b : a)); const worst = ok.reduce((a, b) => (b.pace < a.pace ? b : a));
    const gap = best.pace / worst.pace - 1;
    if (gap >= 0.12) findings.push({ kind: 'pattern', weight: 40 + gap * 100, text: `${what(worst).replace(/^./, (c) => c.toUpperCase())} runs ${pct(gap * 100)} slower than ${what(best)} (${worst.pace}% against ${best.pace}% pace).` });
  };
  spread(patterns.shift, (x) => `the ${x.label.toLowerCase()} shift`);
  spread(patterns.machine, (x) => x.label);
  spread(patterns.weekday, (x) => x.label);
  const small = patterns.size[0];
  if (small && small.runs >= 10 && overall.pace && small.pace && small.pace < overall.pace * 0.75) {
    findings.push({ kind: 'pattern', weight: 45, text: `Small jobs (${small.label.toLowerCase()} cards) run at ${small.pace}% pace against ${overall.pace}% overall: the set-up${setupAll ? ` (about ${Math.round(setupAll)} min a run)` : ''} weighs heavily — grouping them saves time.` });
  }
  for (const c of patterns.customer.filter((x) => x.runs >= 10 && x.pace && overall.pace && Math.abs(off(x, overall.pace)) >= 0.2).slice(0, 3)) {
    findings.push({ kind: 'pattern', weight: 35 + Math.abs(off(c, overall.pace)) * 50, text: `${c.label}${c.name ? ` (${c.name})` : ''} jobs run ${pct(off(c, overall.pace) * 100)} ${off(c, overall.pace) > 0 ? 'faster' : 'slower'} than the usual for their cards.` });
  }
  const wk = patterns.week.filter((w) => w.runs >= 5);
  if (wk.length >= 6) {
    const recent = wk.slice(-4); const before = wk.slice(0, -4);
    const pr = (l) => l.reduce((t, w) => t + w.pace * w.cards, 0) / Math.max(1, l.reduce((t, w) => t + w.cards, 0));
    const ch = pr(recent) / pr(before) - 1;
    if (Math.abs(ch) >= 0.08) findings.push({ kind: 'trend', weight: 30 + Math.abs(ch) * 100, text: `The last 4 weeks ran ${pct(ch * 100)} ${ch > 0 ? 'faster' : 'slower'} than the weeks before.` });
  }
  if (cardsOff.length) findings.push({ kind: 'pattern', weight: 25, text: `${cardsOff.length} card${cardsOff.length === 1 ? '' : 's'} run well off the usual for their kind — e.g. ${cardsOff.slice(0, 2).map((c) => `${c.item}${c.name ? ` ${c.name}` : ''} at ${Math.round(c.ratio * 100)}%`).join(', ')}.` });
  const rm = remakes.find((x) => x.pct >= 3 && x.cards >= 500);
  if (rm) findings.push({ kind: 'quality', weight: 20 + rm.pct, text: `${rm.customer}${rm.name ? ` (${rm.name})` : ''}: ${rm.pct}% of cards were remakes.` });
  const lt = lateness.customer.find((x) => x.jobs >= 5 && x.late_pct >= 20);
  if (lt) findings.push({ kind: 'quality', weight: 20 + lt.late_pct / 2, text: `${lt.label}${lt.name ? ` (${lt.name})` : ''}: ${lt.late_pct}% of jobs finished after the cut-off.` });
  const ms = matching.customers.filter((c) => c.suggest && c.confidence !== 'low');
  if (ms.length) findings.push({ kind: 'deploy', weight: 50, text: `Matching: ${ms.length} customer${ms.length === 1 ? '' : 's'} run at a different speed from the one planned — e.g. ${ms.slice(0, 2).map((c) => `${c.customer} ${c.speed}/h`).join(', ')}.` });
  findings.sort((a, b) => b.weight - a.weight);

  return {
    days, from: P.from.toISOString(), to: P.to.toISOString(), cards_db: !!cards,
    runs: { total: P.total, used: runs.length, anomalies: P.anomalies, with_kind: runs.filter((r) => r.kind).length, cards: runs.reduce((t, r) => t + r.qty, 0), remade: remadeAll,
      first: runs[0]?.start_at || null, last: runs[runs.length - 1]?.start_at || null, days: new Set(runs.map((r) => r.start_at.slice(0, 10))).size },
    overall, setup: { all: setupAll, machines: setups }, speeds, oee: oees, accuracy, patterns, cards: cardsOff, overruns, remakes, lateness, matching,
    findings: findings.map(({ kind, text }) => ({ kind, text })),
  };
}

// ---- 🔎 Explode: one table of the Learned view opened up — any window of days, grouped by any of
// these, each row's share of the whole, drilled into by filtering on rows (filter: { dim: key }).
// Pace is against each kind's speed learned over the window, or the 180 days to its end if longer.
const DIMS = {
  machine: { label: 'Machine', of: (r) => r.machine || '—' },
  shift: { label: 'Shift', of: (r, x) => ({ morning: 'Morning', afternoon: 'Afternoon', night: 'Night' })[shiftOf(new Date(r.start_at), x.shiftStarts)], order: (k) => ['Morning', 'Afternoon', 'Night'].indexOf(k) },
  weekday: { label: 'Weekday', of: (r) => WEEKDAYS[new Date(r.start_at).getDay()], order: (k) => (WEEKDAYS.indexOf(k) + 6) % 7 },
  hour: { label: 'Hour started', of: (r) => `${pad(new Date(r.start_at).getHours())}:00`, order: (k) => k },
  size: { label: 'Cards in the run', of: (r) => SIZES.find(([lo, hi]) => r.qty >= lo && r.qty < hi)[2], order: (k) => SIZES.findIndex((z) => z[2] === k) },
  customer: { label: 'Customer', of: (r) => r.customer || '—', name: (k, x) => x.nameOf(k) },
  kind: { label: 'Kind of card', of: (r) => r.kindKey || '—', text: (k, l) => (l[0].kind ? [l[0].kind.type, l[0].kind.material, l[0].kind.sides].filter(Boolean).join(' · ') || 'any card' : 'not known') },
  card: { label: 'Card (AX)', of: (r) => r.item || '—', name: (k, x, l) => l[0].card?.name || l[0].item_name || null },
  job: { label: 'Job', of: (r) => r.job || '—', name: (k, x, l) => l[0].customer || null },
  day: { label: 'Day', of: (r) => r.start_at.slice(0, 10), order: (k) => k },
  week: { label: 'Week of', of: (r) => mondayOf(new Date(r.start_at)), order: (k) => k },
  month: { label: 'Month', of: (r) => r.start_at.slice(0, 7), order: (k) => k },
};
const TIME_DIMS = new Set(['day', 'week', 'month', 'hour']);
const pctOf = (n, all) => (all ? r1((n / all) * 100) : null);

/**
 * opts: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', by, filter, source: 'perso' | 'otto', cards, custNames, shiftStarts }
 * → { from, to, by, filter, dims, total, rows, trend, filter_labels }
 */
function explode(opts) {
  const { cards = null, custNames = new Map(), shiftStarts = { night: 1305, morning: 345, afternoon: 825 } } = opts;
  const source = opts.source === 'otto' ? 'otto' : 'perso';
  const by = DIMS[opts.by] ? opts.by : 'customer';
  const ok = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  const to = ok(opts.to) ? new Date(`${opts.to}T00:00:00`) : new Date();
  to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 1); // the window ends at the end of `to`
  let from = ok(opts.from) ? new Date(`${opts.from}T00:00:00`) : new Date(to.getTime() - 90 * DAY);
  if (from >= to) from = new Date(to.getTime() - DAY);
  if (to - from > 800 * DAY) from = new Date(to.getTime() - 800 * DAY);
  const span = Math.round((to - from) / DAY);
  const x = { shiftStarts, nameOf: (c) => custNames.get(String(c || '').toUpperCase()) || null };

  const all = runsFor(source, span, to, source === 'perso' ? cards : null).runs;
  // the pace reference: kind speeds over the window, at least 180 days of it
  const ref = source === 'perso' ? (span >= 180 ? all : runsFor('perso', 180, to, cards).runs) : all;
  const refSpeeds = speedsOf(ref); const refFleet = overallRate(ref);
  for (const r of all) { const s = source === 'perso' ? refSpeeds.get(r.kindKey)?.speed || refFleet : refFleet; r.expected = s ? (r.qty / s) * 60 : null; }

  const filter = {}; const filterLabels = [];
  for (const [d, v] of Object.entries(opts.filter || {})) if (DIMS[d] && v !== null && v !== undefined && v !== '') filter[d] = String(v);
  const runs = all.filter((r) => Object.entries(filter).every(([d, v]) => String(DIMS[d].of(r, x)) === v));
  for (const [d, v] of Object.entries(filter)) {
    const l = all.filter((r) => String(DIMS[d].of(r, x)) === v);
    const text = DIMS[d].text && l.length ? DIMS[d].text(v, l) : v;
    filterLabels.push({ dim: d, key: v, dim_label: DIMS[d].label, label: text, name: DIMS[d].name && l.length ? DIMS[d].name(v, x, l) : null });
  }

  const sum = (l, f) => l.reduce((t, r) => t + (f(r) || 0), 0);
  const stats = (l) => {
    const cardsN = sum(l, (r) => r.qty); const mins = sum(l, (r) => r.minutes);
    const used = l.filter((r) => r.expected > 0); const exp = sum(used, (r) => r.expected); const act = sum(used, (r) => r.minutes);
    const remade = sum(l.filter((r) => r.remake), (r) => r.qty);
    return { runs: l.length, cards: cardsN, minutes: Math.round(mins), hours: r1(mins / 60), per_hour: mins ? Math.round((cardsN / mins) * 60) : null,
      pace: source === 'perso' && act ? r1((exp / act) * 100) : null, remade, remade_pct: pctOf(remade, cardsN),
      avg_run: l.length ? Math.round(mins / l.length) : null, avg_cards: l.length ? Math.round(cardsN / l.length) : null,
      days: new Set(l.map((r) => r.start_at.slice(0, 10))).size, first: l[0]?.start_at || null, last: l[l.length - 1]?.start_at || null };
  };
  const total = stats(runs);
  const D = DIMS[by];
  const rows = [...groupBy(runs, (r) => D.of(r, x))].map(([k, l]) => {
    const st = stats(l);
    return { key: String(k), label: D.text ? D.text(k, l) : String(k), name: D.name ? D.name(k, x, l) : null, ...st,
      runs_pct: pctOf(st.runs, total.runs), cards_pct: pctOf(st.cards, total.cards), hours_pct: pctOf(st.minutes, total.minutes), remade_share: pctOf(st.remade, total.remade) };
  });
  if (D.order) rows.sort((a, b) => { const p = D.order(a.key); const q = D.order(b.key); return p < q ? -1 : p > q ? 1 : 0; });
  else rows.sort((a, b) => b.cards - a.cards);

  // how the selection went over time: by day for up to 2 months, else by week
  const step = span <= 62 ? 'day' : 'week';
  const trend = by === step ? [] : [...groupBy(runs, (r) => DIMS[step].of(r, x))].map(([k, l]) => ({ label: k, ...stats(l) })).sort((a, b) => a.label.localeCompare(b.label));

  return { source, from: ymd(from), to: ymd(new Date(to.getTime() - DAY)), days: span, by, filter, filter_labels: filterLabels,
    dims: Object.entries(DIMS).map(([k, d]) => ({ key: k, label: d.label, time: TIME_DIMS.has(k) })), total, rows, trend, trend_step: step,
    window: { first: all[0]?.start_at || null, last: all[all.length - 1]?.start_at || null, runs: all.length } };
}

module.exports = { learn, explode, wmedian, closeness, buildModel, predict, modelFor };
