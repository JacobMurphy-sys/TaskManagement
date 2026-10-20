'use strict';
// 🔍 Planning search: a work order (WO) or a card (AX) looked up everywhere Planning knows about it —
// the open work orders export, the Matching export, the plan history (when it came in, started, was
// done, how late), the ⏱ production runs and the card database — for one page of what's known.
const db = require('./db');
const planning = require('./planning');

const MAX = 12;
const lc = (v) => String(v ?? '').trim().toLowerCase();
const minutesOf = (r) => (r.start_at && r.end_at ? Math.max(0, (new Date(r.end_at) - new Date(r.start_at)) / 60000) : null);
const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const median = (xs) => { const a = xs.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const r1 = (x) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/**
 * Suggestions as you type: work orders and cards matching `q` (anywhere in it; a card by its name too).
 * ctx: { lines (open WO export lines), otto (Matching jobs), cards (Map AX → card) }
 * → [{ kind: 'wo' | 'item', key, label, sub, open }]
 */
function suggest(q, { lines = [], otto = [], cards = null } = {}) {
  const t = lc(q);
  if (t.length < 2) return [];
  const wos = new Map(); const items = new Map();
  const addWo = (wo, sub, open = false) => { const k = String(wo).toUpperCase(); const cur = wos.get(k); if (!cur || (open && !cur.open)) wos.set(k, { kind: 'wo', key: k, label: k, sub, open }); };
  const addItem = (ax, sub, open = false) => { const k = planning.axKey(ax); if (!k) return; const cur = items.get(k); if (!cur || (open && !cur.open)) items.set(k, { kind: 'item', key: k, label: String(ax).trim(), sub, open }); };
  for (const l of lines) {
    if (lc(l.wo).includes(t)) addWo(l.wo, `open · due ${l.due || '—'}${l.customer ? ` · ${l.customer}` : ''}`, true);
    if (lc(l.article).includes(t) || lc(planning.axKey(l.article)).includes(t)) addItem(l.article, `in open WO ${l.wo}`, true);
  }
  for (const j of otto) if (lc(j.name).includes(t) || lc(j.wo).includes(t)) addWo(j.wo, `Matching ${j.done ? 'done' : 'open'} · ${j.name}`, !j.done);
  for (const h of db.all('SELECT wo, customer, due, done_at FROM plan_history_jobs WHERE lower(wo) LIKE ? ESCAPE \'\\\' ORDER BY first_seen DESC LIMIT 40', [like(t)])) {
    addWo(h.wo, `${h.done_at ? `done ${h.done_at.slice(0, 10)}` : `due ${h.due || '—'}`}${h.customer ? ` · ${h.customer}` : ''}`);
  }
  for (const r of db.all('SELECT job, max(start_at) AS at FROM prod_runs WHERE lower(job) LIKE ? ESCAPE \'\\\' GROUP BY job ORDER BY at DESC LIMIT 40', [like(t)])) {
    addWo(planning.woOfName(r.job), `ran ${String(r.at).slice(0, 10)}`);
  }
  for (const r of db.all('SELECT item, max(item_name) AS name, count(*) AS n FROM prod_runs WHERE item IS NOT NULL AND (lower(item) LIKE ? ESCAPE \'\\\' OR lower(item_name) LIKE ? ESCAPE \'\\\') GROUP BY item ORDER BY n DESC LIMIT 40', [like(t), like(t)])) {
    addItem(r.item, `${r.n} run${r.n === 1 ? '' : 's'}${r.name ? ` · ${r.name}` : ''}`);
  }
  if (cards) {
    let n = 0;
    for (const [k, c] of cards) {
      if (n >= 60) break;
      if (k.toLowerCase().includes(t) || lc(c.name).includes(t)) { n++; if (!items.has(k)) addItem(k, [c.name, c.customer || c.trigram].filter(Boolean).join(' · ') || 'in the card database'); }
    }
  }
  // exact and starts-with first, open before the rest
  const rank = (s) => (lc(s.key) === t || lc(s.label) === t ? 0 : lc(s.key).startsWith(t) || lc(s.label).startsWith(t) ? 1 : 2) * 2 + (s.open ? 0 : 1);
  return [...wos.values(), ...items.values()].sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label)).slice(0, MAX);
}

// a set of runs, summed: { runs, cards, minutes, per_hour, remade, machines, first, last }
function totals(runs) {
  const mins = runs.reduce((t, r) => t + (r.minutes || 0), 0); const cards = runs.reduce((t, r) => t + (r.qty || 0), 0);
  return { runs: runs.length, cards, minutes: Math.round(mins), per_hour: mins ? Math.round((cards / mins) * 60) : null, remade: runs.filter((r) => r.remake).reduce((t, r) => t + (r.qty || 0), 0),
    machines: [...new Set(runs.map((r) => r.machine).filter(Boolean))], first: runs[0]?.start_at || null, last: runs[runs.length - 1]?.end_at || runs[runs.length - 1]?.start_at || null };
}
const runRow = (r) => ({ source: r.source, job: r.job, wo: planning.woOfName(r.job), machine: r.machine, start_at: r.start_at, end_at: r.end_at, qty: r.qty, remake: !!r.remake, item: r.item, item_name: r.item_name,
  minutes: r.minutes === null ? null : Math.round(r.minutes), per_hour: r.minutes ? Math.round((r.qty / r.minutes) * 60) : null });

