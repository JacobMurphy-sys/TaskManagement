'use strict';
// 📐 Capacity planning to Excel, laid out like the CPM workbook: per plan (the base and each scenario
// compared) a sheet with the working time, the forecast per customer and technology, the capacity it
// needs (÷ OEE), the machines' hours and capacity, and a summary per technology — the figures as the
// app worked them out, but as formulas over the inputs (split, OEE, availability, speed, shifts,
// hours), so they can be changed in Excel. Then charts, the forecast check and the scenarios.
const { sheet, buildBook } = require('./xlsxbook');
const { colName } = require('./xlsx');

// the CPM workbook's technology colours (DOD teal, Laser purple, Emboss black — a dark grey for bars)
const TECH_COL = { DOD: '008080', Emboss: '404040', Laser: '7030A0', Matching: '2563EB', OTTO: '2563EB', 'Hand match': '0EA5E9' };
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
  kv('Made', `${made} from SITHUB › Capacity`); kv('Forecast', `as read in ${base.forecast_as_of || '—'}${flex ? ', flex applied (each customer\'s actual ÷ forecast in earlier years)' : ', no flex'}`);
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

// ---- 🕐 a day by the hour, laid out like the CPM daily sheet ------------------------------------------
// d: cpmday.day(). One row per customer and technology (renewal %, the month's volume, daily and renewal
// cards a day ÷ OEE) with its day over the hours (× the hour profile on its own sheet); the renewal
// windows; the hours worked and each machine's share of each hour per technology; and per technology the
// day's demand, capacity, load and what's carried over — formulas over the blue-on-yellow inputs.
const TECH_LIGHT = { DOD: '7FC0C0', Emboss: 'A6A6A6', Laser: 'B597D0', Matching: '93B4F5', OTTO: '93B4F5', 'Hand match': '9BD9F5' };
function buildDayWorkbook(d, { scenario = null } = {}) {
  const T = d.techs; const H = d.hours; const HC = 16; const n = 24; const hc = (i) => HC + i; const L = (c) => colName(c - 1);
  const hl = (h) => `${String(h).padStart(2, '0')}:00`;
  const MX = d.unit === 'items'; // Matching's day: items for cards, the OEE its customer's (and its speed's) — as on the page
  const name = `${MX ? 'Matching ' : 'Day '}${d.label}`.slice(0, 31);
  const sh = sheet(name); const pr = sheet('Hour profile');
  for (const s of [sh, pr]) { s.width(1, 9).width(2, 10).width(3, 9).width(4, 28).width(5, 9); for (let c = 6; c <= 14; c++) s.width(c, 10); s.width(15, 10); for (let i = 0; i < n; i++) s.width(hc(i), 8); s.width(hc(n), 11); }
  sh.set(1, 1, `CPM daily${MX ? ' — Matching' : ''} — a working day in ${d.label}${scenario ? ` — ${scenario}` : ''}`, 'title');
  sh.set(2, 1, `Forecast as read in ${d.forecast_as_of || '—'} · ${d.flex ? 'flex applied' : 'no flex'} · each customer's day spread as its cards were produced (Hour profile sheet) · renewals = Low priority work orders, in each technology's window`, 'note');
  sh.set(3, 1, 'Cells in blue on yellow are inputs — renewal %, volume, OEE, the hour profile, the renewal windows, hours worked, speeds, availability and how each machine splits its hours — change them and the day works itself out.', 'note');
  sh.set(4, 1, 'Working days', 'bold'); sh.set(4, 3, d.workdays, 'input');
  sh.set(4, 5, 'Renewal OEE +', 'bold'); sh.set(4, 6, d.bonus, 'inputPct');
  sh.set(4, 8, 'Capacity × ', 'bold'); sh.set(4, 10, d.hour_share ?? 1, 'inputDec'); sh.set(4, 11, (d.hour_share ?? 1) < 1 ? `${Math.round((d.hour_share ?? 1) * 8 * 100) / 100} hours of each 8 counted (Capacity settings) — the losses are in each customer's OEE` : 'full speed, the whole hour — the losses are in each customer\'s OEE', 'note');
  const head = (s, row, labels) => { labels.forEach((l, i) => s.set(row, i + 1, l, i >= 5 ? 'headerNum' : 'header')); s.set(row, 15, s === sh && row === 6 ? 'Added' : '', 'header'); H.forEach((h, i) => s.set(row, hc(i), hl(h), 'headerNum')); s.set(row, hc(n), 'Day', 'headerNum'); };
  const R0 = 7; const rows = d.rows; const R1 = R0 + rows.length - 1;
  head(sh, 6, ['Daily %', 'Renewals %', 'Trigram', 'Customer', 'Tech', 'Month', 'Daily /month', 'Daily /day', 'OEE', 'Needed daily', 'RNW /month', 'RNW /day', 'RNW OEE', 'Needed RNW']);
  head(pr, 6, ['', '', 'Trigram', 'Customer', 'Tech', 'From', '', '', '', '', '', '', '', '']);
  pr.set(1, 1, 'Hour profile — the share of each customer\'s day in each hour', 'title');
  pr.set(2, 1, 'Learned from when its cards were produced (timing report, the last 4 months): own = its own runs, technology = all runs of the technology, even = spread over the hours worked. Each row should add up to 100%.', 'note');
  rows.forEach((r, k) => {
    const row = R0 + k;
    sh.set(row, 2, r.rnw_pct, 'inputPct'); sh.f(row, 1, `1-B${row}`, 'pct', r.daily_pct);
    sh.set(row, 3, r.trigram || '—'); sh.set(row, 4, r.name); sh.set(row, 5, r.tech); if (r.added) sh.set(row, 15, r.added === 'campaign' ? 'campaign' : 'scenario', 'bold');
    sh.set(row, 6, r.month_volume, 'input'); sh.f(row, 7, `F${row}*A${row}`, 'int', r.month_volume * r.daily_pct); sh.f(row, 8, r.peak && r.peak.factor !== 1 ? `G${row}/$C$4*${r.peak.factor}` : `G${row}/$C$4`, 'int', r.daily); // worst case: × its busiest day ÷ its average
    sh.set(row, 9, r.oee, 'inputPct'); sh.f(row, 10, `H${row}/I${row}`, 'int', r.need_daily);
    sh.f(row, 11, `F${row}*B${row}`, 'int', r.month_volume * r.rnw_pct); sh.f(row, 12, `K${row}/$C$4`, 'int', r.renew);
    if (MX) sh.set(row, 13, r.oee_rnw, 'inputPct'); else sh.f(row, 13, `MIN(1,I${row}+$F$4)`, 'pct', r.oee_rnw); sh.f(row, 14, `L${row}/M${row}`, 'int', r.need_rnw);
    r.hours.forEach((v, i) => sh.f(row, hc(i), `$J${row}*'Hour profile'!${L(hc(i))}${row}`, 'int', v));
    sh.f(row, hc(n), `SUM(${L(hc(0))}${row}:${L(hc(n - 1))}${row})`, 'intBold', r.need_daily);
    pr.set(row, 3, r.trigram || '—'); pr.set(row, 4, r.name); pr.set(row, 5, r.tech); pr.set(row, 6, r.profile, 'note');
    r.shares.forEach((v, i) => pr.set(row, hc(i), v, 'inputPct')); pr.f(row, hc(n), `SUM(${L(hc(0))}${row}:${L(hc(n - 1))}${row})`, 'pctBold', 1);
  });
  const tot = R1 + 1; sh.set(tot, 4, 'Total', 'bold');
  for (const c of [6, 7, 8, 10, 11, 12, 14, ...H.map((_, i) => hc(i)), hc(n)]) sh.f(tot, c, `SUM(${L(c)}${R0}:${L(c)}${R1})`, 'intBold');
  const section = (row, text) => { for (let c = 1; c <= hc(n); c++) sh.set(row, c, c === 1 ? text : '', 'section'); };
  // renewal windows
  let r = tot + 2; section(r, 'Renewals — each technology\'s renewal cards a day (÷ renewal OEE), spread evenly over the hours ticked (1)'); r++;
  head(sh, r, ['', '', '', '', 'Tech', '', '', '', '', '', '', '', '', 'Needed RNW']); r++;
  const rnw = {};
  for (const t of T) {
    const flags = r; const per = r + 1; rnw[t] = per; const set = new Set(d.renewals[t].hours);
    sh.set(flags, 4, 'window (1 = renewals run)'); sh.set(flags, 5, t, 'bold'); H.forEach((h, i) => sh.set(flags, hc(i), set.has(h) ? 1 : 0, 'input'));
    sh.set(per, 4, 'renewals in the hour'); sh.set(per, 5, t, 'bold'); sh.f(per, 14, `SUMIF($E$${R0}:$E$${R1},"${t}",$N$${R0}:$N$${R1})`, 'intBold', d.renewals[t].need);
    H.forEach((_, i) => sh.f(per, hc(i), `IF(SUM($${L(hc(0))}${flags}:$${L(hc(n - 1))}${flags})>0,${L(hc(i))}${flags}*$N${per}/SUM($${L(hc(0))}${flags}:$${L(hc(n - 1))}${flags}),0)`, 'int', d.renewals[t].per[i]));
    sh.f(per, hc(n), `SUM(${L(hc(0))}${per}:${L(hc(n - 1))}${per})`, 'intBold', d.renewals[t].need);
    r += 2;
  }
  // machines: hours worked, speed, availability, how each splits its hours
  r++; section(r, 'Capacity — each machine\'s speed × availability × its share of the hour for the technology, in the hours worked (1)'); r++;
  head(sh, r, ['', '', 'Machine', '', 'Tech', 'Speed /h', 'Available', '', '', '', '', '', '', '']); r++;
  const worked = r; sh.set(worked, 4, 'hours worked (1)', 'bold'); H.forEach((_, i) => sh.set(worked, hc(i), d.worked[i] ? 1 : 0, 'input')); r++;
  const shareRows = [];
  for (const m of d.capacity_machines) for (const t of m.techs) {
    sh.set(r, 3, m.name, 'bold'); sh.set(r, 4, m.techs.length > 1 ? 'share of the hour' : ''); sh.set(r, 5, t); sh.set(r, 6, m.speed[t], 'input'); sh.set(r, 7, m.avail ?? 1, 'inputPct');
    H.forEach((_, i) => sh.set(r, hc(i), m.share[i]?.[t] ?? 0, m.techs.length > 1 ? 'inputPct' : 'pct'));
    shareRows.push({ row: r, m, t }); r++;
  }
  r++; const C0 = r;
  for (const { row, m, t } of shareRows) {
    sh.set(r, 3, m.name); sh.set(r, 4, m.only?.length ? 'capacity — only the work it may run' : 'capacity'); sh.set(r, 5, t);
    if (m.only?.length) { // kept for some customers / cards: the work it's given that hour, the rest idle
      H.forEach((_, i) => sh.set(r, hc(i), m.used?.[t]?.[i] || 0, 'fixed')); sh.f(r, hc(n), `SUM(${L(hc(0))}${r}:${L(hc(n - 1))}${r})`, 'intBold'); r++; continue;
    }
    H.forEach((_, i) => sh.f(r, hc(i), `$F${row}*$G${row}*${L(hc(i))}${row}*${L(hc(i))}$${worked}*$J$4`, 'int', d.worked[i] ? m.speed[t] * (m.avail ?? 1) * (m.share[i]?.[t] ?? 0) * (d.full ? 1 : Math.min(1, d.hph / 8)) : 0));
    sh.f(r, hc(n), `SUM(${L(hc(0))}${r}:${L(hc(n - 1))}${r})`, 'intBold'); r++;
  }
  const C1 = r - 1;
  // per technology: the day against the capacity
  r++; section(r, 'The day per technology'); r++;
  head(sh, r, ['', '', '', '', 'Tech', '', '', '', '', '', '', '', '', '']); const headRow = r; r++;
  const S = {};
  for (const t of T) {
    const X = d.tech[t]; const R = S[t] = {}; const lab = (txt) => { sh.set(r, 4, txt); sh.set(r, 5, t, 'bold'); return r++; };
    R.daily = lab('Daily (÷ OEE)'); R.rnw = lab('Renewals'); R.need = lab('Needed'); R.cap = lab('Capacity'); R.load = lab('Load'); R.carry = lab('Carried over');
    R.added = lab('of the daily: added (campaigns, scenario)'); R.addedRnw = lab('of the renewals: added'); R.own = lab('Daily, the forecast\'s own'); R.rnwOwn = lab('Renewals, the forecast\'s own');
    H.forEach((_, i) => { const c = hc(i); const at = (row) => `${L(c)}${row}`;
      sh.f(R.daily, c, `SUMIF($E$${R0}:$E$${R1},"${t}",${L(c)}$${R0}:${L(c)}$${R1})`, 'int', X.daily[i]);
      sh.f(R.rnw, c, `${L(c)}${rnw[t]}`, 'int', X.renewals[i]); sh.f(R.need, c, `${at(R.daily)}+${at(R.rnw)}`, 'intBold', X.need[i]);
      sh.f(R.cap, c, C1 >= C0 ? `SUMIF($E$${C0}:$E$${C1},"${t}",${L(c)}$${C0}:${L(c)}$${C1})` : '0', 'int', X.capacity[i]);
      sh.f(R.load, c, `IF(${at(R.cap)}>0,${at(R.need)}/${at(R.cap)},"")`, 'pct', X.load[i]);
      sh.f(R.carry, c, i ? `MAX(0,${L(c - 1)}${R.carry}+${at(R.need)}-${at(R.cap)})` : `MAX(0,${at(R.need)}-${at(R.cap)})`, 'int', X.backlog[i]);
      // what's added (column O marked): its daily hours, and its renewals over the technology's window
      const fl = rnw[t] - 1; const winSum = `SUM($${L(hc(0))}$${fl}:$${L(hc(n - 1))}$${fl})`;
      sh.f(R.added, c, `SUMIFS(${L(c)}$${R0}:${L(c)}$${R1},$E$${R0}:$E$${R1},"${t}",$O$${R0}:$O$${R1},"<>")`, 'int', X.added?.[i] || 0);
      sh.f(R.addedRnw, c, `IF(${winSum}>0,${L(c)}$${fl}*SUMIFS($N$${R0}:$N$${R1},$E$${R0}:$E$${R1},"${t}",$O$${R0}:$O$${R1},"<>")/${winSum},0)`, 'int', X.added_rnw?.[i] || 0);
      sh.f(R.own, c, `${at(R.daily)}-${at(R.added)}`, 'int', X.daily[i] - (X.added?.[i] || 0)); sh.f(R.rnwOwn, c, `${at(R.rnw)}-${at(R.addedRnw)}`, 'int', X.renewals[i] - (X.added_rnw?.[i] || 0)); });
    for (const row of [R.daily, R.rnw, R.need, R.cap, R.added, R.addedRnw, R.own, R.rnwOwn]) sh.f(row, hc(n), `SUM(${L(hc(0))}${row}:${L(hc(n - 1))}${row})`, 'intBold');
    sh.f(R.load, hc(n), `IF(${L(hc(n))}${R.cap}>0,${L(hc(n))}${R.need}/${L(hc(n))}${R.cap},"")`, 'pctBold', X.total.load);
    sh.cf.push({ ref: `${L(hc(0))}${R.load}:${L(hc(n))}${R.load}`, rules: [{ op: 'greaterThan', v: '1', dxf: 'bad' }, { op: 'between', v: '0.85', v2: '1', dxf: 'warn' }, { op: 'between', v: '0', v2: '0.85', dxf: 'good' }] });
    sh.cf.push({ ref: `${L(hc(0))}${R.carry}:${L(hc(n - 1))}${R.carry}`, rules: [{ op: 'greaterThan', v: '0.5', dxf: 'bad' }] });
    r++;
  }
  // each row in its technology's colour, as the CPM workbook does
  for (const [a, b] of [[R0, R1], [C0 - shareRows.length - 1, C1]]) if (b >= a) sh.cf.push({ ref: `A${a}:${L(hc(n))}${b}`, rules: T.map((t) => ({ expr: `$E${a}="${t}"`, dxf: t })) });
  if (rows.length) pr.cf.push({ ref: `A${R0}:${L(hc(n))}${R1}`, rules: T.map((t) => ({ expr: `$E${R0}="${t}"`, dxf: t })) });
  if (rows.length) sh.cf.push({ ref: `${L(hc(0))}${R0}:${L(hc(n - 1))}${R1}`, rules: [{ scale: ['FFFFFF', '7382E6'] }] }); // where each customer's day lands
  sh.freeze = { row: 7, col: 6 }; pr.freeze = { row: 7, col: 6 };
  // charts
  const ch = sheet('Charts'); ch.set(1, 1, `${MX ? 'Matching — a' : 'A'} working day in ${d.label} — charts`, 'title'); ch.set(2, 1, 'They read the day sheet: change an input there and they follow.', 'note');
  const cats = sh.full(headRow, hc(0), headRow, hc(n - 1)); const rng = (row) => sh.full(row, hc(0), row, hc(n - 1)); const W = 13; const HH = 20;
  ch.charts.push({ title: MX ? 'Matching — needed (bars) against capacity (line)' : 'All technologies — needed (bars) against each one\'s capacity (lines)', cats, fmt: '#,##0', from: [1, 4], to: [2 * W, 4 + HH - 1],
    series: [...T.map((t) => ({ name: `${t} needed`, ref: rng(S[t].need), kind: 'bar', color: TECH_COL[t] || '1F77B4' })), ...T.map((t) => ({ name: `${t} capacity`, ref: rng(S[t].cap), kind: 'line', color: TECH_COL[t] || '1F77B4', dash: true }))] });
  const AT0 = 4 + HH; ch.charts.push({ title: MX ? 'Matching — load hour by hour' : 'All technologies — load hour by hour', cats, pct: true, from: [1, AT0], to: [2 * W, AT0 + HH - 1],
    series: T.map((t) => ({ name: t, ref: rng(S[t].load), kind: 'line', color: TECH_COL[t] || '1F77B4', markers: true })) });
  const anyAdded = T.some((t) => (d.tech[t].added || []).some((v) => v > 0.5) || (d.tech[t].added_rnw || []).some((v) => v > 0.5));
  T.forEach((t, i) => { const at = [1 + (i % 2) * W, 4 + 2 * HH + Math.floor(i / 2) * HH];
    ch.charts.push({ title: `${t} — the day against capacity`, cats, stacked: true, fmt: '#,##0', from: at, to: [at[0] + W - 1, at[1] + HH - 1],
      series: [{ name: 'Daily', ref: rng(anyAdded ? S[t].own : S[t].daily), kind: 'bar', color: TECH_COL[t] || '1F77B4' }, ...(anyAdded ? [{ name: 'Added (campaigns, scenario)', ref: rng(S[t].added), kind: 'bar', color: 'FF7A1A' }] : []),
        { name: 'Renewals', ref: rng(anyAdded ? S[t].rnwOwn : S[t].rnw), kind: 'bar', color: TECH_LIGHT[t] || '9AA7BD' }, ...(anyAdded ? [{ name: 'Renewals added', ref: rng(S[t].addedRnw), kind: 'bar', color: 'FFBE8C' }] : []),
        { name: 'Capacity', ref: rng(S[t].cap), kind: 'line', color: '111827' }, { name: 'Carried over', ref: rng(S[t].carry), kind: 'line', color: 'C0392B', dash: true }] }); });
  if (MX) { // what's different on Matching, said once at the top
    sh.set(2, 1, `Forecast as read in ${d.forecast_as_of || '—'} · ${d.flex ? 'flex applied' : 'no flex'} · Matching: each customer's forecast cards × its share through Matching = items (Month); OEE = its Matching OEE ÷ its speed factor (its own Matching speed, metal cards at the metal machines' speed), so items ÷ OEE is machine time at the machines' usual speed; renewals = its Low priority Matching work orders, at the renewal OEE; each day spread as its Matching runs ended (Hour profile)`, 'note');
  }
  return buildBook([sh, pr, ch]);
}

