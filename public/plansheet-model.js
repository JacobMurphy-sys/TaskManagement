'use strict';
// 📄 The production plan as data (the sheets, their rows and colours), shared by the browser (planning.js:
// 📄 Generate plan) and the server (src/planauto.js: the plans made on a schedule), so both make the same PDF.
// Loaded before planning.js in the browser; required by the server. Nothing here touches the page.

// Date and number formats made once: making one per row is what made long lists slow to draw.
const PLF = {
  wkHm: new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }),
  hm: new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }),
  day: new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }),
  num: new Intl.NumberFormat('en-GB'),
  one: new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }),
};

// 🖨 The operator sheet: for each cell (card type), the open work orders in the list's order —
// big, plain and colour-coded, with a box to tick. A job with cards of several types is on each
// of those cells' sheets with that type's cards.
const CELL_ORDER = ['dod', 'emboss', 'laser'];
function cellsOf(jobs) {
  const cells = new Map();
  for (const j of jobs) {
    const by = new Map();
    for (const a of j.articles) { const t = a.card?.type || 'Other'; by.set(t, (by.get(t) || 0) + a.qty); }
    for (const [t, qty] of by) { if (!cells.has(t)) cells.set(t, []); cells.get(t).push({ job: j, qty }); }
  }
  const rank = (t) => { const i = CELL_ORDER.indexOf(t.toLowerCase()); return i < 0 ? (t === 'Other' ? 99 : 50) : i; };
  return [...cells.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0])).map(([type, rows]) => ({ type, rows }));
}
// The plan as data: which sheets go on which page, and each row's text and colour. The server draws
// it as a PDF (src/plansheet.js); planSheetHtml() draws the same as a web page.
function planSheetModel(jobs, { cells: pick, layout = 'pages', limit = 0, method = '', test = false, spec = null, splitOverdue = false, groups = null, title = 'Production plan', fileLabel = 'Plan', now = new Date() } = {}) {
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = ymd(now); const tm = new Date(now); tm.setDate(tm.getDate() + 1); const tomorrow = ymd(tm);
  const nowKey = `${today}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const side = layout === 'side';
  const when = (j) => {
    if (!j.deadline) return { cls: 'later', tag: '—', time: '', day: '' };
    const [d, t] = j.deadline.split('T');
    const time = j.no_cutoff ? (side ? 'eod' : 'end of day') : t;
    const short = `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`; // 8/10: the date in the side-by-side pill
    const day = side ? short : PLF.day.format(new Date(`${d}T12:00`));
    if (j.deadline < nowKey) return { cls: 'late', tag: 'LATE', time: `${day} ${time}`, day: short };
    if (d === today) return { cls: 'today', tag: 'TODAY', time, day: short };
    if (d === tomorrow) return { cls: 'tomorrow', tag: 'TOMORROW', time, day: short };
    return { cls: 'later', tag: side ? day : PLF.day.format(new Date(`${d}T12:00`)).toUpperCase(), time, day: short };
  };
  const n = (v) => PLF.num.format(Number(v || 0));
  const cells = (groups || cellsOf(jobs)).filter((c) => !pick || pick.includes(c.type));
  // overdue (past its deadline, not running): on a list of its own when split off
  const isOver = (r) => !r.job.running && !r.job.keep && when(r.job).cls === 'late';
  const section = (c, all, overdue = false) => ({
    name: c.type, overdue, empty: overdue ? 'Nothing overdue.' : 'Nothing open.',
    rows: (limit > 0 ? all.slice(0, limit) : all).map((r, i) => {
      const w = when(r.job);
      return { no: r.job.running ? '' : String(i + 1), running: !!r.job.running, wo: r.job.wo, suffix: r.job.is_otto ? r.job.name.slice(r.job.wo.length) : `/${r.job.per}`,
        note: r.note || '', customer: r.job.customer || '', hot: /high|urgent/i.test(r.job.prio || ''), pinned: !!r.job.pinned, qty: n(r.qty), cls: w.cls, tag: w.tag, time: w.time, day: w.day };
    }),
  });
  const main = (c) => section(c, splitOverdue ? c.rows.filter((r) => !isOver(r)) : c.rows);
  const over = (c) => section(c, c.rows.filter(isOver), true);
  const overCells = cells.filter((c) => !c.noOverdue); // In Progress: nothing moves, so no overdue sheet
  let pages;
  if (side) pages = [{ sections: cells.map(main) }, ...(splitOverdue && overCells.length ? [{ sections: overCells.map(over) }] : [])];
  else pages = cells.flatMap((c) => [{ sections: [main(c)] }, ...(splitOverdue && !c.noOverdue ? [{ sections: [over(c)] }] : [])]);
  const stamp = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return { layout, method, test, stamp, title: `${title} — ${stamp}`, file_label: fileLabel, running_legend: !groups, pages, spec };
}

// 🧪 Testing mode: a last page explaining, in general terms, how each kind of list is put in order.
function orderSpec(p, mode, { split = false } = {}, now = new Date()) {
  const days = p.mitigation?.days ?? 5;
  const byMode = {
    fifo: [{ h2: 'FIFO — by deadline' }, { ol: ['Earliest deadline first, so overdue work orders (oldest first) are at the top.', 'Same deadline: priority High, then Normal, then Low.', 'Still the same: by work order / job number.'] }],
    bau: [{ h2: 'BAU — by due day, then priority' }, { ol: ['Earliest due **day** first.', 'Within a day: priority High, then Normal, then Low.', 'Then the earliest cut-off time, then work order / job number.'] }],
    score: [{ h2: 'Score — highest score first' }, { p: 'Each work order gets a score; the highest goes first (same score: earliest deadline first). The score adds up:' },
      { ul: ['**Deadline** — overdue work orders score highest, more the longer they\'re overdue; others score more the closer their deadline.', '**Modifier lists** (e.g. Matching, Dispatch, Manual) — extra points for particular customers, card tags or card types, e.g. work orders that need extra steps later on.', '**Shift** — extra points for particular customers during particular shifts.'] }],
    mitigation: [{ h2: 'Mitigation — as many on time as possible' }, { ol: [`**Due within the next ${days} working day${days === 1 ? '' : 's'}** and still able to make their deadline — earliest deadline first.`, '**Late anyway** — work orders that will miss their deadline whatever we do, oldest first. They come after the ones that can still be saved.', '**Due later** than that — earliest deadline first.'] }],
  };
  return [{ h1: 'How this list was ordered' }, { note: `Testing mode · printed ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` },
    { h2: 'Every list' }, { ul: ['Each cell\'s sheet lists the open work orders with cards of that type (DOD, Emboss, Laser, …), in the same order on every sheet.', 'A work order\'s deadline is its due date at the shipper\'s cut-off time.',
      '**Running** work orders come first (marked with a triangle), then any **pinned** by the planner, then the rest as below.',
      ...(split ? ['Overdue work orders (past their deadline and not running) are taken off each cell\'s list and put on a separate **Overdue** sheet for that cell, in the same order.'] : [])] },
    ...(byMode[mode] || []),
    { h2: 'The sheet' }, { ul: ['Colours: **red** = past its deadline when printed (LATE); **amber** = due today; **blue** = due tomorrow; otherwise the date is shown.', '**!** = High / Urgent priority; **PIN** = pinned; the number is the place in the order.'] }];
}
// Matching, in the order the work moves: Incoming (its perso work order still open), Ready (perso done,
// not started at Matching), In Progress (started at Matching) — each in the Matching list's order (plan date, then Urgent / High first).
// 💳 Cards and ✉️ carriers of a Matching job. The cards from its perso work order (done when none is
// open; in progress when one is being made); the carriers from the CPS status in the Matching export:
//   Waiting — both not ready, or both in progress · Waiting carrier — cards ready or in progress, carriers not
//   Waiting cards — carriers ready or in progress, cards not · Ready — both ready
// { cards: 'ready' | 'in progress' | 'not started', carriers: 'ready' | 'in progress' | 'not ready' | 'ready or in progress' | null }
function ottoReadiness(o) {
  const cards = !o.perso_open ? 'ready' : (o.perso || []).some((p) => /progress|running|started/i.test(p.status || '')) ? 'in progress' : 'not started';
  const st = String(o.status || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const carriers = /^waiting (for )?carriers?$/.test(st) ? 'not ready' : /^waiting (for )?cards?$/.test(st) ? 'ready or in progress'
    : st === 'waiting' ? (cards === 'in progress' ? 'in progress' : 'not ready') : st === 'ready' ? 'ready' : null;
  return { cards, carriers };
}
// The Incoming note: where the cards and carriers are, and when perso expects the cards to be ready.
function ottoIncomingNote(o) {
  const r = ottoReadiness(o);
  const when = r.cards !== 'ready' && o.perso_finish_at ? ` (ready ~ ${PLF.wkHm.format(new Date(o.perso_finish_at))})` : '';
  const cards = r.cards === 'not started' ? `cards not started — ${o.perso.length} perso job${o.perso.length === 1 ? '' : 's'} open` : `cards ${r.cards}`;
  return `${cards[0].toUpperCase()}${cards.slice(1)}${when}${r.carriers ? ` · carriers ${r.carriers}` : ''}`;
}

function ottoGroups(ot) {
  const row = (o, extra = {}) => ({ job: { ...o, is_otto: true, running: false, pinned: false, ...extra }, qty: o.qty });
  const all = [...ot.running, ...ot.queue];
  return [
    { type: 'Incoming', rows: ot.queue.filter((o) => o.perso_open).map((o) => ({ ...row(o), note: ottoIncomingNote(o) })) },
    { type: 'Ready', rows: ot.queue.filter((o) => !o.perso_open).map((o) => row(o)) },
    { type: 'In Progress', noOverdue: true, rows: all.filter((o) => o.running).map((o) => row(o, { keep: true })) },
  ];
}
function ottoSpec({ split = false } = {}, now = new Date()) {
  return [{ h1: 'How this list was ordered' }, { note: `Testing mode · printed ${now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` },
    { h2: 'The three lists' }, { ul: ['**Incoming** — Matching jobs whose perso work order is still being made. They can\'t start yet; the note says where the **cards** are (not started / in progress, and when perso expects them ready) and the **carriers** (from the CPS status: Waiting carrier → not ready, Waiting cards → ready or in progress, Waiting → as the cards).', '**Ready** — Matching jobs whose perso work is finished and that haven\'t been started yet: these can be picked up now.',
      '**In Progress** — Matching jobs already started.', ...(split ? ['Overdue Incoming and Ready jobs (past their plan date) are put on a separate **Overdue** sheet for that list.'] : [])] },
    { h2: 'Order — in every list' }, { ol: ['Earliest plan date and time first.', 'Same time: Urgent, then High, then the rest.', 'Still the same: by name.'] },
    { h2: 'The sheet' }, { ul: ['Colours: **red** = past its plan date when printed (LATE); **amber** = due today; **blue** = due tomorrow; otherwise the date is shown.', '**!** = Urgent / High priority; the number is the place in the list.'] }];
}

if (typeof module !== 'undefined' && module.exports) module.exports = { PLF, cellsOf, planSheetModel, orderSpec, ottoGroups, ottoSpec, ottoReadiness, ottoIncomingNote };
