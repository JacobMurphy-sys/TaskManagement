'use strict';
// 📐 Capacity planning to Excel, laid out like the CPM workbook: per plan (the base and each scenario
// compared) a sheet with the working time, the forecast per customer and technology, the capacity it
// needs (÷ OEE), the machines' hours and capacity, and a summary per technology — the figures as the
// app worked them out, but as formulas over the inputs (split, OEE, availability, speed, shifts,
// hours), so they can be changed in Excel. Then charts, the forecast check and the scenarios.
const { sheet, buildBook } = require('./xlsxbook');
const { colName } = require('./xlsx');

// the CPM workbook's technology colours (DOD teal, Laser purple, Emboss black — a dark grey for bars)
const TECH_COL = { DOD: '008080', Emboss: '404040', Laser: '7030A0' };
const SC_COL = ['7A5CFF', 'E0861A'];
const FIRST = 7; // the first period column (G)

const near = (a, b) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
const r4 = (x) => Math.round(x * 1e6) / 1e6;

function describe(c, CARD_FIELDS) {
  const span = `${c.from ? ` from ${c.from}` : ''}${c.to ? ` until ${c.to}` : ''}`;
  const pct = (x) => `${Number(x) >= 0 ? '+' : ''}${Number(x) || 0}%`;
  switch (c.type) {
    case 'speed': return `Speed ${pct(c.pct)}${c.machine ? ` on ${c.machine}` : ' on all machines'}${c.tech ? ` (${c.tech})` : ''}${span}`;
    case 'add_machine': return `Add ${c.name || 'a machine'} running ${(c.techs || []).join(', ') || '—'}${span}`;
    case 'remove_machine': return `Remove ${c.machine}${span}`;
    case 'capabilities': return `${c.machine} runs ${(c.techs || []).join(', ') || 'nothing'}${span}`;
    case 'restrict': return `${c.machine} only runs ${[(c.customers || []).length ? `customers ${c.customers.join(', ')}` : '', (c.values || []).length ? `${CARD_FIELDS[c.field] || c.field}: ${c.values.join(', ')}` : ''].filter(Boolean).join(' and ') || 'anything'}${span}`;
    case 'shifts': return `${c.shifts !== undefined && c.shifts !== '' ? `${c.shifts} shifts` : ''}${c.hours ? ` ${c.hours} productive hours a shift` : ''}${span}`;
    case 'oee': return `OEE ${Number(c.points) >= 0 ? '+' : ''}${Number(c.points) || 0} points${c.customer ? ` for ${c.customer}` : ''}${c.tech ? ` (${c.tech})` : ''}${span}`;
    case 'volume': return `Volume ${pct(c.pct)}${c.customer ? ` for ${c.customer}` : ' for all customers'}${span}`;
    case 'new_customer': return `New customer ${c.name || ''}: ${Number(c.qty) || 0} cards a month${span}`;
    default: return c.type;
  }
}