// ---- 🔗 Matching by month: the year's items, the machine time they need and the capacity, as formulas over the
// inputs (working hours, capacity an hour), with the chart reading them
function buildMatchMonthWorkbook(d, { scenario = null } = {}) {
  const sh = sheet(`Matching ${d.year}`); const ch = sheet('Chart');
  [12, 10, 10, 12, 12, 12, 14, 14, 9, 12, 48].forEach((w, i) => sh.width(i + 1, w));
  sh.set(1, 1, `CPM monthly — Matching — ${d.year}${scenario ? ` — ${scenario}` : ''}`, 'title');
  sh.set(2, 1, `Forecast as read in ${d.forecast_as_of || '—'} · ${d.flex ? 'flex applied' : 'no flex'} · items = each customer's forecast cards × its share through Matching; needed = items ÷ its Matching OEE (× its speed factor, metal at the metal speed), in machine time at the usual speed; capacity = the Matching machines' speed × the hours worked.`, 'note');
  sh.set(3, 1, 'Cells in blue on yellow are inputs — the hours worked and the capacity an hour — change them and the rest follows.', 'note');
  const H = ['Month', 'Working days', 'Hours worked', 'Capacity /h', 'Cards (forecast)', 'Items matched', 'Needed (÷ OEE)', 'Capacity', 'Load', 'Metal items', 'Biggest customers (needed)'];
  H.forEach((h, i) => sh.set(5, i + 1, h, i >= 1 && i <= 9 ? 'headerNum' : 'header'));
  const R0 = 6;
  d.months.forEach((m, k) => {
    const r = R0 + k; const capH = m.hours ? m.capacity / m.hours : d.capacity_hour;
    sh.set(r, 1, m.label, 'bold'); sh.set(r, 2, m.workdays, 'int'); sh.set(r, 3, m.hours, 'input'); sh.set(r, 4, capH, 'input');
    sh.set(r, 5, m.cards, 'int'); sh.set(r, 6, m.items, 'int'); sh.set(r, 7, m.need, 'intBold');
    sh.f(r, 8, `C${r}*D${r}`, 'int', m.capacity); sh.f(r, 9, `IF(H${r}>0,G${r}/H${r},"")`, 'pct', m.load);
    sh.set(r, 10, m.metal?.items || 0, 'int'); sh.set(r, 11, (m.top || []).slice(0, 5).map((c) => `${c.trigram || c.name} ${Math.round(c.need).toLocaleString('en-GB')}`).join(' · '));
  });
  const R1 = R0 + d.months.length - 1; const T = R1 + 1;
  sh.set(T, 1, 'Year', 'bold'); for (const c of [2, 3, 5, 6, 7, 8, 10]) sh.f(T, c, `SUM(${colName(c - 1)}${R0}:${colName(c - 1)}${R1})`, 'intBold');
  sh.f(T, 9, `IF(H${T}>0,G${T}/H${T},"")`, 'pctBold');
  sh.cf.push({ ref: `I${R0}:I${T}`, rules: [{ op: 'greaterThan', v: '1', dxf: 'bad' }, { op: 'between', v: '0.85', v2: '1', dxf: 'warn' }, { op: 'between', v: '0', v2: '0.85', dxf: 'good' }] });
  sh.freeze = { row: 6, col: 2 };
  ch.set(1, 1, `Matching ${d.year} — needed against capacity`, 'title'); ch.set(2, 1, 'It reads the month sheet: change an input there and it follows.', 'note');
  const cats = sh.full(R0, 1, R1, 1);
  ch.charts.push({ title: 'Matching — needed (bars) against capacity (line), by month', cats, fmt: '#,##0', from: [1, 4], to: [16, 26],
    series: [{ name: 'Needed (÷ OEE)', ref: sh.full(R0, 7, R1, 7), kind: 'bar', color: TECH_COL.Matching }, { name: 'Capacity', ref: sh.full(R0, 8, R1, 8), kind: 'line', color: '111827' }] });
  ch.charts.push({ title: 'Matching — load by month', cats, pct: true, from: [1, 28], to: [16, 46], series: [{ name: 'Load', ref: sh.full(R0, 9, R1, 9), kind: 'line', color: TECH_COL.Matching, markers: true }] });
  return buildBook([sh, ch]);
}

