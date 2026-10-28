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

// ---- the day -----------------------------------------------------------------------------------------
// windows: { DOD: [hours], … } — the hours renewals run; blank: all the hours the shifts cover
function day({ year, month, changes = [], useFlex = true, cards = null, full = true }) {
  const plan = cpm.compute({ year, period: 'month', changes, useFlex, cards });
  const P = plan.periods[month - 1]; const T = plan.techs; const H = hoursOfDay(); const warnings = [...plan.warnings];
  const rs = runs(cards); const prof = profiles(cards, rs); const mh = machineHours(cards, rs); const rnw = renewalShares(cards);
  const over = json(setting('cpm_rnw_share', '{}'), {}); // 'TRI|tech' → share typed in
  const bonus = Number(setting('cpm_rnw_bonus', '0.05')) || 0;
  let windows = json(setting('cpm_rnw_hours', '{}'), {});
  for (const c of changes) if (c.type === 'rnw_window' && c.tech && (!c.from || `${year}-${pad(month)}` >= c.from) && (!c.to || `${year}-${pad(month)}` <= c.to)) windows = { ...windows, [cpm.normTech(c.tech)]: (c.hours || []).map(Number) };
  if (!rs.length) warnings.push('No ⏱ timing report runs in the last months — each day is spread evenly over the hours worked');
  const days = P.workdays || 0;
  // the hours the shifts cover, from the first shift's start
  const shifts = P.shifts ?? plan.shifts; const hph = P.hph ?? plan.hours;
  const first = Math.floor(hm(setting('plan_shift_morning', '05:45'), 345) / 60 + 0.5) % 24;
  const worked = new Set(Array.from({ length: Math.min(24, Math.round(shifts * 8)) }, (_, i) => (first + i) % 24));
  const factor = full ? 1 : Math.min(1, hph / 8);
  // customers
  const rows = [];
  for (const D of plan.detail) {
    const x = D.months[month]; if (!x || !days) continue;
    const tri = D.trigram; const vol = x.fc * x.split; if (!vol) continue;
    const learned = rnw.get(`${tri}|${D.tech}`) || rnw.get(tri) || null; const typed = over[`${tri}|${D.tech}`];
    const rShare = typed !== undefined && typed !== null && typed !== '' ? Number(typed) : learned ? learned.share : 0;
    const oee = x.oee; const oeeR = Math.min(1, oee + bonus);
    const daily = (vol * (1 - rShare)) / days; const renew = (vol * rShare) / days;
    const p = prof.get(`${tri}|${D.tech}`) || prof.get(`*|${D.tech}`) || prof.get('*|*') || null;
    const shares = H.map((h) => (p ? p[h] : worked.has(h) ? 1 / worked.size : 0));
    rows.push({ trigram: tri, name: D.name, tech: D.tech, month_volume: vol, daily_pct: 1 - rShare, rnw_pct: rShare, rnw_learned: learned ? learned.share : null, rnw_typed: typed ?? null,
      oee, oee_rnw: oeeR, workdays: days, daily, renew, need_daily: daily / oee, need_rnw: renew / oeeR, profile: p ? (prof.has(`${tri}|${D.tech}`) ? 'own' : 'technology') : 'even', shares,
      hours: shares.map((s) => (daily / oee) * s) });
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
  // split as it ran in that hour (else as the month gives it its hours)
  const cap = Object.fromEntries(T.map((t) => [t, Array(24).fill(0)])); const machines = [];
  for (const m of P.machines) {
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
      for (const t of ts) cap[t][i] += m.speed[t] * (m.avail ?? 1) * sh[t] * factor;
    });
    machines.push(row);
  }
  // demand, load and the backlog carried from hour to hour
  const out = {};
  for (const t of T) {
    const daily = H.map((_, i) => rows.filter((r) => r.tech === t).reduce((a, r) => a + r.hours[i], 0));
    const renewals = rnwByTech[t].per; const need = daily.map((v, i) => v + renewals[i]);
    let carry = 0; const backlog = need.map((v, i) => { carry = Math.max(0, carry + v - cap[t][i]); return carry; });
    const tot = need.reduce((a, b) => a + b, 0); const capTot = cap[t].reduce((a, b) => a + b, 0);
    out[t] = { daily, renewals, need, capacity: cap[t], backlog, load: need.map((v, i) => (cap[t][i] ? v / cap[t][i] : v ? null : 0)),
      total: { need: tot, daily: daily.reduce((a, b) => a + b, 0), renewals: rnwByTech[t].need, capacity: capTot, load: capTot ? tot / capTot : null, end_backlog: carry, hours_over: need.filter((v, i) => v > cap[t][i] + 0.5).length } };
  }
  return { year, month, label: new Date(year, month - 1, 15).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }), workdays: days, hours: H, worked: H.map((h) => worked.has(h)), shifts, hph, full,
    techs: T, rows, renewals: rnwByTech, windows, bonus, capacity_machines: machines, tech: out, cutoffs: cutoffs(), warnings: [...new Set(warnings)],
    learned: { runs: rs.length, renewals: [...rnw.values()].reduce((a, x) => a + x.qty, 0) }, forecast_as_of: plan.forecast_as_of, flex: useFlex };
}

module.exports = { day, hoursOfDay, profiles, renewalShares, machineHours, cutoffs };
