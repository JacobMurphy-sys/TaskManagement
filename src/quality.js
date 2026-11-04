'use strict';
// 🧪 Quality and ⛑ EHS: Reporting's month-by-month pages (the Quality module).
//  - Quality: the customer complaints from the Salesforce export (kpidata source 'salesforce'), by the month
//    a case was opened: how many and how serious, containment and closure, cost, and where they came from.
//  - EHS: the safety concern forms (source 'ehs'): accidents (AC), near misses (NM) and safety concerns (SC)
//    by the month of the incident, open forms, risk (how often × how bad, as on the form) and where.
// Each picks a month (YYYY-MM): that month, the 12 months up to it, and the year to date.

const db = require('./db');
const kpiData = require('./kpidata');

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (day) => String(day || '').slice(0, 7);
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const monthLabel = (m) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const addMonths = (m, n) => { const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const today = () => new Date().toISOString().slice(0, 10);
const daysBetween = (a, b) => (a && b ? Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000) : null);
const avg = (xs) => { const v = xs.filter((x) => x !== null && x !== undefined && Number.isFinite(x)); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const validMonth = (m) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || '')) ? m : null);

// the source's rows, its extra fields spread in
function rowsOf(source) {
  kpiData.ensure();
  return db.all('SELECT day, customer, type, extra FROM kpi_rows WHERE source = ? AND day <> \'\' ORDER BY day, rowid', [source])
    .map((r) => { let x = {}; try { x = JSON.parse(r.extra || '{}') || {}; } catch { /* left empty */ } return { ...x, day: r.day, who: r.customer, type: r.type }; });
}
const sourceInfo = (source) => db.get('SELECT file, modified, imported_at, rows, skipped, first_day, last_day FROM kpi_sources WHERE source = ?', [source]) || null;
// the months to pick from: every month with something in it, and this month, newest first
const monthsOf = (rows) => [...new Set([thisMonth(), ...rows.map((r) => monthOf(r.day))])].filter(Boolean).sort().reverse().map((m) => ({ month: m, label: monthLabel(m) }));
// counts by a field, for the month and the year to date: [{ name, month, ytd }], biggest first, the tail as "Other"
function breakdown(rows, inMonth, inYtd, key, { top = 8, blank = 'Not given' } = {}) {
  const at = new Map();
  for (const r of rows) {
    if (!inYtd(r)) continue;
    const k = String(r[key] ?? '').trim() || blank;
    const e = at.get(k) || { name: k, month: 0, ytd: 0 };
    e.ytd++; if (inMonth(r)) e.month++;
    at.set(k, e);
  }
  const all = [...at.values()].sort((a, b) => b.month - a.month || b.ytd - a.ytd || a.name.localeCompare(b.name));
  if (all.length <= top + 1) return all;
  const rest = all.slice(top);
  return [...all.slice(0, top), { name: `Other (${rest.length})`, month: rest.reduce((t, x) => t + x.month, 0), ytd: rest.reduce((t, x) => t + x.ytd, 0), other: true }];
}

// ---- 🧪 Quality: the Salesforce complaints -------------------------------------------------------
const SEVERITIES = ['Critical', 'Major', 'Minor'];
const severityOf = (s) => SEVERITIES.find((x) => x.toLowerCase() === String(s || '').trim().toLowerCase()) || 'Other';
const isClosedCase = (c) => !!c.closed || /^(closed|cancel)/i.test(String(c.status || ''));