// ---- 👷 Headcount: the year by month, as formulas over its inputs (rates, working days, hours a day, efficiency,
// people, other work), with the charts reading them; and the hours per customer
function buildHeadcountWorkbook(d, { scenario = null, flex = true } = {}) {
  const M = d.months; const C = d.config; const T = d.techs; const K = d.methods; const mc = (i) => 3 + i; const YC = 15; const L = (c) => colName(c - 1);
  const sh = sheet(`Headcount ${d.year}`); sh.width(1, 40).width(2, 12); for (let i = 0; i < 12; i++) sh.width(mc(i), 10); sh.width(YC, 12);
  sh.set(1, 1, `Headcount ${d.year}${scenario ? ` — ${scenario}` : ''}`, 'title');
  sh.set(2, 1, `Forecast as read in ${d.forecast_as_of || '—'}. Blue on yellow are inputs — the cards (forecast × split${flex ? ' × flex' : ''}), the rates, working days, hours a day, efficiency, people and the other work: change one and the rest follows, charts too.`, 'note');
  sh.set(4, 1, 'Hours a day (a person)', 'bold'); sh.set(4, 2, C.day_hours, 'inputDec');
  sh.set(5, 1, 'Efficiency (share of their hours on the work)', 'bold'); sh.set(5, 2, C.efficiency, 'inputPct');
  const head = (row, b = '') => { sh.set(row, 1, '', 'header'); sh.set(row, 2, b, 'headerNum'); M.forEach((m, i) => sh.set(row, mc(i), m.label, 'headerNum')); sh.set(row, YC, String(d.year), 'headerNum'); };
  const section = (row, text) => { for (let c = 1; c <= YC; c++) sh.set(row, c, c === 1 ? text : '', 'section'); };
  const yearSum = (row, style = 'intBold') => sh.f(row, YC, `SUM(${L(mc(0))}${row}:${L(mc(11))}${row})`, style);
  let r = 7; head(r); const hd = r; r++;
  const wd = r; sh.set(wd, 1, 'Working days', 'bold'); M.forEach((m, i) => sh.set(wd, mc(i), m.workdays, 'input')); yearSum(wd); r += 2;
  const hourRows = []; const kinds = []; // the rows of hours, for the totals and the chart
  const workRows = (label, list, cardsOf, rateOf) => {
    section(r, label); r++; head(r, 'cards / h'); r++;
    for (const k of list) {
      const cr = r; const hr = r + 1; const rate = rateOf(k);
      sh.set(cr, 1, `${k} — cards`); M.forEach((m, i) => sh.set(cr, mc(i), cardsOf(m, k), 'input')); yearSum(cr);
      sh.set(hr, 1, `${k} — hours`, 'bold'); sh.set(hr, 2, rate || 0, 'input');
      M.forEach((m, i) => sh.f(hr, mc(i), `IF($B${hr}>0,${L(mc(i))}${cr}/$B${hr},0)`, 'int', rate ? cardsOf(m, k) / rate : 0)); yearSum(hr);
      hourRows.push(hr); kinds.push(k); r += 2;
    }
  };
  workRows('Perso — cards (forecast × split) and the hours at each technology\'s rate', T, (m, t) => (m.perso[t] || 0) * (d.rates[t] || 0), (t) => d.rates[t]);
  workRows('Matching — the cards matched each way and the hours at its rate', K, (m, k) => (m.match[k] || 0) * (d.rates[k] || 0), (k) => d.rates[k]);
  const core = r; sh.set(core, 1, 'Perso and matching hours', 'bold'); M.forEach((_, i) => sh.f(core, mc(i), hourRows.map((h) => `${L(mc(i))}${h}`).join('+') || '0', 'intBold', M[i].core)); yearSum(core); r += 2;
  section(r, 'Other work — hours a day each (× the month\'s working days), and one-off hours'); r++; head(r, 'h a day'); r++;
  const otherRows = [];
  (C.other || []).forEach((o) => { sh.set(r, 1, o.name); sh.set(r, 2, o.per_day || 0, 'inputDec'); M.forEach((m, i) => sh.f(r, mc(i), `$B${r}*${L(mc(i))}$${wd}`, 'int', (o.per_day || 0) * m.workdays)); yearSum(r); otherRows.push(r); r++; });
  const ex = r; sh.set(ex, 1, 'One-off hours (extra)'); M.forEach((m, i) => sh.set(ex, mc(i), m.extra || 0, 'input')); yearSum(ex); otherRows.push(ex); r++;
  const oth = r; sh.set(oth, 1, 'Other work', 'bold'); M.forEach((m, i) => sh.f(oth, mc(i), `SUM(${L(mc(i))}${otherRows[0]}:${L(mc(i))}${ex})`, 'intBold', m.other_total)); yearSum(oth); r += 2;
  const tot = r; sh.set(tot, 1, 'Hours needed', 'bold'); M.forEach((m, i) => sh.f(tot, mc(i), `${L(mc(i))}${core}+${L(mc(i))}${oth}`, 'intBold', m.total)); yearSum(tot); r += 2;
  section(r, 'People — there (permanent + agency − off sick) against needed'); r++; head(r); r++;
  const stRow = (label, k) => { sh.set(r, 1, label); M.forEach((m, i) => sh.set(r, mc(i), m.staff ? m.staff[k] || 0 : 0, 'input')); return r++; };
  const pe = stRow('Permanent', 'perm'); const ag = stRow('Agency', 'agency'); const si = stRow('Off sick (on average)', 'sick');
  const he = r++; sh.set(he, 1, 'People there', 'bold'); M.forEach((m, i) => sh.f(he, mc(i), `${L(mc(i))}${pe}+${L(mc(i))}${ag}-${L(mc(i))}${si}`, 'intBold', m.heads ?? 0));
  const ph = r++; sh.set(ph, 1, 'Hours a person (hours a day × working days × efficiency)'); M.forEach((m, i) => sh.f(ph, mc(i), `$B$4*${L(mc(i))}${wd}*$B$5`, 'dec', m.per_head));
  const av = r++; sh.set(av, 1, 'Hours there', 'bold'); M.forEach((m, i) => sh.f(av, mc(i), `${L(mc(i))}${he}*${L(mc(i))}${ph}`, 'intBold', m.available ?? 0)); yearSum(av);
  const nd = r++; sh.set(nd, 1, 'People needed', 'bold'); M.forEach((m, i) => sh.f(nd, mc(i), `IF(${L(mc(i))}${ph}>0,${L(mc(i))}${tot}/${L(mc(i))}${ph},0)`, 'dec', m.fte_needed || 0));
  const gh = r++; sh.set(gh, 1, 'Hours spare (− short)', 'bold'); M.forEach((m, i) => sh.f(gh, mc(i), `${L(mc(i))}${av}-${L(mc(i))}${tot}`, 'intBold', m.gap_hours ?? 0)); yearSum(gh);
  const gp = r++; sh.set(gp, 1, 'People spare (− short)', 'bold'); M.forEach((m, i) => sh.f(gp, mc(i), `${L(mc(i))}${he}-${L(mc(i))}${nd}`, 'dec', m.gap_fte ?? 0));
  for (const row of [gh, gp]) sh.cf.push({ ref: `${L(mc(0))}${row}:${L(YC)}${row}`, rules: [{ op: 'lessThan', v: '0', dxf: 'bad' }, { op: 'greaterThanOrEqual', v: '0', dxf: 'good' }] });
  sh.freeze = { row: hd, col: 2 };
  const cats = sh.full(hd, mc(0), hd, mc(11)); const rng = (row) => sh.full(row, mc(0), row, mc(11)); const COLS = { DOD: '008080', Emboss: '4B5563', Laser: '7030A0', OTTO: 'D97706', HMT: 'F59E0B' };
  const at0 = r + 2; const W = 8; const HH = 20;
  sh.charts.push({ title: 'Hours needed, by kind of work, against the hours there', cats, stacked: true, fmt: '#,##0', from: [1, at0], to: [1 + W, at0 + HH - 1],
    series: [...hourRows.map((h, j) => ({ name: kinds[j], ref: rng(h), kind: 'bar', color: COLS[kinds[j]] || '6B7280' })), { name: 'Other work', ref: rng(oth), kind: 'bar', color: 'A5B4FC' }, { name: 'Hours there', ref: rng(av), kind: 'line', color: '111827' }] });
  sh.charts.push({ title: 'People needed against people there', cats, fmt: '0', from: [2 + W, at0], to: [2 + 2 * W, at0 + HH - 1],
    series: [{ name: 'People needed', ref: rng(nd), kind: 'bar', color: '7382E6' }, { name: 'People there', ref: rng(he), kind: 'line', color: '111827' }] });
  // the hours per customer (and per technology / way of matching)
  const cu = sheet('By customer'); cu.width(1, 30).width(2, 12); for (let i = 0; i < 12; i++) cu.width(mc(i), 10); cu.width(YC, 12);
  cu.set(1, 1, `Headcount ${d.year} — the hours per customer`, 'title'); cu.set(2, 1, 'Each customer\'s cards × its split, at the rates (worked out in SITHUB; the totals are formulas).', 'note');
  cu.set(4, 1, 'Customer', 'header'); cu.set(4, 2, 'Work', 'header'); M.forEach((m, i) => cu.set(4, mc(i), m.label, 'headerNum')); cu.set(4, YC, String(d.year), 'headerNum');
  let q = 5; const custRows = [];
  for (const c of d.customers) {
    const top = q; cu.set(q, 1, c.trigram ? `${c.trigram} — ${c.name}` : c.name, 'bold'); cu.set(q, 2, 'all', 'bold');
    const parts = Object.entries(c.by || {}).filter(([, a]) => a.some((v) => v > 0.005));
    M.forEach((_, i) => cu.f(q, mc(i), parts.length ? `SUM(${L(mc(i))}${q + 1}:${L(mc(i))}${q + parts.length})` : '0', 'intBold', c.hours[i])); cu.f(q, YC, `SUM(${L(mc(0))}${q}:${L(mc(11))}${q})`, 'intBold');
    custRows.push(top); q++;
    for (const [k, a] of parts) { cu.set(q, 2, k); a.forEach((v, i) => cu.set(q, mc(i), v, 'dec')); cu.f(q, YC, `SUM(${L(mc(0))}${q}:${L(mc(11))}${q})`, 'int'); q++; }
  }
  if (custRows.length) { cu.set(q, 1, 'All customers', 'bold'); M.forEach((_, i) => cu.f(q, mc(i), custRows.map((x) => `${L(mc(i))}${x}`).join('+'), 'intBold')); cu.f(q, YC, `SUM(${L(mc(0))}${q}:${L(mc(11))}${q})`, 'intBold');
    cu.cf.push({ ref: custRows.map((x) => `${L(mc(0))}${x}:${L(mc(11))}${x}`).join(' '), rules: [{ scale: ['FFFFFF', '7382E6'] }] }); }
  cu.freeze = { row: 4, col: 2 };
  const top8 = custRows.slice(0, 8); const cats2 = cu.full(4, mc(0), 4, mc(11)); const PAL = ['430099', '7382E6', '008080', 'D97706', '7030A0', '4B5563', 'C0392B', '2E8B57'];
  if (top8.length) cu.charts.push({ title: 'Hours per customer — the biggest', cats: cats2, stacked: true, fmt: '#,##0', from: [3, q + 3], to: [14, q + 24],
    series: top8.map((row, j) => ({ name: String(d.customers[j].trigram || d.customers[j].name), ref: cu.full(row, mc(0), row, mc(11)), kind: 'bar', color: PAL[j % PAL.length] })) });
  return buildBook([sh, cu]);
}

