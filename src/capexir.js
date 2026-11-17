'use strict';
// 📑 The IR pack of an investment (💶 CAPEX): the corporate financial model (.xlsx) and the IR deck (.pptx),
// filled in from what the CAPEX tool collects and downloaded on demand. The two templates are company
// documents, not part of SITHUB: where they're saved is set in 💶 CAPEX ⋯ › IR templates, and they're read
// from there each time (so a new version on the share is used at once).
//
// What an investment keeps for its IR pack is one JSON column (capex.ir), shaped by irOf() below. Money is
// in the investment's currency, in units (as its estimated cost is); the templates take thousands (k€).
const { readZip, zip, xmlEsc } = require('./xlsx');
const { readBook, colLetters } = require('./xlsxread');
const { createCalc } = require('./xlcalc');

const NATURES = ['Building', 'Equipment', 'IT'];
const JUSTIFS = ['Replacement / Obsolescence', 'Strategic footprint', 'Growth / Capacity increase', 'Compliance', 'Improvement / Productivity'];
const ITEM_KINDS = { equipment: 'Equipment (CAPEX)', setup: 'Set-up, transport, installation (CAPEX)', opex: 'Associated expense (OPEX)' };
// the P&L lines savings go on (Step 2 of the model: its row), savings positive, extra costs negative
const SAVING_LINES = {
  labour: ['Shop floor labour', 41], maint: ['Maintenance labour', 42], other_labour: ['Other labour', 43], consumables: ['Consumables', 45],
  spares: ['Spare parts', 48], freight: ['Freight and import duties', 74], opex: ['Running costs (OPEX)', 73],
};
const MILESTONES = { investco: 'InvestCo', po: 'PO issuance', fat: 'FAT', delivery: 'Equipment delivery', sat: 'SAT', sop: 'Start of production' };
const ANSWERS = { yes: 'Yes ✔', no: 'No ✘', na: 'N/A' };
const MAX_JSON = 400000;

// ---- the IR data -----------------------------------------------------------------------------------
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(String(v).replace(/[\s,]/g, '')); return Number.isFinite(n) ? n : null; };
const str = (v, max = 2000) => String(v ?? '').trim().slice(0, max);
const ym = (v) => (/^\d{4}-\d{2}/.test(String(v || '')) ? String(v).slice(0, 7) : '');
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const list = (v) => (Array.isArray(v) ? v : []);

// a clean IR record from whatever was sent or kept (unknown keys dropped, numbers made numbers)
function irOf(raw) {
  let r = raw;
  if (typeof r === 'string') { try { r = JSON.parse(r || '{}'); } catch { r = {}; } }
  r = r && typeof r === 'object' ? r : {};
  const months = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => ym(k) === k && num(v) !== null).map(([k, v]) => [k, num(v)]));
  const years = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).filter(([k, v]) => /^\d{4}$/.test(k) && num(v) !== null).map(([k, v]) => [k, num(v)]));
  return {
    ir_number: str(r.ir_number, 60), bu: str(r.bu, 40), bu_leader: str(r.bu_leader, 40), site: str(r.site, 200),
    nature: NATURES.includes(r.nature) ? r.nature : '', justif: JUSTIFS.includes(r.justif) ? r.justif : '',
    budgeted: ['yes', 'no'].includes(r.budgeted) ? r.budgeted : '',
    budget: { capex: num(r.budget?.capex), cashout_year: num(r.budget?.cashout_year), opex: num(r.budget?.opex), payback: num(r.budget?.payback), roi: num(r.budget?.roi) },
    cap_start: ym(r.cap_start), depreciation_years: num(r.depreciation_years),
    detail: str(r.detail, 4000), reasons: list(r.reasons).slice(0, 6).map((s) => str(s, 400)), risks: list(r.risks).slice(0, 6).map((s) => str(s, 400)),
    items: list(r.items).slice(0, 40).map((i) => ({ name: str(i?.name, 200), kind: ITEM_KINDS[i?.kind] ? i.kind : 'equipment', qty: num(i?.qty), amount: num(i?.amount), initial: num(i?.initial),
      supplier: str(i?.supplier, 200), validated: !!i?.validated, cashout: months(i?.cashout), ...(i?.from_guide ? { from_guide: true } : {}) })),
    quotes: list(r.quotes).slice(0, 6).map((q) => ({ supplier: str(q?.supplier, 200), price: num(q?.price), comment: str(q?.comment, 400), selected: !!q?.selected })),
    selection_reason: str(r.selection_reason, 2000),
    freight: Object.fromEntries(['sea', 'air'].map((k) => [k, { co2: str(r.freight?.[k]?.co2, 60), lead: str(r.freight?.[k]?.lead, 60), price: num(r.freight?.[k]?.price) }])),
    freight_mode: ['sea', 'air'].includes(r.freight_mode) ? r.freight_mode : '', freight_reason: str(r.freight_reason, 1000),
    negotiation: { purchaser: str(r.negotiation?.purchaser, 200), explanation: str(r.negotiation?.explanation, 1000), conditions: str(r.negotiation?.conditions, 1000), gains: str(r.negotiation?.gains, 1000) },
    milestones: Object.fromEntries(Object.keys(MILESTONES).map((k) => [k, ymd(r.milestones?.[k])])),
    planning_comments: str(r.planning_comments, 2000), cashout_comments: str(r.cashout_comments, 2000),
    savings: Object.fromEntries(Object.keys(SAVING_LINES).map((k) => [k, years(r.savings?.[k])]).filter(([, v]) => Object.keys(v).length)),
    growth: list(r.growth).slice(0, 9).map((g) => ({ customer: str(g?.customer, 120), asp: num(g?.asp), unit_cost: num(g?.unit_cost), volumes: years(g?.volumes) })),
    risks_opps: list(r.risks_opps).slice(0, 10).map((x) => ({ kind: x?.kind === 'opp' ? 'opp' : 'risk', text: str(x?.text, 400), k: num(x?.k) })),
    // 🧭 the step-by-step answers, as given (the fields above are worked out from them in the browser)
    guide: Object.fromEntries(Object.entries(r.guide && typeof r.guide === 'object' ? r.guide : {}).filter(([k, v]) => /^[a-z_]{1,30}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 80)
      .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v])),
    checklist: Object.fromEntries(Object.entries(r.checklist && typeof r.checklist === 'object' ? r.checklist : {})
      .filter(([n, v]) => /^\d{1,3}$/.test(n) && v && (ANSWERS[v.a] || v.note)).map(([n, v]) => [n, { a: ANSWERS[v.a] ? v.a : '', note: str(v.note, 400) }])),
  };
}
// the column as it's kept (400 kB at most)
function irJson(raw) {
  const s = JSON.stringify(irOf(raw));
  if (s.length > MAX_JSON) { const e = new Error('The IR details are too big to keep'); e.status = 400; throw e; }
  return s;
}

// the template's currency code for the investment's currency
const CODES = { '€': 'EUR', '£': 'GBP', $: 'USD', 'US$': 'USD', zł: 'PLN', kr: 'SEK', 'CHF': 'CHF' };
const codeOf = (cur) => { const c = String(cur || '').trim(); return CODES[c] || (/^[A-Za-z]{3}$/.test(c) ? c.toUpperCase() : 'EUR'); };
const symOf = (cur) => { const c = codeOf(cur); return { EUR: '€', GBP: '£', USD: '$' }[c] || c; };

// nature and justification from the category, where not chosen
function defaultsFor(x) {
  const c = String(x.category || '');
  return {
    nature: /\bIT\b|digital/i.test(c) ? 'IT' : /building|facilit/i.test(c) ? 'Building' : 'Equipment',
    justif: /replac|obsol/i.test(c) ? JUSTIFS[0] : /capacity|growth/i.test(c) ? JUSTIFS[2] : /safety|complian/i.test(c) ? JUSTIFS[3] : /cost|quality|saving|productiv/i.test(c) ? JUSTIFS[4] : '',
  };
}