function quality(month) {
  const rows = rowsOf('salesforce').map((c) => ({ ...c, severity: severityOf(c.type), customer: c.who }));
  const months = monthsOf(rows);
  const m = validMonth(month) || months[0].month;
  const y = m.slice(0, 4);
  const inMonth = (c) => monthOf(c.day) === m;
  const inYtd = (c) => c.day.slice(0, 4) === y && monthOf(c.day) <= m;
  const opened = rows.filter(inMonth);
  const prev = rows.filter((c) => monthOf(c.day) === addMonths(m, -1));
  const sev = (list) => Object.fromEntries([...SEVERITIES, 'Other'].map((s) => [s, list.filter((c) => c.severity === s).length]));
  // containment and closure that happened in the month (whenever the case was opened)
  const containedIn = rows.filter((c) => monthOf(c.contained) === m);
  const closedIn = rows.filter((c) => monthOf(c.closed) === m);
  const onTime = containedIn.filter((c) => c.target && c.contained <= c.target).length;
  const withTarget = containedIn.filter((c) => c.target).length;
  const open = rows.filter((c) => !isClosedCase(c));
  const t = today();
  const ytd = rows.filter(inYtd);
  const trend = Array.from({ length: 12 }, (_, i) => addMonths(m, i - 11)).map((mm) => {
    const list = rows.filter((c) => monthOf(c.day) === mm);
    return { month: mm, label: monthLabel(mm), ...sev(list), total: list.length, closed: rows.filter((c) => monthOf(c.closed) === mm).length };
  });
  const caseOut = (c) => ({ ref: c.ref, day: c.day, customer: c.customer, severity: c.severity, kind: c.kind, status: c.status, category: c.category, summary: c.summary,
    defect: c.defect, origin: c.origin, failure_type: c.failure_type, owner: c.owner, target: c.target, contained: c.contained, closed: c.closed, parts: c.parts,
    recurrence: c.recurrence, cost: c.cost, cause: c.cause, non_detection: c.non_detection,
    age: daysBetween(c.day, c.closed || t), contain_late: !c.contained && c.target && c.target < t });
  return {
    source: sourceInfo('salesforce'), months, month: m, label: monthLabel(m), year: Number(y),
    tiles: {
      opened: opened.length, opened_prev: prev.length, severity: sev(opened), ytd: ytd.length, ytd_severity: sev(ytd),
      contained: containedIn.length, contained_on_time: onTime, contained_with_target: withTarget,
      days_to_contain: avg(containedIn.map((c) => daysBetween(c.day, c.contained))), closed: closedIn.length, days_to_close: avg(closedIn.map((c) => daysBetween(c.day, c.closed))),
      open: open.length, open_not_contained: open.filter((c) => !c.contained).length, open_contain_late: open.filter((c) => !c.contained && c.target && c.target < t).length,
      cost: opened.reduce((s, c) => s + num(c.cost), 0), cost_ytd: ytd.reduce((s, c) => s + num(c.cost), 0),
      parts: opened.reduce((s, c) => s + num(c.parts), 0), recurrences: opened.filter((c) => /^y/i.test(String(c.recurrence || ''))).length,
    },
    trend,
    breakdowns: {
      customer: breakdown(rows, inMonth, inYtd, 'customer'), defect: breakdown(rows, inMonth, inYtd, 'defect'), origin: breakdown(rows, inMonth, inYtd, 'origin'),
      category: breakdown(rows, inMonth, inYtd, 'category'), failure_type: breakdown(rows, inMonth, inYtd, 'failure_type'),
    },
    cases: opened.map(caseOut).reverse(),
    open: open.map(caseOut).sort((a, b) => (b.contain_late - a.contain_late) || (b.age - a.age)),
  };
}

// ---- ⛑ EHS: the safety concern forms -----------------------------------------------------------
// the form's own scales (its "data" sheet): how often it could happen and how bad it would be
const OCCURRENCE = [['Rarely', 0.5], ['Once a year', 1], ['Multiple times a year', 1], ['Once a month', 2], ['Multiple times a month', 2], ['Once a week', 3],
  ['Multiple times a week', 3], ['Once a day', 6], ['Multiple times a day', 6], ['Constantly', 10]];
const EFFECT = [['Minor injury (first aid)', 1], ['Injury & absenteeism', 3, 'Injury & abseentism'], ['Serious incident (permanent disability)', 7], ['One death', 15, 'Oone death'], ['A few deaths', 40, 'A few death'], ['Many deaths', 100, 'Many Death']];
const EHS_TYPES = [['AC', 'Accident'], ['NM', 'Near miss'], ['SC', 'Safety concern']];
const isOpenForm = (f) => /^(open|actioned)$/i.test(String(f.status || '').trim()) || !String(f.status || '').trim();
const norm = (s) => String(s || '').trim().toLowerCase();
const effectIndex = (e) => EFFECT.findIndex(([n, , alt]) => norm(n) === norm(e) || (alt && norm(alt) === norm(e)));
const occurrenceIndex = (o) => OCCURRENCE.findIndex(([n]) => norm(n) === norm(o));

