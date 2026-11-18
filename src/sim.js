'use strict';
// 📣 SIM (Short Interval Management): the KPI part of the briefings between shifts and departments. It looks at one
// day — by default the last working day before today — and the month up to it, for four topics:
//  - Quality: CPMS that day (customer complaints opened ÷ cards shipped × 1,000,000, as on Operations) and the
//    internal reports typed in at the SIM (sim_reports);
//  - Safety: the safety concern forms by incident date (AC accidents, NM near misses, SC safety concerns);
//  - Scrap: the scrap rate (scrap ÷ cards persoed, from the source the A3 uses), with the day's top work orders;
//  - OTD: OTD SC that day (1 − SC delays dated that day ÷ cards shipped that day), with its delays, and the
//    planner's work orders due that day that were late.
// Each is coloured against the KPI's target set on Operations, with an amber band (sim_band_<topic>, 10% unless set).

const db = require('./db');
const kpiData = require('./kpidata');
const siteKpis = require('./sitekpis');

const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const validDay = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) ? d : null);
const isCard = (t) => /card/i.test(String(t || ''));
const parseExtra = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const isCustomerComplaint = (c) => /customer\s*complaint/i.test(String(c.kind || ''));
const TOPICS = ['quality', 'safety', 'scrap', 'otd'];

// the working week (Production's days and holidays): is a day worked?
function calendarOf(settings) {
  const days = new Set(String(settings.plan_days || '1,2,3,4,5').split(',').map(Number).filter((d) => d >= 0 && d <= 6));
  const holidays = new Set(String(settings.cpm_holidays || '').split(/[\s,;]+/).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)));
  return (day) => days.has(new Date(`${day}T12:00:00Z`).getUTCDay()) && !holidays.has(day);
}
// the last working day before a day (today, by default)
function lastWorkingDay(isWorked, before) {
  let d = addDays(before, -1);
  for (let i = 0; i < 31 && !isWorked(d); i++) d = addDays(d, -1);
  return d;
}

// the amber band of a topic (a share of the target: 0.1 = 10%)
const bandOf = (settings, topic) => { const v = Number(settings[`sim_band_${topic}`]); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.1; };
// green / yellow / red against the target: 'down' is better lower (CPMS, scrap), 'up' better higher (OTD)
function colourOf(value, target, better, band) {
  if (value === null || value === undefined || target === null || target === undefined) return null;
  if (better === 'down') return value <= target ? 'green' : value <= target * (1 + band) || (target === 0 && value === 0) ? 'yellow' : 'red';
  return value >= target ? 'green' : value >= target * (1 - band) ? 'yellow' : 'red';
}

/**
 * SIM for a day: { day, default_day, label, days: [the month up to it], topics: { quality, safety, scrap, otd } }
 */
