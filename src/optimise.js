'use strict';
// 🔎 Production › Insights › Optimisation: work orders that could be fewer. For each customer, the separate work
// orders whose cards could run as one: the same card (or the same kind of card), so the same personalisation
// method, going out with the same shipper at the same shipping time on the same due-out day (or within a few
// working days). Each such set could be one work order: fewer set-ups, change-overs, paperwork and despatches.
// Looked for in the open work orders now (to act on) or in the history of the past weeks (habits to raise with
// the customer, or to plan around).

const db = require('./db');
const planning = require('./planning');
const { normTech } = require('./cpm'); // the card database's type as a production technology: DOD, Emboss or Laser

const pad = (n) => String(n).padStart(2, '0');
const hhmm = (m) => (m === null || m === undefined ? null : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
const isRenewal = (prio) => /^low/i.test(String(prio || '').trim());
const dayDiff = (a, b) => Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);

// What has to be the same, from the page's choices (each one optional):
//  card: 'tech' the same production technology (DOD, Emboss, Laser: the card database's type), the default |
//        'kind' the same kind of card (type, material, print sides) | 'ax' the same card (Card AX)
//  shipper, time: the same shipper / shipping time; due: 'day' the same due-out day | 'w1'…'w5' within that many
//  days of each other | 'any'; prio: dailies and renewals kept apart
function options(q = {}) {
  const on = (v, d) => (v === undefined || v === null || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase()));
  const due = /^(day|any|w[1-5])$/.test(String(q.due || '')) ? String(q.due) : 'day';
  return { card: ['ax', 'kind'].includes(q.card) ? q.card : 'tech', shipper: on(q.shipper, true), time: on(q.time, true), due, prio: on(q.prio, true) };
}

// one line a card: { wo, per, customer, article, qty, card: { type, material, sides, name }, due, time, shipper, renewal }
function linesOfJobs(jobs, cards) {
  const out = [];
  for (const j of jobs) {
    for (const a of j.articles || []) {
      if (!a.article || !j.customer || !j.due) continue;
      const card = a.card || cards?.get(planning.axKey(a.article)) || null;
      out.push({ wo: j.wo, per: j.per || '', customer: String(j.customer).toUpperCase(), article: a.article, qty: Number(a.qty) || 0,
        card: card ? { type: card.type || null, tech: normTech(card.type), material: card.material || null, sides: card.sides || null, name: card.name || null } : null,
        due: j.due, time: j.time ?? hhmm(j.cutoff ?? null), shipper: j.shipper || null, renewal: isRenewal(j.prio), prio: j.prio || null, done: !!j.done });
    }
  }
  return out;
}