function ehs(month) {
  const rows = rowsOf('ehs').map((f) => ({ ...f, location: f.who, kind: String(f.type || '').toUpperCase() }));
  const months = monthsOf(rows);
  const m = validMonth(month) || months[0].month;
  const y = m.slice(0, 4);
  const inMonth = (f) => monthOf(f.day) === m;
  const inYtd = (f) => f.day.slice(0, 4) === y && monthOf(f.day) <= m;
  const byType = (list) => Object.fromEntries(EHS_TYPES.map(([k]) => [k, list.filter((f) => f.kind === k).length]));
  const forms = rows.filter(inMonth);
  const prev = rows.filter((f) => monthOf(f.day) === addMonths(m, -1));
  const ytd = rows.filter(inYtd);
  const open = rows.filter(isOpenForm);
  const t = today();
  const end = m === thisMonth() ? t : `${addMonths(m, 1)}-01`; // "days since" as of the month's end (or today)
  const lastAccident = rows.filter((f) => f.kind === 'AC' && f.day < end).map((f) => f.day).sort().pop() || null;
  const respondedIn = forms.filter((f) => f.response_day);
  // the risk matrix: forms of the year to date by how often × how bad (as scored on the form)
  const matrix = OCCURRENCE.map(([o, os]) => ({ occurrence: o, score: os, cells: EFFECT.map(([e, es]) => ({ effect: e, score: es, risk: os * es, count: 0, open: 0 })) }));
  let unscored = 0;
  for (const f of ytd) {
    const oi = occurrenceIndex(f.occurrence); const ei = effectIndex(f.effect);
    if (oi < 0 || ei < 0) { unscored++; continue; }
    const cell = matrix[oi].cells[ei]; cell.count++; if (isOpenForm(f)) cell.open++;
  }
  const formOut = (f) => ({ num: f.num, day: f.day, time: f.time, kind: f.kind, status: f.status, location: f.location, detail: f.detail, category: f.category,
    first_aid: f.first_aid, occurrence: f.occurrence, effect: f.effect, risk: f.risk ?? (f.occ_score && f.effect_score ? f.occ_score * f.effect_score : null),
    response: f.response, description: f.description, immediate: f.immediate, corrective: f.corrective, name: f.name, otl: f.otl, scf_response: f.scf_response,
    responder: f.responder, response_day: f.response_day, days_open: isOpenForm(f) ? daysBetween(f.day, t) : (f.response_day ? daysBetween(f.day, f.response_day) : null) });
  return {
    source: sourceInfo('ehs'), months, month: m, label: monthLabel(m), year: Number(y), types: EHS_TYPES,
    tiles: {
      month: byType(forms), prev: byType(prev), ytd: byType(ytd), total: forms.length, total_ytd: ytd.length,
      open: open.length, open_high: open.filter((f) => num(f.risk) >= 6).length,
      days_since_accident: lastAccident ? daysBetween(lastAccident, end) : null, last_accident: lastAccident,
      days_to_respond: avg(respondedIn.map((f) => daysBetween(f.day, f.response_day))), responded: respondedIn.length,
      first_aid: forms.filter((f) => f.first_aid && !/^none$/i.test(f.first_aid)).length,
    },
    trend: Array.from({ length: 12 }, (_, i) => addMonths(m, i - 11)).map((mm) => { const list = rows.filter((f) => monthOf(f.day) === mm); return { month: mm, label: monthLabel(mm), ...byType(list), total: list.length }; }),
    breakdowns: {
      category: breakdown(rows, inMonth, inYtd, 'category'), location: breakdown(rows, inMonth, inYtd, 'location'),
      first_aid: breakdown(rows, inMonth, inYtd, 'first_aid'), response: breakdown(rows, inMonth, inYtd, 'response'),
    },
    matrix, unscored,
    forms: forms.map(formOut).reverse(),
    open: open.map(formOut).sort((a, b) => num(b.risk) - num(a.risk) || num(b.days_open) - num(a.days_open)),
  };
}

module.exports = { quality, ehs, monthLabel, addMonths, OCCURRENCE, EFFECT };