// ---- the figures, worked out once for both files -----------------------------------------------------
const monthAdd = (k, n) => { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const monthsBetween = (a, b) => { const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
const sumOf = (o) => Object.values(o || {}).reduce((t, v) => t + (Number(v) || 0), 0);

function figures(x, { today = new Date() } = {}) {
  const ir = irOf(x.ir);
  const def = defaultsFor(x);
  const notes = [];
  const nature = ir.nature || def.nature; const justif = ir.justif || def.justif;
  const planned = ym(x.planned_date) || today.toISOString().slice(0, 7);
  const ms = ir.milestones;
  // the items: as listed, or the investment as one item
  let items = ir.items.filter((i) => i.name || i.amount);
  if (!items.length) { items = [{ name: x.title, kind: nature === 'Building' ? 'setup' : 'equipment', qty: 1, amount: Number(x.amount) || 0, initial: null, supplier: x.supplier || '', validated: false, cashout: {} }]; }
  const capexItems = items.filter((i) => i.kind !== 'opex'); const opexItems = items.filter((i) => i.kind === 'opex');
  const capex = capexItems.reduce((t, i) => t + (i.amount || 0), 0);
  const opex = opexItems.reduce((t, i) => t + (i.amount || 0), 0);
  if (ir.items.length && Math.abs(capex - (Number(x.amount) || 0)) > 0.5) notes.push(`The CAPEX items add up to ${Math.round(capex).toLocaleString('en-GB')}, the estimated cost is ${Math.round(Number(x.amount) || 0).toLocaleString('en-GB')}: the files use the items.`);
  // each item's cash-out by month: as planned, or all of it in the PO month (or the planned date's)
  const firstMonth = ym(ms.po) || planned;
  let phased = 0;
  for (const i of items) {
    if (Object.keys(i.cashout).length) { phased++; continue; }
    i.cashout = i.amount ? { [firstMonth]: i.amount } : {};
  }
  if (phased < items.length) notes.push(`Cash-out not phased for ${items.length - phased === items.length ? 'the items' : `${items.length - phased} item(s)`}: put in ${firstMonth} (the ${ms.po ? 'PO month' : 'planned date'}).`);
  for (const i of items) { const s = sumOf(i.cashout); if (i.amount && Math.abs(s - i.amount) > 0.5) notes.push(`${i.name || 'An item'}: its cash-out (${Math.round(s).toLocaleString('en-GB')}) isn't its amount (${Math.round(i.amount).toLocaleString('en-GB')}).`); }
  const allMonths = [...new Set(items.flatMap((i) => Object.keys(i.cashout)))].sort();
  // when it starts being depreciated: as given, else the start of production, else the planned date
  const capStart = ir.cap_start || ym(ms.sop) || planned;
  const capYear = Number(capStart.slice(0, 4)); const capMonth = Number(capStart.slice(5, 7));
  const depYears = ir.depreciation_years || 5;
  if (!ir.depreciation_years) notes.push('Depreciation over 5 years assumed (set the years in Business case).');
  const years = Array.from({ length: 10 }, (_, k) => capYear + k);
  // depreciation, straight line by month from the start of capitalisation
  const dep = Object.fromEntries(years.map((y) => [y, 0]));
  const monthly = capex / (depYears * 12);
  for (let k = 0; k < depYears * 12; k++) { const y = Number(monthAdd(capStart, k).slice(0, 4)); if (y in dep) dep[y] += monthly; }
  // savings by line and year; the annual saving from the essentials when none are given
  const savings = JSON.parse(JSON.stringify(ir.savings));
  if (!Object.keys(savings).length && Number(x.annual_saving) > 0) {
    const from = ym(ms.sop) || capStart; const fy = Number(from.slice(0, 4)); const fm = Number(from.slice(5, 7));
    savings.labour = {};
    for (const y of years) { if (y < fy || y >= fy + depYears + (fm > 1 ? 1 : 0)) continue; savings.labour[y] = y === fy ? (Number(x.annual_saving) * (12 - fm + 1)) / 12 : Number(x.annual_saving); }
    notes.push('The annual saving is taken as a shop floor labour saving, from the start of production: split it by line in Business case.');
  }
  const growth = ir.growth.filter((g) => g.customer || Object.keys(g.volumes).length);
  const cashYears = [...new Set(allMonths.map((m) => Number(m.slice(0, 4))))];
  if (cashYears.some((y) => y < capYear)) notes.push(`Some cash-out is before ${capYear}, the year capitalisation starts: the model's cash-out plan starts in ${capYear}, so it's counted in January ${capYear}.`);
  if (cashYears.some((y) => y > capYear + 3)) notes.push('Cash-out more than 4 years out is left out of the model\'s cash-out plan.');
  return { x, ir, nature, justif, items, capexItems, opexItems, capex, opex, allMonths, capStart, capYear, capMonth, depYears, years, dep, savings, growth, notes, currency: codeOf(x.currency), sym: symOf(x.currency) };
}

// ---- the financial model ------------------------------------------------------------------------------
// The template's sheets by what they start with (Step1 > KPIs, Step2 > P&L, …), so a renamed version still fits.
function modelSheets(book) {
  const find = (re) => book.sheets.find((s) => re.test(s.name)) || null;
  return { kpi: find(/^step\s*1/i), pl: find(/^step\s*2/i), cf: find(/^step\s*3/i), plan: find(/^step\s*4/i), asset: find(/asset.*description/i), risks: find(/risk/i), group: find(/group\s*assumption/i) };
}
// what the template offers: its business units (Group assumptions, the first table)
function modelMeta(buf) {
  const book = readBook(buf);
  const S = modelSheets(book);
  const missing = ['kpi', 'pl', 'cf', 'plan'].filter((k) => !S[k]);
  if (missing.length) throw new Error(`This doesn't look like the financial model: no ${missing.map((k) => ({ kpi: 'Step1 > KPIs', pl: 'Step2 > P&L', cf: 'Step3 > Cash Flow', plan: 'Step4 > Cash-out plan' }[k])).join(', ')} sheet`);
  const bus = [];
  if (S.group) {
    const sh = book.sheet(S.group.name);
    let started = false;
    for (let r = 1; r <= Math.min(sh.maxRow, 60); r++) {
      const v = sh.cells.get(`B${r}`)?.v;
      if (String(v ?? '').trim().toUpperCase() === 'BU') { if (started) break; started = true; continue; }
      if (started) { if (v === null || v === undefined || v === '') { if (bus.length) break; continue; } if (typeof v === 'string') bus.push(v.trim()); }
    }
  }
  return { bus, sheets: Object.fromEntries(Object.entries(S).map(([k, s]) => [k, s?.name || null])) };
}

// every value the model gets, as { sheetName: { ref: value } }
function modelInputs(f, S) {
  const { x, ir } = f;
  const k = (v) => (v === null || v === undefined ? null : Math.round((v / 1000) * 1000) / 1000); // thousands, to the unit
  const out = {}; const put = (sheet, ref, v) => { if (!sheet) return; (out[sheet.name] = out[sheet.name] || {})[ref] = v; };
  // Step 1: the project
  put(S.kpi, 'C7', 'InvestCo');
  put(S.kpi, 'C8', `${x.ref ? `${x.ref} ` : ''}${x.title}`);
  if (ir.bu) { put(S.kpi, 'C9', ir.bu_leader || ir.bu); put(S.kpi, 'C10', ir.bu); }
  put(S.kpi, 'C12', [f.nature, f.justif].filter(Boolean).join(' – '));
  put(S.kpi, 'C13', f.capYear);
  put(S.kpi, 'C14', f.capMonth);
  const launch = ym(ir.milestones.sop) || f.capStart;
  put(S.kpi, 'C15', { date: `${launch}-01` });
  put(S.kpi, 'C16', f.currency);
  put(S.kpi, 'C18', f.depYears);
  // Step 4: the cash-out plan, CAPEX items by month over 4 years from the year capitalisation starts
  const yearCols = [3, 16, 29, 42]; // D, Q, AD, AQ: January of each year (a total column after each December)
  const rows = f.capexItems.slice(0, 10).map((i) => ({ name: i.name || 'Equipment', cashout: { ...i.cashout } }));
  if (f.capexItems.length > 10) { const rest = f.capexItems.slice(9); rows[9] = { name: `Other (${rest.length} items)`, cashout: {} }; for (const i of rest) for (const [m, v] of Object.entries(i.cashout)) rows[9].cashout[m] = (rows[9].cashout[m] || 0) + v; }
  rows.forEach((row, n) => {
    const r = 9 + n;
    put(S.plan, `C${r}`, row.name);
    const cells = {};
    for (const [m, v] of Object.entries(row.cashout)) {
      let y = Number(m.slice(0, 4)); let mo = Number(m.slice(5, 7));
      if (y < f.capYear) { y = f.capYear; mo = 1; }
      const yi = y - f.capYear; if (yi > 3) continue;
      const ref = `${colLetters(yearCols[yi] + mo)}${r}`;
      cells[ref] = (cells[ref] || 0) + v;
    }
    for (const [ref, v] of Object.entries(cells)) put(S.plan, ref, k(v));
  });
  // Step 2: the P&L, 10 years (E…N) from the year capitalisation starts
  const col = (y) => colLetters(5 + (y - f.capYear)); // E = year 1
  for (const y of f.years) if (f.dep[y]) put(S.pl, `${col(y)}50`, -k(f.dep[y]));
  for (const [line, byYear] of Object.entries(f.savings)) {
    const row = SAVING_LINES[line]?.[1]; if (!row) continue;
    for (const [y, v] of Object.entries(byYear)) if (f.years.includes(Number(y)) && v) put(S.pl, `${col(Number(y))}${row}`, k(v));
  }
  // one-off associated expenses (OPEX) in their year, on dedicated OPEX (with any running-cost saving there)
  for (const i of f.opexItems) for (const [m, v] of Object.entries(i.cashout)) {
    const y = Math.max(Number(m.slice(0, 4)), f.capYear); if (!f.years.includes(y)) continue;
    const ref = `${col(y)}73`; const cur = out[S.pl?.name]?.[ref] || 0; put(S.pl, ref, Math.round((cur - v / 1000) * 1000) / 1000);
  }
  // added volumes: quantities (thousands) and ASP per line, their variable costs on a payables line
  const varCost = {};
  f.growth.slice(0, 9).forEach((g, n) => {
    put(S.pl, `D${8 + n}`, g.customer || `Customer ${n + 1}`);
    for (const [y, q] of Object.entries(g.volumes)) {
      if (!f.years.includes(Number(y))) continue;
      put(S.pl, `${col(Number(y))}${8 + n}`, q);
      if (g.asp !== null) put(S.pl, `${col(Number(y))}${19 + n}`, g.asp);
      if (g.unit_cost) varCost[y] = (varCost[y] || 0) + q * g.unit_cost;
    }
  });
  if (Object.keys(varCost).length) { put(S.pl, 'D46', 'Variable costs of the added volumes'); for (const [y, v] of Object.entries(varCost)) put(S.pl, `${col(Number(y))}46`, -Math.round(v * 1000) / 1000); }
  // the asset and its associated expenses
  const eq = f.capexItems.filter((i) => i.kind === 'equipment'); const su = f.capexItems.filter((i) => i.kind === 'setup');
  put(S.asset, 'D5', k(eq.reduce((t, i) => t + (i.amount || 0), 0)));
  put(S.asset, 'D6', eq.reduce((t, i) => t + (i.qty || 1), 0) || null);
  put(S.asset, 'D7', k(su.reduce((t, i) => t + (i.amount || 0), 0)));
  const lines = (list_, from, n) => {
    const shown = list_.slice(0, n);
    if (list_.length > n) { const rest = list_.slice(n - 1); shown[n - 1] = { name: `Other (${rest.length} items)`, amount: rest.reduce((t, i) => t + (i.amount || 0), 0), supplier: '', validated: rest.every((i) => i.validated) }; }
    shown.forEach((i, j) => { put(S.asset, `C${from + j}`, i.name); put(S.asset, `D${from + j}`, k(i.amount)); put(S.asset, `E${from + j}`, i.supplier || null); put(S.asset, `F${from + j}`, i.validated ? 'Yes' : 'No'); });
  };
  lines(f.capexItems, 12, 8);
  lines(f.opexItems, 22, 4);
  // risks and opportunities
  const rs = ir.risks_opps.filter((r) => r.kind === 'risk' && r.text).slice(0, 5); const os = ir.risks_opps.filter((r) => r.kind === 'opp' && r.text).slice(0, 5);
  rs.forEach((r, j) => { put(S.risks, `A${4 + j}`, r.text); put(S.risks, `B${4 + j}`, r.k); });
  os.forEach((r, j) => { put(S.risks, `A${11 + j}`, r.text); put(S.risks, `B${11 + j}`, r.k); });
  return out;
}

// a cell's XML for a value, keeping its style
const serialOf = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000 + 25569;
function cellXml(ref, s, v) {
  const sa = s ? ` s="${s}"` : '';
  if (v === null || v === undefined || v === '') return `<c r="${ref}"${sa}/>`;
  if (v && typeof v === 'object' && v.date) return `<c r="${ref}"${sa}><v>${serialOf(v.date)}</v></c>`;
  if (typeof v === 'number') return `<c r="${ref}"${sa}><v>${v}</v></c>`;
  return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(v))}</t></is></c>`;
}
const colNo = (ref) => [...ref.match(/^[A-Z]+/)[0]].reduce((t, ch) => t * 26 + ch.charCodeAt(0) - 64, 0);
// write values into a sheet's XML: an existing cell keeps its style; a missing one is added in its row
function writeCells(xml, values) {
  for (const [ref, v] of Object.entries(values)) {
    const re = new RegExp(`<c\\b(?=[^>]*\\sr="${ref}")([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`);
    if (re.test(xml)) { xml = xml.replace(re, (whole, attrs) => cellXml(ref, (attrs.match(/\ss="(\d+)"/) || [])[1], v)); continue; }
    if (v === null || v === undefined || v === '') continue;
    const row = Number(ref.match(/\d+$/)[0]); const cell = cellXml(ref, null, v);
    const rowRe = new RegExp(`(<row\\b(?=[^>]*\\sr="${row}")[^>]*?)(/>|>([\\s\\S]*?)</row>)`);
    if (rowRe.test(xml)) {
      xml = xml.replace(rowRe, (whole, open, end, body = '') => {
        if (end === '/>') return `${open}>${cell}</row>`;
        const parts = body.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
        const at = parts.findIndex((p) => colNo(p.match(/\sr="([A-Z]+)\d+"/)[1]) > colNo(ref));
        if (at < 0) parts.push(cell); else parts.splice(at, 0, cell);
        return `${open.replace(/\sspans="[^"]*"/, '')}>${parts.join('')}</row>`;
      });
    } else {
      const next = [...xml.matchAll(/<row\b[^>]*\sr="(\d+)"/g)].find((m) => Number(m[1]) > row);
      const rowXml = `<row r="${row}">${cell}</row>`;
      xml = next ? xml.slice(0, next.index) + rowXml + xml.slice(next.index) : xml.replace(/<\/sheetData>/, `${rowXml}</sheetData>`).replace(/<sheetData\s*\/>/, `<sheetData>${rowXml}</sheetData>`);
    }
  }
  return xml;
}