// one plan → a sheet; returns the rows the charts and comparisons need
function planSheet(name, res, ctx) {
  const sh = sheet(name); const P = res.periods; const n = P.length; const T = res.techs;
  const col = (i) => FIRST + i; const tot = FIRST + n; const now = ctx.today;
  sh.width(1, 11).width(2, 30).width(3, 10).width(4, 9).width(5, 9).width(6, 2); for (let i = 0; i <= n; i++) sh.width(col(i), ctx.period === 'week' ? 9 : 11);
  sh.width(tot, 13);
  sh.set(1, 1, `CPM ${res.year} — ${name}`, 'title');
  sh.set(2, 1, `Forecast as read in ${res.forecast_as_of || '—'} · ${ctx.flex ? 'flex applied' : 'no flex'} · ${res.shifts} shifts × ${res.hours} productive hours · ${ctx.period === 'week' ? 'by week' : 'by month'} · made ${ctx.made}`, 'note');
  sh.set(3, 1, 'Cells in blue on yellow are inputs — change them and the rest works itself out. Grey cells are figures fixed by a scenario change for that period.', 'note');
  let r = 5;
  const head = (row, labels, totalLabel = ctx.period === 'week' ? 'Year' : 'Year') => {
    labels.forEach((l, i) => sh.set(row, i + 1, l, 'header'));
    for (let i = labels.length + 1; i < FIRST; i++) sh.set(row, i, '', 'header');
    P.forEach((p, i) => sh.set(row, col(i), p.label, 'headerNum')); sh.set(row, tot, totalLabel, 'headerNum');
  };
  const sumRow = (row, style = 'intBold') => sh.f(row, tot, `SUM(${sh.ref(row, col(0))}:${sh.ref(row, col(n - 1))})`, style);
  const section = (row, text) => { for (let c = 1; c <= tot; c++) sh.set(row, c, c === 1 ? text : '', 'section'); };

  // ---- working time
  section(r, 'Working time'); r++;
  head(r, ['', '', '', '', '']); const rCal = r + 1;
  const rDays = rCal; const rShifts = rCal + 1; const rHph = rCal + 2; const rHours = rCal + 3;
  sh.set(rDays, 1, 'Working days', 'bold'); sh.set(rShifts, 1, 'Shifts', 'bold'); sh.set(rHph, 1, 'Productive hours a shift', 'bold'); sh.set(rHours, 1, 'Hours', 'bold');
  P.forEach((p, i) => {
    sh.set(rDays, col(i), p.workdays, 'input'); sh.set(rShifts, col(i), p.shifts ?? 0, 'input'); sh.set(rHph, col(i), p.hph ?? 0, 'inputDec');
    if (near(p.workdays * (p.shifts || 0) * (p.hph || 0), p.hours)) sh.f(rHours, col(i), `${sh.ref(rDays, col(i))}*${sh.ref(rShifts, col(i))}*${sh.ref(rHph, col(i))}`, 'int', p.hours);
    else sh.set(rHours, col(i), p.hours, 'fixed');
  });
  sumRow(rDays, 'intBold'); sumRow(rHours, 'intBold');
  r = rHours + 2;

  // ---- forecast per customer, by technology, and the capacity it needs
  const det = [...(res.detail || [])].sort((a, b) => (a.trigram || '~').localeCompare(b.trigram || '~') || a.name.localeCompare(b.name) || T.indexOf(a.tech) - T.indexOf(b.tech));
  const per = (D, i) => { // the period's figures from the months it covers
    const p = P[i]; let fc = 0; let tfc = 0; let need = 0;
    for (const [mk, f] of Object.entries(p.share || {})) { const m = Number(mk.slice(5)); const x = D.months[m]; if (!x) continue; fc += x.fc * f; tfc += x.fc * x.split * f; need += ((x.fc * x.split) / x.oee) * f; }
    return { fc, tfc, need };
  };
  const splitOf = (D) => { const v = Object.values(D.months).map((x) => x.split); return v.every((x) => near(x, v[0])) ? v[0] : null; };
  const oeeOf = (D) => { const v = Object.values(D.months).map((x) => x.oee); return v.every((x) => near(x, v[0])) ? v[0] : null; };
  const avgSplit = (D) => { const q = Object.values(D.months); const f = q.reduce((a, x) => a + x.fc, 0); return f ? q.reduce((a, x) => a + x.fc * x.split, 0) / f : 0; };
  const avgOee = (D) => { const q = Object.values(D.months); const t = q.reduce((a, x) => a + x.fc * x.split, 0); const nd = q.reduce((a, x) => a + (x.fc * x.split) / x.oee, 0); return nd ? t / nd : D.oee; };

  section(r, `Forecast — cards per customer${ctx.flex ? ' (× flex)' : ''}${res.changes?.some((c) => c.type === 'volume') ? ', with the scenario\'s volume changes' : ''}`); r++;
  head(r, ['Trigram', 'Customer', 'Technology', 'Split', 'OEE']); r++;
  const rFc0 = r;
  det.forEach((D, k) => {
    const row = rFc0 + k; const sp = splitOf(D); const oe = oeeOf(D);
    sh.set(row, 1, D.trigram || '—'); sh.set(row, 2, D.name); sh.set(row, 3, D.tech);
    sh.set(row, 4, r4(sp ?? avgSplit(D)), sp === null ? 'pct' : 'inputPct'); sh.set(row, 5, r4(oe ?? avgOee(D)), oe === null ? 'pct' : 'inputPct');
    P.forEach((_, i) => sh.set(row, col(i), per(D, i).fc, 'input'));
    sumRow(row, 'int');
  });
  const rFc1 = rFc0 + det.length - 1; r = rFc1 + 2;
  sh.set(r - 1, 1, det.some((D) => splitOf(D) === null || oeeOf(D) === null) ? 'A split or OEE that changes over the year (the Amex forecast\'s own split, a scenario\'s OEE change) is shown as its average and used month by month below.' : '', 'note');

  section(r, 'Forecast by technology — cards (forecast × split)'); r++;
  head(r, ['Trigram', 'Customer', 'Technology', '', '']); r++;
  const rTf0 = r;
  det.forEach((D, k) => {
    const row = rTf0 + k; const sp = splitOf(D);
    sh.set(row, 1, D.trigram || '—'); sh.set(row, 2, D.name); sh.set(row, 3, D.tech);
    P.forEach((_, i) => { const x = per(D, i); const fcRef = sh.ref(rFc0 + k, col(i));
      if (sp !== null) sh.f(row, col(i), `${fcRef}*$D${rFc0 + k}`, 'int', x.tfc);
      else sh.f(row, col(i), `${fcRef}*${x.fc ? r4(x.tfc / x.fc) : 0}`, 'fixed', x.tfc); });
    sumRow(row, 'int');
  });
  const rTf1 = rTf0 + det.length - 1; r = rTf1 + 2;

  section(r, 'Capacity needed — cards at full speed (forecast by technology ÷ OEE)'); r++;
  head(r, ['Trigram', 'Customer', 'Technology', '', '']); r++;
  const rNd0 = r;
  det.forEach((D, k) => {
    const row = rNd0 + k; const oe = oeeOf(D);
    sh.set(row, 1, D.trigram || '—'); sh.set(row, 2, D.name); sh.set(row, 3, D.tech);
    P.forEach((_, i) => { const x = per(D, i); const tRef = sh.ref(rTf0 + k, col(i));
      if (oe !== null) sh.f(row, col(i), `${tRef}/$E${rFc0 + k}`, 'int', x.need);
      else sh.f(row, col(i), `${tRef}/${x.need ? r4(x.tfc / x.need) : 1}`, 'fixed', x.need); });
    sumRow(row, 'int');
  });
  const rNd1 = rNd0 + det.length - 1; r = rNd1 + 2;

  // ---- machines: hours per technology, and capacity
  const mk = []; const seen = new Set();
  for (const p of P) for (const m of p.machines) for (const t of m.techs) if (m.speed?.[t] > 0 && !seen.has(`${m.name}|${t}`)) { seen.add(`${m.name}|${t}`); mk.push({ name: m.name, tech: t }); }
  const mAt = (i, name) => P[i].machines.find((m) => m.name === name);
  const only = (name) => (res.changes || []).filter((c) => c.type === 'restrict' && c.machine === name).map((c) => describe(c, ctx.CARD_FIELDS).replace(`${name} only runs `, 'only ')).join('; ');
  section(r, 'Machines — hours on each technology (hours × availability × the share of its hours the technology gets)'); r++;
  head(r, ['Machine', 'Note', 'Technology', 'Available', 'Speed /h']); r++;
  const rMh0 = r;
  mk.forEach((x, k) => {
    const row = rMh0 + k; const first = P.map((_, i) => mAt(i, x.name)).find((m) => m && m.speed?.[x.tech] > 0);
    sh.set(row, 1, x.name, 'bold'); sh.set(row, 2, [first && first.techs.length > 1 ? `shares its hours: ${first.techs.join(' / ')}` : '', only(x.name)].filter(Boolean).join(' · '), 'note'); sh.set(row, 3, x.tech);
    sh.set(row, 4, r4(first?.avail ?? 1), 'inputPct'); sh.set(row, 5, first?.speed?.[x.tech] || 0, 'input');
    P.forEach((p, i) => {
      const m = mAt(i, x.name); const hrs = m?.alloc?.[x.tech] || 0;
      if (!m || !hrs) { sh.set(row, col(i), 0, 'fixed'); return; }
      const base = p.hours * (m.avail ?? 1);
      if (base > 0) sh.f(row, col(i), `${colName(col(i) - 1)}$${rHours}*$D${row}${near(hrs, base) ? '' : `*${r4(hrs / base)}`}`, 'dec', hrs);
      else sh.set(row, col(i), hrs, 'fixed');
    });
    sumRow(row, 'intBold');
  });
  const rMh1 = rMh0 + mk.length - 1; r = rMh1 + 2;

  section(r, 'Machines — capacity in cards (hours × speed)'); r++;
  head(r, ['Machine', '', 'Technology', '', '']); r++;
  const rMc0 = r;
  mk.forEach((x, k) => {
    const row = rMc0 + k; sh.set(row, 1, x.name, 'bold'); sh.set(row, 3, x.tech);
    P.forEach((_, i) => { const m = mAt(i, x.name); const hrs = m?.alloc?.[x.tech] || 0; const sp = m?.speed?.[x.tech] || 0; const hRef = sh.ref(rMh0 + k, col(i));
      const baseSp = Number(sh.cells.get(`${rMh0 + k},5`)?.v) || 0;
      if (!hrs) sh.f(row, col(i), `${hRef}*$E${rMh0 + k}`, 'int', 0);
      else if (near(sp, baseSp)) sh.f(row, col(i), `${hRef}*$E${rMh0 + k}`, 'int', hrs * sp);
      else sh.f(row, col(i), `${hRef}*${r4(sp)}`, 'fixed', hrs * sp); });
    sumRow(row, 'int');
  });
  const rMc1 = rMc0 + mk.length - 1; r = rMc1 + 2;

  // ---- summary per technology
  section(r, 'Summary'); r++;
  head(r, ['Technology', '', '', '', '']); r++;
  const rows = {}; const tcol = (from, to) => `$C$${from}:$C$${to}`;
  const sumif = (crit, from, to, i) => (to < from ? '0' : `SUMIF(${tcol(from, to)},"${crit}",${sh.ref(from, col(i))}:${sh.ref(to, col(i))})`);
  const anyUnplaced = P.some((p) => T.some((t) => p.techs[t].unplaced > 0.5));
  const anyIdle = P.some((p) => T.some((t) => p.techs[t].reserved > 0.5));
  for (const t of T) {
    const R = rows[t] = {}; let k = r;
    const label = (txt) => { sh.set(k, 1, t, 'bold'); sh.set(k, 2, txt); return k++; };
    R.cap = label('Capacity'); R.need = label('Capacity needed'); R.open = label('Open (capacity − needed)');
    if (anyUnplaced) R.unpl = label('Can\'t be placed (machine restrictions)');
    if (anyIdle) R.idle = label('Idle on restricted machines (not capacity)');
    R.load = label('Load (needed ÷ capacity)'); R.fc = label(`Forecast — cards${ctx.flex ? ' (× flex)' : ''}`); R.act = label('Actual — cards persoed'); R.dev = label('Actual vs forecast');
    P.forEach((p, i) => {
      const c = col(i); const x = p.techs[t]; const at = (row) => sh.ref(row, c);
      sh.f(R.cap, c, sumif(t, rMc0, rMc1, i), 'int', x.capacity);
      sh.f(R.need, c, sumif(t, rNd0, rNd1, i), 'int', x.need);
      if (R.unpl) sh.set(R.unpl, c, Math.round(x.unplaced || 0), 'fixed');
      if (R.idle) sh.set(R.idle, c, Math.round(x.reserved || 0), 'fixed');
      sh.f(R.open, c, R.unpl ? `IF(${at(R.unpl)}>0,MIN(${at(R.cap)}-${at(R.need)},-${at(R.unpl)}),${at(R.cap)}-${at(R.need)})` : `${at(R.cap)}-${at(R.need)}`, 'int', x.gap);
      const load = `IF(${at(R.cap)}>0,${at(R.need)}/${at(R.cap)},"")`;
      sh.f(R.load, c, R.unpl ? `IF(${at(R.unpl)}>0,MAX(IF(${at(R.cap)}>0,${at(R.need)}/${at(R.cap)},0),${at(R.need)}/MAX(1,${at(R.need)}-${at(R.unpl)})),${load})` : load, 'pct', x.util);
      sh.f(R.fc, c, sumif(t, rTf0, rTf1, i), 'int', x.demand);
      if (p.start <= now) { sh.set(R.act, c, Math.round(x.actual || 0)); sh.f(R.dev, c, `IF(${at(R.fc)}>0,${at(R.act)}/${at(R.fc)}-1,"")`, 'pctSigned', x.demand ? x.actual / x.demand - 1 : null); }
    });
    for (const row of [R.cap, R.need, R.open, R.fc, R.act, R.unpl, R.idle].filter(Boolean)) sumRow(row, 'intBold');
    sh.f(R.load, tot, `IF(${sh.ref(R.cap, tot)}>0,${sh.ref(R.need, tot)}/${sh.ref(R.cap, tot)},"")`, 'pctBold');
    const doneCols = P.map((p, i) => (p.start <= now ? i : -1)).filter((i) => i >= 0);
    if (doneCols.length) sh.f(R.dev, tot, `IFERROR(SUM(${sh.ref(R.act, col(0))}:${sh.ref(R.act, col(doneCols[doneCols.length - 1]))})/SUM(${sh.ref(R.fc, col(0))}:${sh.ref(R.fc, col(doneCols[doneCols.length - 1]))})-1,"")`, 'pctSigned');
    sh.cf.push({ ref: `${sh.ref(R.load, col(0))}:${sh.ref(R.load, tot)}`, rules: [{ op: 'greaterThan', v: '1', dxf: 'bad' }, { op: 'between', v: '0.85', v2: '1', dxf: 'warn' }, { op: 'between', v: '0', v2: '0.85', dxf: 'good' }] });
    sh.cf.push({ ref: `${sh.ref(R.open, col(0))}:${sh.ref(R.open, tot)}`, rules: [{ op: 'lessThan', v: '0', dxf: 'bad' }] });
    r = k + 1;
  }
  // all technologies
  const A = rows.all = {}; let k = r;
  const lab = (txt) => { sh.set(k, 1, 'All', 'bold'); sh.set(k, 2, txt); return k++; };
  A.cap = lab('Capacity'); A.need = lab('Capacity needed'); A.load = lab('Load'); A.fc = lab('Forecast — cards'); A.act = lab('Actual — cards persoed'); A.dev = lab('Actual vs forecast');
  P.forEach((p, i) => { const c = col(i); const s = (key) => T.map((t) => sh.ref(rows[t][key], c)).join('+');
    sh.f(A.cap, c, s('cap'), 'int', p.total.capacity); sh.f(A.need, c, s('need'), 'int', p.total.need);
    sh.f(A.load, c, `IF(${sh.ref(A.cap, c)}>0,${sh.ref(A.need, c)}/${sh.ref(A.cap, c)},"")`, 'pct', p.total.util);
    sh.f(A.fc, c, s('fc'), 'int', p.total.demand);
    if (p.start <= now) { sh.f(A.act, c, s('act'), 'int', p.total.actual); sh.f(A.dev, c, `IF(${sh.ref(A.fc, c)}>0,${sh.ref(A.act, c)}/${sh.ref(A.fc, c)}-1,"")`, 'pctSigned'); } });
  for (const row of [A.cap, A.need, A.fc, A.act]) sumRow(row, 'intBold');
  sh.f(A.load, tot, `IF(${sh.ref(A.cap, tot)}>0,${sh.ref(A.need, tot)}/${sh.ref(A.cap, tot)},"")`, 'pctBold');
  sh.cf.push({ ref: `${sh.ref(A.load, col(0))}:${sh.ref(A.load, tot)}`, rules: [{ op: 'greaterThan', v: '1', dxf: 'bad' }, { op: 'between', v: '0.85', v2: '1', dxf: 'warn' }, { op: 'between', v: '0', v2: '0.85', dxf: 'good' }] });
  r = k + 1;
  if (res.warnings?.length) { sh.set(r, 1, 'Notes', 'bold'); res.warnings.forEach((w, j) => sh.set(r + 1 + j, 1, `⚠ ${w}`, 'note')); }
  // each row's text in its technology's colour, as the CPM workbook does
  const techRows = [[rFc0, rFc1], [rTf0, rTf1], [rNd0, rNd1], [rMh0, rMh1], [rMc0, rMc1]].filter(([a, b]) => b >= a);
  for (const [a, b] of techRows) sh.cf.push({ ref: `A${a}:${colName(tot - 1)}${b}`, rules: T.map((t) => ({ expr: `$C${a}="${t}"`, dxf: t })) });
  for (const t of T) { const R = rows[t]; const rs = Object.values(R); sh.cf.push({ ref: `A${Math.min(...rs)}:B${Math.max(...rs)}`, rules: [{ expr: `$A${Math.min(...rs)}="${t}"`, dxf: t }] }); }
  sh.freeze = { row: 1, col: FIRST };
  return { sh, rows, headRow: 6, n, col };
}

