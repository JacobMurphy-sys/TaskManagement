'use strict';
// 💶 CAPEX planner: pending investments and larger projects — what's asked for, why, what it costs,
// when, and where it stands. Its exports: a detailed Excel workbook to edit and examine (the register
// with every field, and a summary by status, category and quarter as formulas over it), and PDF
// one-pagers to present — one investment, or the whole plan on a page.
const PDFDocument = require('pdfkit');
const { sheet, buildBook } = require('./xlsxbook');

const CATEGORIES = ['Replacement', 'Capacity / growth', 'Safety & compliance', 'Quality', 'Cost saving', 'IT / digital', 'Building & facilities', 'Other'];
const STATUS = { draft: 'Draft', submitted: 'Submitted', approved: 'Approved', ordered: 'Ordered', installed: 'Installed', closed: 'Closed', rejected: 'Rejected', on_hold: 'On hold' };
const OPEN = ['draft', 'submitted', 'approved', 'ordered', 'on_hold']; // still to spend or decide
const PRIORITY = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Critical' };
// what has to be filled in before an investment can be saved
const REQUIRED = { title: 'Title', category: 'Category', owner: 'Requested by', amount: 'Estimated cost', planned_date: 'Planned date', justification: 'Business justification' };
const FIELDS = ['title', 'category', 'owner', 'amount', 'currency', 'planned_date', 'justification', 'status', 'priority', 'description', 'sponsor', 'department',
  'supplier', 'quote_ref', 'annual_saving', 'payback_months', 'risk_if_not', 'approved_on', 'approved_by', 'po_number', 'actual_cost', 'project_id', 'next_action', 'notes'];

const quarter = (d) => (d ? `${String(d).slice(0, 4)} Q${Math.floor((Number(String(d).slice(5, 7)) - 1) / 3) + 1}` : '');
// payback in months worked out from the saving, unless given
const payback = (x) => (x.payback_months ?? (x.annual_saving > 0 ? Math.round((x.amount / x.annual_saving) * 12 * 10) / 10 : null));