function seek(lines, opts, { names = new Map() } = {}) {
  const o = options(opts);
  const keyOf = (l) => [l.customer,
    // a card whose technology isn't known (not in the card database) only goes with the same card
    o.card === 'tech' ? (l.card?.tech ? `tech:${l.card.tech}` : `ax:${l.article}`)
      : o.card === 'kind' ? (l.card ? ['type', 'material', 'sides'].map((k) => String(l.card[k] || '').toLowerCase()).join('|') : `ax:${l.article}`) : l.article,
    o.shipper ? (l.shipper || '').toLowerCase() : '', o.time ? l.time || '' : '', o.prio ? (l.renewal ? 'R' : 'D') : '', o.due === 'day' ? l.due : ''].join('\u0001');
  const buckets = new Map();
  for (const l of lines) { const k = keyOf(l); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(l); }
  // due dates within a window: neighbours no further apart than it are one set
  const win = o.due === 'any' ? Infinity : o.due === 'day' ? 0 : Number(o.due.slice(1));
  const groups = [];
  for (const list of buckets.values()) {
    list.sort((a, b) => a.due.localeCompare(b.due) || a.wo.localeCompare(b.wo));
    let cur = [];
    const close = () => {
      const wos = [...new Set(cur.map((l) => l.wo))];
      if (wos.length >= 2) groups.push(cur);
      cur = [];
    };
    for (const l of list) { if (cur.length && dayDiff(cur[cur.length - 1].due, l.due) > win) close(); cur.push(l); }
    if (cur.length) close();
  }
  const out = groups.map((g) => {
    const f = g[0]; const wos = [...new Set(g.map((l) => l.wo))];
    const dues = g.map((l) => l.due).sort();
    return {
      customer: f.customer, name: names.get(f.customer) || null,
      article: o.card === 'ax' ? f.article : [...new Set(g.map((l) => l.article))].join(', '), card: f.card,
      method: f.card?.tech || f.card?.type || null, cards_n: new Set(g.map((l) => l.article)).size, shipper: o.shipper ? f.shipper : [...new Set(g.map((l) => l.shipper).filter(Boolean))].join(', ') || null,
      time: o.time ? f.time : [...new Set(g.map((l) => l.time).filter(Boolean))].join(', ') || null,
      renewal: o.prio ? f.renewal : null, from: dues[0], to: dues[dues.length - 1],
      wos: wos.length, could_be: 1, saving: wos.length - 1, cards: g.reduce((t, l) => t + l.qty, 0),
      lines: g.map((l) => ({ wo: l.wo, per: l.per, article: l.article, qty: l.qty, due: l.due, time: l.time, shipper: l.shipper, prio: l.prio, done: l.done })),
    };
  }).sort((a, b) => b.saving - a.saving || b.cards - a.cards || a.customer.localeCompare(b.customer));
  // per customer: their work orders, how many are in a set, and how many fewer there could be
  const custs = new Map();
  for (const l of lines) { const c = custs.get(l.customer) || custs.set(l.customer, { customer: l.customer, name: names.get(l.customer) || null, wos: new Set(), in_sets: new Set(), saving: 0, sets: 0, cards: 0 }).get(l.customer); c.wos.add(l.wo); c.cards += l.qty; }
  // how many fewer: work orders linked by the sets they share become one each (a work order with several cards is
  // in several sets, but it's still one work order, so it's counted once)
  const parent = new Map(); const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const g of out) {
    const c = custs.get(g.customer); c.sets++;
    const wos = [...new Set(g.lines.map((l) => l.wo))];
    for (const w of wos) { c.in_sets.add(w); if (!parent.has(w)) parent.set(w, w); }
    for (const w of wos.slice(1)) parent.set(find(w), find(wos[0]));
  }
  const customers = [...custs.values()].map((c) => {
    const roots = new Set([...c.in_sets].map(find)); const saving = c.in_sets.size - roots.size;
    return { customer: c.customer, name: c.name, wos: c.wos.size, in_sets: c.in_sets.size, sets: c.sets, saving, could_be: c.wos.size - saving, cards: c.cards, share: c.wos.size ? saving / c.wos.size : 0 };
  }).sort((a, b) => b.saving - a.saving || b.wos - a.wos);
  const allWos = new Set(lines.map((l) => l.wo)); const inSets = new Set(out.flatMap((g) => g.lines.map((l) => l.wo)));
  const saving = customers.reduce((t, c) => t + c.saving, 0);
  return { options: o, total: { wos: allWos.size, lines: lines.length, customers: custs.size, sets: out.length, in_sets: inSets.size, saving, share: allWos.size ? saving / allWos.size : 0,
    no_card: lines.filter((l) => !l.card).length }, customers, groups: out.slice(0, 400) };
}

// the history: work orders due between two days (the planner's record of every export read), a line a card
function historyLines(from, to) {
  let jobs = [];
  try {
    jobs = db.all('SELECT key, wo, per, customer, due, deadline, prio, shipper, done_at FROM plan_history_jobs WHERE due >= ? AND due <= ?', [from, to]);
  } catch { return []; }
  const arts = new Map();
  try { for (const r of db.all('SELECT key, article, qty FROM plan_history_lines WHERE key IN (SELECT key FROM plan_history_jobs WHERE due >= ? AND due <= ?)', [from, to])) { if (!arts.has(r.key)) arts.set(r.key, []); arts.get(r.key).push({ article: r.article, qty: r.qty }); } } catch { /* none */ }
  return jobs.map((j) => ({ ...j, time: j.deadline && !/T23:59/.test(j.deadline) ? j.deadline.slice(11, 16) : null, articles: arts.get(j.key) || [], done: !!j.done_at }));
}

module.exports = { options, linesOfJobs, seek, historyLines };