/** Everything about a work order. ctx as suggest(). */
function workorder(woIn, { lines = [], otto = [], cards = null } = {}) {
  const wo = String(woIn || '').trim().toUpperCase();
  const open = lines.filter((l) => String(l.wo).toUpperCase() === wo).map((l) => {
    const c = cards ? cards.get(planning.axKey(l.article)) || null : null;
    return { per: l.per, article: l.article, qty: l.qty, status: l.status, due: l.due, prio: l.prio, group: l.group, shipper: l.shipper, cutoff: l.cutoff_raw,
      card: c ? { name: c.name, type: c.type, material: c.material, sides: c.sides, customer: c.customer } : null };
  });
  const matching = otto.filter((j) => String(j.wo).toUpperCase() === wo).map((j) => ({ name: j.name, qty: j.qty, status: j.status, due: j.due, done: !!j.done, machine: j.machine || null }));
  const history = db.all('SELECT key, per, customer, qty, due, deadline, prio, shipper, first_seen, last_seen, started_at, done_at, late_minutes FROM plan_history_jobs WHERE upper(wo) = ? ORDER BY first_seen', [wo]);
  const runs = db.all('SELECT * FROM prod_runs WHERE upper(job) LIKE ? ESCAPE \'\\\' ORDER BY start_at', [`${wo.replace(/[\\%_]/g, (c) => `\\${c}`)}%`]).map((r) => ({ ...r, minutes: minutesOf(r) }));
  const perso = runs.filter((r) => r.source === 'perso'); const matchRuns = runs.filter((r) => r.source === 'otto');
  const first = open[0] || history[0] || null;
  const customer = first?.customer || (/^C[A-Z]{3}/i.test(wo) ? wo.slice(1, 4) : null);
  const cust = customer && cards ? [...cards.values()].find((c) => String(c.trigram || '').toUpperCase() === customer)?.customer || null : null;
  const found = open.length || matching.length || history.length || runs.length;
  return { wo, found: !!found, customer, customer_name: cust, open, matching, history, runs: runs.map(runRow),
    perso: totals(perso), otto: totals(matchRuns), items: [...new Set([...open.map((l) => l.article), ...perso.map((r) => r.item)].filter(Boolean))] };
}

/** Everything about a card (AX). ctx as suggest(), plus model (planlearn's, for the learned time). */
function item(axIn, { lines = [], cards = null, model = null, predict = null } = {}) {
  const ax = planning.axKey(axIn);
  const card = cards ? cards.get(ax) || null : null;
  const open = lines.filter((l) => planning.axKey(l.article) === ax).map((l) => ({ wo: l.wo, per: l.per, qty: l.qty, status: l.status, due: l.due, prio: l.prio, shipper: l.shipper, customer: l.customer }));
  // runs: the item column holds the AX as the report has it ("0002358794" and "2358794" alike)
  const runs = db.all("SELECT * FROM prod_runs WHERE source = 'perso' AND item IS NOT NULL AND (item = ? OR ltrim(item, '0') = ? OR upper(item) = ?) ORDER BY start_at", [String(axIn).trim(), ax, ax])
    .map((r) => ({ ...r, minutes: minutesOf(r) }));
  const rates = runs.filter((r) => r.minutes > 0 && r.qty > 0).map((r) => (r.qty / r.minutes) * 60);
  const byMachine = [...runs.reduce((m, r) => m.set(r.machine || '—', [...(m.get(r.machine || '—') || []), r]), new Map())].map(([machine, l]) => ({ machine, ...totals(l) })).sort((a, b) => b.cards - a.cards);
  const byCustomer = [...runs.reduce((m, r) => { const c = r.trigram || r.customer || '—'; return m.set(c, [...(m.get(c) || []), r]); }, new Map())].map(([customer, l]) => ({ customer, ...totals(l) })).sort((a, b) => b.cards - a.cards);
  const name = card?.name || runs.find((r) => r.item_name)?.item_name || null;
  let learned = null;
  if (model && predict) {
    const kindKey = card ? [card.type, card.material, card.sides].map(lc).join('|') : null;
    const customer = open[0]?.customer || card?.trigram || runs[runs.length - 1]?.trigram || null;
    const p = predict(model, { article: ax, qty: 1000, customer: customer ? String(customer).toUpperCase() : null, kindKey });
    if (p) learned = { per_hour: Math.round(p.rate), setup: r1(p.setup), from: p.from, runs: p.runs, minutes_1000: Math.round(p.minutes) };
  }
  const found = !!(card || open.length || runs.length);
  return { ax, found, label: String(axIn).trim(), name, card, open, runs: runs.slice(-40).reverse().map(runRow), total: totals(runs),
    median_per_hour: rates.length ? Math.round(median(rates)) : null, by_machine: byMachine, by_customer: byCustomer, learned,
    jobs: [...new Set(runs.map((r) => planning.woOfName(r.job)))].slice(-30).reverse() };
}

module.exports = { suggest, workorder, item };