// ---- Excel: the register (every field, editable) and a summary of formulas over it
function workbook(items, { currency = '£', stamp = '' } = {}) {
  const reg = sheet('Register');
  const cols = [['Ref', 'ref', 11, 'text'], ['Title', 'title', 34, 'inputText'], ['Status', 'status', 11, 'inputText'], ['Category', 'category', 18, 'inputText'], ['Priority', 'priority', 9, 'inputText'],
    ['Requested by', 'owner', 16, 'inputText'], ['Sponsor', 'sponsor', 16, 'inputText'], ['Department', 'department', 14, 'inputText'], ['Estimated cost', 'amount', 14, 'inputMoney'], ['Currency', 'currency', 8, 'inputText'],
    ['Planned date', 'planned_date', 12, 'inputDate'], ['Quarter', null, 9, 'text'], ['Annual saving', 'annual_saving', 13, 'inputMoney'], ['Payback (months)', null, 11, 'dec'],
    ['Supplier', 'supplier', 16, 'inputText'], ['Quote', 'quote_ref', 12, 'inputText'], ['Approved on', 'approved_on', 12, 'inputDate'], ['Approved by', 'approved_by', 14, 'inputText'],
    ['PO number', 'po_number', 12, 'inputText'], ['Actual cost', 'actual_cost', 13, 'inputMoney'], ['Variance', null, 12, 'money'], ['Project', 'project_name', 20, 'text'],
    ['Business justification', 'justification', 50, 'inputWrap'], ['Description', 'description', 40, 'inputWrap'], ['Risk if not done', 'risk_if_not', 36, 'inputWrap'], ['Next action', 'next_action', 36, 'inputWrap'], ['Notes', 'notes', 36, 'inputWrap']];
  const C = Object.fromEntries(cols.map(([h], i) => [h, i + 1]));
  reg.set(1, 1, 'CAPEX register', 'title'); reg.set(2, 1, `${items.length} investment${items.length === 1 ? '' : 's'}${stamp ? ` · exported ${stamp}` : ''} · yellow cells are inputs — the quarter, payback and variance follow them`, 'note');
  const H = 4; cols.forEach(([h, , w], i) => { reg.set(H, i + 1, h, 'header'); reg.width(i + 1, w); });
  const toDate = (d) => (d ? Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86400000) : null);
  items.forEach((x, k) => {
    const r = H + 1 + k;
    for (const [h, key, , st] of cols) {
      if (!key) continue;
      let v = x[key];
      if (key === 'status') v = STATUS[v] || v; if (key === 'priority') v = PRIORITY[v] || v; if (key === 'currency') v = v || currency;
      if (key === 'planned_date' || key === 'approved_on') v = toDate(v);
      reg.set(r, C[h], v ?? null, st);
    }
    const c = (h) => reg.ref(r, C[h]);
    reg.f(r, C.Quarter, `IF(${c('Planned date')}="","",YEAR(${c('Planned date')})&" Q"&INT((MONTH(${c('Planned date')})+2)/3))`, 'text', quarter(x.planned_date));
    reg.f(r, C['Payback (months)'], `IF(${c('Annual saving')}>0,ROUND(${c('Estimated cost')}/${c('Annual saving')}*12,1),"")`, 'dec', x.annual_saving > 0 ? Math.round((x.amount / x.annual_saving) * 120) / 10 : null);
    reg.f(r, C.Variance, `IF(${c('Actual cost')}="","",${c('Actual cost')}-${c('Estimated cost')})`, 'money', x.actual_cost !== null && x.actual_cost !== undefined ? x.actual_cost - x.amount : null);
  });
  reg.freeze = { row: H + 1, col: 3 };
  const last = H + Math.max(items.length, 1) + 200; // room to add rows below
  const rng = (h) => reg.full(H + 1, C[h], last, C[h]);
  reg.cf.push({ ref: `${reg.ref(H + 1, C.Variance)}:${reg.ref(last, C.Variance)}`, rules: [{ op: 'greaterThan', v: 0, dxf: 'bad' }, { op: 'lessThan', v: 0, dxf: 'good' }] });

  // the summary: per currency, totals by status, category and quarter — SUMIFS over the register
  const sum = sheet('Summary');
  sum.set(1, 1, 'CAPEX summary', 'title'); sum.set(2, 1, 'Totals of the Register sheet — they follow it as it is edited', 'note');
  sum.width(1, 26); for (let i = 2; i <= 4; i++) sum.width(i, 15);
  const curs = [...new Set(items.map((x) => x.currency || currency))]; if (!curs.length) curs.push(currency);
  let r = 4;
  const tot = (label, critRange, values, total) => {
    sum.set(r, 1, label, 'section'); sum.set(r, 2, 'Count', 'section'); sum.set(r, 3, 'Estimated', 'section'); sum.set(r, 4, 'Actual', 'section'); r++;
    const first = r;
    for (const v of values) {
      sum.set(r, 1, v.label, 'text');
      const cur = v.cur; const crit = `${critRange},${sum.ref(r, 1)},${rng('Currency')},"${cur}"`;
      sum.f(r, 2, `COUNTIFS(${crit})`, 'int', v.n); sum.f(r, 3, `SUMIFS(${rng('Estimated cost')},${crit})`, 'money', v.est); sum.f(r, 4, `SUMIFS(${rng('Actual cost')},${crit})`, 'money', v.act);
      r++;
    }
    if (total) { sum.set(r, 1, 'Total', 'bold'); for (const c of [2, 3, 4]) sum.f(r, c, `SUM(${sum.range(first, c, r - 1, c)})`, c === 2 ? 'intBold' : 'moneyBold', null); r++; }
    r++;
  };
  for (const cur of curs) {
    const mine = items.filter((x) => (x.currency || currency) === cur);
    const agg = (fn, key) => { const m = new Map(); for (const x of mine) { const k = fn(x); const a = m.get(k) || m.set(k, { n: 0, est: 0, act: 0 }).get(k); a.n++; a.est += x.amount || 0; a.act += x.actual_cost || 0; } return m; };
    sum.set(r, 1, `In ${cur}`, 'bold'); r++;
    const bs = agg((x) => STATUS[x.status] || x.status);
    tot('By status', rng('Status'), Object.values(STATUS).map((l) => ({ label: l, cur, ...(bs.get(l) || { n: 0, est: 0, act: 0 }) })), true);
    const bc = agg((x) => x.category);
    tot('By category', rng('Category'), [...new Set([...CATEGORIES, ...mine.map((x) => x.category)])].map((l) => ({ label: l, cur, ...(bc.get(l) || { n: 0, est: 0, act: 0 }) })), true);
    const bq = agg((x) => quarter(x.planned_date));
    const qs = [...bq.keys()].filter(Boolean).sort();
    if (qs.length) tot('By planned quarter', rng('Quarter'), qs.map((l) => ({ label: l, cur, ...bq.get(l) })), true);
  }
  return buildBook([sum, reg], { active: 1 });
}

