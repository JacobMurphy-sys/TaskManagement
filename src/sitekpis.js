'use strict';
// 🏭 Operations' site KPIs: the standard set the site is followed on, each one a tile with a target that can
// be set (and switched off), month by month. Worked out from what SITHUB already reads where it can:
//  - Service level: OTD (the OTD report's delays against cards shipped, as the A3; SC, customer or both)
//  - Quality: CPMS, customer complaints per million cards shipped (the Salesforce export, else the
//    complaints typed in each week on the Weekly SC Report)
//  - Wastage: the scrap rate (scrap ÷ cards persoed, as the A3)
//  - Productivity: cards persoed per working hour (the weekly Protime hours), and each machine's cards per
//    hour of run time (the timing reports) for the range across the site
//  - CAPEX: the year's investments in the 💶 CAPEX register, committed (approved and on) and in the pipeline
//  - Cards persoed / shipped, work orders on time, late and still open: as on the page before
// Others there's no source for yet (transformation costs, MIR, GCI, gross inventory) are typed in each month.

const db = require('./db');
const kpiData = require('./kpidata');

const pad = (n) => String(n).padStart(2, '0');
const addMonths = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const json = (s, d) => { try { return s ? JSON.parse(s) ?? d : d; } catch { return d; } };
const setting = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value;
const setSetting = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);

// the KPIs, in the order they're shown. better: which way is good; typed: a figure typed in each month;
// unit/fmt: how it's written (the page formats); on: shown unless switched off; target: none until set
const KPIS = [
  { key: 'transfo', label: 'Transfo costs', unit: '€ a card', better: 'down', typed: true, on: false, decimals: 2 },
  { key: 'cpms', label: 'Quality', sub: 'CPMS', unit: 'complaints per million cards shipped', better: 'down', decimals: 2 },
  { key: 'otd', label: 'Service level', sub: 'OTD', unit: '%', better: 'up', pct: true, decimals: 1 },
  { key: 'wastage', label: 'Wastage', sub: 'scrap rate', unit: '%', better: 'down', pct: true, decimals: 2 },
  { key: 'productivity', label: 'Productivity', unit: 'cards an hour', better: 'up', decimals: 0 },
  { key: 'mir', label: 'MIR', unit: '', better: 'down', typed: true, on: true, decimals: 0 },
  { key: 'gci', label: 'GCI', unit: '%', better: 'up', typed: true, on: false, pct: true, decimals: 0 },
  { key: 'inventory', label: 'Gross inventory', unit: 'k€', better: 'down', typed: true, on: false, decimals: 0 },
  { key: 'capex', label: 'CAPEX', unit: 'k€ this year', better: 'down', decimals: 0 },
  { key: 'volume', label: 'Cards persoed', unit: 'cards', better: 'up', decimals: 0 },
  { key: 'ontime', label: 'Work orders on time', sub: 'dailies', unit: '%', better: 'up', pct: true, decimals: 1 },
  { key: 'openlate', label: 'Late, still open', unit: 'work orders', better: 'down', decimals: 0 },
];
const OTD_MEASURES = { sc: 'OTD SC (Service Center delays)', c: 'OTD C (customer delays)', all: 'OTD (all delays)' };

// the KPIs as set up here: switched on or off, their target, and how OTD is counted
function config() {
  const saved = json(setting('ops_kpis'), {});
  return KPIS.map((k) => {
    const s = saved[k.key] || {};
    const target = s.target === null || s.target === undefined || s.target === '' || !Number.isFinite(Number(s.target)) ? null : Number(s.target);
    return { ...k, on: typeof s.on === 'boolean' ? s.on : k.on !== false, target, ...(k.key === 'otd' ? { measure: OTD_MEASURES[s.measure] ? s.measure : 'sc', measures: OTD_MEASURES } : {}) };
  });
}
// { kpis: { key: { on, target, measure } } }: only what's given changes
function setConfig(body) {
  const saved = json(setting('ops_kpis'), {});
  for (const [key, v] of Object.entries(body?.kpis || {})) {
    const k = KPIS.find((x) => x.key === key); if (!k || !v || typeof v !== 'object') continue;
    const s = saved[key] || {};
    if ('on' in v) s.on = !!v.on;
    if ('target' in v) {
      if (v.target === null || v.target === '') delete s.target;
      else { const n = Number(String(v.target).replace(',', '.')); if (!Number.isFinite(n)) throw Object.assign(new Error(`${k.label}: the target must be a number`), { status: 400 }); s.target = n; }
    }
    if ('measure' in v && key === 'otd') { if (!OTD_MEASURES[v.measure]) throw Object.assign(new Error('OTD is counted as sc, c or all'), { status: 400 }); s.measure = v.measure; }
    saved[key] = s;
  }
  setSetting('ops_kpis', JSON.stringify(saved));
  return config();
}
// a figure typed in for a month (null removes it)
function setValue(key, month, value) {
  const k = KPIS.find((x) => x.key === key && x.typed);
  if (!k) throw Object.assign(new Error('That KPI isn\'t typed in'), { status: 400 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ''))) throw Object.assign(new Error('Not a month (YYYY-MM)'), { status: 400 });
  const all = json(setting('ops_values'), {}); const v = all[key] || {};
  if (value === null || value === '' || value === undefined) delete v[month];
  else { const n = Number(String(value).replace(',', '.')); if (!Number.isFinite(n)) throw Object.assign(new Error('Type a number'), { status: 400 }); v[month] = n; }
  all[key] = v; setSetting('ops_values', JSON.stringify(all));
  return v;
}

