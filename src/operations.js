'use strict';
// 🏭 Operations: Reporting's month-by-month operations dashboard (Prod Management), from the sources the
// Weekly SC Report already reads plus the planner's own history:
//  - OTD: the month's delays from Production's OTD report (by the month of the week typed against them, as the
//    A3 counts them) against the cards shipped — OTD SC (Service Center: internal delays) and OTD C (customer:
//    external delays) — per customer too; and the planner's work orders due in the month, on time or late,
//    split into dailies and renewals (Low priority, as in Capacity planning) per customer.
//  - Production: cards (and PIN mailers) persoed and shipped, by day, by customer, the 12 months up to it.
//  - Scrap: the remakes (goods consumption with an …Err reason code, or the machine rejections) by day,
//    customer and cause; the scrap rate = scrap ÷ cards persoed, as on the A3.

const db = require('./db');
const kpiData = require('./kpidata');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const addMonths = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const monthLabel = (m) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const validMonth = (m) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')) ? m : null);
const isCard = (t) => /card/i.test(String(t || ''));
const isPin = (t) => /pin/i.test(String(t || ''));
const isRenewal = (prio) => /^low/i.test(String(prio || '').trim());
const norm = (s) => String(s || '').trim().toLowerCase();
const parseExtra = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };

// the months to pick from: every month with production in it, this month and the last, newest first
function monthsOf() {
  kpiData.ensure();
  const have = db.all("SELECT DISTINCT substr(day, 1, 7) AS m FROM kpi_rows WHERE source IN ('perso', 'shipped') AND day <> ''").map((r) => r.m).filter(validMonth);
  return [...new Set([thisMonth(), addMonths(thisMonth(), -1), ...have])].sort().reverse().map((m) => ({ month: m, label: monthLabel(m) }));
}
// counts by a key for the month and the year to date: [{ name, month, ytd }], biggest this month first, the tail as "Other"
function breakdown(rows, keyOf, valOf, inMonth, inYtd, top = 10) {
  const at = new Map();
  for (const r of rows) {
    if (!inYtd(r)) continue;
    const k = String(keyOf(r) ?? '').trim() || 'Not given';
    const e = at.get(k) || { name: k, month: 0, ytd: 0 };
    const v = valOf(r); e.ytd += v; if (inMonth(r)) e.month += v;
    at.set(k, e);
  }
  const all = [...at.values()].filter((x) => x.ytd).sort((a, b) => b.month - a.month || b.ytd - a.ytd || a.name.localeCompare(b.name));
  if (all.length <= top + 1) return all;
  const rest = all.slice(top);
  return [...all.slice(0, top), { name: `Other (${rest.length})`, month: rest.reduce((t, x) => t + x.month, 0), ytd: rest.reduce((t, x) => t + x.ytd, 0), other: true }];
}