// ---- PDF one-pagers
const clean = (s) => String(s ?? '').replace(/[▶►]/g, '>').replace(/[^\x20-\x7E -ÿ–—‘’“”•…€\n]/gu, '').trim();
const BRAND = '#430099'; const BRAND2 = '#7382e6'; const INK = '#1d1b2e'; const MUTED = '#6b6985'; const LINE = '#dddbe8';
const STATUS_COL = { draft: '#8a8a9a', submitted: '#7382e6', approved: '#238446', ordered: '#0e7490', installed: '#430099', closed: '#555555', rejected: '#c93636', on_hold: '#b86e00' };
const fmtMoney = (v, cur) => (v === null || v === undefined || v === '' ? '—' : `${/[A-Za-z.]$/.test(cur) ? `${cur} ` : cur}${Number(v).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`);
const fmtDate = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function pdfDoc(title, landscape = false) {
  const doc = new PDFDocument({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: 36, info: { Title: clean(title), Creator: 'CI Manager' } });
  const chunks = []; doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.page.margins.bottom = 0; // one page: nothing written near the foot starts another
  return { doc, done };
}
// the purple band across the top
function band(doc, title, sub, right) {
  const W = doc.page.width;
  doc.rect(0, 0, W, 74).fill(BRAND); doc.rect(0, 74, W, 4).fill(BRAND2);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19).text(clean(title), 36, 20, { width: W - 230, height: 26, ellipsis: true, lineBreak: false });
  doc.font('Helvetica').fontSize(9.5).fillColor('#e4e0ff').text(clean(sub), 36, 48, { width: W - 230, lineBreak: false });
  if (right) { doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff'); const w = doc.widthOfString(clean(right)) + 18; doc.roundedRect(W - 36 - w, 26, w, 20, 10).fill(right.col || '#ffffff33'); doc.fillColor('#ffffff').text(clean(right), W - 36 - w + 9, 32, { lineBreak: false }); }
}
function foot(doc, stamp) {
  const y = doc.page.height - 26;
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`CI Manager · CAPEX planner · printed ${clean(stamp)}`, 36, y, { width: doc.page.width - 72, align: 'right', lineBreak: false });
}