function sim(dayIn, { settings = {}, today = new Date(), names = new Map() } = {}) {
  kpiData.ensure();
  const isWorked = calendarOf(settings);
  const todayKey = isoDay(today);
  const defaultDay = lastWorkingDay(isWorked, todayKey);
  const day = validDay(dayIn) || defaultDay;
  const from = `${day.slice(0, 7)}-01`;
  const days = []; for (let d = from; d <= day; d = addDays(d, 1)) days.push(d);
  const inMtd = (d) => d >= from && d <= day;
  const cfg = Object.fromEntries(siteKpis.config().map((k) => [k.key, k]));
  const target = (k) => (cfg[k]?.target === null || cfg[k]?.target === undefined ? null : cfg[k].target);

  // ---- the day's and month's cards: persoed (scrap rate) and shipped (CPMS, OTD)
  const vol = (source) => {
    const m = new Map();
    for (const r of db.all('SELECT day, type, qty FROM kpi_rows WHERE source = ? AND day >= ? AND day <= ?', [source, from, day])) if (isCard(r.type)) m.set(r.day, (m.get(r.day) || 0) + (r.qty || 0));
    return m;
  };
  const persoed = vol('perso'); const shipped = vol('shipped');
  // how far each report has been read (the day's figures may not be in yet)
  const readTo = (source) => { try { return db.get('SELECT MAX(day) AS d FROM kpi_rows WHERE source = ?', [source])?.d || null; } catch { return null; } };
  const shippedTo = readTo('shipped'); const persoTo = readTo('perso');

  // ---- quality: customer complaints by the day opened, against cards shipped; the internal reports typed in
  const cases = db.all("SELECT day, customer, type, extra FROM kpi_rows WHERE source = 'salesforce' AND day >= ? AND day <= ? ORDER BY day, rowid", [from, day])
    .map((r) => ({ ...parseExtra(r.extra), day: r.day, customer: r.customer, severity: r.type }))
    .filter(isCustomerComplaint);
  let reports = []; try { reports = db.all('SELECT id, day, text, area, created_by, created_at FROM sim_reports WHERE day >= ? AND day <= ? ORDER BY day, id', [from, day]); } catch { reports = []; }
  const cpmsOf = (d) => { const s = shipped.get(d) || 0; const n = cases.filter((c) => c.day === d).length; return s ? (n / s) * 1e6 : null; }; // no cards shipped read for the day: no figure (not 0)
  const qMtdShip = days.reduce((a, d) => a + (shipped.get(d) || 0), 0);
  const quality = {
    target: target('cpms'), better: 'down', band: bandOf(settings, 'quality'), unit: 'CPMS',
    value: cpmsOf(day), shipped: shipped.get(day) || 0, read_to: shippedTo,
    complaints: cases.filter((c) => c.day === day).map((c) => ({ ref: c.ref || null, customer: c.customer, severity: c.severity || null, summary: c.summary || c.defect || null })),
    internal: reports.filter((r) => r.day === day),
    mtd: { value: qMtdShip ? (cases.length / qMtdShip) * 1e6 : null, complaints: cases.length, internal: reports.length },
    by_day: days.map((d) => ({ day: d, worked: isWorked(d), value: cpmsOf(d), complaints: cases.filter((c) => c.day === d).length, internal: reports.filter((r) => r.day === d).length })),
  };

  // ---- safety: the forms by incident date
  const forms = db.all("SELECT day, customer, type, extra FROM kpi_rows WHERE source = 'ehs' AND day >= ? AND day <= ? ORDER BY day, rowid", [from, day])
    .map((r) => { const x = parseExtra(r.extra); return { day: r.day, kind: String(r.type || '').toUpperCase(), location: r.customer || x.location || null, detail: x.detail || null, description: x.description || null, category: x.category || null, status: x.status || null, num: x.num ?? null }; });
  const countOf = (list) => ({ ac: list.filter((f) => f.kind === 'AC').length, nm: list.filter((f) => f.kind === 'NM').length, sc: list.filter((f) => f.kind === 'SC').length });
  const safetyColour = (c) => (c.ac ? 'red' : c.nm ? 'yellow' : 'green');
  const dayForms = forms.filter((f) => f.day === day);
  const safety = {
    ...countOf(dayForms), colour: safetyColour(countOf(dayForms)), rule: 'Red with an accident, yellow with a near miss, green otherwise',
    forms: dayForms, mtd: countOf(forms),
    by_day: days.map((d) => { const c = countOf(forms.filter((f) => f.day === d)); return { day: d, worked: isWorked(d), ...c, colour: forms.some((f) => f.day === d) || isWorked(d) ? safetyColour(c) : null }; }),
  };

  // ---- scrap: the remakes from the source the A3 uses, against cards persoed
  const scrapFrom = kpiData.scrapSource();
  const scrapRows = (scrapFrom === 'consumption'
    ? db.all("SELECT day, customer, type, scrap, extra FROM kpi_rows WHERE source = 'consumption' AND scrap <> 0 AND day >= ? AND day <= ?", [from, day])
      .map((r) => { const x = parseExtra(r.extra); return { day: r.day, customer: r.customer || x.customer_name || null, qty: r.scrap, cause: [r.type, x.reason_name].filter(Boolean).join(' · ') || 'No reason code', wo: x.wo || null, item: x.item_name || x.item || null }; })
    : db.all("SELECT day, customer, qty, extra FROM kpi_rows WHERE source = 'remakes' AND day >= ? AND day <= ?", [addDays(from, -14), addDays(day, 14)]) // (counted by the day persoed, a little apart)
      .map((r) => { const x = parseExtra(r.extra); return { day: x.perso_day || r.day, customer: r.customer, qty: r.qty, cause: [x.machine, x.mode].filter(Boolean).join(' · ') || 'Not given', wo: x.wo || null, item: null }; }))
    .filter((r) => r.day && inMtd(r.day));
  const scrapOf = (d) => scrapRows.filter((r) => r.day === d).reduce((a, r) => a + (r.qty || 0), 0);
  const rateOf = (d) => { const p = persoed.get(d) || 0; return p ? scrapOf(d) / p : null; };
  const byWo = new Map();
  for (const r of scrapRows.filter((x) => x.day === day)) {
    const k = r.wo || `${r.customer || '?'}|${r.cause}`; const e = byWo.get(k) || { wo: r.wo, customer: r.customer, qty: 0, causes: new Map(), item: r.item };
    e.qty += r.qty || 0; e.causes.set(r.cause, (e.causes.get(r.cause) || 0) + (r.qty || 0)); byWo.set(k, e);
  }
  const mtdPerso = days.reduce((a, d) => a + (persoed.get(d) || 0), 0); const mtdScrap = scrapRows.reduce((a, r) => a + (r.qty || 0), 0);
  const scrap = {
    target: target('wastage'), better: 'down', band: bandOf(settings, 'scrap'), from: scrapFrom,
    value: rateOf(day), scrap: scrapOf(day), persoed: persoed.get(day) || 0, read_to: persoTo,
    top: [...byWo.values()].sort((a, b) => b.qty - a.qty).slice(0, 5).map((e) => ({ wo: e.wo, customer: e.customer, name: names.get(String(e.customer || '').toUpperCase()) || null, qty: e.qty, item: e.item,
      cause: [...e.causes.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c).slice(0, 2).join(', ') })),
    mtd: { value: mtdPerso ? mtdScrap / mtdPerso : null, scrap: mtdScrap, persoed: mtdPerso },
    by_day: days.map((d) => ({ day: d, worked: isWorked(d), value: rateOf(d), scrap: scrapOf(d) })),
  };

  // ---- OTD: SC delays dated that day against the cards shipped that day; the planner's late work orders due that day
  const otdAll = db.all("SELECT day, week, customer, type, qty, extra FROM kpi_rows WHERE source = 'otd'")
    .map((r) => { const x = parseExtra(r.extra); return { day: r.day || '', week: String(r.week || '').toUpperCase(), customer: r.customer, internal: /^int/i.test(r.type || ''), external: /^ext/i.test(r.type || ''), qty: r.qty || 0, reason: x.reason || null, wo: x.wo || null }; });
  const dated = otdAll.filter((r) => r.day && inMtd(r.day));
  const scOf = (d) => dated.filter((r) => r.day === d && r.internal).reduce((a, r) => a + r.qty, 0);
  const otdOf = (d) => { const s = shipped.get(d) || 0; return s ? 1 - scOf(d) / s : null; };
  const wk = kpiData.weekCode(day); const undated = otdAll.filter((r) => !r.day && r.week === wk);
  let lateWos = [];
  try {
    lateWos = db.all('SELECT wo, per, customer, qty, deadline, done_at, late_minutes FROM plan_history_jobs WHERE deadline >= ? AND deadline < ?', [day, addDays(day, 1)])
      .filter((j) => (j.done_at ? Number(j.late_minutes) > 0 : `${j.deadline}` < today.toISOString().slice(0, 16)))
      .map((j) => ({ wo: j.wo, customer: j.customer, name: names.get(String(j.customer || '').toUpperCase()) || null, qty: j.qty, deadline: j.deadline, done_at: j.done_at, open: !j.done_at,
        late_hours: j.done_at ? Math.round((Number(j.late_minutes) || 0) / 6) / 10 : Math.round((today - new Date(j.deadline)) / 360000) / 10 }))
      .sort((a, b) => (b.qty || 0) - (a.qty || 0)).slice(0, 5);
  } catch { lateWos = []; }
  const dayDelays = dated.filter((r) => r.day === day);
  const mtdShip = days.reduce((a, d) => a + (shipped.get(d) || 0), 0); const mtdSc = dated.filter((r) => r.internal).reduce((a, r) => a + r.qty, 0);
  const otd = {
    target: target('otd'), better: 'up', band: bandOf(settings, 'otd'),
    value: otdOf(day), shipped: shipped.get(day) || 0, read_to: shippedTo, sc: scOf(day), customer: dayDelays.filter((r) => r.external).reduce((a, r) => a + r.qty, 0),
    delays: dayDelays.sort((a, b) => b.qty - a.qty).slice(0, 5).map((r) => ({ customer: r.customer, qty: r.qty, kind: r.internal ? 'SC' : r.external ? 'C' : '?', reason: r.reason, wo: r.wo })),
    undated: { week: wk, rows: undated.length, qty: undated.reduce((a, r) => a + r.qty, 0) },
    late_wos: lateWos,
    mtd: { value: mtdShip ? 1 - mtdSc / mtdShip : null, sc: mtdSc, shipped: mtdShip },
    by_day: days.map((d) => ({ day: d, worked: isWorked(d), value: otdOf(d), sc: scOf(d) })),
  };

  // colours: the day's and each day of the month's
  for (const [k, t] of Object.entries({ quality, scrap, otd })) {
    t.colour = colourOf(t.value, t.target, t.better, t.band); t.mtd.colour = colourOf(t.mtd.value, t.target, t.better, t.band);
    for (const b of t.by_day) b.colour = colourOf(b.value, t.target, t.better, t.band);
    t.key = k;
  }
  const dayLabel = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { day, default_day: defaultDay, today: todayKey, label: dayLabel, worked: isWorked(day), topics: { quality, safety, scrap, otd }, bands: Object.fromEntries(TOPICS.map((t) => [t, bandOf(settings, t)])) };
}

module.exports = { sim, colourOf, lastWorkingDay, calendarOf, TOPICS };