// ---- 🏭 Site capacity: each machine flat out — speed × hours a day (shifts × 8 × its share for perso) × working
// days — as formulas over its inputs, the technologies' totals at each machine's split, with charts
function buildSiteWorkbook(d) {
  const T = d.techs; const M = d.months; const L = (c) => colName(c - 1);
  const sh = sheet(`Site Capacity ${d.year}`); const SC = 7; const mc = (i) => SC + T.length + 1 + i; const YC = mc(12);
  sh.width(1, 22).width(2, 14).width(3, 10).width(4, 11).width(5, 11).width(6, 11); for (let i = 0; i < T.length; i++) sh.width(SC + i, 9); sh.width(SC + T.length, 11); for (let i = 0; i < 12; i++) sh.width(mc(i), 11); sh.width(YC, 13);
  sh.set(1, 1, `Site Capacity ${d.year} — what the machines could make flat out`, 'title');
  sh.set(2, 1, 'Run speed × hours a day (shifts × 8 h × its share for perso) × working days — no OEE: the losses are counted in Capacity planning\'s OEE. Blue on yellow are inputs; change one and the rest follows, charts too.', 'note');
  sh.set(4, 1, 'Shifts a day', 'bold'); sh.set(4, 2, d.shifts, 'input'); sh.set(4, 3, 'Hours a shift', 'bold'); sh.set(4, 4, d.hours, 'input');
  const hr = 6; const head = [['Machine', 1], ['Runs', 2], ['Counted', 3], ['Speed /h', 4], ['Share for perso', 5], ['Hours a day', 6]];
  head.forEach(([l, c]) => sh.set(hr, c, l, c >= 4 ? 'headerNum' : 'header')); T.forEach((t, i) => sh.set(hr, SC + i, `${t} share`, 'headerNum')); sh.set(hr, SC + T.length, 'A day', 'headerNum');
  M.forEach((m, i) => sh.set(hr, mc(i), m.label, 'headerNum')); sh.set(hr, YC, String(d.year), 'headerNum');
  const wd = hr + 1; sh.set(wd, 1, 'Working days', 'bold'); M.forEach((m, i) => sh.set(wd, mc(i), m.workdays, 'input')); sh.f(wd, YC, `SUM(${L(mc(0))}${wd}:${L(mc(11))}${wd})`, 'intBold');
  const R0 = wd + 1; let r = R0;
  for (const m of d.machines) {
    const c = m.counted; const speed = c ? (c.hour || 0) : 0;
    sh.set(r, 1, m.name, 'bold'); sh.set(r, 2, m.techs.join(', ')); sh.set(r, 3, c ? (c.basis === 'mix' ? 'its mix' : c.basis === 'fastest' ? `fastest (${c.tech})` : c.tech) : '—', 'note');
    sh.set(r, 4, speed, 'input'); sh.set(r, 5, m.avail ?? 1, 'inputPct'); sh.f(r, 6, `$B$4*$D$4*E${r}`, 'dec', m.hours_day);
    T.forEach((t, i) => sh.set(r, SC + i, c ? (c.basis === 'mix' ? c.split[t] || 0 : c.tech === t ? 1 : 0) : 0, 'inputPct'));
    sh.f(r, SC + T.length, `D${r}*F${r}`, 'int', c ? c.day : 0);
    M.forEach((mm, i) => sh.f(r, mc(i), `$${L(SC + T.length)}${r}*${L(mc(i))}$${wd}`, 'int', c ? c.months[i] : 0)); sh.f(r, YC, `SUM(${L(mc(0))}${r}:${L(mc(11))}${r})`, 'intBold', c ? c.year : 0);
    r++;
  }
  const R1 = r - 1; r++;
  const tr = {}; for (const t of T) { tr[t] = r; sh.set(r, 1, t, 'bold'); sh.set(r, 3, 'at each machine\'s share', 'note');
    sh.f(r, SC + T.length, R1 >= R0 ? `SUMPRODUCT($${L(SC + T.indexOf(t))}$${R0}:$${L(SC + T.indexOf(t))}$${R1},${L(SC + T.length)}$${R0}:${L(SC + T.length)}$${R1})` : '0', 'intBold', d.counted_by_tech[t].day);
    M.forEach((_, i) => sh.f(r, mc(i), R1 >= R0 ? `SUMPRODUCT($${L(SC + T.indexOf(t))}$${R0}:$${L(SC + T.indexOf(t))}$${R1},${L(mc(i))}$${R0}:${L(mc(i))}$${R1})` : '0', 'int', d.counted_by_tech[t].months[i]));
    sh.f(r, YC, `SUM(${L(mc(0))}${r}:${L(mc(11))}${r})`, 'intBold', d.counted_by_tech[t].year); r++; }
  const all = r; sh.set(all, 1, 'Site', 'bold'); for (const c of [SC + T.length, ...M.map((_, i) => mc(i)), YC]) sh.f(all, c, R1 >= R0 ? `SUM(${L(c)}${R0}:${L(c)}${R1})` : '0', 'intBold');
  sh.freeze = { row: hr, col: 1 };
  const COLS = { DOD: '008080', Emboss: '4B5563', Laser: '7030A0' };
  const at0 = all + 3; const W = 9; const HH = 20; const cats = sh.full(hr, mc(0), hr, mc(11));
  sh.charts.push({ title: 'Cards the site could make each month, by technology', cats, stacked: true, from: [1, at0], to: [1 + W, at0 + HH - 1],
    series: T.map((t) => ({ name: t, ref: sh.full(tr[t], mc(0), tr[t], mc(11)), kind: 'bar', color: COLS[t] || '6B7280' })) });
  if (R1 >= R0) sh.charts.push({ title: 'Each machine — cards a year', cats: sh.full(R0, 1, R1, 1), from: [2 + W, at0], to: [2 + 2 * W, at0 + HH - 1],
    series: [{ name: String(d.year), ref: sh.full(R0, YC, R1, YC), kind: 'bar', color: '7382E6' }] });
  const mm = d.match?.machines || []; if (!mm.length) return buildBook([sh]);
  // 🔗 Matching: the same hours (the perso sheet's shifts × hours a shift), its machines' speed; metal at the metal speed
  const ms = sheet(`Matching ${d.year}`); const MC = (i) => 6 + i; const MY = MC(12);
  ms.width(1, 22).width(2, 11).width(3, 11).width(4, 11).width(5, 11); for (let i = 0; i < 12; i++) ms.width(MC(i), 11); ms.width(MY, 13);
  ms.set(1, 1, `Matching ${d.year} — what the Matching machines could match flat out`, 'title');
  ms.set(2, 1, `Items: run speed × hours a day (the shifts × hours on the site sheet) × working days — no OEE. Metal: the machines ticked for metal running metal cards only, at their metal speed.`, 'note');
  const site = `'Site Capacity ${d.year}'`;
  const mh = 4; [['Machine', 1], ['Speed /h', 2], ['Metal /h', 3], ['Hours a day', 4], ['A day', 5]].forEach(([l, c]) => ms.set(mh, c, l, c >= 2 ? 'headerNum' : 'header'));
  M.forEach((m, i) => ms.set(mh, MC(i), m.label, 'headerNum')); ms.set(mh, MY, String(d.year), 'headerNum');
  const mw = mh + 1; ms.set(mw, 1, 'Working days', 'bold'); M.forEach((_, i) => ms.f(mw, MC(i), `${site}!${L(mc(i))}${wd}`, 'int', d.months[i].workdays)); ms.f(mw, MY, `SUM(${L(MC(0))}${mw}:${L(MC(11))}${mw})`, 'intBold');
  const Q0 = mw + 1; let q = Q0;
  for (const m of mm) {
    ms.set(q, 1, m.hand ? `${m.name} (hand match)` : m.name, 'bold'); ms.set(q, 2, m.speed, 'input'); if (m.metal) ms.set(q, 3, m.metal_speed || 0, 'input'); else ms.set(q, 3, '—', 'note');
    ms.f(q, 4, `${site}!$B$4*${site}!$D$4`, 'dec', m.hours_day); ms.f(q, 5, `B${q}*D${q}`, 'int', m.day);
    M.forEach((_, i) => ms.f(q, MC(i), `$E${q}*${L(MC(i))}$${mw}`, 'int', m.months[i])); ms.f(q, MY, `SUM(${L(MC(0))}${q}:${L(MC(11))}${q})`, 'intBold', m.year); q++;
  }
  const Q1 = q - 1; const mt = q; ms.set(mt, 1, 'Matching', 'bold');
  for (const c of [5, ...M.map((_, i) => MC(i)), MY]) ms.f(mt, c, `SUM(${L(c)}${Q0}:${L(c)}${Q1})`, 'intBold');
  let mtl = null;
  if (mm.some((m) => m.metal)) { mtl = mt + 1; ms.set(mtl, 1, 'Metal only', 'bold'); ms.set(mtl, 2, 'the metal machines on metal cards', 'note');
    ms.f(mtl, 5, `SUMPRODUCT(IFERROR(C${Q0}:C${Q1}*1,0),D${Q0}:D${Q1})`, 'intBold', d.match.metal?.day || 0);
    M.forEach((_, i) => ms.f(mtl, MC(i), `$E${mtl}*${L(MC(i))}$${mw}`, 'int', d.match.metal?.months[i] || 0)); ms.f(mtl, MY, `SUM(${L(MC(0))}${mtl}:${L(MC(11))}${mtl})`, 'intBold', d.match.metal?.year || 0); }
  ms.freeze = { row: mh, col: 1 };
  const mat0 = (mtl || mt) + 3; const mcats = ms.full(mh, MC(0), mh, MC(11));
  ms.charts.push({ title: 'Items the Matching machines could match each month', cats: mcats, from: [1, mat0], to: [1 + W, mat0 + HH - 1],
    series: [{ name: 'Matching', ref: ms.full(mt, MC(0), mt, MC(11)), kind: 'bar', color: '2563EB' }, ...(mtl ? [{ name: 'Metal only', ref: ms.full(mtl, MC(0), mtl, MC(11)), kind: 'line', color: '6B7280' }] : [])] });
  return buildBook([sh, ms]);
}

module.exports = { buildMatchMonthWorkbook, buildCpmWorkbook, buildDayWorkbook, buildHeadcountWorkbook, buildSiteWorkbook, describe };