// the weekly figures (Protime hours, complaints typed in, cards persoed) by the month each week reports in
function weeksByMonth(years) {
  const out = new Map();
  for (const y of years) {
    let weeks = []; try { weeks = kpiData.weeklyVolumes(y).weeks; } catch { weeks = []; }
    for (const w of weeks) {
      const mm = `${y}-${pad(kpiData.monthIndex(w.month) + 1)}`;
      const e = out.get(mm) || { cards: 0, hours: 0, cards_with_hours: 0, weeks: [], cc: 0, cc_typed: false };
      const cards = (w.perso_total || 0) * 1000;
      e.cards += cards;
      if (w.hours > 0) { e.hours += w.hours; e.cards_with_hours += cards; }
      const cc = [w.cc_critical, w.cc_major, w.cc_minor];
      if (cc.some((x) => x !== null && x !== undefined)) { e.cc_typed = true; e.cc += cc.reduce((a, b) => a + (Number(b) || 0), 0); }
      e.weeks.push({ week: w.week, cards, hours: w.hours ?? null, productivity: w.hours > 0 ? cards / w.hours : null });
      out.set(mm, e);
    }
  }
  return out;
}

/**
 * The KPIs for a month, from the Operations page's own figures (ops) plus what's worked out here:
 * { config, values: { key: { now, prev, ytd, trend: [12 months] } }, detail: { … per KPI } }
 */