// one investment on a page
async function onePager(x, { currency = '£', stamp = '' } = {}) {
  const cur = x.currency || currency;
  const { doc, done } = pdfDoc(`${x.ref} ${x.title}`);
  const W = doc.page.width; const L = 36; const R = W - 36;
  const pill = Object.assign(new String(STATUS[x.status] || x.status), { col: STATUS_COL[x.status] });
  band(doc, x.title, `${x.ref || ''} · ${x.category} · requested by ${x.owner}${x.department ? ` · ${x.department}` : ''}`, pill);
  // the key figures, as tiles
  let y = 96;
  const tiles = [['Estimated cost', fmtMoney(x.amount, cur)], ['Planned', `${fmtDate(x.planned_date)}`], ['Annual saving', fmtMoney(x.annual_saving, cur)], ['Payback', payback(x) ? `${payback(x)} months` : '—']];
  const tw = (R - L - 3 * 10) / 4;
  tiles.forEach(([l, v], i) => { const tx = L + i * (tw + 10); doc.roundedRect(tx, y, tw, 52, 6).lineWidth(1).fillAndStroke('#f5f4fc', LINE); doc.rect(tx, y, 3, 52).fill(i ? BRAND2 : BRAND);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(l.toUpperCase(), tx + 12, y + 9, { lineBreak: false }); doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(clean(v), tx + 12, y + 22, { width: tw - 18, lineBreak: false, ellipsis: true }); });
  y += 70;
  // where it stands: the steps from draft to closed, the current one marked
  const STEPS = ['draft', 'submitted', 'approved', 'ordered', 'installed', 'closed'];
  const at = STEPS.indexOf(x.status); const sw = (R - L) / (STEPS.length - 1);
  const off = at < 0; // rejected or on hold: shown beside the track
  doc.moveTo(L + 6, y + 8).lineTo(R - 6, y + 8).lineWidth(2).strokeColor(LINE).stroke();
  if (at > 0) doc.moveTo(L + 6, y + 8).lineTo(L + 6 + Math.min(at, STEPS.length - 1) * sw - (at === STEPS.length - 1 ? 12 : 0), y + 8).lineWidth(2).strokeColor(BRAND).stroke();
  STEPS.forEach((st, i) => { const cx = L + 6 + i * sw - (i === STEPS.length - 1 ? 12 : 0); const reached = !off && i <= at;
    doc.circle(cx, y + 8, i === at ? 7 : 5).lineWidth(1.5).fillAndStroke(reached ? (i === at ? STATUS_COL[st] : BRAND) : '#ffffff', reached ? (i === at ? STATUS_COL[st] : BRAND) : LINE);
    doc.fillColor(i === at ? INK : MUTED).font(i === at ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).text(STATUS[st], cx - 40, y + 19, { width: 80, align: 'center', lineBreak: false }); });
  if (off) { const t = `${STATUS[x.status]}`; doc.font('Helvetica-Bold').fontSize(8.5); const w = doc.widthOfString(t) + 14; doc.roundedRect(R - w, y - 16, w, 15, 7).fill(STATUS_COL[x.status]); doc.fillColor('#ffffff').text(t, R - w + 7, y - 12, { lineBreak: false }); }
  y += 42;
  // facts, two columns
  const facts = [['Category', x.category], ['Priority', PRIORITY[x.priority]], ['Requested by', x.owner], ['Sponsor', x.sponsor], ['Department', x.department], ['Supplier', x.supplier],
    ['Quote', x.quote_ref], ['Project', x.project_name], ['Approved', x.approved_on ? `${fmtDate(x.approved_on)}${x.approved_by ? ` by ${x.approved_by}` : ''}` : null], ['PO number', x.po_number],
    ['Actual cost', x.actual_cost !== null && x.actual_cost !== undefined ? `${fmtMoney(x.actual_cost, cur)} (${x.actual_cost - x.amount >= 0 ? '+' : ''}${fmtMoney(x.actual_cost - x.amount, cur)} vs estimate)` : null]].filter(([, v]) => v);
  const colW = (R - L - 20) / 2; const rows = Math.ceil(facts.length / 2);
  facts.forEach(([l, v], i) => { const cx = L + (i >= rows ? colW + 20 : 0); const cy = y + (i % rows) * 17;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(l, cx, cy, { width: 90, lineBreak: false }); doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(clean(v), cx + 92, cy, { width: colW - 92, lineBreak: false, ellipsis: true });
    doc.moveTo(cx, cy + 13).lineTo(cx + colW, cy + 13).lineWidth(0.4).strokeColor(LINE).stroke(); });
  y += rows * 17 + 14;
  // the text sections, each given the room it needs (the page shared out fairly)
  const sections = [['Business justification', x.justification], ['Description', x.description], ['Risk if not done', x.risk_if_not], ['Next action', x.next_action], ['Notes', x.notes]].filter(([, v]) => v && String(v).trim());
  const bottom = doc.page.height - 44; let room = bottom - y;
  sections.forEach(([h, v], i) => {
    const left = sections.length - i; const body = clean(v);
    doc.font('Helvetica').fontSize(9.5); const need = doc.heightOfString(body, { width: R - L }) + 20; const give = Math.min(need, Math.max(40, room / left + (i === 0 ? room * 0.15 : 0)));
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10.5).text(h, L, y, { lineBreak: false });
    doc.moveTo(L, y + 14).lineTo(R, y + 14).lineWidth(1).strokeColor(BRAND2).stroke();
    doc.fillColor(INK).font('Helvetica').fontSize(9.5).text(body, L, y + 19, { width: R - L, height: give - 22, ellipsis: true });
    y += give + 8; room = bottom - y;
  });
  foot(doc, stamp); doc.end(); return done;
}

