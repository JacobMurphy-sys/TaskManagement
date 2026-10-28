'use strict';
// 📐 Capacity planning, a day by the hour (the CPM daily sheet): a working day of a month, hour by hour
// from the start of the day — each customer and technology's volume for the day (the month's forecast ÷
// its working days), split into daily work and renewals; the daily part spread over the hours as the
// customer's cards were produced (the ⏱ timing report), the renewals over each technology's renewal
// window; ÷ OEE (renewals a few points more); against each technology's capacity in that hour.
const db = require('./db');
const cpm = require('./cpm');
const planning = require('./planning');

const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const setting = (k, d) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value ?? d;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (s, d) => { const m = String(s || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : d; };
const LOOKBACK = 120; // days of history to learn from

// the day's hours, from the hour the day starts (Production's day start, 06:00): [6, 7, … 23, 0, … 5]
const dayStart = () => Math.floor(hm(setting('plan_day_start', '06:00'), 360) / 60) % 24;
const hoursOfDay = () => Array.from({ length: 24 }, (_, i) => (dayStart() + i) % 24);

// ---- learned from history --------------------------------------------------------------------------
// the timing report's runs over the last months: { trigram, tech, machine, start, end, qty }
function runs(cards) {
  const from = new Date(); from.setDate(from.getDate() - LOOKBACK);
  const machineTech = new Map(db.all('SELECT name, types FROM plan_machines').map((m) => [String(m.name).toLowerCase(), String(m.types || '').split(/[,;/]/).map(cpm.normTech).filter(Boolean)]));
  let rows = [];
  try {
    rows = db.all("SELECT start_at, end_at, qty, trigram, item, machine FROM prod_runs WHERE source = 'perso' AND remake = 0 AND end_at IS NOT NULL AND job NOT LIKE 'M%' AND start_at >= ?", [ymd(from)]);
  } catch { /* no timing report */ }
  return rows.map((r) => {
    const card = cards ? cards.get(planning.axKey(r.item)) : null; const mt = machineTech.get(String(r.machine || '').toLowerCase()) || [];
    return { trigram: String(r.trigram || '').toUpperCase() || null, tech: cpm.normTech(card?.type) || (mt.length === 1 ? mt[0] : null), machine: r.machine || '', start: new Date(r.start_at), end: new Date(r.end_at), qty: Number(r.qty) || 0 };
  }).filter((r) => !Number.isNaN(r.start.getTime()) && !Number.isNaN(r.end.getTime()));
}
// a run's quantity over the hours of the day it covers: [hour 0..23] → qty
function spread(r, add) {
  const s = r.start.getTime(); const e = Math.max(s + 60000, r.end.getTime()); const len = e - s;
  for (let t = s; t < e;) { const d = new Date(t); const next = new Date(d); next.setMinutes(0, 0, 0); next.setHours(d.getHours() + 1); const until = Math.min(e, next.getTime()); add(d.getHours(), (r.qty * (until - t)) / len); t = until; }
}
// each customer and technology's day: 'TRI|tech' (also '*|tech' and '*|*') → shares per hour of the
// day [hour 0..23], from when their cards were produced
function profiles(cards, rs = runs(cards)) {
  const by = new Map(); const put = (k, h, q) => { const a = by.get(k) || by.set(k, Array(24).fill(0)).get(k); a[h] += q; };
  for (const r of rs) { if (!r.qty) continue; spread(r, (h, q) => { if (r.trigram && r.tech) put(`${r.trigram}|${r.tech}`, h, q); if (r.tech) put(`*|${r.tech}`, h, q); put('*|*', h, q); }); }
  const out = new Map(); const counts = new Map();
  for (const r of rs) if (r.trigram && r.tech) counts.set(`${r.trigram}|${r.tech}`, (counts.get(`${r.trigram}|${r.tech}`) || 0) + 1);
  for (const [k, a] of by) { const tot = a.reduce((x, y) => x + y, 0); if (tot > 0 && (k.startsWith('*') || (counts.get(k) || 0) >= 5)) out.set(k, a.map((x) => x / tot)); }
  return out;
}
// each customer and technology's day by when its daily work orders arrive: when they first appear in the
// hourly open-order export — midway between that export and the one before it; an order first seen after a
// gap of more than 2 hours (the app closed, the first read) could have come any time, so it's left out.
// Renewals (Low priority) aren't daily work, so they're left out too. Same keys as profiles().
function arrivals(cards) {
  const from = new Date(); from.setDate(from.getDate() - LOOKBACK);
  let reads = []; try { reads = db.all('SELECT file_modified FROM plan_history_reads ORDER BY file_modified').map((r) => r.file_modified); } catch { return { profiles: new Map(), orders: 0 }; }
  const at = new Map(); // a read → when its new orders arrived (a time), if the read before was close enough
  const covered = new Set(); // the hours of the day the export was read through (no gap over 2 hours), lately
  for (let i = 1; i < reads.length; i++) { const a = new Date(reads[i - 1]); const b = new Date(reads[i]); if (b - a > 0 && b - a <= 2 * 3600000) { at.set(reads[i], new Date((a.getTime() + b.getTime()) / 2)); if (b >= from) for (let t = a.getTime(); t < b.getTime(); t += 1800000) covered.add(new Date(t).getHours()); } }
  let jobs = []; try { jobs = db.all("SELECT key, customer, qty, prio, first_seen FROM plan_history_jobs WHERE first_seen >= ? AND customer IS NOT NULL AND (prio IS NULL OR lower(prio) NOT LIKE 'low%')", [ymd(from)]); } catch { return { profiles: new Map(), orders: 0 }; }
  const lines = new Map(); try { for (const l of db.all('SELECT key, article, qty FROM plan_history_lines WHERE key IN (SELECT key FROM plan_history_jobs WHERE first_seen >= ?)', [ymd(from)])) (lines.get(l.key) || lines.set(l.key, []).get(l.key)).push(l); } catch { /* none */ }
  const by = new Map(); const n = new Map(); const put = (k, h, q) => { const a = by.get(k) || by.set(k, Array(24).fill(0)).get(k); a[h] += q; n.set(k, (n.get(k) || 0) + 1); };
  let orders = 0;
  for (const j of jobs) {
    const t0 = at.get(j.first_seen); if (!t0) continue; const h = t0.getHours(); const tri = String(j.customer).toUpperCase(); orders++;
    const ls = (lines.get(j.key) || []).map((l) => ({ t: cpm.normTech(cards?.get(planning.axKey(l.article))?.type), q: Number(l.qty) || 0 })).filter((l) => l.t && l.q);
    if (ls.length) for (const l of ls) { put(`${tri}|${l.t}`, h, l.q); put(`*|${l.t}`, h, l.q); }
    put(`${tri}|*`, h, Number(j.qty) || 0); put('*|*', h, Number(j.qty) || 0);
  }
  const out = new Map();
  for (const [k, a] of by) { const tot = a.reduce((x, y) => x + y, 0); if (tot > 0 && (k.startsWith('*') || (n.get(k) || 0) >= 5)) out.set(k, a.map((x) => x / tot)); }
  return { profiles: out, orders, counts: n, covered };
}
// a day's shares → its typical hour (a circular mean, so 23:00 and 01:00 average to midnight): 9.5 for 09:30
function meanHour(p) {
  let x = 0; let y = 0; p.forEach((w, h) => { const a = ((h + 0.5) / 24) * 2 * Math.PI; x += w * Math.cos(a); y += w * Math.sin(a); });
  if (Math.abs(x) + Math.abs(y) < 1e-9) return null; return ((Math.atan2(y, x) / (2 * Math.PI)) * 24 + 24) % 24;
}
// what was really persoed, hour by hour, on an average working day: the chosen month's runs when it has
// any, else the last 4 weeks. { tech: [hour 0..23] cards, days, from, to }
function actualDay(cards, year, month) {
  const pad2 = (x) => String(x).padStart(2, '0'); const mFrom = `${year}-${pad2(month)}-01`; const mTo = `${year}-${pad2(month)}-31`;
  const machineTech = new Map(db.all('SELECT name, types FROM plan_machines').map((m) => [String(m.name).toLowerCase(), String(m.types || '').split(/[,;/]/).map(cpm.normTech).filter(Boolean)]));
  const read = (a, b) => { try { return db.all("SELECT start_at, end_at, qty, item, machine FROM prod_runs WHERE source = 'perso' AND remake = 0 AND end_at IS NOT NULL AND job NOT LIKE 'M%' AND start_at >= ? AND start_at <= ?", [a, `${b}T23:59:59`]); } catch { return []; } };
  let rows = read(mFrom, mTo); let from = mFrom; let to = mTo; let which = 'month';
  if (!rows.length) { const e = new Date(); const b = new Date(); b.setDate(b.getDate() - 28); from = ymd(b); to = ymd(e); rows = read(from, to); which = 'last 4 weeks'; }
  const workDays = new Set(String(setting('plan_days', '1,2,3,4,5')).split(',').map(Number));
  const by = {}; const days = new Set();
  for (const r of rows) {
    const card = cards ? cards.get(planning.axKey(r.item)) : null; const mt = machineTech.get(String(r.machine || '').toLowerCase()) || [];
    const t = cpm.normTech(card?.type) || (mt.length === 1 ? mt[0] : null); if (!t) continue;
    const run = { start: new Date(r.start_at), end: new Date(r.end_at), qty: Number(r.qty) || 0 }; if (Number.isNaN(run.start.getTime())) continue;
    if (workDays.has(run.start.getDay())) days.add(ymd(run.start));
    spread(run, (h, q) => { (by[t] = by[t] || Array(24).fill(0))[h] += q; });
  }
  const nd = Math.max(1, days.size);
  return { per: Object.fromEntries(Object.entries(by).map(([t, a]) => [t, a.map((x) => x / nd)])), days: days.size, from, to, which };
}
// a machine running several technologies: the share of each hour it ran each one — name → [hour] → { tech: share }
function machineHours(cards, rs = runs(cards)) {
  const by = new Map();
  for (const r of rs) { if (!r.tech || !r.machine) continue; spread({ ...r, qty: (r.end - r.start) / 60000 || 1 }, (h, mins) => { const m = by.get(r.machine.toLowerCase()) || by.set(r.machine.toLowerCase(), Array.from({ length: 24 }, () => ({}))).get(r.machine.toLowerCase()); m[h][r.tech] = (m[h][r.tech] || 0) + mins; }); }
  const out = new Map();
  for (const [m, hrs] of by) out.set(m, hrs.map((x) => { const tot = Object.values(x).reduce((a, b) => a + b, 0); return tot ? Object.fromEntries(Object.entries(x).map(([t, v]) => [t, v / tot])) : null; }));
  return out;
}
// the share of each customer's volume (and technology, where the cards tell) that's renewals: the export's
// Low priority work orders over the last months. 'TRI|tech' and 'TRI' → { share, qty }
function renewalShares(cards) {
  const from = new Date(); from.setDate(from.getDate() - LOOKBACK);
  const out = new Map(); const add = (k, low, q) => { const x = out.get(k) || out.set(k, { low: 0, qty: 0 }).get(k); x.qty += q; if (low) x.low += q; };
  let jobs = []; try { jobs = db.all('SELECT key, customer, qty, prio FROM plan_history_jobs WHERE first_seen >= ? AND customer IS NOT NULL', [ymd(from)]); } catch { return out; }
  const lines = new Map(); try { for (const l of db.all('SELECT key, article, qty FROM plan_history_lines WHERE key IN (SELECT key FROM plan_history_jobs WHERE first_seen >= ?)', [ymd(from)])) (lines.get(l.key) || lines.set(l.key, []).get(l.key)).push(l); } catch { /* none */ }
  for (const j of jobs) {
    const low = /^low/i.test(String(j.prio || '')); const tri = String(j.customer).toUpperCase(); add(tri, low, Number(j.qty) || 0);
    for (const l of lines.get(j.key) || []) { const t = cpm.normTech(cards?.get(planning.axKey(l.article))?.type); if (t) add(`${tri}|${t}`, low, Number(l.qty) || 0); }
  }
  for (const x of out.values()) x.share = x.qty ? x.low / x.qty : 0;
  return out;
}
// the shipping cut-offs work orders had lately: ['08:00', '12:00', …], the commonest first (at most 6)
function cutoffs() {
  const from = new Date(); from.setDate(from.getDate() - LOOKBACK);
  let rows = []; try { rows = db.all("SELECT substr(deadline, 12, 5) AS t, COUNT(*) AS n FROM plan_history_jobs WHERE first_seen >= ? AND deadline IS NOT NULL AND length(deadline) >= 16 GROUP BY t ORDER BY n DESC LIMIT 6", [ymd(from)]); } catch { /* none */ }
  return rows.filter((r) => /^\d{2}:\d{2}$/.test(r.t) && r.n >= 3).map((r) => r.t).sort();
}
// the shipment times shown: the ones set on the tab ([{ time: '17:00', label: 'PostNL' }]), else the learned ones
function shipTimes() {
  const set = json(setting('cpm_cutoffs', ''), null);
  const learned = cutoffs().map((time) => ({ time, label: '' }));
  const own = Array.isArray(set) ? set.filter((x) => x && /^\d{1,2}:\d{2}$/.test(String(x.time || ''))).map((x) => ({ time: String(x.time).padStart(5, '0'), label: String(x.label || '').slice(0, 30) })).sort((a, b) => a.time.localeCompare(b.time)) : null;
  return { times: own || learned, own: !!own, learned };
}

// each customer's shipping cut-off: its commonest one lately (daily work, by cards) — 'TRI' → hours (16.5
// for 16:30); '*' the commonest of all
function customerCutoffs() {
  const from = new Date(); from.setDate(from.getDate() - LOOKBACK);
  let rows = []; try { rows = db.all("SELECT customer, substr(deadline, 12, 5) AS t, SUM(qty) AS q FROM plan_history_jobs WHERE first_seen >= ? AND deadline IS NOT NULL AND length(deadline) >= 16 AND customer IS NOT NULL AND (prio IS NULL OR lower(prio) NOT LIKE 'low%') GROUP BY customer, t", [ymd(from)]); } catch { /* none */ }
  const best = new Map(); const all = new Map();
  for (const r of rows) {
    if (!/^\d{2}:\d{2}$/.test(r.t)) continue; const h = Number(r.t.slice(0, 2)) + Number(r.t.slice(3)) / 60; const tri = String(r.customer).toUpperCase();
    if (!best.has(tri) || best.get(tri).q < r.q) best.set(tri, { h, q: r.q }); all.set(h, (all.get(h) || 0) + r.q);
  }
  const out = new Map([...best].map(([k, v]) => [k, v.h]));
  const top = [...all].sort((a, b) => b[1] - a[1])[0]; if (top) out.set('*', top[0]);
  return out;
}
// Smoothing a technology's day as the floor catches up: the daily work is taken in the order it comes in,
// and each piece goes into the spare capacity of the hour it comes in, then the next hour with spare
// capacity, and so on — around the renewals (fixed in their window). What only fits after its shipping
// cut-off (after the cut-off it came in after: the next day's) is still done at the next spare capacity,
// and counted late; what fits nowhere in the 24 hours stays where it came in, over capacity.
// rows: the technology's rows; base: the renewals per hour (need); cap: capacity per hour (need)
function smoothDay(H, rows, base, cap, cutoffOf) {
  const load = base.slice(); const cards = Array(24).fill(0); const perRow = rows.map(() => Array(24).fill(0)); const packets = [];
  rows.forEach((r, k) => r.hours.forEach((amt, i) => {
    if (amt <= 1e-9) return;
    const cut = cutoffOf(r.trigram); let delta = cut === null ? 24 : (cut - H[i] + 24) % 24; if (delta <= 0) delta = 24;
    packets.push({ k, i, amt, delta, ratio: r.oee });
  }));
  packets.sort((a, b) => a.i - b.i || a.delta - b.delta); // first come first served; the earlier cut-off first
  let late = 0; let unplaced = 0;
  for (const p of packets) {
    const put = (s, v) => { load[s] += v; cards[s] += v * p.ratio; perRow[p.k][s] += v; };
    let left = p.amt;
    for (let o = 0; o < 24 && left > 1e-9; o++) {
      const s = (p.i + o) % 24; const free = Math.max(0, cap[s] - load[s]); if (free <= 1e-9) continue;
      const v = Math.min(free, left); put(s, v); left -= v; if (o >= p.delta) late += v;
    }
    if (left > 1e-9) { put(p.i, left); unplaced += left; }
  }
  return { load, cards, perRow, late, unplaced };
}

// each customer's typical work order: the median size (cards) of its work orders lately, per technology
// where the cards tell — 'TRI|tech' / 'TRI|*' / '*|tech' / '*|*', daily (D) and renewals (R) apart
function orderSizes(cards) {
  const from = new Date(); from.setDate(from.getDate() - LOOKBACK);
  let jobs = []; try { jobs = db.all('SELECT key, customer, qty, prio FROM plan_history_jobs WHERE first_seen >= ? AND customer IS NOT NULL AND qty > 0', [ymd(from)]); } catch { return new Map(); }
  const lines = new Map(); try { for (const l of db.all('SELECT key, article, qty FROM plan_history_lines WHERE key IN (SELECT key FROM plan_history_jobs WHERE first_seen >= ?)', [ymd(from)])) (lines.get(l.key) || lines.set(l.key, []).get(l.key)).push(l); } catch { /* none */ }
  const by = new Map(); const add = (k, q) => (by.get(k) || by.set(k, []).get(k)).push(q);
  for (const j of jobs) {
    const kind = /^low/i.test(String(j.prio || '')) ? 'R' : 'D'; const tri = String(j.customer).toUpperCase();
    const per = {}; for (const l of lines.get(j.key) || []) { const t = cpm.normTech(cards?.get(planning.axKey(l.article))?.type); if (t) per[t] = (per[t] || 0) + (Number(l.qty) || 0); }
    for (const [t, q] of Object.entries(per)) if (q > 0) { add(`${kind}|${tri}|${t}`, q); add(`${kind}|*|${t}`, q); }
    add(`${kind}|${tri}|*`, Number(j.qty)); add(`${kind}|*|*`, Number(j.qty));
  }
  const out = new Map(); for (const [k, a] of by) if (a.length >= (k.includes('|*|') || k.endsWith('|*|*') ? 1 : 3)) { a.sort((x, y) => x - y); out.set(k, a[Math.floor(a.length / 2)]); }
  return out;
}
// A typical day run as the floor runs it: each customer's day cut into work orders of its typical size,
// coming in at its usual times (the arrival profile's quantiles) — renewals at the start of their window —
// and each run as a block, start to finish, on the first free machine that runs its technology (and may
// run that customer), first come first served; renewals only in their window. Three days are run and the
// middle one kept, so what's carried over from the day before is in it.
// slots: H; rows; machines: [{ name, techs, speed, avail, only }]; worked(i); factor; windows: tech → hours
function runBlocks({ H, rows, machines, workedAt, factor, rnwHours, sizes, allowed, cutoffOf }) {
  const STEP = 1 / 60; const DAYS = 3; const orders = []; let id = 0;
  const sizeOf = (kind, r) => sizes.get(`${kind}|${r.trigram}|${r.tech}`) || sizes.get(`${kind}|${r.trigram}|*`) || sizes.get(`${kind}|*|${r.tech}`) || sizes.get(`${kind}|*|*`) || 1000;
  for (let dd = 0; dd < DAYS; dd++) for (const r of rows) {
    // daily: n work orders at the profile's quantiles
    if (r.daily > 0.5) {
      const n = Math.max(1, Math.round(r.daily / sizeOf('D', r))); const cum = []; let c = 0; for (const x of r.shares) { c += x; cum.push(c); }
      for (let k = 0; k < n; k++) {
        const q = ((k + 0.5) / n) * (c || 1); let i = cum.findIndex((v) => v >= q - 1e-12); if (i < 0) i = 23;
        const prev = i ? cum[i - 1] : 0; const frac = r.shares[i] > 0 ? (q - prev) / r.shares[i] : 0.5;
        const at = dd * 24 + i + Math.min(0.999, Math.max(0, frac)); const cards = r.daily / n;
        const cut = cutoffOf(r.trigram); let dl = null; if (cut !== null) { const clock = H[i] + frac; let dt = (cut - clock + 24) % 24; if (dt <= 0) dt = 24; dl = at + dt; }
        orders.push({ id: id++, day: dd, kind: 'daily', r, tech: r.tech, cards, need: cards / r.oee, left: cards / r.oee, at, deadline: dl });
      }
    }
    if (r.renew > 0.5) {
      const hrs = rnwHours[r.tech] || []; const first = H.findIndex((h) => hrs.includes(h)); const i = first < 0 ? 0 : first;
      const n = Math.max(1, Math.round(r.renew / sizeOf('R', r)));
      for (let k = 0; k < n; k++) orders.push({ id: id++, day: dd, kind: 'renewal', r, tech: r.tech, cards: r.renew / n, need: r.renew / n / r.oee_rnw, left: r.renew / n / r.oee_rnw, at: dd * 24 + i, deadline: null });
    }
  }
  orders.sort((a, b) => a.at - b.at || a.id - b.id);
  const ms = machines.map((m) => ({ ...m, job: null, blocks: [] }));
  const T = [...new Set(rows.map((r) => r.tech))];
  const ran = Object.fromEntries(T.map((t) => [t, Array(24 * DAYS).fill(0)])); const cardsRan = Object.fromEntries(T.map((t) => [t, Array(24 * DAYS).fill(0)]));
  const waitAt = Object.fromEntries(T.map((t) => [t, Array(24 * DAYS).fill(0)])); const ranR = Object.fromEntries(T.map((t) => [t, Array(24 * DAYS).fill(0)])); const cardsR = Object.fromEntries(T.map((t) => [t, Array(24 * DAYS).fill(0)]));
  let next = 0; const queue = [];
  for (let t = 0; t < 24 * DAYS - 1e-9; t += STEP) {
    while (next < orders.length && orders[next].at <= t + 1e-9) queue.push(orders[next++]);
    const hi = Math.floor(t + 1e-9) % 24; const hour = H[hi]; const on = workedAt(hi);
    const inWindow = (o) => o.kind !== 'renewal' || !(rnwHours[o.tech] || []).length || rnwHours[o.tech].includes(hour);
    for (const m of ms) {
      if (!on) continue;
      if (m.job && !inWindow(m.job)) { queue.unshift(m.job); m.job = null; } // a renewal out of its window goes back, part done, and the machine takes daily work
      let tl = STEP; // the minute: one order after another in it
      while (tl > 1e-12) {
        if (!m.job) { // the first waiting order it may run
          const k = queue.findIndex((o) => m.techs.includes(o.tech) && m.speed[o.tech] > 0 && (!m.only?.length || allowed(m, o.r) > 0) && inWindow(o));
          if (k < 0) break; m.job = queue.splice(k, 1)[0]; if (m.job.start === undefined) m.job.start = t + (STEP - tl); m.job.machine = m.name;
        }
        const o = m.job; const perH = m.speed[o.tech] * (m.avail ?? 1) * factor; if (!(perH > 0)) break;
        const done = Math.min(perH * tl, o.left); const used = done / perH;
        const hx = Math.floor(t + 1e-9); o.left -= done; ran[o.tech][hx] += done; cardsRan[o.tech][hx] += done * (o.cards / o.need); tl -= used;
        if (o.kind === 'renewal') { ranR[o.tech][hx] += done; cardsR[o.tech][hx] += done * (o.cards / o.need); }
        if (o.left <= 1e-6) { o.end = t + (STEP - tl); m.blocks.push(o); m.job = null; }
      }
    }
    const h0 = Math.floor(t + 1e-9); if (Math.floor(t + STEP + 1e-9) > h0) for (const tt of T) waitAt[tt][h0] = queue.filter((o) => o.tech === tt).reduce((a, o) => a + o.left, 0) + ms.filter((m) => m.job?.tech === tt).reduce((a, m) => a + m.job.left, 0); // what's waiting (or still running) at the end of the hour
  }
  // the middle day
  const D0 = 24; const pick = (a) => a.slice(D0, D0 + 24);
  const blocks = ms.map((m) => ({ name: m.name, techs: m.techs, blocks: m.blocks.filter((o) => o.end > D0 && o.start < D0 + 24).map((o) => ({
    customer: o.r.trigram || o.r.name, name: o.r.name, tech: o.tech, kind: o.kind, cards: Math.round(o.cards), start: o.start - D0, end: o.end - D0, arrived: o.at - D0, deadline: o.deadline === null ? null : o.deadline - D0,
    late: o.deadline !== null && o.end > o.deadline + 1e-6, from_yesterday: o.day < 1 })) }));
  const late = orders.filter((o) => o.day === 1 && o.kind === 'daily' && o.deadline !== null && (o.end === undefined || o.end > o.deadline + 1e-6));
  const unfinished = orders.filter((o) => o.day === 1 && o.end === undefined);
  return { blocks, per: Object.fromEntries(T.map((t) => [t, { need: pick(ran[t]), cards: pick(cardsRan[t]), need_rnw: pick(ranR[t]), cards_rnw: pick(cardsR[t]), waiting: pick(waitAt[t]) }])),
    late: late.map((o) => ({ customer: o.r.trigram || o.r.name, name: o.r.name, tech: o.tech, cards: Math.round(o.cards), arrived: o.at - D0, deadline: o.deadline - D0, end: o.end === undefined ? null : o.end - D0 })),
    sizes: Object.fromEntries(rows.map((r) => [`${r.trigram || r.name}|${r.tech}`, Math.round(sizeOf('D', r))])),
    orders: orders.filter((o) => o.day === 1).length, unfinished: unfinished.length };
}

// a run-period setting → the share of the day in each clock hour [0..23] (null: nothing set)
function manualShares(v) {
  const out = Array(24).fill(0);
  if (Array.isArray(v?.hours)) v.hours.slice(0, 24).forEach((x, h) => { out[h] = Math.max(0, Number(x) || 0); });
  else if (Array.isArray(v?.periods)) for (const p of v.periods) {
    const a = hm(p.from, null); let b = hm(p.to, null); const w = Math.max(0, Number(p.share) || 0); if (a === null || b === null || !w) continue;
    if (b <= a) b += 1440; const len = b - a; // minutes; past midnight wraps
    for (let t = a; t < b;) { const h = Math.floor(t / 60); const end = Math.min(b, (h + 1) * 60); out[h % 24] += (w * (end - t)) / len; t = end; }
  }
  const tot = out.reduce((x, y) => x + y, 0); return tot > 0 ? out.map((x) => x / tot) : null;
}

// ---- the day -----------------------------------------------------------------------------------------
// windows: { DOD: [hours], … } — the hours renewals run; blank: all the hours the shifts cover
function day({ year, month, changes = [], useFlex = true, cards = null, full = true }) {
  const plan = cpm.compute({ year, period: 'month', changes, useFlex, cards });
  const P = plan.periods[month - 1]; const T = plan.techs; const H = hoursOfDay(); const warnings = [...plan.warnings];
  const rs = runs(cards); const mh = machineHours(cards, rs); const rnw = renewalShares(cards);
  // the daily part's day: when its work orders arrive (default) or when its cards were produced
  const source = setting('cpm_day_profile', 'arrival') === 'produced' ? 'produced' : 'arrival';
  const arr = source === 'arrival' ? arrivals(cards) : null; const prof = arr ? arr.profiles : profiles(cards, rs);
  if (arr && arr.orders && arr.covered.size < 24) { const miss = Array.from({ length: 24 }, (_, h) => h).filter((h) => !arr.covered.has(h));
    warnings.push(`The hourly export wasn't read at ${miss.length > 8 ? `${miss.length} hours of the day` : miss.map((h) => `${pad(h)}:00`).join(', ')} lately (the app not running) — work arriving then isn't timed, so the arrival times lean towards the hours it was read; the shared server, reading round the clock, avoids this`); }
  if (arr && !arr.orders) warnings.push('No work orders seen arriving yet (the hourly open-order export, read with no gap over 2 hours) — each day is spread as its cards were produced instead');
  const over = json(setting('cpm_rnw_share', '{}'), {}); // 'TRI|tech' → share typed in
  const bonus = Number(setting('cpm_rnw_bonus', '0.05')) || 0;
  let windows = json(setting('cpm_rnw_hours', '{}'), {});
  for (const c of changes) if (c.type === 'rnw_window' && c.tech && (!c.from || `${year}-${pad(month)}` >= c.from) && (!c.to || `${year}-${pad(month)}` <= c.to)) windows = { ...windows, [cpm.normTech(c.tech)]: (c.hours || []).map(Number) };
  if (full && changes.some((c) => c.type === 'shifts' && Number(c.hours) > 0)) warnings.push('This scenario changes the productive hours a shift — they only count with “Productive” capacity, not at full speed');
  if (!rs.length && !(arr && arr.orders)) warnings.push('No ⏱ timing report runs in the last months — each day is spread evenly over the hours worked');
  const prodProf = arr ? profiles(cards, rs) : prof;
  const days = P.workdays || 0;
  // the hours the shifts cover, from the first shift's start
  const shifts = P.shifts ?? plan.shifts; const hph = P.hph ?? plan.hours;
  const first = Math.floor(hm(setting('plan_shift_morning', '05:45'), 345) / 60 + 0.5) % 24;
  const worked = new Set(Array.from({ length: Math.min(24, Math.round(shifts * 8)) }, (_, i) => (first + i) % 24));
  const factor = full ? 1 : Math.min(1, hph / 8);
  // customers
  // run periods set by hand: 'TRI|tech' / 'TRI|*' / '*|tech' / '*|*' → { periods: [{ from: '07:00', to: '12:00', share: 60 }] }
  // or { hours: [24 weights by the clock] } — made into a day's shares by the clock hour
  const manual = new Map();
  for (const [k, v] of Object.entries(json(setting('cpm_day_manual', '{}'), {}))) { const sh = manualShares(v); if (sh) manual.set(k, sh); }
  const rows = [];
  for (const D of plan.detail) {
    const x = D.months[month]; if (!x || !days) continue;
    const tri = D.trigram; const vol = x.fc * x.split; if (!vol) continue;
    const learned = rnw.get(`${tri}|${D.tech}`) || rnw.get(tri) || null; const typed = over[`${tri}|${D.tech}`];
    const rShare = typed !== undefined && typed !== null && typed !== '' ? Number(typed) : learned ? learned.share : 0;
    const oee = x.oee; const oeeR = Math.min(1, oee + bonus);
    const daily = (vol * (1 - rShare)) / days; const renew = (vol * rShare) / days;
    let p = null; let from = 'even';
    let seen = null;
    // set by hand on the tab: the customer and technology, the customer, everyone else (this technology / all)
    for (const k of [`${tri}|${D.tech}`, `${tri}|*`, `*|${D.tech}`, '*|*']) if (!p && manual.get(k)) { p = manual.get(k); from = k.startsWith('*') ? 'manual-default' : 'manual'; }
    const manualP = p; const manualFrom = from; p = null; from = 'even'; // what's learned, kept to show beside what's set by hand
    if (!p && arr && arr.orders) { for (const [k, f] of [[`${tri}|${D.tech}`, 'own'], [`${tri}|*`, 'own'], [`*|${D.tech}`, 'technology'], ['*|*', 'technology']]) if (!p && prof.get(k)) { p = prof.get(k); from = `arrivals-${f}`; if (f === 'own') seen = arr.counts.get(`${tri}|*`) || arr.counts.get(k) || null; } }
    if (!p) for (const [k, f] of [[`${tri}|${D.tech}`, 'own'], [`*|${D.tech}`, 'technology'], ['*|*', 'technology']]) if (!p && prodProf.get(k)) { p = prodProf.get(k); from = f; }
    const learnedShares = H.map((h) => (p ? p[h] : worked.has(h) ? 1 / worked.size : 0)); const learnedFrom = from;
    if (manualP) { p = manualP; from = manualFrom; }
    const shares = H.map((h) => (p ? p[h] : worked.has(h) ? 1 / worked.size : 0));
    rows.push({ trigram: tri, name: D.name, tech: D.tech, month_volume: vol, daily_pct: 1 - rShare, rnw_pct: rShare, rnw_learned: learned ? learned.share : null, rnw_typed: typed ?? null,
      oee, oee_rnw: oeeR, workdays: days, daily, renew, need_daily: daily / oee, need_rnw: renew / oeeR, profile: from, learned_shares: learnedShares, learned_from: learnedFrom, arrive_avg: p ? meanHour(p) : null, arrive_seen: seen, shares,
      hours: shares.map((s) => (daily / oee) * s), cards_hours: shares.map((s) => daily * s) });
  }
  rows.sort((a, b) => T.indexOf(a.tech) - T.indexOf(b.tech) || b.need_daily - a.need_daily);
  // renewals: each technology's day of renewals over its window
  const rnwByTech = {};
  for (const t of T) {
    const need = rows.filter((r) => r.tech === t).reduce((a, r) => a + r.need_rnw, 0);
    const win = (windows[t] || []).map(Number).filter((h) => h >= 0 && h < 24); const hrs = win.length ? win : [...worked];
    rnwByTech[t] = { need, hours: hrs, window: !!win.length, per: H.map((h) => (hrs.includes(h) ? need / hrs.length : 0)) };
  }
  // capacity per hour: each machine's speed × availability in the hours worked, a multi-technology machine
  // split as it ran in that hour (else as the month gives it its hours). A machine kept for some customers /
  // cards counts only the work it's allowed in that hour (theirs, daily and renewals, the card share learned
  // from what they ran); the rest of its hour is idle — no one else may use it — so not capacity.
  const cap = Object.fromEntries(T.map((t) => [t, Array(24).fill(0)])); const idle = Object.fromEntries(T.map((t) => [t, Array(24).fill(0)])); const machines = [];
  const byM = Object.fromEntries(T.map((t) => [t, new Map()])); const addM = (t, name, i, v) => { const a = byM[t].get(name) || byM[t].set(name, Array(24).fill(0)).get(name); a[i] += v; }; // each machine's part of a technology's capacity
  const restricted = P.machines.filter((m) => m.only?.length);
  const rem = rows.map((r) => H.map((h, i) => r.hours[i] + (rnwByTech[r.tech].hours.includes(h) ? r.need_rnw / rnwByTech[r.tech].hours.length : 0)));
  const fields = [...new Set(restricted.flatMap((m) => m.only.map((o) => o.field).filter(Boolean)))];
  const mix = fields.length ? cpm.cardMix(cards, fields) : new Map();
  if (fields.length && !cards) warnings.push('A machine is restricted to some cards, but the card database isn\'t linked — it gets none of that work');
  const allowed = (m, r) => m.only.reduce((f, o) => {
    if (o.customers && !o.customers.includes(r.trigram) && !o.customers.includes(r.name)) return 0;
    if (!o.values) return f;
    const mx = mix.get(`${r.trigram}|${r.tech}`) || mix.get(`*|${r.tech}`); if (!mx) return 0;
    let share = 0; for (const [sig, x] of mx) if (o.values.includes(String(json(sig, {})[o.field] ?? ''))) share += x; return f * share;
  }, 1);
  const order = [...restricted, ...P.machines.filter((m) => !m.only?.length)];
  for (const m of order) {
    const ts = m.techs.filter((t) => cap[t] && m.speed?.[t] > 0); if (!ts.length) continue;
    const allocT = ts.reduce((a, t) => a + (m.alloc?.[t] || 0), 0); const learned = ts.length > 1 ? mh.get(String(m.name).toLowerCase()) : null;
    const row = { name: m.name, techs: ts, speed: m.speed, avail: m.avail ?? 1, share: [] };
    H.forEach((h, i) => {
      let sh = null;
      if (ts.length === 1) sh = { [ts[0]]: 1 };
      else if (learned?.[h]) { const l = learned[h]; const tot = ts.reduce((a, t) => a + (l[t] || 0), 0); if (tot > 0) sh = Object.fromEntries(ts.map((t) => [t, (l[t] || 0) / tot])); }
      if (!sh) sh = Object.fromEntries(ts.map((t) => [t, allocT ? (m.alloc[t] || 0) / allocT : 1 / ts.length]));
      row.share.push(sh);
      if (!worked.has(h)) return;
      for (const t of ts) {
        const c = m.speed[t] * (m.avail ?? 1) * sh[t] * factor;
        if (!m.only?.length) { cap[t][i] += c; addM(t, m.name, i, c); continue; }
        const mine = rows.map((r, k) => (r.tech === t ? rem[k][i] * allowed(m, r) : 0)); const want = mine.reduce((a, b) => a + b, 0);
        const use = Math.min(c, want); const f = want ? use / want : 0;
        rows.forEach((r, k) => { if (mine[k]) rem[k][i] -= mine[k] * f; });
        cap[t][i] += use; addM(t, m.name, i, use); idle[t][i] += c - use; ((row.used = row.used || {})[t] = row.used[t] || Array(24).fill(0))[i] = use;
      }
    });
    if (m.only?.length) row.only = m.only;
    machines.push(row);
  }
  // demand, load and the backlog carried from hour to hour; the same in cards (capacity × the hour's OEE);
  // and what was really persoed in an average working day's hours
  const act = actualDay(cards, year, month);
  // each customer's cut-off: typed in for it on the tab, else its commonest lately, else the commonest of all
  const cuts = customerCutoffs(); const typedCut = json(setting('cpm_cutoff_cust', '{}'), {}); const hrs = (t) => Number(t.slice(0, 2)) + Number(t.slice(3, 5)) / 60;
  const cutoffOf = (tri) => (tri && /^\d{2}:\d{2}$/.test(typedCut[tri] || '') ? hrs(typedCut[tri]) : cuts.has(tri) ? cuts.get(tri) : cuts.has('*') ? cuts.get('*') : null);
  for (const r of rows) { r.cutoff = cutoffOf(r.trigram); r.cutoff_typed = (r.trigram && typedCut[r.trigram]) || null; r.cutoff_learned = cuts.has(r.trigram) ? cuts.get(r.trigram) : cuts.has('*') ? cuts.get('*') : null; }
  const ship = shipTimes();
  const out = {};
  for (const t of T) {
    const cDaily = H.map((_, i) => rows.filter((r) => r.tech === t).reduce((a, r) => a + r.cards_hours[i], 0));
    const rCards = rows.filter((r) => r.tech === t).reduce((a, r) => a + r.renew, 0);
    const cRnw = H.map((h) => (rnwByTech[t].hours.includes(h) ? rCards / rnwByTech[t].hours.length : 0));
    const daily = H.map((_, i) => rows.filter((r) => r.tech === t).reduce((a, r) => a + r.hours[i], 0));
    const renewals = rnwByTech[t].per; const need = daily.map((v, i) => v + renewals[i]);
    let carry = 0; const backlog = need.map((v, i) => { carry = Math.max(0, carry + v - cap[t][i]); return carry; });
    const tot = need.reduce((a, b) => a + b, 0); const capTot = cap[t].reduce((a, b) => a + b, 0);
    const cards_ = cDaily.map((v, i) => v + cRnw[i]); const dayRatio = need.reduce((a, b) => a + b, 0) ? cards_.reduce((a, b) => a + b, 0) / need.reduce((a, b) => a + b, 0) : 1;
    const effCap = cap[t].map((c, i) => c * (need[i] > 0.5 ? cards_[i] / need[i] : dayRatio));
    // smoothed: the daily work moved within its hours before the cut-off, to stay under capacity
    const tr = rows.filter((r) => r.tech === t); const sm = smoothDay(H, tr, renewals, cap[t], cutoffOf);
    const sDaily = sm.load.map((v, i) => v - renewals[i]); const sNeed = sm.load; const sCards = sm.cards.map((v, i) => v + cRnw[i]);
    let sc = 0; const sBack = sNeed.map((v, i) => { sc = Math.max(0, sc + v - cap[t][i]); return sc; });
    tr.forEach((r, k) => { r.smoothed = sm.perRow[k]; r.smoothed_cards = sm.perRow[k].map((v) => v * r.oee); });
    const smooth = { daily: sDaily, need: sNeed, load: sNeed.map((v, i) => (cap[t][i] ? v / cap[t][i] : v ? null : 0)), backlog: sBack,
      cards: { daily: sm.cards, total: sCards, capacity: cap[t].map((c, i) => c * (sNeed[i] > 0.5 ? sCards[i] / sNeed[i] : dayRatio)) },
      peak: Math.max(...sNeed.map((v, i) => (cap[t][i] ? v / cap[t][i] : 0))), hours_over: sNeed.filter((v, i) => v > cap[t][i] + 0.5).length, over: sNeed.reduce((a, v, i) => a + Math.max(0, v - cap[t][i]), 0), late: sm.late, unplaced: sm.unplaced, end_backlog: sc };
    out[t] = { daily, renewals, need, capacity: cap[t], idle: idle[t], backlog, smooth,
      cards: { daily: cDaily, renewals: cRnw, total: cards_, capacity: effCap, actual: act.per[t] ? H.map((h) => act.per[t][h]) : null, oee: dayRatio }, load: need.map((v, i) => (cap[t][i] ? v / cap[t][i] : v ? null : 0)),
      total: { need: tot, daily: daily.reduce((a, b) => a + b, 0), renewals: rnwByTech[t].need, capacity: capTot, idle: idle[t].reduce((a, b) => a + b, 0), load: capTot ? tot / capTot : null, end_backlog: carry, hours_over: need.filter((v, i) => v > cap[t][i] + 0.5).length } };
  }
  // the day as work orders, run in blocks
  let blocks = null;
  try {
    blocks = runBlocks({ H, rows, machines: P.machines.filter((m) => m.techs.some((t) => cap[t] && m.speed?.[t] > 0)), workedAt: (i) => worked.has(H[i]), factor,
      rnwHours: Object.fromEntries(T.map((t) => [t, rnwByTech[t].window ? rnwByTech[t].hours : []])), sizes: orderSizes(cards), allowed: (m, r) => (m.only?.length ? allowed(m, r) : 1), cutoffOf });
  } catch (err) { warnings.push(`The work-order run couldn't be worked out: ${err.message}`); }
  return { blocks, year, month, label: new Date(year, month - 1, 15).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), workdays: days, hours: H, worked: H.map((h) => worked.has(h)), shifts, hph, full,
    techs: T, rows, renewals: rnwByTech, windows, bonus, profile_source: source, arrivals_seen: arr ? arr.orders : null, actual: { days: act.days, from: act.from, to: act.to, which: act.which }, capacity_machines: machines, capacity_by_machine: Object.fromEntries(T.map((t) => [t, [...byM[t]].map(([name, per]) => ({ name, per }))])), tech: out, cutoffs: ship.times.map((x) => x.time), cutoff_labels: ship.times.map((x) => x.label), ship_times: ship, cutoff_typed: typedCut, manual: json(setting('cpm_day_manual', '{}'), {}), warnings: [...new Set(warnings)],
    learned: { runs: rs.length, renewals: [...rnw.values()].reduce((a, x) => a + x.qty, 0) }, forecast_as_of: plan.forecast_as_of, flex: useFlex };
}

module.exports = { day, manualShares, hoursOfDay, profiles, arrivals, actualDay, smoothDay, customerCutoffs, orderSizes, runBlocks, renewalShares, machineHours, cutoffs };