function operations(month, { names = new Map(), today = new Date() } = {}) {
  kpiData.ensure();
  const months = monthsOf();
  const m = validMonth(month) || addMonths(thisMonth(), -1); // the last full month, the one being reported on
  const y = m.slice(0, 4); const prevM = addMonths(m, -1);
  const from12 = addMonths(m, -11);
  const inMonth = (r) => r.day.slice(0, 7) === m;
  const inYtd = (r) => r.day.slice(0, 4) === y && r.day.slice(0, 7) <= m;
  const sumBy = (rows, f) => rows.reduce((t, r) => t + (f(r) || 0), 0);
  const range = [`${from12 < `${y}-01` ? from12 : `${y}-01`}-01`, `${addMonths(m, 1)}-01`];

  // ---- production: persoed and shipped
  const perso = db.all("SELECT day, customer, type, qty FROM kpi_rows WHERE source = 'perso' AND day >= ? AND day < ?", range);
  const shipped = db.all("SELECT day, customer, type, qty FROM kpi_rows WHERE source = 'shipped' AND day >= ? AND day < ?", range);
  const vol = (rows, mm, pred = isCard) => sumBy(rows.filter((r) => r.day.slice(0, 7) === mm && pred(r.type)), (r) => r.qty);
  const daysIn = new Date(Date.UTC(Number(y), Number(m.slice(5, 7)), 0)).getUTCDate();
  const byDay = Array.from({ length: daysIn }, (_, i) => `${m}-${pad(i + 1)}`).map((day) => {
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    return { day, weekend: dow === 0 || dow === 6, persoed: sumBy(perso.filter((r) => r.day === day && isCard(r.type)), (r) => r.qty), shipped: sumBy(shipped.filter((r) => r.day === day && isCard(r.type)), (r) => r.qty), scrap: 0 };
  });

  // ---- scrap: from the source the A3 uses
  const scrapFrom = kpiData.scrapSource();
  const scrapRows = scrapFrom === 'consumption'
    ? db.all("SELECT day, customer, type, scrap, extra FROM kpi_rows WHERE source = 'consumption' AND scrap <> 0 AND day >= ? AND day < ?", range)
      .map((r) => { const x = parseExtra(r.extra); return { day: r.day, customer: r.customer, qty: r.scrap, cause: [r.type, x.reason_name].filter(Boolean).join(' · ') || 'No reason code', wo: x.wo, item: x.item_name || x.item }; })
    : db.all("SELECT day, customer, qty, extra FROM kpi_rows WHERE source = 'remakes' AND day >= ? AND day < ?", range)
      .map((r) => { const x = parseExtra(r.extra); return { day: x.perso_day || r.day, customer: r.customer, qty: r.qty, cause: [x.machine, x.mode].filter(Boolean).join(' · ') || 'Not given', wo: x.wo, item: null }; })
      .filter((r) => r.day);
  for (const d of byDay) d.scrap = sumBy(scrapRows.filter((r) => r.day === d.day), (r) => r.qty);
  const scrapOf = (mm) => sumBy(scrapRows.filter((r) => r.day.slice(0, 7) === mm), (r) => r.qty);
  const rate = (scrap, cards) => (cards ? scrap / cards : null);

  // ---- OTD from the OTD report: delays in the month of the week typed against them
  const weekMonth = new Map();
  for (const yy of [Number(y) - 1, Number(y)]) for (const w of kpiData.weeksOf(yy)) weekMonth.set(w.week, `${yy}-${pad(kpiData.monthIndex(w.month) + 1)}`);
  const delays = db.all("SELECT week, customer, type, qty, extra FROM kpi_rows WHERE source = 'otd' AND week <> ''")
    .map((r) => ({ month: weekMonth.get(String(r.week).toUpperCase()), customer: r.customer, internal: /^int/i.test(r.type || ''), external: /^ext/i.test(r.type || ''), qty: r.qty || 0, reason: parseExtra(r.extra).reason || null }))
    .filter((r) => r.month);
  const delaysOf = (mm) => ({ internal: sumBy(delays.filter((r) => r.month === mm && r.internal), (r) => r.qty), external: sumBy(delays.filter((r) => r.month === mm && r.external), (r) => r.qty) });
  const otdOf = (mm) => { const s = vol(shipped, mm); const d = delaysOf(mm); return { shipped: s, ...d, otd_sc: s ? 1 - d.internal / s : null, otd_c: s ? 1 - d.external / s : null }; };
  const otdM = otdOf(m); const otdP = otdOf(prevM);
  const ytdMonths = Array.from({ length: Number(m.slice(5, 7)) }, (_, i) => `${y}-${pad(i + 1)}`);
  const ytdShip = sumBy(ytdMonths, (mm) => vol(shipped, mm));
  const ytdDel = ytdMonths.reduce((t, mm) => { const d = delaysOf(mm); return { internal: t.internal + d.internal, external: t.external + d.external }; }, { internal: 0, external: 0 });
  // per customer: the month's delays, against what the customer was shipped (matched by name)
  const shipByCust = new Map();
  for (const r of shipped) if (r.day.slice(0, 7) === m && isCard(r.type)) shipByCust.set(norm(r.customer), (shipByCust.get(norm(r.customer)) || 0) + (r.qty || 0));
  const delayCust = new Map();
  for (const r of delays.filter((x) => x.month === m)) {
    const k = norm(r.customer); const e = delayCust.get(k) || { customer: r.customer, internal: 0, external: 0, reasons: new Map() };
    if (r.internal) e.internal += r.qty; if (r.external) e.external += r.qty;
    if (r.reason) e.reasons.set(r.reason, (e.reasons.get(r.reason) || 0) + r.qty);
    delayCust.set(k, e);
  }
  const otdCustomers = [...delayCust.entries()].map(([k, e]) => {
    const s = shipByCust.get(k) || null;
    return { customer: e.customer, shipped: s, internal: e.internal, external: e.external, otd_sc: s ? 1 - e.internal / s : null, otd_c: s ? 1 - e.external / s : null,
      reasons: [...e.reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, qty]) => ({ reason, qty })) };
  }).sort((a, b) => (b.internal + b.external) - (a.internal + a.external));

  // ---- the planner's work orders due in the month: on time or late, dailies and renewals, per customer
  const now = today.toISOString();
  let jobs = [];
  try {
    jobs = db.all('SELECT wo, per, customer, qty, due, deadline, prio, done_at, late_minutes, last_seen FROM plan_history_jobs WHERE deadline >= ? AND deadline < ?', [`${m}-01`, `${addMonths(m, 1)}-01`]);
  } catch { /* no planner history yet */ }
  // unfinished and not on the planner for 3 days: gone without a finish time, so neither late nor open (as the tile)
  const seenSince = new Date(today - 3 * 86400000).toISOString().slice(0, 10);
  const stateOf = (j) => (j.done_at ? (Number(j.late_minutes) > 0 ? 'late' : 'on_time') : `${j.last_seen || ''}` < seenSince ? 'gone' : (`${j.deadline}` < now.slice(0, 16) ? 'overdue' : 'open'));
  const blank = () => ({ cards: 0, on_time: 0, late: 0, overdue: 0, open: 0, gone: 0, wos: 0 });
  const add = (b, j) => { const q = Number(j.qty) || 0; b.cards += q; b[stateOf(j)] += q; b.wos += 1; };
  const custOT = new Map(); const tot = { daily: blank(), renewal: blank() };
  for (const j of jobs) {
    const k = String(j.customer || '?').toUpperCase(); const kind = isRenewal(j.prio) ? 'renewal' : 'daily';
    const e = custOT.get(k) || { customer: k, name: names.get(k) || null, daily: blank(), renewal: blank() };
    add(e[kind], j); add(tot[kind], j); custOT.set(k, e);
  }
  const pct = (b) => (b.on_time + b.late ? b.on_time / (b.on_time + b.late) : null); // of what's finished
  for (const e of custOT.values()) { e.daily.pct = pct(e.daily); e.renewal.pct = pct(e.renewal); }
  tot.daily.pct = pct(tot.daily); tot.renewal.pct = pct(tot.renewal);
  const late = jobs.filter((j) => ['late', 'overdue'].includes(stateOf(j))).map((j) => ({ wo: j.wo, per: j.per, customer: j.customer, name: names.get(String(j.customer || '').toUpperCase()) || null,
    qty: j.qty, deadline: j.deadline, done_at: j.done_at, renewal: isRenewal(j.prio), prio: j.prio, late_hours: j.done_at ? Math.round((Number(j.late_minutes) || 0) / 6) / 10 : Math.round((today - new Date(j.deadline)) / 360000) / 10, open: !j.done_at }))
    .sort((a, b) => b.late_hours - a.late_hours).slice(0, 200);
  let openLate = { wos: 0, cards: 0 };
  try { openLate = db.get("SELECT COUNT(*) AS wos, COALESCE(SUM(qty), 0) AS cards FROM plan_history_jobs WHERE done_at IS NULL AND deadline < ? AND last_seen >= ?", [now.slice(0, 16), seenSince]) || openLate; } catch { /* none */ }

  // ---- the 12 months up to the chosen one
  const trend = Array.from({ length: 12 }, (_, i) => addMonths(m, i - 11)).map((mm) => {
    const p = vol(perso, mm); const s = vol(shipped, mm); const sc = scrapOf(mm); const o = otdOf(mm);
    return { month: mm, label: monthLabel(mm), persoed: p, shipped: s, scrap: sc, scrap_rate: rate(sc, p), otd_sc: o.otd_sc, otd_c: o.otd_c };
  });

  const persoM = vol(perso, m); const persoP = vol(perso, prevM);
  const shipM = vol(shipped, m); const shipP = vol(shipped, prevM);
  const scrapM = scrapOf(m); const scrapP = scrapOf(prevM);
  const cardsRows = (rows) => rows.filter((r) => isCard(r.type));
  const src = (s) => db.get('SELECT file, modified, imported_at, rows FROM kpi_sources WHERE source = ?', [s]) || null;
  return {
    month: m, label: monthLabel(m), months, year: Number(y), scrap_from: scrapFrom,
    sources: { perso: src('perso'), shipped: src('shipped'), otd: src('otd'), scrap: src(scrapFrom) },
    tiles: {
      otd: { ...otdM, prev_sc: otdP.otd_sc, prev_c: otdP.otd_c, ytd_sc: ytdShip ? 1 - ytdDel.internal / ytdShip : null, ytd_c: ytdShip ? 1 - ytdDel.external / ytdShip : null },
      on_time: tot,
      persoed: persoM, persoed_prev: persoP, persoed_pin: vol(perso, m, isPin), persoed_ytd: sumBy(ytdMonths, (mm) => vol(perso, mm)),
      shipped: shipM, shipped_prev: shipP, shipped_pin: vol(shipped, m, isPin), shipped_ytd: ytdShip,
      scrap: scrapM, scrap_rate: rate(scrapM, persoM), scrap_prev: scrapP, scrap_rate_prev: rate(scrapP, persoP),
      open_late: openLate,
    },
    by_day: byDay, trend,
    customers: {
      persoed: breakdown(cardsRows(perso), (r) => r.customer, (r) => r.qty, inMonth, inYtd),
      shipped: breakdown(cardsRows(shipped), (r) => r.customer, (r) => r.qty, inMonth, inYtd),
      scrap: breakdown(scrapRows, (r) => r.customer, (r) => r.qty, inMonth, inYtd),
      causes: breakdown(scrapRows, (r) => r.cause, (r) => r.qty, inMonth, inYtd),
    },
    // scrap by cause, with its customers and cards, for the month
    scrap_detail: (() => {
      const at = new Map();
      for (const r of scrapRows.filter(inMonth)) {
        const e = at.get(r.cause) || { cause: r.cause, qty: 0, customers: new Map(), items: new Map() };
        e.qty += r.qty; e.customers.set(r.customer || '?', (e.customers.get(r.customer || '?') || 0) + r.qty);
        if (r.item) e.items.set(r.item, (e.items.get(r.item) || 0) + r.qty);
        at.set(r.cause, e);
      }
      const top = (mp) => [...mp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([name, qty]) => ({ name, qty }));
      return [...at.values()].sort((a, b) => b.qty - a.qty).map((e) => ({ cause: e.cause, qty: e.qty, share: scrapM ? e.qty / scrapM : null, customers: top(e.customers), items: top(e.items) }));
    })(),
    otd_customers: otdCustomers,
    on_time_customers: [...custOT.values()].sort((a, b) => (b.daily.cards + b.renewal.cards) - (a.daily.cards + a.renewal.cards)),
    late,
    planner: jobs.length > 0,
  };
}

module.exports = { operations, monthLabel };