// the plan on a page: totals by status, what's planned by quarter, and the open investments
async function overview(items, { currency = '£', stamp = '', title = 'CAPEX plan' } = {}) {
  const { doc, done } = pdfDoc(title, true);
  const W = doc.page.width; const L = 36; const R = W - 36;
  const main = (() => { const m = new Map(); for (const x of items) m.set(x.currency || currency, (m.get(x.currency || currency) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0] || currency; })();
  const mine = items.filter((x) => (x.currency || currency) === main); const other = items.length - mine.length;
  const open = mine.filter((x) => OPEN.includes(x.status));
  band(doc, title, `${items.length} investment${items.length === 1 ? '' : 's'} · ${open.length} open · amounts in ${main}${other ? ` (${other} in other currencies left out of the totals)` : ''}`);
  const total = (st) => mine.filter((x) => st.includes(x.status)).reduce((a, x) => a + (x.amount || 0), 0);
  const tiles = [['Pending decision', total(['draft', 'submitted', 'on_hold']), BRAND2], ['Approved, not ordered', total(['approved']), '#238446'], ['Committed (ordered)', total(['ordered']), '#0e7490'], ['Delivered this year', mine.filter((x) => ['installed', 'closed'].includes(x.status) && String(x.approved_on || x.planned_date || '').slice(0, 4) === String(new Date().getFullYear())).reduce((a, x) => a + (x.actual_cost ?? x.amount ?? 0), 0), BRAND]];
  let y = 94; const tw = (R - L - 3 * 10) / 4;
  tiles.forEach(([l, v, col], i) => { const tx = L + i * (tw + 10); doc.roundedRect(tx, y, tw, 50, 6).lineWidth(1).fillAndStroke('#f5f4fc', LINE); doc.rect(tx, y, 3, 50).fill(col);
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(l.toUpperCase(), tx + 12, y + 9, { lineBreak: false }); doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(fmtMoney(v, main), tx + 12, y + 22, { lineBreak: false }); });
  y += 66;
  // planned by quarter: bars of the open investments
  const byQ = new Map(); for (const x of open) { const q = quarter(x.planned_date); byQ.set(q, (byQ.get(q) || 0) + (x.amount || 0)); }
  const qs = [...byQ.keys()].sort().slice(0, 8); const maxQ = Math.max(1, ...qs.map((q) => byQ.get(q)));
  const chartW = 230; const chartH = 120;
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10.5).text('Open investments by planned quarter', L, y, { lineBreak: false });
  const by0 = y + 20;
  if (!qs.length) doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('Nothing open.', L, by0 + 10);
  const bw = Math.min(40, (chartW - 10) / Math.max(qs.length, 1) - 8);
  qs.forEach((q, i) => { const v = byQ.get(q); const h = (v / maxQ) * (chartH - 30); const bx = L + i * (bw + 8);
    doc.rect(bx, by0 + chartH - 18 - h, bw, h).fill(i % 2 ? BRAND2 : BRAND);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(7).text(fmtMoney(v, main).replace(/(\d)(\d{3})$/, '$1k').replace(/,\d{3}k$/, 'k'), bx - 6, by0 + chartH - 30 - h, { width: bw + 12, align: 'center', lineBreak: false });
    doc.fillColor(MUTED).font('Helvetica').fontSize(7).text(q.replace(/^\d\d/, "'"), bx - 6, by0 + chartH - 14, { width: bw + 12, align: 'center', lineBreak: false }); });
  // by category: a ranked list beside it
  const byC = new Map(); for (const x of open) byC.set(x.category, (byC.get(x.category) || 0) + (x.amount || 0));
  const cx = L + chartW + 30; const catW = 230; const maxC = Math.max(1, ...byC.values());
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10.5).text('Open by category', cx, y, { lineBreak: false });
  [...byC].sort((a, b) => b[1] - a[1]).slice(0, 7).forEach(([c, v], i) => { const ry = by0 + i * 15;
    doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(clean(c), cx, ry, { width: 100, lineBreak: false, ellipsis: true });
    doc.rect(cx + 104, ry + 1, ((catW - 170) * v) / maxC, 8).fill(BRAND2); doc.fillColor(INK).font('Helvetica-Bold').fontSize(8).text(fmtMoney(v, main), cx + catW - 60, ry, { width: 60, align: 'right', lineBreak: false }); });
  // by status, counts
  const sx = cx + catW + 30;
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10.5).text('By status', sx, y, { lineBreak: false });
  Object.entries(STATUS).forEach(([k, l], i) => { const n = items.filter((x) => x.status === k).length; const ry = by0 + i * 13.5;
    doc.circle(sx + 4, ry + 5, 3.5).fill(STATUS_COL[k]); doc.fillColor(INK).font('Helvetica').fontSize(8.5).text(`${l}`, sx + 12, ry, { lineBreak: false }); doc.font('Helvetica-Bold').text(String(n), sx + 90, ry, { lineBreak: false }); });
  y = by0 + chartH + 6;
  // the open investments, by planned date
  doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10.5).text('Open investments', L, y, { lineBreak: false }); y += 16;
  const cols = [['Ref', 66], ['Investment', 186], ['Category', 88], ['Requested by', 80], ['Planned', 62], ['Status', 62], ['Cost', 70], ['Next action', R - L - 614]];
  let x0 = L; doc.rect(L, y, R - L, 15).fill('#edebfa');
  cols.forEach(([h, w]) => { doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5).text(h.toUpperCase(), x0 + 4, y + 4, { width: w - 6, lineBreak: false, align: h === 'Cost' ? 'right' : 'left' }); x0 += w; });
  y += 17;
  const list = open.slice().sort((a, b) => String(a.planned_date).localeCompare(String(b.planned_date)) || b.amount - a.amount);
  const room = Math.floor((doc.page.height - 44 - y) / 14); const shown = list.length > room ? list.slice(0, room - 1) : list;
  shown.forEach((x, i) => { if (i % 2) doc.rect(L, y - 2, R - L, 14).fill('#faf9fe'); x0 = L;
    const vals = [x.ref, x.title, x.category, x.owner, fmtDate(x.planned_date), STATUS[x.status], fmtMoney(x.amount, main), x.next_action || ''];
    vals.forEach((v, j) => { const [h, w] = cols[j]; doc.fillColor(h === 'Status' ? STATUS_COL[x.status] : INK).font(h === 'Investment' || h === 'Cost' ? 'Helvetica-Bold' : 'Helvetica').fontSize(8).text(clean(v), x0 + 4, y + 1, { width: w - 6, height: 10, lineBreak: false, ellipsis: true, align: h === 'Cost' ? 'right' : 'left' }); x0 += w; });
    y += 14; });
  if (shown.length < list.length) doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`… and ${list.length - shown.length} more — see the Excel export`, L + 4, y + 1);
  foot(doc, stamp); doc.end(); return done;
}

module.exports = { CATEGORIES, STATUS, OPEN, PRIORITY, REQUIRED, FIELDS, workbook, onePager, overview, quarter, payback };