function siteKpis(ops) {
  const m = ops.month; const y = Number(m.slice(0, 4));
  const months = ops.trend.map((t) => t.month);
  const cfg = config();
  const otdCfg = cfg.find((k) => k.key === 'otd');
  const values = {}; const detail = {};
  const byMonth = (f) => months.map((mm) => ({ month: mm, value: f(mm) }));
  const pick = (trend) => ({ now: trend.find((t) => t.month === m)?.value ?? null, prev: trend.find((t) => t.month === addMonths(m, -1))?.value ?? null, trend });

  // ---- OTD: by the measure chosen
  const tr = new Map(ops.trend.map((t) => [t.month, t]));
  const otdAll = (t) => (t?.shipped ? 1 - ((t.otd_internal || 0) + (t.otd_external || 0)) / t.shipped : null);
  const otdOf = (t) => (!t ? null : otdCfg.measure === 'c' ? t.otd_c : otdCfg.measure === 'all' ? otdAll(t) : t.otd_sc);
  values.otd = { ...pick(byMonth((mm) => otdOf(tr.get(mm)))), ytd: otdCfg.measure === 'c' ? ops.tiles.otd.ytd_c : otdCfg.measure === 'all' ? ops.tiles.otd.ytd_all : ops.tiles.otd.ytd_sc };

  // ---- wastage: the scrap rate
  values.wastage = pick(byMonth((mm) => tr.get(mm)?.scrap_rate ?? null));
  { const ytdT = ops.trend.filter((t) => t.month.slice(0, 4) === String(y) && t.month <= m); const p = ytdT.reduce((a, t) => a + t.persoed, 0); values.wastage.ytd = p ? ytdT.reduce((a, t) => a + t.scrap, 0) / p : null; }

  // ---- volume, work orders on time, late and open
  values.volume = { ...pick(byMonth((mm) => tr.get(mm)?.persoed ?? null)), ytd: ops.tiles.persoed_ytd };
  values.ontime = { now: ops.tiles.on_time.daily.pct, prev: null, trend: null };
  values.openlate = { now: ops.tiles.open_late.wos, prev: null, trend: null };

  // ---- productivity: cards persoed ÷ the weekly working hours; and by machine from the timing reports
  const wk = weeksByMonth([y - 1, y]);
  const prodOf = (mm) => { const e = wk.get(mm); return e && e.hours > 0 ? e.cards_with_hours / e.hours : null; };
  values.productivity = pick(byMonth(prodOf));
  { const ytdM = [...wk.entries()].filter(([mm]) => mm.slice(0, 4) === String(y) && mm <= m); const h = ytdM.reduce((a, [, e]) => a + e.hours, 0); values.productivity.ytd = h ? ytdM.reduce((a, [, e]) => a + e.cards_with_hours, 0) / h : null; }
  let machines = [];
  try {
    machines = db.all(`SELECT machine, SUM(qty) AS cards, SUM((julianday(end_at) - julianday(start_at)) * 24) AS hours, COUNT(*) AS runs FROM prod_runs
      WHERE source = 'perso' AND remake = 0 AND job NOT LIKE 'M%' AND start_at IS NOT NULL AND end_at IS NOT NULL AND end_at > start_at AND end_at >= ? AND end_at < ? AND machine <> ''
      GROUP BY machine ORDER BY machine`, [`${m}-01`, `${addMonths(m, 1)}-01`])
      .filter((r) => r.hours > 0.05 && r.cards > 0).map((r) => ({ machine: r.machine, cards: r.cards, hours: Math.round(r.hours * 10) / 10, runs: r.runs, per_hour: r.cards / r.hours }));
  } catch { machines = []; }
  const ph = machines.map((x) => x.per_hour);
  detail.productivity = { weeks: (wk.get(m)?.weeks || []), machines, range: ph.length ? [Math.min(...ph), Math.max(...ph)] : null, hours_typed: !!wk.get(m)?.hours };

  // ---- CPMS: customer complaints per million cards shipped
  const sfRead = !!db.get("SELECT 1 FROM kpi_sources WHERE source = 'salesforce'");
  let cases = [];
  if (sfRead) {
    try {
      const q = require('./quality').quality(m);
      const pm = new Map(q.pack.months.map((r) => [r.month, r]));
      values.cpms = { ...pick(byMonth((mm) => pm.get(mm)?.cpms ?? null)), ytd: q.pack.ytd.cpms };
      detail.cpms = { from: 'salesforce', trend: months.map((mm) => ({ month: mm, cc: pm.get(mm)?.cc ?? 0, shipped: pm.get(mm)?.shipped ?? 0 })) };
      cases = q.cases.filter((c) => /customer\s*complaint/i.test(String(c.kind || ''))).map((c) => ({ ref: c.ref, day: c.day, customer: c.customer, severity: c.severity, summary: c.summary, status: c.status }));
    } catch { /* below */ }
  }
  if (!values.cpms) {
    const ship = (mm) => tr.get(mm)?.shipped || 0;
    const ccOf = (mm) => (wk.get(mm)?.cc_typed ? wk.get(mm).cc : null);
    values.cpms = pick(byMonth((mm) => (ccOf(mm) !== null && ship(mm) ? (ccOf(mm) / ship(mm)) * 1e6 : null)));
    const ytdM = months.filter((mm) => mm.slice(0, 4) === String(y) && mm <= m && ccOf(mm) !== null); const s = ytdM.reduce((a, mm) => a + ship(mm), 0);
    values.cpms.ytd = s ? (ytdM.reduce((a, mm) => a + ccOf(mm), 0) / s) * 1e6 : null;
    detail.cpms = { from: 'typed', trend: months.map((mm) => ({ month: mm, cc: ccOf(mm), shipped: ship(mm) })) };
  }
  detail.cpms.cases = cases;

  // ---- CAPEX: the year's investments (by planned date): committed (approved and on) and in the pipeline
  let capex = [];
  try { capex = db.all("SELECT id, ref, title, category, owner, amount, currency, planned_date, status FROM capex WHERE substr(planned_date, 1, 4) = ? ORDER BY planned_date", [String(y)]); } catch { capex = []; }
  const COMMITTED = ['approved', 'ordered', 'installed', 'closed']; const PIPE = ['submitted', 'on_hold'];
  const sumOf = (list) => list.reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const committed = capex.filter((c) => COMMITTED.includes(c.status)); const pipeline = capex.filter((c) => PIPE.includes(c.status));
  const capexK = (mm) => sumOf(committed.filter((c) => c.planned_date.slice(0, 7) <= mm)) / 1000; // committed for the year so far, in k
  values.capex = { now: sumOf(committed) / 1000, prev: null, trend: months.map((mm) => ({ month: mm, value: mm.slice(0, 4) === String(y) ? capexK(mm) : null })), ytd: capexK(m) };
  detail.capex = {
    year: y, committed: sumOf(committed), pipeline: sumOf(pipeline), draft: sumOf(capex.filter((c) => c.status === 'draft')),
    currencies: [...new Set(capex.map((c) => c.currency || '').filter(Boolean))],
    by_month: Array.from({ length: 12 }, (_, i) => `${y}-${pad(i + 1)}`).map((mm) => ({ month: mm, committed: sumOf(committed.filter((c) => c.planned_date.slice(0, 7) === mm)), pipeline: sumOf(pipeline.filter((c) => c.planned_date.slice(0, 7) === mm)) })),
    items: capex.filter((c) => c.status !== 'rejected').map((c) => ({ ...c })),
  };

  // ---- typed in each month
  const typed = json(setting('ops_values'), {});
  for (const k of KPIS.filter((x) => x.typed)) {
    const v = typed[k.key] || {};
    values[k.key] = { ...pick(byMonth((mm) => (Number.isFinite(v[mm]) ? (k.pct ? v[mm] / 100 : v[mm]) : null))), ytd: null, typed: true }; // a % typed as 73: kept as 0.73, as the others
  }
  return { config: cfg, values, detail };
}

module.exports = { KPIS, config, setConfig, setValue, siteKpis };