function buildCpmWorkbook({ base, scenarios = [], period, flex, sources, CARD_FIELDS }) {
  const made = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const ctx = { period, flex, made, today: new Date().toISOString().slice(0, 10), CARD_FIELDS };
  // sheet names: Excel's 31 characters, without [ ] : * ? / \ (and so unique, being numbered)
  const plans = [{ name: `CPM ${base.year}`, res: base }, ...scenarios.map((s, j) => ({ name: `S${j + 1} ${String(s.name).replace(/[\\/?*[\]:']/g, ' ')}`.slice(0, 31).trim(), res: { ...s }, sc: s }))];
  const built = plans.map((p) => ({ ...p, ...planSheet(p.name, p.res, ctx) }));
  const B = built[0];
  // ---- charts: per technology capacity needed against capacity (and the scenarios'), forecast against actual
  const ch = sheet('Charts'); ch.set(1, 1, `CPM ${base.year} — charts`, 'title'); ch.set(2, 1, 'The charts read the plan sheets: change an input there and they follow.', 'note');
  const cats = B.sh.full(B.headRow, FIRST, B.headRow, FIRST + B.n - 1);
  const W = 13; const H = 20; const rng = (row) => B.sh.full(row, FIRST, row, FIRST + B.n - 1);
  // all three technologies together: capacity needed (bars) against capacity (lines), and each one's load
  ch.charts.push({ title: 'All technologies — capacity needed (bars) against capacity (lines)', cats, from: [1, 4], to: [1 + W - 1, 4 + H - 1],
    series: [...base.techs.map((t) => ({ name: `${t} needed`, ref: rng(B.rows[t].need), kind: 'bar', color: TECH_COL[t] || '1F77B4' })),
      ...base.techs.map((t) => ({ name: `${t} capacity`, ref: rng(B.rows[t].cap), kind: 'line', color: TECH_COL[t] || '1F77B4', dash: true }))] });
  ch.charts.push({ title: 'All technologies — load (needed ÷ capacity)', cats, pct: true, from: [1 + W, 4], to: [2 * W, 4 + H - 1],
    series: base.techs.map((t) => ({ name: t, ref: rng(B.rows[t].load), kind: 'line', color: TECH_COL[t] || '1F77B4', markers: true, labels: period !== 'week', pct: true })) });
  const OFF = H; // the charts per technology below
  base.techs.forEach((t, i) => {
    const R = B.rows[t]; const at = [1 + (i % 2) * W, 4 + OFF + Math.floor(i / 2) * H];
    ch.charts.push({ title: `${t} — capacity needed against capacity`, cats, from: at, to: [at[0] + W - 1, at[1] + H - 1],
      series: [{ name: 'Capacity needed', ref: B.sh.full(R.need, FIRST, R.need, FIRST + B.n - 1), kind: 'bar', color: TECH_COL[t] || '1F77B4', labels: period !== 'week' },
        { name: 'Capacity', ref: B.sh.full(R.cap, FIRST, R.cap, FIRST + B.n - 1), kind: 'line', color: '111827', labels: period !== 'week' },
        ...built.slice(1).map((s, j) => ({ name: `Capacity — ${s.sc.name}`, ref: s.sh.full(s.rows[t].cap, FIRST, s.rows[t].cap, FIRST + s.n - 1), kind: 'line', color: SC_COL[j % 2], dash: true }))] });
  });
  const k = base.techs.length; const at = [1 + (k % 2) * W, 4 + OFF + Math.floor(k / 2) * H];
  ch.charts.push({ title: 'Forecast against actual — all technologies (cards)', cats, from: at, to: [at[0] + W - 1, at[1] + H - 1],
    series: [{ name: 'Forecast', ref: B.sh.full(B.rows.all.fc, FIRST, B.rows.all.fc, FIRST + B.n - 1), kind: 'bar', color: '9AA7BD', labels: period !== 'week' },
      { name: 'Persoed', ref: B.sh.full(B.rows.all.act, FIRST, B.rows.all.act, FIRST + B.n - 1), kind: 'bar', color: '2563EB', labels: period !== 'week' }] });
  const at2 = [1, 4 + OFF + Math.ceil((k + 1) / 2) * H];
  ch.charts.push({ title: 'Load, all technologies together — base plan against the scenarios', cats, pct: true, from: at2, to: [at2[0] + 2 * W - 1, at2[1] + H - 1],
    series: built.map((s, j) => ({ name: j ? s.sc.name : 'Base plan', ref: s.sh.full(s.rows.all.load, FIRST, s.rows.all.load, FIRST + s.n - 1), kind: 'line', color: j ? SC_COL[(j - 1) % 2] : '111827', dash: j > 0, markers: true })) });

  // ---- the forecast as read, against SITHUB's Database
  const fcs = sheet('Forecast check'); const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  fcs.width(1, 26); for (let i = 2; i <= 14; i++) fcs.width(i, 12);
  fcs.set(1, 1, `Forecast ${base.year} as read`, 'title'); fcs.set(2, 1, 'BeNeLux: Benelux + “basic” lines; Amex: TOTAL BAU. SITHUB\'s Database adds January\'s Amex to every month; the total here takes each month\'s own.', 'note');
  fcs.set(4, 1, '', 'header'); M.forEach((m, i) => fcs.set(4, 2 + i, m, 'headerNum')); fcs.set(4, 14, 'Year', 'headerNum');
  const bn = sources?.benelux || Array(12).fill(0); const ax = sources?.amex || Array(12).fill(0);
  [['BeNeLux', bn], ['Amex', ax]].forEach(([l, a], j) => { fcs.set(5 + j, 1, l, 'bold'); a.forEach((v, i) => fcs.set(5 + j, 2 + i, Math.round(v))); fcs.f(5 + j, 14, 'SUM(B' + (5 + j) + ':M' + (5 + j) + ')', 'intBold'); });
  fcs.set(7, 1, 'Total', 'bold'); M.forEach((_, i) => { const c = String.fromCharCode(66 + i); fcs.f(7, 2 + i, `${c}5+${c}6`, 'intBold', bn[i] + ax[i]); }); fcs.f(7, 14, 'SUM(B7:M7)', 'intBold');
  fcs.set(8, 1, 'SITHUB Database', 'note'); M.forEach((_, i) => { const c = String.fromCharCode(66 + i); fcs.f(8, 2 + i, `${c}5+$B$6`, 'int', bn[i] + ax[0]); }); fcs.f(8, 14, 'SUM(B8:M8)', 'int');

  // ---- the scenarios and how the plan was worked out
  const ab = sheet('Scenarios & notes'); ab.width(1, 26); ab.width(2, 100);
  ab.set(1, 1, 'Scenarios and notes', 'title'); let r = 3;
  const kv = (k2, v) => { ab.set(r, 1, k2, 'bold'); ab.set(r, 2, v, 'wrap'); r++; };
  kv('Made', `${made} from CI Manager › 📐 Capacity`); kv('Forecast', `as read in ${base.forecast_as_of || '—'}${flex ? ', flex applied (each customer\'s actual ÷ forecast in earlier years)' : ', no flex'}`);
  kv('Working time', `${base.shifts} shifts × ${base.hours} productive hours a shift on Production's working days, less the holidays set`);
  kv('Speeds', base.techs.map((t) => `${t} ${base.speeds[t] || '—'}/h (${base.speed_from?.[t] || 'none'})`).join(' · '));
  kv('How it\'s worked out', 'Capacity needed = forecast × split ÷ OEE. Capacity = hours × availability × speed; a machine running several technologies gives its hours to whichever is short (shared evenly when neither is). By week, a month\'s forecast is spread over its working days.');
  r++;
  for (const s of scenarios) {
    ab.set(r, 1, s.name, 'section'); ab.set(r, 2, '', 'section'); r++;
    if (s.notes) kv('Notes', s.notes);
    kv('By', `${s.owner_name || '—'}${s.shared ? ' (shared)' : ''}`);
    (s.changes || []).forEach((c, i) => kv(`Change ${i + 1}`, describe(c, CARD_FIELDS)));
    r++;
  }
  if (!scenarios.length) { ab.set(r, 1, 'No scenario compared — the base plan only.', 'note'); r++; }
  const sheets = [...built.map((b) => b.sh), ch, fcs, ab];
  return buildBook(sheets, { active: 0 });
}

module.exports = { buildCpmWorkbook, describe };