// The model filled in (a workbook Excel recalculates on opening) and its results worked out by SITHUB.
function fillModel(tpl, x, opts = {}) {
  const f = opts.figures || figures(x, opts);
  const book = readBook(tpl);
  const S = modelSheets(book);
  if (!S.kpi || !S.pl || !S.cf || !S.plan) throw new Error('The financial model template is missing its Step 1–4 sheets');
  const inputs = modelInputs(f, S);
  const files = readZip(tpl);
  for (const [name, values] of Object.entries(inputs)) {
    const info = book.sheets.find((s) => s.name === name);
    const p = info?.file; if (!p || !files[p]) continue;
    files[p] = Buffer.from(writeCells(files[p].toString('utf8'), values), 'utf8');
  }
  // Excel works every formula out again when it opens the file
  if (files['xl/workbook.xml']) {
    let wb = files['xl/workbook.xml'].toString('utf8');
    wb = /<calcPr\b/.test(wb) ? wb.replace(/<calcPr\b([^>]*?)(\/?)>/, (w, a, end) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${end}>`) : wb.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>');
    files['xl/workbook.xml'] = Buffer.from(wb, 'utf8');
  }
  // the results, by SITHUB's own formula engine over the template with these inputs
  const sheets = {}; for (const s of book.sheets) sheets[s.name] = Object.assign(book.sheet(s.name), { name: s.name });
  const over = new Map(); for (const [n, values] of Object.entries(inputs)) for (const [ref, v] of Object.entries(values)) over.set(`${n}!${ref}`, v && typeof v === 'object' && v.date ? serialOf(v.date) : v);
  // an input where the template has no cell yet: an empty one, so ranges over it (SUM(D9:O18)…) see the value
  for (const [n, values] of Object.entries(inputs)) {
    const sh = sheets[n]; if (!sh) continue;
    for (const ref of Object.keys(values)) {
      if (sh.cells.has(ref)) continue;
      const row = Number(ref.match(/\d+$/)[0]); const col = colNo(ref);
      sh.cells.set(ref, { r: ref, row, col, v: null, t: 'n', s: 0, f: null });
      if (row > sh.maxRow) sh.maxRow = row; if (col > sh.maxCol) sh.maxCol = col;
    }
  }
  const calc = createCalc(sheets, { override: (sh, ref) => over.get(`${sh}!${ref}`) });
  // …and written in as each formula's saved result, so the file shows them even where nothing recalculates (previews, phones)
  for (const info of book.sheets) {
    const p = info.file; if (!p || !files[p]) continue;
    const sh = sheets[info.name]; const refs = new Set([...sh.cells.values()].filter((c) => c.f || /<f\b/.test(c.raw || '')).map((c) => c.r));
    if (!refs.size) continue;
    files[p] = Buffer.from(files[p].toString('utf8').replace(/<c\b([^>]*?)>([\s\S]*?)<\/c>/g, (whole, attrs, inner) => {
      const ref = attrs.match(/\sr="([A-Z]+\d+)"/)?.[1]; if (!ref || !/<f\b/.test(inner) || !refs.has(ref)) return whole;
      let v; try { v = calc.value(info.name, ref); } catch { return whole; }
      if (v === null || v === undefined) v = '';
      const isE = v && typeof v === 'object' && 'error' in v;
      if (v && typeof v === 'object' && !isE) return whole; // an array result: left for Excel
      const t = isE ? 'e' : typeof v === 'string' ? 'str' : typeof v === 'boolean' ? 'b' : null;
      const out = isE ? v.error : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'number' ? (Number.isFinite(v) ? v : 0) : xmlEsc(v);
      const a2 = attrs.replace(/\st="[^"]*"/, '') + (t ? ` t="${t}"` : '');
      const f = inner.match(/<f\b[^>]*\/>|<f\b[^>]*>[\s\S]*?<\/f>/)[0];
      return `<c${a2}>${f}<v>${out}</v></c>`;
    }), 'utf8');
  }
  const val = (sheet, ref) => { if (!sheet) return null; try { const v = calc.value(sheet.name, ref); return v && typeof v === 'object' && 'error' in v ? null : v; } catch { return null; } };
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const results = {
    payback_years: n(val(S.cf, 'C39')), npv: n(val(S.cf, 'C41')), roi: n(val(S.cf, 'C43')), irr: n(val(S.cf, 'C45')),
    revenue: n(val(S.pl, 'O39')), margin: n(val(S.pl, 'O62')), ebit: n(val(S.pl, 'O77')), ebitda: n(val(S.pl, 'O79')),
    discount: n(val(S.kpi, 'C23')), tax: n(val(S.kpi, 'C22')), dso: n(val(S.kpi, 'C19')), dio: n(val(S.kpi, 'C20')), dpo: n(val(S.kpi, 'C21')),
    total_k: n(val(S.kpi, 'C17')),
  };
  // the rows the deck shows (labels as the model has them), by year
  const yearsShown = Math.min(10, Math.max(f.depYears + 1, 3));
  const rowsOf = (sheet, labelCol, firstCol, defs) => defs.map(([r, label]) => ({
    label: label || String(val(sheet, `${labelCol}${r}`) ?? '').trim(), row: r,
    values: Array.from({ length: yearsShown }, (_, k) => n(val(sheet, `${colLetters(firstCol + k)}${r}`)) || 0),
  }));
  const pl = rowsOf(S.pl, 'D', 5, [[17, 'Volume (thousands)'], [39, 'Revenue'], [41], [42], [43], [45], [46], [48], [50, 'Depreciation'], [60, 'Total cost of goods sold'], [62, 'Marginal contribution'],
    [71, 'S&M'], [72, 'G&A'], [73, 'Dedicated OPEX'], [74, 'Freight and import duties'], [75, 'Total OPEX'], [77, 'Contributive EBIT'], [79, 'Contributive EBITDA']])
    .filter((r, i, all) => [39, 60, 62, 75, 77, 79].includes(r.row) || r.values.some((v) => Math.abs(v) > 0.0005) || (r.row === 17 && all.length && f.growth.length));
  const cf = rowsOf(S.cf, 'B', 3, [[8, 'Total revenue'], [10, 'Contributive EBITDA'], [12, 'Depreciation & amortisation'], [14, 'Contributive EBIT'], [16, 'Tax on income'], [17, 'Net profit'],
    [29, 'Working capital variation'], [25, 'Cash-out (investment)'], [30, 'Yearly cash generated'], [32, 'Discounted cash'], [33, 'Cumulated discounted cash']]);
  for (const r of [...pl, ...cf]) r.total = r.values.reduce((t, v) => t + v, 0);
  for (const r of cf) if (r.row === 33) r.total = r.values[r.values.length - 1];
  results.tables = { years: Array.from({ length: yearsShown }, (_, k) => f.capYear + k), pl, cf };
  // the model's sheets as the IR slide groups them: Step 1's inputs and KPIs, the P&L over 10 years, the cash-out plan
  const lab = (sheet, col, r) => { const v = val(sheet, `${col}${r}`); return v === null || v === undefined ? '' : String(v).trim(); };
  results.summary = {
    title: lab(S.kpi, 'C', 8),
    initial: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 29].map((r) => ({ row: r, label: lab(S.kpi, 'B', r), value: val(S.kpi, `C${r}`) })).filter((x) => x.label),
    kpis: [31, 32, 33, 35, 36, 38, 39, 41, 43, 45, 47, 49].map((r) => ({ row: r, label: lab(S.kpi, 'B', r), value: r === 31 ? null : val(S.kpi, `C${r}`) })).filter((x) => x.label),
    years: Array.from({ length: 10 }, (_, k) => n(val(S.pl, `${colLetters(5 + k)}6`)) || f.capYear + k),
    pl: [17, 28, 39, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 58, 59, 60, 62, 63, 70, 71, 72, 73, 74, 75, 77, 79]
      .map((r) => ({ row: r, label: lab(S.pl, 'D', r), values: Array.from({ length: 10 }, (_, k) => n(val(S.pl, `${colLetters(5 + k)}${r}`))), total: n(val(S.pl, `O${r}`)) })),
    plan: { year: f.capYear, rows: Array.from({ length: 10 }, (_, k) => 9 + k).map((r) => ({ row: r, label: lab(S.plan, 'C', r),
      months: [0, 1, 2, 3].map((yi) => Array.from({ length: 12 }, (_, m) => n(val(S.plan, `${colLetters([3, 16, 29, 42][yi] + 1 + m)}${r}`)) || 0)) })) },
  };
  return { buf: zip(files), results, figures: f };
}

// ---- the IR deck ---------------------------------------------------------------------------------------
const EMU = 914400;
const esc = (s) => xmlEsc(String(s ?? ''));
// the shapes directly in a slide's shape tree, with where they are and their text
function shapesOf(xml) {
  const tree = xml.match(/<p:spTree>([\s\S]*)<\/p:spTree>/);
  if (!tree) return [];
  const base = tree.index + '<p:spTree>'.length; const body = tree[1];
  const out = []; const tags = ['p:sp', 'p:graphicFrame', 'p:pic', 'p:cxnSp', 'p:grpSp'];
  let i = 0;
  while (i < body.length) {
    const lt = body.indexOf('<p:', i); if (lt < 0) break;
    const name = body.slice(lt + 1).match(/^p:[A-Za-z]+/)[0];
    if (!tags.includes(name)) { const close = body.indexOf('>', lt); i = close + 1; continue; }
    // the element's end, counting nested elements of the same name
    const re = new RegExp(`<${name}(?=[\\s>/])[^>]*?(/?)>|</${name}>`, 'g'); re.lastIndex = lt;
    let depth = 0; let j = body.length; let m;
    while ((m = re.exec(body))) {
      if (m[0].startsWith('</')) { depth--; if (!depth) { j = m.index + m[0].length; break; } } else if (m[1] === '/') { if (!depth) { j = m.index + m[0].length; break; } } else depth++;
    }
    const sx = body.slice(lt, j);
    const off = sx.match(/<a:off x="(-?\d+)" y="(-?\d+)"\/>/); const ext = sx.match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    out.push({ kind: name, xml: sx, start: base + lt, end: base + j, id: Number(sx.match(/<p:cNvPr\b[^>]*\sid="(\d+)"/)?.[1] || 0), name: sx.match(/<p:cNvPr\b[^>]*\sname="([^"]*)"/)?.[1] || '',
      x: off ? Number(off[1]) : null, y: off ? Number(off[2]) : null, w: ext ? Number(ext[1]) : null, h: ext ? Number(ext[2]) : null,
      ph: sx.match(/<p:ph\b[^>]*?type="([^"]+)"/)?.[1] || (/<p:ph\b/.test(sx) ? 'body' : ''),
      text: [...sx.matchAll(/<a:p>[\s\S]*?<\/a:p>|<a:p\b[^>]*>[\s\S]*?<\/a:p>/g)].map((p) => [...p[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('')).filter(Boolean).join(' / ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'") });
    i = j;
  }
  return out;
}
// a run's properties from a paragraph: its first run's, else its end-of-paragraph ones, else a plain dark one
function runProps(pXml, { dark = false, sz } = {}) {
  let rPr = pXml.match(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/)?.[0];
  if (!rPr) { const e = pXml.match(/<a:endParaRPr\b([^>]*)(\/>|>([\s\S]*?)<\/a:endParaRPr>)/); if (e) rPr = e[2] === '/>' ? `<a:rPr${e[1]}/>` : `<a:rPr${e[1]}>${e[3]}</a:rPr>`; }
  if (!rPr) rPr = '<a:rPr lang="en-GB" dirty="0"/>';
  if (dark && !/<a:solidFill>/.test(rPr)) rPr = rPr.replace(/<a:rPr\b([^>]*?)\/>/, '<a:rPr$1></a:rPr>').replace(/<\/a:rPr>$/, '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:rPr>');
  if (sz) rPr = rPr.replace(/\ssz="\d+"/, '').replace(/^<a:rPr\b/, `<a:rPr sz="${sz}"`);
  return rPr;
}
// paragraphs of text (lines; a line may be { text, bold }) in a text body, styled as its first (or given) paragraph
function bodyWith(txBody, lines, { keepFirst = false, dark = false, sz, noBullet = false } = {}) {
  const paras = txBody.match(/<a:p>[\s\S]*?<\/a:p>|<a:p\b[^>]*>[\s\S]*?<\/a:p>|<a:p\/>/g) || [];
  const tplP = (keepFirst ? paras[1] : paras[0]) || paras[0] || '<a:p></a:p>';
  let pPr = tplP.match(/<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/)?.[0] || '';
  if (noBullet) { // a table cell: plain text, whatever bullets the example had
    pPr = pPr.replace(/<a:bu(?:Font|Char|AutoNum|Clr|ClrTx|SzPct|SzPts|SzTx|FontTx|Blip|None)\b[^>]*?(?:\/>|>[\s\S]*?<\/a:bu\w+>)/g, '').replace(/\s(marL|indent)="[^"]*"/g, '');
    pPr = !pPr ? '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>' : /\/>$/.test(pPr) ? pPr.replace(/^<a:pPr\b/, '<a:pPr marL="0" indent="0"').replace(/\/>$/, '><a:buNone/></a:pPr>') : pPr.replace(/^<a:pPr\b/, '<a:pPr marL="0" indent="0"').replace(/<\/a:pPr>$/, '<a:buNone/></a:pPr>');
  }
  const rPr = runProps(tplP, { dark, sz });
  const one = (l) => {
    const t = typeof l === 'object' && l ? l : { text: l };
    let r = rPr; if (t.bold) r = r.replace(/\sb="[01]"/, '').replace(/^<a:rPr\b/, '<a:rPr b="1"');
    return `<a:p>${pPr}${String(t.text ?? '') === '' ? `${r.replace(/^<a:rPr/, '<a:endParaRPr').replace(/<\/a:rPr>$/, '</a:endParaRPr>')}` : `<a:r>${r}<a:t>${esc(t.text)}</a:t></a:r>`}</a:p>`;
  };
  const head = txBody.match(/^<(p|a):txBody>([\s\S]*?)(?=<a:p[\s>/])/);
  const pre = head ? head[0] : txBody.replace(/<a:p[\s\S]*$/, '');
  const tag = txBody.startsWith('<p:') ? 'p:txBody' : 'a:txBody';
  return `${pre}${keepFirst && paras[0] ? paras[0] : ''}${(lines.length ? lines : ['']).map(one).join('')}</${tag}>`;
}
function setText(shXml, lines, opts = {}) {
  const tb = shXml.match(/<p:txBody>[\s\S]*<\/p:txBody>/);
  if (!tb) return shXml.replace(/<\/p:spPr>/, `</p:spPr><p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/>${bodyWith('<a:txBody><a:p></a:p></a:txBody>', lines, { dark: true, ...opts }).replace(/^<a:txBody>|<\/a:txBody>$/g, '')}</p:txBody>`);
  return shXml.replace(tb[0], bodyWith(tb[0], lines, { dark: true, ...opts }));
}
// each paragraph's text changed in place (fn(text, i) → new text, or undefined to keep it), keeping its formatting
function editParas(shXml, fn) {
  let i = -1;
  return shXml.replace(/<a:p>[\s\S]*?<\/a:p>|<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (p) => {
    i++;
    const text = [...p.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const nt = fn(text, i); if (nt === undefined || nt === text) return p;
    const rPr = runProps(p); const open = p.match(/^<a:p\b[^>]*>/)[0]; const pPr = p.match(/<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/)?.[0] || '';
    return `${open}${pPr}<a:r>${rPr}<a:t>${esc(nt)}</a:t></a:r></a:p>`;
  });
}
function setFill(shXml, hex) {
  return shXml.replace(/<p:spPr>([\s\S]*?)<\/p:spPr>/, (w, inner) => {
    const cleaned = inner.replace(/<a:noFill\/>|<a:solidFill>[\s\S]*?<\/a:solidFill>(?=\s*(<a:ln\b|$))|<a:gradFill[\s\S]*?<\/a:gradFill>/, '');
    const at = cleaned.search(/<a:ln\b|<a:effectLst|$/);
    return `<p:spPr>${cleaned.slice(0, at)}<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>${cleaned.slice(at)}</p:spPr>`;
  });
}
function setGeom(shXml, { x, y, w, h }) {
  const has = /<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/.test(shXml.match(/<p:spPr>[\s\S]*?<\/p:spPr>|<p:spPr\/>/)?.[0] || '');
  const xfrm = `<a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm>`;
  if (has) return shXml.replace(/(<p:spPr\b[^>]*>[\s\S]*?)<a:xfrm\b[^>]*>[\s\S]*?<\/a:xfrm>/, `$1${xfrm}`);
  return shXml.replace(/<p:spPr\/>/, `<p:spPr>${xfrm}</p:spPr>`).replace(/<p:spPr>(?!<a:xfrm)/, `<p:spPr>${xfrm}`);
}
// a table's rows and cells (in a graphicFrame), to fill in place
function tableRows(frameXml) {
  return [...frameXml.matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)].map((m) => ({ xml: m[0], cells: [...m[0].matchAll(/<a:tc\b[^>]*?(?:\/>|>[\s\S]*?<\/a:tc>)/g)].map((c) => c[0]) }));
}
function cellWith(tcXml, text, { bold, fill, sz } = {}) {
  let out = tcXml;
  const tb = out.match(/<a:txBody>[\s\S]*?<\/a:txBody>/);
  const lines = String(text ?? '').split('\n');
  const body = bodyWith(tb ? tb[0] : '<a:txBody><a:bodyPr/><a:lstStyle/><a:p></a:p></a:txBody>', lines.map((t) => ({ text: t, bold })), { sz, noBullet: true });
  out = tb ? out.replace(tb[0], body) : out.replace(/^<a:tc\b([^>]*?)(\/?)>/, (w, a) => `<a:tc${a}>${body}`).replace(/<a:tc\b([^>]*?)\/>$/, '');
  if (fill) {
    const fillXml = `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>`;
    if (/<a:tcPr\b[^>]*\/>/.test(out)) out = out.replace(/<a:tcPr\b([^>]*)\/>/, `<a:tcPr$1>${fillXml}</a:tcPr>`);
    else if (/<a:tcPr\b/.test(out)) out = out.replace(/(<a:tcPr\b[^>]*>)([\s\S]*?)<\/a:tcPr>/, (w, open, inner) => `${open}${inner.replace(/<a:noFill\/>|<a:solidFill>[\s\S]*?<\/a:solidFill>/, '')}${fillXml}</a:tcPr>`);
    else out = out.replace(/<\/a:tc>$/, `<a:tcPr>${fillXml}</a:tcPr></a:tc>`);
  }
  return out;
}
// fill a table: values[r][c] (undefined leaves a cell as it is)
function fillTable(frameXml, values, opts = {}) {
  let out = frameXml;
  tableRows(frameXml).forEach((row, r) => {
    if (!values[r]) return;
    let rx = row.xml;
    row.cells.forEach((tc, c) => { const v = values[r][c]; if (v === undefined) return; rx = rx.replace(tc, cellWith(tc, v && typeof v === 'object' ? v.t : v, { ...opts, ...(v && typeof v === 'object' ? v : {}) })); });
    out = out.replace(row.xml, rx);
  });
  return out;
}
// A new table (SITHUB's own, in the deck's colours): rows of cells { t, b, fill, color, align }
const BRAND = '430099'; const LIGHT = 'EDE7F6'; const LINE = 'C9C2DC'; const TEAL = '32B4B4'; const INPUT = 'DDF3F3';
function newTable({ id, name, x, y, w, h, widths, rows, sz = 700, dense = false }) {
  const total = widths.reduce((t, v) => t + v, 0); const cols = widths.map((v) => Math.round((v / total) * w));
  const rh = Math.max(dense ? 60000 : 150000, Math.round(h / Math.max(rows.length, 1)));
  const mar = dense ? 'marL="27432" marR="27432" marT="0" marB="0"' : 'marL="45720" marR="45720" marT="18288" marB="18288"';
  const border = (side) => `<a:${side} w="6350"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:${side}>`;
  const tc = (c) => {
    const cell = typeof c === 'object' && c ? c : { t: c };
    const color = cell.color || ([BRAND, TEAL].includes(cell.fill) ? 'FFFFFF' : '1D1B2E');
    const paras = String(cell.t ?? '').split('\n').map((t) => `<a:p><a:pPr algn="${cell.align || 'l'}"/>${t === '' ? `<a:endParaRPr lang="en-GB" sz="${sz}" dirty="0"/>` : `<a:r><a:rPr lang="en-GB" sz="${cell.sz || sz}"${cell.b ? ' b="1"' : ''} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${esc(t)}</a:t></a:r>`}</a:p>`).join('');
    return `<a:tc${cell.span > 1 ? ` gridSpan="${cell.span}"` : ''}${cell.merged ? ' hMerge="1"' : ''}><a:txBody><a:bodyPr/><a:lstStyle/>${paras}</a:txBody><a:tcPr ${mar} anchor="ctr">${border('lnL')}${border('lnR')}${border('lnT')}${border('lnB')}${cell.fill ? `<a:solidFill><a:srgbClr val="${cell.fill}"/></a:solidFill>` : '<a:noFill/>'}</a:tcPr></a:tc>`;
  };
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(w)}" cy="${rh * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">`
    + `<a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${cols.map((cw) => `<a:gridCol w="${cw}"/>`).join('')}</a:tblGrid>`
    + rows.map((r) => `<a:tr h="${rh}">${r.map(tc).join('')}</a:tr>`).join('')
    + '</a:tbl></a:graphicData></a:graphic></p:graphicFrame>';
}

// numbers as the deck shows them
const kOf = (v, dp) => { if (v === null || v === undefined || !Number.isFinite(v)) return '–'; const a = Math.abs(v); const d = dp ?? (a >= 100 ? 0 : a >= 10 ? 1 : a === 0 ? 0 : 1); return v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d }); };
const kU = (units) => kOf(units === null || units === undefined ? null : units / 1000); // units → k
const pct = (v) => (v === null || v === undefined ? '–' : `${(v * 100).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (k) => `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
const dateLabel = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

// The checklist (slides 2–3): its questions, read from the deck itself, and which apply to a justification
function checklistOf(tpl) {
  const files = readZip(tpl);
  const out = [];
  for (const s of slidesOf(files)) {
    if (!/check\s*list/i.test(s.title)) continue;
    for (const sh of shapesOf(s.xml).filter((x) => x.kind === 'p:graphicFrame' && /<a:tbl>/.test(x.xml))) {
      const rows = tableRows(sh.xml).map((r) => r.cells.map((c) => [...c.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join('').replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').trim()));
      const head = rows[0] || []; const iNo = head.findIndex((h) => h === '#'); const iQ = head.findIndex((h) => /question/i.test(h)); const iCat = head.findIndex((h) => /mandatory|category/i.test(h));
      if (iNo < 0 || iQ < 0) continue;
      for (const r of rows.slice(1)) { const n = Number(r[iNo]); if (!n) continue; out.push({ n, topic: r[0] || '', question: r[iQ] || '', for: iCat >= 0 ? r[iCat] || 'All' : 'All' }); }
    }
  }
  return out;
}
// does a checklist line ("All", "Replacement / Obsolete", "Capacity Improvement / productivity", …) apply to this justification?
function applies(forText, justif) {
  const t = String(forText || 'All').toLowerCase();
  if (!t || /\ball\b/.test(t)) return true;
  if (!justif) return true;
  const j = justif.toLowerCase();
  return (/replac|obsol/.test(t) && /replac|obsol/.test(j)) || (/capacity/.test(t) && /growth|capacity/.test(j)) || (/improvement|productiv/.test(t) && /improvement|productiv/.test(j)) || (/complian/.test(t) && /complian/.test(j)) || (/footprint|strateg/.test(t) && /footprint|strateg/.test(j));
}
// the answers SITHUB can tell from the data (by question number), where none is given
function autoAnswers(f) {
  const { ir } = f; const a = {};
  const set = (n, ans, why) => { a[n] = { a: ans, auto: true, why }; };
  if (ir.budgeted) set(3, ir.budgeted, 'from Budgeted?');
  if (ir.milestones.po && ir.milestones.delivery && ir.milestones.sop) set(7, 'yes', 'milestones set');
  if (f.items.some((i) => i.initial && i.amount !== null && i.initial > i.amount)) set(11, 'yes', 'a negotiated price below the initial quote');
  if (ir.quotes.filter((q) => q.supplier).length >= 3) set(12, 'yes', '3 quotes');
  if (ir.freight_mode) set(13, ir.freight_mode === 'sea' ? 'yes' : 'no', `${ir.freight_mode === 'sea' ? 'sea' : 'air'} freight chosen`);
  if (f.opexItems.some((i) => /licen|training/i.test(i.name))) set(14, 'yes', 'licences or training in the associated expenses');
  if (ir.items.length && ir.items.every((i) => Object.keys(i.cashout).length)) set(22, 'yes', 'cash-out phased');
  if (ir.reasons.filter(Boolean).length >= 3) set(25, 'yes', '3 reasons');
  if (ir.risks.filter(Boolean).length >= 3) set(26, 'yes', '3 consequences');
  if (Object.keys(ir.savings).length) set(40, 'yes', 'savings by line');
  return a;
}

// the slides in order, with their titles
function slidesOf(files) {
  const pres = files['ppt/presentation.xml']?.toString('utf8') || '';
  const rels = files['ppt/_rels/presentation.xml.rels']?.toString('utf8') || '';
  const target = (id) => rels.match(new RegExp(`<Relationship\\b(?=[^>]*\\sId="${id}")[^>]*\\sTarget="([^"]+)"`))?.[1];
  return [...pres.matchAll(/<p:sldId\b[^>]*\sr:id="([^"]+)"/g)].map((m, i) => {
    const t = target(m[1]); if (!t) return null;
    const path = `ppt/${t.replace(/^\.?\//, '').replace(/^\/ppt\//, '')}`;
    const xml = files[path]?.toString('utf8'); if (!xml) return null;
    const title = shapesOf(xml).find((s) => /^(title|ctrTitle)$/.test(s.ph))?.text || '';
    return { n: i + 1, path, xml, title };
  }).filter(Boolean);
}

// The deck filled in. model: fillModel()'s result (for the financial slides), or null.
function fillDeck(tpl, x, { figures: f0, model = null, today = new Date(), quote = null } = {}) {
  const f = f0 || figures(x, { today });
  const { ir } = f; const files = readZip(tpl); const notes = [];
  const R = model?.results || null;
  const cur = f.sym; const kc = `k${cur}`;
  const answers = { ...autoAnswers(f), ...Object.fromEntries(Object.entries(ir.checklist).filter(([, v]) => v.a)) };
  const thisYear = today.getUTCFullYear();
  const cashByMonth = {}; for (const i of f.capexItems) for (const [m, v] of Object.entries(i.cashout)) cashByMonth[m] = (cashByMonth[m] || 0) + v;
  const paybackMonths = R?.payback_years !== null && R?.payback_years !== undefined ? Math.round(R.payback_years * 12) : (x.payback_months ?? null);

  let unified = false; const drop = []; const hidden = [];
  for (const s of slidesOf(files)) {
    let xml = s.xml; const t = s.title;
    let shapes = shapesOf(xml);
    const by = (fn) => shapes.find(fn);
    // (by its id: a shape found before an earlier change has moved in the XML since)
    const replace = (sh, nx) => { const now = (sh.id && shapes.find((z) => z.id === sh.id && z.kind === sh.kind)) || sh; xml = xml.slice(0, now.start) + nx + xml.slice(now.end); shapes = shapesOf(xml); };
    const remove = (sh) => replace(sh, '');
    const nextId = () => Math.max(0, ...[...xml.matchAll(/<p:cNvPr\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
    const insert = (frameXml) => { xml = xml.replace(/<\/p:spTree>/, `${frameXml}</p:spTree>`); shapes = shapesOf(xml); };
    const dropExample = () => { for (;;) { const e = by((sh) => sh.text.trim() === 'Example'); if (!e) break; remove(e); } };
    const tables = () => shapes.filter((sh) => sh.kind === 'p:graphicFrame' && /<a:tbl>/.test(sh.xml));

    if (/^investment committee/i.test(t)) {
      const sub = by((sh) => /project name/i.test(sh.text));
      if (sub) replace(sub, setText(sub.xml, [`Project name : ${x.ref ? `${x.ref} ` : ''}${x.title}`, `IR n° : ${ir.ir_number || ''}`], { dark: false }));
    } else if (/check\s*list/i.test(t)) {
      for (const tb of tables()) {
        const rows = tableRows(tb.xml); const head = rows[0]?.cells.map((c) => [...c.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('')) || [];
        const iNo = head.findIndex((h) => h.trim() === '#'); const iCat = head.findIndex((h) => /mandatory|category/i.test(h)); if (iNo < 0) continue;
        const values = rows.map((r, ri) => {
          if (!ri) return null;
          const txt = r.cells.map((c) => [...c.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(''));
          const n = Number(txt[iNo]); if (!n) return null;
          const out = []; const last = r.cells.length - 1;
          const ans = answers[n];
          if (ans?.a) out[last] = `${ANSWERS[ans.a]}${ir.checklist[n]?.note ? ` – ${ir.checklist[n].note}` : ''}`;
          else if (iCat >= 0 && !applies(txt[iCat].replace(/&amp;/g, '&'), f.justif)) out[last] = 'N/A'; // not asked for this kind of investment
          return out;
        });
        replace(tb, fillTable(tb.xml, values));
      }
    } else if (/^executive summary/i.test(t)) {
      // tick the nature and the justification: the small box left of each label
      const tick = (label) => {
        const lab = by((sh) => sh.kind === 'p:sp' && sh.text.trim().toLowerCase() === label.toLowerCase()); if (!lab) return;
        const box = shapes.filter((sh) => sh.kind === 'p:sp' && !sh.text && sh.w && sh.w < 0.3 * EMU && Math.abs((sh.y + sh.h / 2) - (lab.y + lab.h / 2)) < 0.15 * EMU && sh.x < lab.x + 0.05 * EMU)
          .sort((a, b) => b.x - a.x)[0];
        if (box) replace(box, setText(setFill(box.xml, BRAND), [{ text: '✔', bold: true }], { sz: 700 }).replace(/<a:solidFill><a:schemeClr val="tx1"\/><\/a:solidFill><\/a:rPr>/, '<a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:rPr>'));
      };
      tick(f.nature);
      const jl = { 'Replacement / Obsolescence': 'Replacement / Obsolescence', 'Strategic footprint': 'Strategic Footprint', 'Growth / Capacity increase': 'Growth / Capacity increase', Compliance: 'Compliance' }[f.justif];
      if (jl) tick(jl);
      else if (f.justif) notes.push(`The executive summary has no box for "${f.justif}": none ticked.`);
      // site and budgeted: the frame the label sits in
      const frameOf = (label) => { const lab = by((sh) => sh.text.trim().toLowerCase().startsWith(label)); if (!lab) return null; return shapes.filter((sh) => sh !== lab && sh.kind === 'p:sp' && Math.abs(sh.y - lab.y) < 0.05 * EMU && Math.abs(sh.x - lab.x) < 0.05 * EMU && sh.w > lab.w).sort((a, b) => b.w - a.w)[0] || null; };
      const site = frameOf('site'); if (site && ir.site) replace(site, setText(site.xml, [ir.site], { sz: 1000 }));
      const yn = by((sh) => /^yes or no/i.test(sh.text.trim())) || frameOf('is this investment budgeted');
      if (yn && ir.budgeted) replace(yn, setText(yn.xml, [ir.budgeted === 'yes' ? 'Yes' : 'No'], { sz: 1000 }));
      // the milestones: the box under each label
      const under = (re, date) => {
        const lab = by((sh) => re.test(sh.text)); if (!lab || !date) return;
        const box = shapes.filter((sh) => sh.kind === 'p:sp' && !sh.text && sh.y > lab.y + lab.h * 0.8 && Math.abs((sh.x + sh.w / 2) - (lab.x + lab.w / 2)) < 0.4 * EMU && sh.h < 0.4 * EMU && sh.w > 0.4 * EMU).sort((a, b) => a.y - b.y)[0];
        if (box) replace(box, setText(box.xml, [dateLabel(date)], { sz: 900 }));
      };
      under(/1st po target/i, ir.milestones.po); under(/1st equipment delivery/i, ir.milestones.delivery); under(/1st production target/i, ir.milestones.sop);
      // the tables: items, financials vs budget, final cash-out planning
      for (const tb of tables()) {
        const rows = tableRows(tb.xml); const head = rows[0]?.cells.map((c) => [...c.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ')) || [];
        if (/^items$/i.test(head[0]?.trim())) {
          const room = rows.length - 1; let shown = f.capexItems.map((i) => [i.name, kU(i.amount)]);
          if (shown.length > room) { const rest = f.capexItems.slice(room - 1); shown = [...shown.slice(0, room - 1), [`Other (${rest.length} items)`, kU(rest.reduce((a, i) => a + (i.amount || 0), 0))]]; }
          replace(tb, fillTable(tb.xml, [[undefined, `Quotation (${kc})`], ...shown]));
        } else if (head.some((h) => /investment request/i.test(h))) {
          const thisYearCash = Object.entries(cashByMonth).filter(([m]) => Number(m.slice(0, 4)) === thisYear).reduce((a, [, v]) => a + v, 0);
          const b = ir.budget;
          const lab = (r) => rows[r]?.cells.map((c) => [...c.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(' ').trim()) || [];
          const vals = rows.map((r, ri) => {
            const l = lab(ri).join(' ').toLowerCase(); const last = r.cells.length;
            const put = (req, bud) => { const o = []; o[last - 2] = req; o[last - 1] = bud; return o; };
            if (/commitment/.test(l)) return put(kU(f.capex), b.capex !== null ? kU(b.capex) : '');
            if (/cash-out this year|cash-out/.test(l)) return put(kU(thisYearCash), b.cashout_year !== null ? kU(b.cashout_year) : '');
            if (/opex/.test(l)) return put(kU(f.opex), b.opex !== null ? kU(b.opex) : '');
            if (/payback/.test(l)) return put(paybackMonths !== null ? String(paybackMonths) : '–', b.payback !== null ? String(b.payback) : '');
            if (/roi/.test(l)) return put(R?.roi !== null && R?.roi !== undefined ? pct(R.roi) : '–', b.roi !== null ? `${b.roi}%` : '');
            return null;
          });
          replace(tb, fillTable(tb.xml, vals));
        } else if (head.filter((h) => /^(jan|feb|mar)/i.test(h.trim())).length >= 2) {
          // months Jan… of the first year with cash-out, then the next year's, with totals
          const y1 = f.allMonths.length ? Number(f.allMonths[0].slice(0, 4)) : thisYear; let y = y1; let prevJan = false; let sumY = 0; let all = 0;
          const top = []; const bottom = [];
          head.forEach((h, c) => {
            const hm = MONTHS.findIndex((m) => h.trim().toLowerCase().startsWith(m.toLowerCase()));
            if (hm >= 0) { if (hm === 0 && prevJan) y++; prevJan = true; const v = cashByMonth[`${y}-${String(hm + 1).padStart(2, '0')}`] || 0; sumY += v; all += v; bottom[c] = kU(v); return; }
            if (/^total\s*\d{4}/i.test(h.trim())) { top[c] = `Total ${y}`; bottom[c] = kU(sumY); sumY = 0; return; }
            if (/^total$/i.test(h.trim())) { bottom[c] = kU(all); }
          });
          replace(tb, fillTable(tb.xml, [top, bottom]));
          const later = Object.entries(cashByMonth).filter(([m]) => Number(m.slice(0, 4)) > y).reduce((a, [, v]) => a + v, 0);
          if (later) notes.push(`The executive summary's cash-out shows ${y1}–${y}: ${kU(later)} ${kc} after that isn't on it (it is in the model).`);
        }
      }
    } else if (/description\s*&\s*justification/i.test(t)) {
      dropExample();
      const detail = by((sh) => /^xxx/i.test(sh.text.trim()));
      const det = (ir.detail || x.description || '').split('\n').filter((l) => l.trim());
      if (detail && det.length) replace(detail, setText(detail.xml, det));
      const box = (re) => { const lab = by((sh) => re.test(sh.text)); if (!lab) return null; return shapes.filter((sh) => sh !== lab && sh.kind === 'p:sp' && sh.y >= lab.y + lab.h * 0.5 && Math.abs(sh.x - lab.x) < 0.1 * EMU && sh.h > lab.h).sort((a, b) => a.y - b.y)[0]; };
      const why = ir.reasons.filter(Boolean).length ? ir.reasons.filter(Boolean) : String(x.justification || '').split('\n').filter((l) => l.trim());
      const risk = ir.risks.filter(Boolean).length ? ir.risks.filter(Boolean) : String(x.risk_if_not || '').split('\n').filter((l) => l.trim());
      const w = box(/why would we invest/i); if (w) replace(w, setText(w.xml, why.length ? why : ['']));
      const r = box(/risks of not investing/i); if (r) replace(r, setText(r.xml, risk.length ? risk : ['']));
    } else if (/^business assumptions/i.test(t) && f.growth.length) {
      const tb = tables()[0];
      if (tb) {
        const vol = (g) => Object.values(g.volumes).reduce((a, v) => a + v, 0);
        const first = (g) => Object.keys(g.volumes).sort()[0] || '';
        const rows = tableRows(tb.xml);
        const vals = rows.map((r, ri) => {
          if (!ri) return null; const lbl = [...r.cells[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join('');
          if (/total/i.test(lbl)) return [undefined, `${kOf(f.growth.reduce((a, g) => a + vol(g), 0))} k units`];
          const g = f.growth[ri - 2]; if (!g) return null;
          return [`Customer ${ri - 1} : ${g.customer}`, `${kOf(vol(g))} k units`, g.asp !== null ? `${g.asp} ${cur}` : '', undefined, first(g) ? `From ${first(g)}` : ''];
        });
        replace(tb, fillTable(tb.xml, vals));
      }
    } else if (/^planning$/i.test(t)) {
      // the steps by month, drawn as a table (the template's arrows and stars are an example)
      const old = tables()[0];
      const ms = ir.milestones;
      const dates = Object.entries(ms).filter(([, d]) => d);
      if (old && dates.length) {
        const area = { x: old.x, y: old.y, w: old.w, h: old.h };
        const drop = shapes.filter((sh) => sh.y !== null && sh.y >= area.y - 0.02 * EMU && sh.y < area.y + area.h && !/<p:ph\b/.test(sh.xml)).map((sh) => sh.id);
        for (const id of drop) { const cur2 = shapes.find((z) => z.id === id); if (cur2) remove(cur2); }
        dropExample();
        const start = ym((x.created_at || '').slice(0, 10)) || dates.map(([, d]) => d.slice(0, 7)).sort()[0];
        const last = dates.map(([, d]) => d.slice(0, 7)).sort().pop();
        let first = [start, ...dates.map(([, d]) => d.slice(0, 7))].sort()[0];
        let span = monthsBetween(first, last) + 2; const quarterly = span > 18;
        if (quarterly) { first = `${first.slice(0, 4)}-${String(Math.floor((Number(first.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}`; span = Math.ceil((monthsBetween(first, last) + 1) / 3); }
        const cols = Array.from({ length: span }, (_, k) => monthAdd(first, quarterly ? k * 3 : k));
        const idx = (d) => { if (!d) return -1; const m = d.slice(0, 7); const k = monthsBetween(first, m); return quarterly ? Math.floor(k / 3) : k; };
        const header = [{ t: 'Steps', b: true, fill: BRAND }, ...cols.map((c) => ({ t: quarterly ? `Q${Math.floor((Number(c.slice(5, 7)) - 1) / 3) + 1} ${c.slice(2, 4)}` : monthLabel(c), b: true, fill: BRAND, align: 'ctr' }))];
        const lineOf = (label, from, to, stars) => {
          const cells = cols.map(() => ({ t: '', align: 'ctr' }));
          const a = from ? Math.max(0, idx(from)) : Infinity; const b = idx(to);
          if (b >= 0) for (let k = a; k <= Math.min(b, cells.length - 1); k++) cells[k].fill = LIGHT;
          for (const [key, txt] of stars) { const k = idx(ms[key]); if (k >= 0 && k < cells.length) { cells[k].t = cells[k].t ? `${cells[k].t}\n★ ${txt}` : `★ ${txt}`; cells[k].fill = 'D9CCF0'; cells[k].b = true; } }
          return [{ t: label, b: true }, ...cells];
        };
        const rows = [header,
          lineOf('Investment & purchasing process', `${start}-01`, ms.po || ms.investco, [['investco', 'InvestCo'], ['po', 'PO']]),
          lineOf('Delivery process', ms.po ? `${monthAdd(ms.po.slice(0, 7), 1)}-01` : ms.fat || ms.delivery, ms.sop || ms.sat || ms.delivery, [['fat', 'FAT'], ['delivery', 'Delivery'], ['sat', 'SAT'], ['sop', 'Start of production']])];
        const id = nextId();
        insert(newTable({ id, name: 'SITHUB planning', ...area, widths: [2.2, ...cols.map(() => 1)], rows, sz: 700 }));
      }
      const com = by((sh) => /^xxxx/i.test(sh.text.trim()));
      const keyDates = Object.entries(MILESTONES).filter(([k]) => ms[k]).map(([k, l]) => `${l}: ${dateLabel(ms[k])}`).join(' · ');
      if (com) replace(com, setText(com.xml, ir.planning_comments ? ir.planning_comments.split('\n') : keyDates ? [`Key dates: ${keyDates}`] : ['']));
    } else if (/^supplier selection/i.test(t)) {
      const [sup, freight] = [tables().find((tb) => /purchase price/i.test(tb.xml.replace(/<[^>]+>/g, ''))), tables().find((tb) => /freight/i.test(tb.xml.replace(/<[^>]+>/g, '')))];
      const quotes = ir.quotes.filter((q) => q.supplier || q.price);
      if (sup && quotes.length) {
        const rows = tableRows(sup.xml);
        const vals = rows.map((r, ri) => { if (!ri) return [undefined, `Purchase Price (${kc})`]; const q = quotes[ri - 1]; if (!q) return null; return [{ t: q.supplier || `Supplier #${ri}`, bold: q.selected }, { t: kU(q.price), bold: q.selected }, { t: q.comment, bold: q.selected }]; });
        replace(sup, fillTable(sup.xml, vals));
        // the highlight frame onto the selected supplier's row
        const sel = quotes.findIndex((q) => q.selected);
        const tb2 = tables().find((tb) => tb.id === sup.id);
        const hl = shapes.find((sh) => sh.kind === 'p:sp' && !sh.text && sh.w && Math.abs(sh.x - tb2.x) < 0.1 * EMU && Math.abs(sh.w - tb2.w) < 0.1 * EMU && sh.y > tb2.y && sh.y < tb2.y + tb2.h);
        if (hl) {
          if (sel < 0) remove(hl);
          else { const hs = tableRows(tb2.xml).map((r) => Number(r.xml.match(/<a:tr\b[^>]*\sh="(\d+)"/)?.[1] || 0)); const y = tb2.y + hs.slice(0, sel + 1).reduce((a, v) => a + v, 0); replace(hl, setGeom(hl.xml, { x: hl.x, y, w: hl.w, h: hs[sel + 1] || hl.h })); }
        }
      }
      const reason = by((sh) => /^selection justification/i.test(sh.text.trim()));
      if (reason && ir.selection_reason) replace(reason, setText(reason.xml, ir.selection_reason.split('\n'), { keepFirst: true }));
      if (freight && (ir.freight.sea.price !== null || ir.freight.air.price !== null || ir.freight.sea.lead || ir.freight.air.lead)) {
        const rows = tableRows(freight.xml);
        const vals = rows.map((r, ri) => { const lbl = [...r.cells[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(''); const k = /sea/i.test(lbl) ? 'sea' : /air/i.test(lbl) ? 'air' : null; if (!ri || !k) return null; const v = ir.freight[k];
          const bold = ir.freight_mode === k; return [{ t: lbl, bold }, { t: v.co2, bold }, { t: v.lead, bold }, { t: v.price !== null ? `${kU(v.price)} ${kc}` : '', bold }]; });
        replace(freight, fillTable(freight.xml, vals));
      }
      // the chosen supplier's quote, in the box left for its screenshot, as large as fits
      const qbox = by((sh) => /insert quotation/i.test(sh.text));
      if (qbox && quote?.buf) {
        const size = imageSize(quote.buf);
        if (size) {
          const pad = 0.06 * EMU; const bw = qbox.w - 2 * pad; const bh = qbox.h - 2 * pad; const k = Math.min(bw / size.w, bh / size.h);
          const w = size.w * k; const h = size.h * k;
          const rid = addMedia(files, s.path, quote.buf, size.ext);
          replace(qbox, setText(qbox.xml, ['']));
          insert(`<p:pic><p:nvPicPr><p:cNvPr id="${nextId()}" name="SITHUB quote" descr="The chosen supplier's quote"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${Math.round(qbox.x + pad + (bw - w) / 2)}" y="${Math.round(qbox.y + pad + (bh - h) / 2)}"/><a:ext cx="${Math.round(w)}" cy="${Math.round(h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`);
        }
      }
      const fr = by((sh) => /^sea freight should be selected/i.test(sh.text.trim()));
      if (fr && ir.freight_mode === 'air' && ir.freight_reason) replace(fr, setText(fr.xml, [`Air freight: ${ir.freight_reason}`]));
    } else if (/^purchasing negotiation/i.test(t)) {
      const neg = f.capexItems.filter((i) => i.initial);
      const tb = tables()[0];
      if (tb && neg.length) {
        const rows = tableRows(tb.xml); const body = rows.length - 2;
        let shown = neg.map((i) => [i.name, kU(i.initial), kU(i.amount), i.supplier]);
        if (shown.length > body) { const rest = neg.slice(body - 1); shown = [...shown.slice(0, body - 1), [`Other (${rest.length} items)`, kU(rest.reduce((a, i) => a + i.initial, 0)), kU(rest.reduce((a, i) => a + (i.amount || 0), 0)), '']]; }
        const vals = rows.map((r, ri) => { if (!ri) return [undefined, `Initial Cost (${kc})`, `Post-negotiation quote (${kc})`]; if (ri === rows.length - 1) return [undefined, kU(neg.reduce((a, i) => a + i.initial, 0)), kU(neg.reduce((a, i) => a + (i.amount || 0), 0)), '']; return shown[ri - 1] || null; });
        replace(tb, fillTable(tb.xml, vals));
      }
      const sub = by((sh) => /purchaser name/i.test(sh.text));
      const N = ir.negotiation;
      if (sub && (N.purchaser || N.explanation || N.conditions || N.gains)) {
        replace(sub, editParas(sub.xml, (txt) => {
          if (/^purchaser name/i.test(txt)) return `Purchaser name: ${N.purchaser}`;
          if (/^explanation/i.test(txt)) return N.explanation ? `Explanation: ${N.explanation}` : undefined;
          if (/conditions related to the negotiation/i.test(txt)) return N.conditions ? `Conditions related to the negotiation: ${N.conditions}` : undefined;
          if (/other gains/i.test(txt)) return N.gains ? `Other gains from the negotiation: ${N.gains}` : undefined;
          return undefined;
        }));
      }
    } else if (/^financial kpi/i.test(t) && R?.summary) {
      // 📑 one slide in place of the four: the model's Step 1, P&L and cash-out plan side by side (as the screenshots
      // of the model usually are); the other three go
      if (unified) { drop.push(s.path); continue; }
      unified = true;
      for (const sh of [...shapes]) if (!/^(title|dt|ftr|sldNum)$/.test(sh.ph)) { const now = shapes.find((z) => z.id === sh.id); if (now) remove(now); }
      const title = by((sh) => sh.ph === 'title');
      if (title) replace(title, setGeom(setText(title.xml, ['IR'], { dark: false }), { x: 0.26 * EMU, y: 0.12 * EMU, w: 3.6 * EMU, h: 0.42 * EMU }));
      for (const tb of unifiedTables(R.summary, f, nextId())) insert(tb);
    }
    // a slide SITHUB had nothing to fill in is hidden (still in the deck: PowerPoint's Unhide brings it back); the cover and
    // slides without a title (the closing contact slide) stay
    if (xml === s.xml && t && !/^investment committee/i.test(t)) { xml = xml.replace(/<p:sld\b([^>]*?)>/, (w, a) => `<p:sld${a.replace(/\sshow="[^"]*"/, '')} show="0">`); hidden.push(t); }
    if (xml !== s.xml) files[s.path] = Buffer.from(xml, 'utf8');
  }
  for (const path of drop) removeSlide(files, path);
  if (hidden.length) notes.push(`Hidden, as there was nothing to fill in: ${hidden.join(', ')} (Unhide in PowerPoint to use them).`);
  if (!R) notes.push('The financial slides (Financial KPI 1–4) are left as in the template: set where the financial model template is saved to fill them.');
  return { buf: zip(files), notes };
}

// The unified financial slide's tables, laid out as the model's sheets are usually pasted: Step 1 (initial input,
// then the KPIs) on the left, the P&L top right, the cash-out plan under it. Colours as the model's.
function unifiedTables(sum, f, firstId) {
  let id = firstId; const out = [];
  const int = (v) => (typeof v === 'number' ? (Math.round(v) || 0).toLocaleString('en-GB') : v ?? '');
  const p1 = (v) => (typeof v === 'number' ? `${(v * 100).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%` : v ?? '');
  const dateOf = (v) => { if (typeof v !== 'number') return v ?? ''; const d = new Date(Math.round((v - 25569) * 86400000)); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  const fmt1 = { 13: String, 14: String, 15: dateOf, 17: int, 18: String, 19: int, 20: int, 21: int, 22: p1, 23: p1 };
  const fmtK = { 32: int, 35: int, 38: int, 33: p1, 36: p1, 39: p1, 47: p1 };
  const L = 0.26 * EMU; const LW = 3.62 * EMU; const R = 3.98 * EMU; const RW = 5.76 * EMU;
  const title = sum.title || `${f.x.ref || ''} ${f.x.title}`.trim();
  out.push(newTable({ id: id++, name: 'SITHUB IR project', x: L, y: 0.62 * EMU, w: LW, h: 0.2 * EMU, widths: [1], rows: [[{ t: title, b: true, fill: BRAND, align: 'ctr', sz: 900 }]], dense: true }));
  const init = [[{ t: 'Initial input', b: true, fill: TEAL, align: 'ctr', sz: 800, span: 2 }, { t: '', fill: TEAL, merged: true }],
    ...sum.initial.map((r) => [{ t: r.label }, { t: (fmt1[r.row] || ((v) => (typeof v === 'number' ? int(v) : v ?? '')))(r.value), b: true, align: 'ctr', fill: [8, 9, 10, 11, 12, 13, 14, 15, 18, 29].includes(r.row) ? INPUT : undefined }])];
  const initH = init.length * 0.118 * EMU;
  out.push(newTable({ id: id++, name: 'SITHUB IR initial input', x: L, y: 0.9 * EMU, w: LW, h: initH, widths: [1.45, 1.25], rows: init, sz: 550, dense: true }));
  const kp = sum.kpis.map((r) => r.row === 31 ? [{ t: r.label, b: true, fill: TEAL, align: 'ctr', sz: 700, span: 2 }, { t: '', fill: TEAL, merged: true }]
    : [{ t: r.label, b: [32, 35, 38, 41, 43, 45, 47, 49].includes(r.row) }, { t: (fmtK[r.row] || ((v) => (typeof v === 'number' ? int(v) : v ?? '')))(r.value), b: true, align: 'ctr' }]);
  const kpY = 0.9 * EMU + initH + 0.12 * EMU;
  out.push(newTable({ id: id++, name: 'SITHUB IR KPIs', x: L, y: kpY, w: LW, h: Math.min(5.1 * EMU - kpY, kp.length * 0.15 * EMU), widths: [1.45, 1.25], rows: kp, sz: 600, dense: true }));
  // the P&L, 10 years and the period's total; the model's subtotal rows in its colours
  const purple = [17, 28, 39, 62, 77, 79]; const teal = [52, 58, 60, 75];
  const plRows = [[{ t: title, b: true, fill: BRAND, align: 'ctr', sz: 700 }, ...sum.years.map(() => ({ t: '', fill: BRAND })), { t: '', fill: BRAND }],
    [{ t: `in K${f.currency}`, b: true }, ...sum.years.map((y) => ({ t: String(y), b: true, align: 'r' })), { t: 'Total period', b: true, align: 'r' }],
    ...sum.pl.map((r) => {
      const fill = purple.includes(r.row) ? BRAND : teal.includes(r.row) ? TEAL : undefined; const b = !!fill || r.row === 51;
      const v = (x) => (x === null ? '' : r.row === 28 ? x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : r.row === 63 ? p1(x) : int(x));
      return [{ t: r.label, b, fill }, ...r.values.map((x) => ({ t: v(x), align: 'r', b, fill })), { t: v(r.total), align: 'r', b: true, fill: fill || LIGHT }];
    })];
  plRows[0][0].span = 12; for (let k = 1; k < 12; k++) plRows[0][k].merged = true;
  out.push(newTable({ id: id++, name: 'SITHUB IR P&L', x: R, y: 0.12 * EMU, w: RW, h: 3.18 * EMU, widths: [2.4, ...sum.years.map(() => 0.62), 0.75], rows: plRows, sz: 500, dense: true }));
  // the cash-out plan: the first year by month, later years' totals
  const items = sum.plan.rows.filter((r) => r.label && r.months.some((y) => y.some((v) => v)));
  const later = [1, 2, 3].filter((yi) => items.some((r) => r.months[yi].some((v) => v)));
  const y0 = sum.plan.year;
  const tot = (r, yi) => r.months[yi].reduce((a, v) => a + v, 0);
  const k1 = (v) => (v ? v.toLocaleString('en-GB', { maximumFractionDigits: 1 }) : '');
  const head = [{ t: `in k${f.currency}`, b: true, fill: BRAND }, ...MONTHS.map((m) => ({ t: m, b: true, fill: BRAND, align: 'ctr' })), { t: `FY ${y0}`, b: true, fill: BRAND, align: 'ctr' }, ...later.map((yi) => ({ t: `FY ${y0 + yi}`, b: true, fill: BRAND, align: 'ctr' }))];
  const totalRow = [{ t: 'Cash-out', b: true, fill: LIGHT }, ...MONTHS.map((_, m) => ({ t: k1(items.reduce((a, r) => a + r.months[0][m], 0)) || '0', b: true, align: 'ctr', fill: LIGHT })),
    { t: k1(items.reduce((a, r) => a + tot(r, 0), 0)) || '0', b: true, align: 'ctr', fill: LIGHT }, ...later.map((yi) => ({ t: k1(items.reduce((a, r) => a + tot(r, yi), 0)), b: true, align: 'ctr', fill: LIGHT }))];
  const planRows = [head, totalRow, ...items.map((r) => [{ t: r.label }, ...r.months[0].map((v) => ({ t: k1(v), align: 'ctr' })), { t: k1(tot(r, 0)), align: 'ctr', b: true }, ...later.map((yi) => ({ t: k1(tot(r, yi)), align: 'ctr', b: true }))])];
  out.push(newTable({ id: id++, name: 'SITHUB IR cash-out plan', x: R + 0.5 * EMU, y: 3.42 * EMU, w: RW - 0.5 * EMU, h: Math.min(1.65, 0.15 * planRows.length) * EMU, widths: [1.6, ...MONTHS.map(() => 0.5), 0.7, ...later.map(() => 0.7)], rows: planRows, sz: 550, dense: true }));
  return out;
}
// a picture's size in pixels (PNG or JPEG)
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5), ext: 'jpeg' };
      i += 2 + len;
    }
  }
  return null;
}
// a picture into the deck, linked from a slide → its relationship id there
function addMedia(files, slidePath, buf, ext) {
  let n = 1; while (files[`ppt/media/sithub${n}.${ext}`]) n++;
  const media = `ppt/media/sithub${n}.${ext}`; files[media] = buf;
  const relsPath = slidePath.replace(/([^/]+)$/, '_rels/$1.rels');
  let rels = files[relsPath]?.toString('utf8') || '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  let k = 1; while (new RegExp(`Id="rIdS${k}"`).test(rels)) k++;
  const rid = `rIdS${k}`;
  rels = rels.replace(/<\/Relationships>/, `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sithub${n}.${ext}"/></Relationships>`);
  files[relsPath] = Buffer.from(rels, 'utf8');
  let ct = files['[Content_Types].xml'].toString('utf8');
  if (!new RegExp(`<Default\\b[^>]*Extension="${ext}"`, 'i').test(ct)) ct = ct.replace(/<Types\b([^>]*)>/, `<Types$1><Default Extension="${ext}" ContentType="image/${ext}"/>`);
  files['[Content_Types].xml'] = Buffer.from(ct, 'utf8');
  return rid;
}
// a slide out of the deck: its place in the list, its relationship, its part, its notes and pictures only it used
function removeSlide(files, path) {
  const name = path.split('/').pop(); const relsOf = (p) => p.replace(/([^/]+)$/, '_rels/$1.rels');
  const presRels = files['ppt/_rels/presentation.xml.rels'].toString('utf8');
  const rel = presRels.match(new RegExp(`<Relationship\\b[^>]*Target="(?:/ppt/)?slides/${name}"[^>]*/>`));
  if (!rel) return;
  const rid = rel[0].match(/\sId="([^"]+)"/)[1];
  files['ppt/_rels/presentation.xml.rels'] = Buffer.from(presRels.replace(rel[0], ''), 'utf8');
  files['ppt/presentation.xml'] = Buffer.from(files['ppt/presentation.xml'].toString('utf8').replace(new RegExp(`<p:sldId\\b[^>]*r:id="${rid}"[^>]*/>`), ''), 'utf8');
  const gone = [path];
  const own = files[relsOf(path)]?.toString('utf8') || '';
  for (const m of own.matchAll(/Target="\.\.\/(notesSlides\/[^"]+|media\/[^"]+)"/g)) gone.push(`ppt/${m[1]}`);
  for (const g of gone) {
    if (g.startsWith('ppt/media/')) { // a picture another part still uses stays
      const still = Object.entries(files).some(([k, v]) => k.endsWith('.rels') && !gone.map(relsOf).includes(k) && v.toString('utf8').includes(g.slice(4)));
      if (still) continue;
    }
    delete files[g]; delete files[relsOf(g)];
  }
  files['[Content_Types].xml'] = Buffer.from(files['[Content_Types].xml'].toString('utf8').replace(new RegExp(`<Override\\b[^>]*PartName="/(${gone.map((g) => g.replace(/[.]/g, '\\.')).join('|')})"[^>]*/>`, 'g'), ''), 'utf8');
}

// 📑 The downloaded files' names, from a pattern set in CAPEX ⋯ › IR templates (the site's own naming scheme):
// {project} the investment's title, {ref} its short ref (CAPEX-0001 → C-0001), {site}, {bu}, {irn} the IR n°, {doc} IR deck /
// Financial model. Without {doc}, the deck and the model share the name (.pptx and .xlsx).
const DEFAULT_NAME = 'InvestCo {project} {ref}';
const shortRef = (ref) => String(ref || '').replace(/^CAPEX-/i, 'C-');
function fileName(x, doc, ext, pattern) {
  const ir = irOf(x.ir);
  const vals = { project: x.title || '', ref: shortRef(x.ref), site: ir.site, bu: ir.bu, irn: ir.ir_number, doc };
  const base = String(pattern || DEFAULT_NAME).replace(/\{(\w+)\}/g, (w, k) => (k.toLowerCase() in vals ? vals[k.toLowerCase()] ?? '' : w))
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150);
  return `${base || shortRef(x.ref) || 'IR'}.${ext}`;
}

// what's still missing for a full IR pack (shown on the investment)
function readiness(x) {
  const f = figures(x); const { ir } = f; const out = [];
  const add = (part, ok, text) => out.push({ part, ok: !!ok, text });
  add('Essentials', ir.ir_number && ir.bu && ir.site, ir.ir_number && ir.bu && ir.site ? 'IR n°, business unit and site' : `Missing: ${[!ir.ir_number && 'IR n°', !ir.bu && 'business unit', !ir.site && 'site'].filter(Boolean).join(', ')}`);
  add('Items & quotes', ir.items.length, ir.items.length ? `${ir.items.length} item(s), ${ir.quotes.filter((q) => q.supplier).length} quote(s)` : 'No items listed: the investment is one item');
  add('Cash-out', ir.items.length && ir.items.every((i) => Object.keys(i.cashout).length), ir.items.some((i) => Object.keys(i.cashout).length) ? 'Phased by month' : 'Not phased: all in the PO month');
  add('Milestones', ir.milestones.po && ir.milestones.delivery && ir.milestones.sop, `${Object.values(ir.milestones).filter(Boolean).length} of ${Object.keys(MILESTONES).length} dates`);
  add('Business case', Object.keys(ir.savings).length || ir.growth.length, Object.keys(ir.savings).length || ir.growth.length ? 'Savings / volumes by year' : Number(x.annual_saving) > 0 ? 'Only the annual saving' : 'No savings or volumes');
  add('Justification', ir.reasons.filter(Boolean).length >= 3 && ir.risks.filter(Boolean).length >= 3, `${ir.reasons.filter(Boolean).length} of 3 reasons, ${ir.risks.filter(Boolean).length} of 3 risks`);
  return { parts: out, notes: f.notes, nature: f.nature, justif: f.justif };
}

module.exports = { fileName, shortRef, DEFAULT_NAME, NATURES, JUSTIFS, ITEM_KINDS, SAVING_LINES, MILESTONES, ANSWERS, irOf, irJson, figures, modelMeta, fillModel, checklistOf, applies, autoAnswers, fillDeck, readiness, defaultsFor, _test: { shapesOf, writeCells, newTable, setText } };
