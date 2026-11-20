// 📑 The IR pack tabs of an investment's window (💶 CAPEX): what the corporate IR deck and financial model
// need beyond the essentials — the request, items and quotes, cash-out and milestones, the business case
// and the checklist. Kept with the investment (its `ir`) and saved with it; ⬇ IR pack fills the templates.

const CXIR_TABS = [['guide', '🧭 Step by step'], ['request', 'Request'], ['items', 'Items & quotes'], ['cash', 'Cash-out & plan'], ['case', 'Business case'], ['check', 'Checklist (optional)']];
let cxIrMetaCache = null;
const cxIrMeta = async (fresh = false) => { if (!cxIrMetaCache || fresh) cxIrMetaCache = await api.get('/capex/ir/meta'); return cxIrMetaCache; };

function cxIrEmpty() {
  return { ir_number: '', bu: '', bu_leader: '', site: '', nature: '', justif: '', budgeted: '', budget: { capex: null, cashout_year: null, opex: null, payback: null, roi: null },
    cap_start: '', depreciation_years: null, detail: '', reasons: ['', '', ''], risks: ['', '', ''], items: [], quotes: [], selection_reason: '',
    freight: { sea: { co2: '', lead: '', price: null }, air: { co2: '', lead: '', price: null } }, freight_mode: '', freight_reason: '',
    negotiation: { purchaser: '', explanation: '', conditions: '', gains: '' }, milestones: { investco: '', po: '', fat: '', delivery: '', sat: '', sop: '' },
    planning_comments: '', cashout_comments: '', savings: {}, growth: [], risks_opps: [], checklist: {},
    not_investing: [0, 1, 2].map(() => ({ text: '', likelihood: '', when: '', cost: null, basis: '' })) };
}
function cxIrOf(x) {
  let r = {}; try { r = JSON.parse(x?.ir || '{}') || {}; } catch { r = {}; }
  const e = cxIrEmpty(); const out = { ...e, ...r };
  for (const k of ['budget', 'negotiation', 'milestones']) out[k] = { ...e[k], ...(r[k] || {}) };
  out.freight = { sea: { ...e.freight.sea, ...(r.freight?.sea || {}) }, air: { ...e.freight.air, ...(r.freight?.air || {}) } };
  for (const k of ['reasons', 'risks']) { out[k] = [...(r[k] || [])]; while (out[k].length < 3) out[k].push(''); }
  // ⚠ if we don't invest: an older record's free-text risks become its first consequences (to be costed)
  out.not_investing = Array.isArray(r.not_investing) && r.not_investing.length ? r.not_investing.map((t) => ({ text: '', likelihood: '', when: '', cost: null, basis: '', ...t }))
    : (r.risks || []).filter(Boolean).map((t) => ({ text: t, likelihood: '', when: '', cost: null, basis: '' }));
  while (out.not_investing.length < 3) out.not_investing.push({ text: '', likelihood: '', when: '', cost: null, basis: '' });
  for (const i of out.items) i.cashout = i.cashout || {};
  for (const g of out.growth) g.volumes = g.volumes || {};
  return out;
}
const cxPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
function cxSetPath(obj, path, v) { const ks = path.split('.'); let o = obj; for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = /^\d+$/.test(k) ? [] : {}; o = o[k]; } o[ks[ks.length - 1]] = v; }
const cxMonthAdd = (k, n) => { const [y, m] = k.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const cxMonthName = (k) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`;
const cxSum = (o) => Object.values(o || {}).reduce((a, v) => a + (Number(v) || 0), 0);

// The IR panes, inside the investment's form. getX(): the form's essentials as they stand (amount, planned date…).
function cxIrPanes(root, x, getX) {
  const ir = cxIrOf(x); const ui = { coFrom: '', coN: 12 };
  let meta = null; let status = null;
  const cur = () => getX().currency || state.settings.currency;
  const inp = (path, { type = 'text', ph = '', w = '', cls = '' } = {}) => { const v = cxPath(ir, path); return `<input type="${type}" data-k="${path}" data-t="${type === 'number' ? 'num' : 'str'}" value="${esc(v ?? '')}" placeholder="${esc(ph)}"${w ? ` style="width:${w}"` : ''}${type === 'number' ? ' step="any"' : ''} class="${cls}">`; };
  const area = (path, rows = 2, ph = '') => `<textarea data-k="${path}" data-t="str" rows="${rows}" placeholder="${esc(ph)}">${esc(cxPath(ir, path) ?? '')}</textarea>`;
  const radio = (path, opts) => `<div class="cx-radios">${opts.map(([v, l]) => `<label class="cx-radio"><input type="radio" name="cxr-${path}" data-k="${path}" data-t="str" value="${esc(v)}" ${cxPath(ir, path) === v ? 'checked' : ''}> ${esc(l)}</label>`).join('')}</div>`;
  const lbl = (text, html, cls = '') => `<label class="f ${cls}"><span class="f-l">${text}</span>${html}</label>`;
  const capYear = () => Number((ir.cap_start || ir.milestones.sop || getX().planned_date || new Date().toISOString()).slice(0, 4));
  const caseYears = () => { const n = Math.min(10, Math.max(5, (Number(ir.depreciation_years) || 5) + 1)); return Array.from({ length: n }, (_, k) => capYear() + k); };

  // ---- 🧭 Step by step: plain questions, one at a time; the answers fill in the technical fields (the other tabs) ----
  const G = () => { ir.guide = ir.guide || {}; return ir.guide; };
  const ym_ = (d) => String(d || '').slice(0, 7);
  const mBetween = (a, b) => { const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number); return (by - ay) * 12 + (bm - am); };
  const gv = (k) => G()[k] ?? '';
  const gIn = (k, { type = 'text', ph = '', w = '' } = {}) => `<input type="${type}" data-g="${k}" value="${esc(gv(k))}" placeholder="${esc(ph)}"${type === 'number' ? ' step="any" min="0"' : ''}${w ? ` style="max-width:${w}"` : ''}>`;
  const gOpts = (k, opts) => `<div class="cxg-opts">${opts.map(([v, title, hint]) => `<label class="cxg-opt ${String(gv(k)) === v ? 'on' : ''}"><input type="radio" name="cxg-${k}" data-g="${k}" value="${esc(v)}" ${String(gv(k)) === v ? 'checked' : ''}><b>${title}</b>${hint ? `<span>${hint}</span>` : ''}</label>`).join('')}</div>`;
  const gYesNo = (k) => gOpts(k, [['yes', 'Yes'], ['no', 'No']]);
  const q = (text, html, hint = '', p = 0) => `<div class="cxg-q"><div class="cxg-qt">${p ? `<span class="cxg-tag ${PRIO[p][2]}" title="${PRIO[p][1]}">${PRIO[p][0]}</span> ` : ''}${text}</div>${hint ? `<div class="small muted">${hint}</div>` : ''}${html}</div>`;
  const NATURE_OF = { building: 'Building', equipment: 'Equipment', it: 'IT' };
  const JUSTIF_OF = { replace: 'Replacement / Obsolescence', growth: 'Growth / Capacity increase', save: 'Improvement / Productivity', comply: 'Compliance', footprint: 'Strategic footprint' };
  const YEARS_FOR = { building: 20, equipment: 7, it: 3 };
  // what the answers mean in the IR's own terms
  // the risks of not investing, as one line each for the deck: what happens — what it would cost a year (how likely, when)
  const whole = (v) => `${curSym(cur())}${Math.round(Number(v) || 0).toLocaleString('en-GB')}`;
  const niLine = (t) => { const bits = [t.likelihood, t.when].filter(Boolean).join(', ');
    return `${t.text}${Number(t.cost) > 0 ? ` — ≈ ${whole(t.cost)} a year` : ''}${bits ? ` (${bits})` : ''}`; };
  function applyGuide() {
    const g = G(); const X = getX();
    if (ir.not_investing.some((t) => String(t.text || '').trim())) ir.risks = ir.not_investing.filter((t) => String(t.text || '').trim()).map(niLine);
    if (NATURE_OF[g.kind]) ir.nature = NATURE_OF[g.kind];
    if (JUSTIF_OF[g.why]) ir.justif = JUSTIF_OF[g.why];
    if (g.budgeted) ir.budgeted = g.budgeted;
    if (g.budget_amount !== '' && g.budget_amount != null) ir.budget.capex = Number(g.budget_amount);
    if (g.years) ir.depreciation_years = Number(g.years);
    // transport & installation, and one-off costs that aren't equipment, as their own items
    const own = (kind, want, name, amount) => {
      const at = ir.items.findIndex((it) => it.kind === kind && it.from_guide);
      if (!want || !(Number(amount) > 0)) { if (at >= 0) ir.items.splice(at, 1); return; }
      const it = at >= 0 ? ir.items[at] : (ir.items.push({ kind, qty: 1, initial: null, supplier: '', validated: false, cashout: {}, from_guide: true }), ir.items[ir.items.length - 1]);
      it.name = name; it.amount = Number(amount);
    };
    own('setup', g.install_included === 'no', 'Transport & installation', g.install_cost);
    own('opex', g.oneoff === 'yes', g.oneoff_what || 'Training, licences and one-off costs', g.oneoff_cost);
    if (g.freight === 'sea' || g.freight === 'air') ir.freight_mode = g.freight; else if (g.freight === 'local') ir.freight_mode = '';
    // how it's paid → the cash-out by month
    if (g.pay && g.pay !== 'manual') {
      const ms = ir.milestones; const planned = ym_(X.planned_date) || new Date().toISOString().slice(0, 7);
      const po = ym_(ms.po) || planned; const del = ym_(ms.delivery) || po; const sop = ym_(ms.sop) || del; const sat = ym_(ms.sat) || sop;
      for (const it of ir.items) {
        const v = Number(it.amount) || 0; it.cashout = {}; if (!v) continue;
        const add = (k, share) => { it.cashout[k] = Math.round(((it.cashout[k] || 0) + v * share) * 100) / 100; };
        if (it.kind === 'opex') add(sop, 1);
        else if (it.kind === 'setup') add(del, 1);
        else if (g.pay === 'delivery') add(del, 1);
        else if (g.pay === 'order') add(po, 1);
        else if (g.pay === 'split') { add(po, 0.3); add(del, 0.6); add(sat, 0.1); }
        else if (g.pay === 'even') { const n = Math.max(1, mBetween(po, del) + 1); for (let k = 0; k < n; k++) add(cxMonthAdd(po, k), 1 / n); }
      }
    }
    // savings and added volume a year → by year, from the start of production, over the years it's depreciated
    const from = ym_(ir.milestones.sop) || ir.cap_start || ym_(X.planned_date);
    if (from) {
      const fy = Number(from.slice(0, 4)); const fm = Number(from.slice(5, 7)); const dep = Number(ir.depreciation_years) || 5;
      const ys = []; for (let y = fy; y <= fy + dep && y < fy + 10; y++) if (y < fy + dep || fm > 1) ys.push(y);
      const ramp = g.ramp !== undefined && g.ramp !== '' && Number(g.ramp) >= 0 ? Math.min(Number(g.ramp), 100) / 100 : 1;
      const share = (y) => (y === fy ? ((13 - fm) / 12) * ramp : y === fy + dep ? (fm - 1) / 12 : 1);
      const spread = (annual) => Object.fromEntries(ys.map((y) => [y, Math.round(annual * share(y) * 100) / 100]).filter(([, v]) => v));
      const labour = (Number(g.hours_week) || 0) * (Number(g.hour_cost) || 0) * (Number(g.weeks) || 48);
      const lines = { labour, maint: Number(g.maint_year) || 0, consumables: Number(g.scrap_year) || 0, opex: Number(g.other_year) || 0 };
      if (['hours_week', 'hour_cost', 'maint_year', 'scrap_year', 'other_year'].some((k) => g[k] !== undefined && g[k] !== '')) {
        for (const [k, v] of Object.entries(lines)) { if (v) ir.savings[k] = spread(v); else delete ir.savings[k]; }
        const f = root.closest('form')?.querySelector('[name=annual_saving]'); const tot = Object.values(lines).reduce((a, v) => a + v, 0);
        if (f && tot) f.value = Math.round(tot);
      }
      if (Number(g.growth_volume) > 0) ir.growth = [{ customer: g.growth_customer || 'Added volume', asp: g.growth_price !== '' && g.growth_price != null ? Number(g.growth_price) : null, unit_cost: g.growth_cost !== '' && g.growth_cost != null ? Number(g.growth_cost) : null, volumes: spread(Number(g.growth_volume)) }];
    }
    // the checklist questions the answers settle
    const ans = (n, a, note) => { if (a) ir.checklist[n] = { a, note: note || ir.checklist[n]?.note || '' }; };
    if (g.director) ans(4, g.director);
    if (g.delay === 'yes' && g.delay_what) { ans(6, 'yes'); ans(8, 'yes', g.delay_what); } else if (g.delay === 'no') { ans(6, 'no'); ans(8, 'na'); }
    if (g.subsidy) { ans(9, g.subsidy); ans(10, g.subsidy === 'yes' && g.subsidy_pct ? 'yes' : 'na', g.subsidy === 'yes' && g.subsidy_pct ? `About ${g.subsidy_pct}%` : ''); }
    if (g.freight === 'local') ans(13, 'na', 'Delivered locally: no sea or air freight');
    if (g.why === 'replace') {
      if (g.similar !== undefined && g.similar !== '') ans(27, Number(g.similar) === 0 ? 'yes' : 'no', `${Number(g.similar) === 0 ? 'No' : g.similar} similar machine${Number(g.similar) === 1 ? '' : 's'} on site`);
      if (g.age) ans(28, 'yes', `${g.age} years old`);
      if (g.support) ans(31, g.support);
    }
    if (g.why === 'comply' && g.audit) { ans(35, g.audit, g.audit === 'yes' && g.audit_date ? `Audit on ${g.audit_date}` : ''); if (g.auditors) ans(36, g.auditors); }
    modalFormDirty = true;
  }
  const money_ = (v) => esc(money(v, cur()));
  let quoteV = Date.now();
  const quoteBlock = () => {
    const pick = (label) => `<label class="button small cx-file">${label}<input type="file" data-cxq accept="image/png,image/jpeg,application/pdf,.pdf" hidden></label>`;
    if (!x?.id) return '<div class="small muted">Save the investment first, then add the chosen supplier\'s quote here.</div>';
    const qt = status?.quote;
    return `<div class="cx-quote">${qt ? `<a href="/api/capex/${x.id}/ir/quote?v=${quoteV}" target="_blank" title="Open it full size"><img src="/api/capex/${x.id}/ir/quote?v=${quoteV}" alt="The quote"></a>
      <div><b>${esc(qt.file_name)}</b><div class="small muted">On the supplier selection slide, in the quotation box.</div><div class="row" style="gap:6px;margin-top:6px">${pick('Replace…')}<button type="button" class="small" data-cxir="quote-del">Remove</button></div></div>`
      : `<div>${pick('📎 Add the quote (a picture or a PDF)')}<div class="small muted" style="margin-top:4px">A screenshot (PNG, JPEG) or the quote's PDF: it goes on the supplier selection slide. For a PDF, SITHUB uses its first page (or the page you choose).</div></div>`}</div>`;
  };
  // Each question has a priority: 1 required (the pack can't be made properly without it), 2 important (a gap in the
  // deck without it), 3 if known. A step is ticked once its priority 1 questions are answered.
  const PRIO = { 1: ['P1', 'Required', 'cxg-p1'], 2: ['P2', 'Important', 'cxg-p2'], 3: ['P3', 'If known', 'cxg-p3'] };
  // ⚠ if we don't invest: what to think about, by the main reason given (and examples for the first rows)
  const NI_THINK = {
    replace: { think: ['How often it breaks down now, and how long it\'s down each time', 'What a lost hour costs (margin lost, overtime, rework)', 'Spare parts or support running out, and what a long stop would mean', 'Customers or audits put at risk by a breakdown'],
      ex: [['Line stops more often as it ages: ~120 h downtime a year', '120 h × the margin lost an hour'], ['No spare parts after the supplier ends support: a long stop', 'weeks down × weekly margin'], ['Late deliveries during breakdowns: penalties', 'penalties in the contract']] },
    growth: { think: ['Orders or volumes you\'d have to turn away', 'The margin on them', 'Overtime, weekend shifts or subcontracting to cover the gap', 'A customer or tender that could go to a competitor'],
      ex: [['Orders we can\'t take in the peak', 'units turned away × margin a unit'], ['Weekend overtime to keep up', 'hours a week × the overtime rate'], ['Losing the tender to a competitor', 'the margin on the contract']] },
    save: { think: ['What keeps costing money every year if nothing changes', 'Hours, scrap, energy, maintenance that stay as they are', 'Whether costs are rising (wear, prices)', 'Competitiveness: prices a customer could get elsewhere'],
      ex: [['Scrap stays at today\'s level', 'cards scrapped a year × their cost'], ['Manual handling hours stay', 'hours a year × the loaded rate'], ['Maintenance costs keep rising', 'last years\' maintenance bills']] },
    comply: { think: ['Fines or penalties', 'An audit finding, or losing a certification or customer approval', 'Business that depends on that approval', 'Safety: incidents, and what they cost'],
      ex: [['A major audit finding: certification at risk', 'revenue that depends on it'], ['A fine from the authority', 'the fine set out in the rule'], ['A customer stops ordering until it\'s fixed', 'that customer\'s margin a year']] },
    footprint: { think: ['What the site plan depends on this for', 'Costs of running both the old and new way longer', 'Volume or customers that move elsewhere if it isn\'t done', 'Dates the group or customers have been promised'],
      ex: [['The move is delayed: two sites running', 'months × the cost of running both'], ['Volume moved to another site', 'its margin a year'], ['Customer dates missed', 'penalties or the business at risk']] },
  };
  const filled = (v) => v !== null && v !== undefined && String(v).trim() !== '';
  const eqItems = () => ir.items.filter((it) => it.kind === 'equipment');
  const niFilled = () => ir.not_investing.filter((t) => filled(t.text));
  const investAmount = () => Number(getX().amount) || ir.items.reduce((a, it) => a + (Number(it.amount) || 0) * (Number(it.qty) || 1), 0);
  const STEPS = [
    { k: 'basics', title: 'The basics', reqs: [[1, 'Site', () => filled(ir.site)], [1, 'Business unit', () => filled(ir.bu)], [3, 'IR n°', () => filled(ir.ir_number)]], html: () => `
      ${q('Which site is it for?', inp('site', { ph: meta?.site || 'e.g. the site\'s name' }), '', 1)}
      ${q('Which business unit pays for it?', `<input type="text" data-k="bu" data-t="str" list="cxir-bus" value="${esc(ir.bu)}" placeholder="${esc(meta?.bu || '')}"><datalist id="cxir-bus">${(meta?.model.bus || []).map((b) => `<option value="${esc(b)}">`).join('')}</datalist>`, 'If you\'re not sure, it\'s usually your own site\'s unit.', 1)}
      ${q('Has the corporate IR tool given it a number yet?', inp('ir_number', { ph: 'Leave blank if not yet' }), 'You get one once the request is entered there; add it later.', 3)}`,
      fills: 'the cover, the executive summary\'s site and the model\'s business unit (its tax and discount rates)' },
    { k: 'kind', title: 'What kind of investment', reqs: [[1, 'What kind', () => G().kind]], html: () => q('What are you asking for?', gOpts('kind', [['equipment', '🏭 A machine or equipment', 'printers, lines, tools, vehicles…'], ['building', '🏢 A building or building works', 'construction, racking, warehouse, utilities…'], ['it', '💻 IT', 'software, servers, scanners, networks…']]), '', 1),
      fills: 'the nature of the investment and a sensible depreciation period' },
    { k: 'why', title: 'Why it\'s needed', reqs: [[1, 'The main reason', () => G().why]], html: () => q('What\'s the main reason?', gOpts('why', [['replace', '♻️ Something old has to be replaced', 'worn out, breaking down, no spare parts or support'], ['growth', '📈 We need more capacity', 'more volume than we can make today'], ['save', '💶 It saves money or works better', 'fewer hours, less scrap, less downtime'], ['comply', '✅ It\'s required', 'a law, an audit, a customer or safety rule'], ['footprint', '🗺 It\'s part of a site plan', 'a move or reorganisation decided for the group']]), '', 1),
      fills: 'the justification ticked on the executive summary' },
    { k: 'budget', title: 'Budget', reqs: [[1, 'Budgeted or not', () => G().budgeted], [2, 'The budgeted amount', () => filled(ir.budget.capex), () => G().budgeted === 'yes'], [3, 'The rest of the budget assumptions', () => [ir.budget.cashout_year, ir.budget.opex, ir.budget.payback, ir.budget.roi].some(filled), () => G().budgeted === 'yes']], html: () => `
      ${q('Was it in this year\'s budget?', gOpts('budgeted', [['yes', 'Yes'], ['no', 'No']]), 'Your controller knows if you don\'t.', 1)}
      ${G().budgeted === 'yes' ? q(`How much was budgeted? (${esc(cur())})`, gIn('budget_amount', { type: 'number', w: '180px' }), '', 2) : ''}
      ${G().budgeted === 'yes' ? q('What else did the budget assume?', `<div class="cxg-grid4">${lbl(`Cash-out this year (${esc(cur())})`, inp('budget.cashout_year', { type: 'number' }))}${lbl(`OPEX (${esc(cur())})`, inp('budget.opex', { type: 'number' }))}${lbl('Payback (months)', inp('budget.payback', { type: 'number' }))}${lbl('ROI (%)', inp('budget.roi', { type: 'number' }))}</div>`, 'The budget column of the executive summary\'s comparison.', 3) : ''}`,
      fills: 'the comparison with the budget on the executive summary' },
    { k: 'buy', title: 'What you\'re buying', reqs: [[1, 'The things bought, with their price', () => eqItems().some((it) => it.amount)], [1, 'Whether delivery and installation are included', () => G().install_included], [1, 'What transport and installation cost', () => Number(G().install_cost) > 0, () => G().install_included === 'no'], [2, 'One-off costs that aren\'t equipment', () => G().oneoff], [3, 'Prices before negotiation', () => eqItems().some((it) => filled(it.initial))]], html: () => {
      const g = G(); const eq = ir.items.map((it, i) => [it, i]).filter(([it]) => it.kind === 'equipment');
      return `${q('List the main things you\'re buying, with the price you were quoted', `<table class="log cx-grid"><thead><tr><th>What</th><th class="num">How many</th><th class="num">Price (${esc(cur())})</th><th>Supplier</th><th class="num" title="If the price was negotiated down: the first quote">Before negotiation <span class="cxg-tag cxg-p3">P3</span></th><th></th></tr></thead><tbody>
          ${eq.map(([, i]) => `<tr><td>${inp(`items.${i}.name`, { ph: 'e.g. DOD printer' })}</td><td>${inp(`items.${i}.qty`, { type: 'number', w: '80px' })}</td><td>${inp(`items.${i}.amount`, { type: 'number' })}</td><td>${inp(`items.${i}.supplier`)}</td><td>${inp(`items.${i}.initial`, { type: 'number', ph: 'if negotiated' })}</td><td><button type="button" class="icon" data-cxir="del-item" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table><button type="button" class="small" data-cxir="add-item" style="margin-top:6px">＋ ${eq.length ? 'Another thing' : 'Add the first thing'}</button>`, 'The total price of each line (not per piece).', 1)}
        ${q('Does the price include delivery and installation?', gOpts('install_included', [['yes', 'Yes, it\'s all included'], ['no', 'No, they cost extra']]), '', 1)}
        ${g.install_included === 'no' ? q(`What do transport and installation cost? (${esc(cur())})`, gIn('install_cost', { type: 'number', w: '180px' }), 'Transport, import duties, installation, site preparation: these count as CAPEX too.', 1) : ''}
        ${q('Are there one-off costs that aren\'t equipment?', gOpts('oneoff', [['yes', 'Yes', 'training, short licences, moving an old machine…'], ['no', 'No']]), '', 2)}
        ${g.oneoff === 'yes' ? `${q('What are they?', gIn('oneoff_what', { ph: 'e.g. operator training' }), '', 2)}${q(`How much? (${esc(cur())})`, gIn('oneoff_cost', { type: 'number', w: '180px' }), '', 2)}` : ''}
        <div class="small muted">CAPEX total: <b>${money_(ir.items.filter((it) => it.kind !== 'opex').reduce((a, it) => a + (Number(it.amount) || 0), 0))}</b></div>`;
    }, fills: 'the item list, CAPEX vs OPEX, the model\'s asset sheet and cash-out plan (and the negotiation slide, with the prices before negotiation)' },
    { k: 'quotes', title: 'Quotes and delivery', reqs: [[1, 'The chosen supplier\'s quote (supplier and price)', () => ir.quotes.some((qq) => qq.selected && filled(qq.supplier) && filled(qq.price))], [2, 'The other quotes (3 for an item over 10 k€)', () => ir.quotes.filter((qq) => filled(qq.supplier)).length >= 3],
      [2, 'Why not the cheapest', () => filled(ir.selection_reason), () => notCheapest()], [2, 'The quote document', () => !!status?.quote, () => !!x?.id], [2, 'How it arrives', () => G().freight], [3, 'Freight cost, lead time and CO₂', () => ['sea', 'air'].some((m) => filled(ir.freight[m].price) || filled(ir.freight[m].lead))]], html: () => `
      ${q('Which suppliers quoted, and which one did you pick?', `<table class="log cx-grid"><thead><tr><th>Supplier</th><th class="num">Price (${esc(cur())})</th><th>Notes</th><th>Picked</th><th></th></tr></thead><tbody>
          ${ir.quotes.map((qq, i) => `<tr><td>${inp(`quotes.${i}.supplier`)}</td><td>${inp(`quotes.${i}.price`, { type: 'number' })}</td><td>${inp(`quotes.${i}.comment`, { ph: 'lead time, conditions…' })}</td><td class="ctr"><input type="radio" name="cxg-quote" data-cxir="pick-quote" data-i="${i}" ${qq.selected ? 'checked' : ''}></td><td><button type="button" class="icon" data-cxir="del-quote" data-i="${i}">✕</button></td></tr>`).join('')}
        </tbody></table><button type="button" class="small" data-cxir="add-quote" style="margin-top:6px" ${ir.quotes.length >= 6 ? 'disabled' : ''}>＋ A quote</button>`, 'The chosen one is required; the process asks for 3 quotes for any single item over 10 k€.', 1)}
      ${notCheapest() ? q('You didn\'t pick the cheapest: why this one?', area('selection_reason', 2, 'e.g. 4 months shorter lead time, better service'), '', 2) : ''}
      ${q('Have you got the chosen supplier\'s quote? Add it here', quoteBlock(), 'A screenshot or the PDF: it goes on the supplier selection slide.', 2)}
      ${q('How will it arrive?', gOpts('freight', [['sea', '🚢 By sea'], ['air', '✈️ By air', 'faster, but costs more and emits more'], ['local', '🚚 By road / locally', 'no sea or air freight']]), '', 2)}
      ${G().freight === 'air' ? q('Why not by sea?', inp('freight_reason', { ph: 'e.g. the line stops if it\'s later than March' }), '', 2) : ''}
      ${G().freight === 'sea' || G().freight === 'air' ? q('Sea and air compared, if you have the figures', `<table class="log cx-grid"><thead><tr><th></th><th class="num">Price (${esc(cur())})</th><th>Lead time</th><th>CO₂</th></tr></thead><tbody>${['sea', 'air'].map((m) => `<tr><td><b>${m === 'sea' ? 'Sea' : 'Air'}</b></td><td>${inp(`freight.${m}.price`, { type: 'number' })}</td><td>${inp(`freight.${m}.lead`, { ph: 'e.g. 6 weeks' })}</td><td>${inp(`freight.${m}.co2`, { ph: 'e.g. 1.2 t' })}</td></tr>`).join('')}</tbody></table>`, 'The supplier or the forwarder can give them.', 3) : ''}`,
      fills: 'the supplier selection slide' },
    { k: 'dates', title: 'Dates', reqs: [[1, 'Order date', () => filled(ir.milestones.po)], [1, 'Delivery date', () => filled(ir.milestones.delivery)], [1, 'Start of production', () => filled(ir.milestones.sop)], [2, 'Approval date', () => filled(ir.milestones.investco)], [3, 'FAT and SAT', () => filled(ir.milestones.fat) || filled(ir.milestones.sat)]], html: () => `
      ${q('When will you place the order?', inp('milestones.po', { type: 'date' }), '', 1)}
      ${q('When will it be delivered?', inp('milestones.delivery', { type: 'date' }), '', 1)}
      ${q('When will it run in production?', inp('milestones.sop', { type: 'date' }), 'Depreciation, savings and added volumes start from here.', 1)}
      ${q('When should it be approved?', inp('milestones.investco', { type: 'date' }), 'The investment committee date, if you know it.', 2)}
      ${q('Acceptance tests, if there are any', `<div class="cxg-grid4">${lbl('At the supplier (FAT)', inp('milestones.fat', { type: 'date' }))}${lbl('On site (SAT)', inp('milestones.sat', { type: 'date' }))}</div>`, 'On the planning slide; the last payment is usually after the SAT.', 3)}`,
      fills: 'the planning slide, the macro planning on the executive summary and when the model starts' },
    { k: 'pay', title: 'Paying for it', reqs: [[1, 'How it\'s paid', () => G().pay]], html: () => `
      ${q('How will the supplier be paid?', gOpts('pay', [['split', 'A deposit with the order, most at delivery, the rest once it runs', '30% · 60% · 10%, the usual terms'], ['delivery', 'All at delivery'], ['order', 'All with the order'], ['even', 'Evenly, month by month, from the order to delivery'], ['manual', 'I\'ll enter it month by month', 'in Details › Cash-out & plan']]), 'Ask purchasing if you\'re not sure: it\'s in the quote\'s payment terms.', 1)}
      ${!ir.milestones.po || !ir.milestones.delivery ? '<div class="small pl-late">Give the order and delivery dates (Dates) so this can be placed in the right months.</div>' : ''}`,
      fills: 'the cash-out by month on the executive summary, the financial slide and the model\'s cash-out plan' },
    { k: 'benefit', title: 'What it brings', reqs: [[1, 'What it saves or earns (or that it doesn\'t)', () => G().no_benefit === 'yes' || Object.keys(ir.savings).length || ir.growth.length], [1, 'Price and cost per added unit', () => filled(G().growth_price) && filled(G().growth_cost), () => Number(G().growth_volume) > 0], [2, 'How many years it\'s used', () => filled(ir.depreciation_years)], [3, 'Ramp-up in the first year', () => filled(G().ramp)]], html: () => {
      const g = G();
      return `<p class="small muted" style="margin-top:0">A year's worth, once it runs. Give what applies; leave the rest blank.</p>
        <label class="cx-radio" style="margin-bottom:10px"><input type="checkbox" data-g="no_benefit" value="yes" ${g.no_benefit === 'yes' ? 'checked' : ''}> It doesn't save or earn anything measurable (e.g. it's required by a rule) <span class="cxg-tag cxg-p1">P1</span></label>
        <div class="cxg-cols"><div><div class="cx-h">It saves <span class="cxg-tag cxg-p1">P1</span></div>
          ${q('Operator hours saved a week', gIn('hours_week', { type: 'number', w: '140px' }))}
          ${q(`What an operator hour costs (${esc(cur())})`, gIn('hour_cost', { type: 'number', w: '140px' }), 'Your controller has the loaded hourly rate.')}
          ${q('Weeks a year it runs', gIn('weeks', { type: 'number', w: '140px', ph: '48' }))}
          ${q(`Maintenance saved a year (${esc(cur())})`, gIn('maint_year', { type: 'number', w: '140px' }))}
          ${q(`Scrap and consumables saved a year (${esc(cur())})`, gIn('scrap_year', { type: 'number', w: '140px' }))}
          ${q(`Other running costs saved a year (${esc(cur())})`, gIn('other_year', { type: 'number', w: '140px' }), 'Energy, rent, subcontracting… (negative if it costs more to run).')}</div>
        <div><div class="cx-h">It earns <span class="cxg-tag cxg-p1">P1</span></div>
          ${q('Extra units a year (thousands)', gIn('growth_volume', { type: 'number', w: '140px' }), 'Only for more capacity: what you could sell that you can\'t make today.')}
          ${Number(g.growth_volume) > 0 ? `${q('For which customer(s)?', gIn('growth_customer'), '', 2)}${q(`Price per unit (${esc(cur())})`, gIn('growth_price', { type: 'number', w: '140px' }), '', 1)}${q(`Material and variable cost per unit (${esc(cur())})`, gIn('growth_cost', { type: 'number', w: '140px' }), '', 1)}` : ''}</div></div>
        ${q('How many years will it be used?', gIn('years', { type: 'number', w: '140px', ph: String(YEARS_FOR[g.kind] || 5) }), `The depreciation period: typically ${g.kind === 'building' ? '20' : g.kind === 'it' ? '3' : '5 to 10'} years${g.kind ? ' for this kind' : ''}; finance confirms it. Blank: 5.`, 2)}
        ${g.no_benefit !== 'yes' ? q('In its first year running, how much of that does it reach? (%)', gIn('ramp', { type: 'number', w: '140px', ph: '100' }), 'If it takes time to get up to speed, e.g. 60: the first year counts that share.', 3) : ''}
        <div class="cxg-fig" id="cxg-fig">${figBox()}</div>`;
    }, fills: 'the P&L, payback, NPV, ROI and IRR in the model and on the financial slide' },
    { k: 'notinvest', title: 'If we don\'t invest', reqs: [[1, 'At least one thing that happens, with what it would cost a year', () => niFilled().some((t) => Number(t.cost) > 0)], [2, 'Three things that happen if we don\'t', () => niFilled().length >= 3], [2, 'How likely each is, and when', () => niFilled().every((t) => t.likelihood && filled(t.when)), () => niFilled().length > 0]], html: () => {
      const g = G(); const T = NI_THINK[g.why] || NI_THINK.replace; const cur0 = esc(cur());
      const rows = ir.not_investing.map((t, i) => { const ex = T.ex[i] || ['', ''];
        return `<div class="cxni-row"><div class="cxni-n">${i + 1}</div><div class="cxni-f">
          ${lbl('What happens', inp(`not_investing.${i}.text`, { ph: ex[0] ? `e.g. ${ex[0]}` : '' }), 'cxni-text')}
          <div class="cxni-line">${lbl('How likely', `<select data-k="not_investing.${i}.likelihood" data-t="str"><option value=""></option>${[['likely', 'Likely'], ['possible', 'Possible'], ['unlikely', 'Unlikely']].map(([v, l]) => `<option value="${v}" ${t.likelihood === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`)}
            ${lbl('When', inp(`not_investing.${i}.when`, { ph: 'e.g. within 12 months', w: '160px' }))}
            ${lbl(`What it would cost a year (${cur0})`, inp(`not_investing.${i}.cost`, { type: 'number', w: '150px' }))}
            ${lbl('How you got to that figure', inp(`not_investing.${i}.basis`, { ph: ex[1] ? `e.g. ${ex[1]}` : 'e.g. hours × rate' }), 'cxni-basis')}</div></div>
          ${ir.not_investing.length > 1 ? `<button type="button" class="icon" data-cxir="del-ni" data-i="${i}" title="Remove">✕</button>` : ''}</div>`; }).join('');
      const costed = niFilled().filter((t) => Number(t.cost) > 0); const likely = costed.filter((t) => t.likelihood === 'likely');
      const sum = (l) => l.reduce((a, t) => a + Number(t.cost), 0);
      return `<p class="small muted" style="margin-top:0">The approval board weighs what the business could lose by <b>not</b> investing as much as what it gains. Say what would happen, how likely it is, when, and — most important — what it would cost a year. A rough, explained figure is better than none.</p>
        <div class="cxni-think"><b>Think about${g.why ? '' : ' (pick the main reason in step 3 for prompts that fit)'}</b><ul>${T.think.map((x) => `<li>${x}</li>`).join('')}</ul></div>
        <div class="cxni-rows">${rows}</div>
        ${ir.not_investing.length < 6 ? '<button type="button" class="small" data-cxir="add-ni">＋ Another</button>' : ''}
        ${costed.length ? `<div class="cxni-total">At stake if we don't invest: <b>${esc(whole(sum(likely)))}</b> a year likely${sum(costed) > sum(likely) ? `, up to <b>${esc(whole(sum(costed)))}</b> a year with all of them` : ''}${investAmount() ? ` — against an investment of ${esc(whole(investAmount()))}` : ''}.</div>` : ''}`;
    }, fills: 'the risks of not investing on the description & justification slide, with their figures' },
    { k: 'story', title: 'The story', reqs: [[1, 'What will be done', () => filled(ir.detail)], [1, 'Three reasons to do it', () => ir.reasons.filter(Boolean).length >= 3]], html: () => `
      ${q('In a few lines, what will be done?', area('detail', 3, 'e.g. Install a second DOD printer on line 3; the layout stays as it is'), '', 1)}
      ${q('Three reasons to do it', ir.reasons.map((_, i) => inp(`reasons.${i}`, { ph: ['e.g. Cover the forecast peak in Q4', 'e.g. Cut lead times to 5 days', 'e.g. Win the new tender'][i] || '' })).join(''), '', 1)}
      <p class="small muted">The risks of not doing it come from step <a href="javascript:void 0" data-cxg-go="notinvest">If we don't invest</a>, with their figures.</p>`,
      fills: 'the description & justification slide' },
    { k: 'done', title: 'Check and download', reqs: [], html: () => {
      const open = (p) => STEPS.flatMap((st) => st.reqs.filter(([pr, , ok, when]) => pr === p && (!when || when()) && !ok()).map(([, label]) => [st, label]));
      const list = (p, intro) => { const o = open(p); if (!o.length) return ''; const [tag, name, cls] = PRIO[p];
        return `<div class="cxg-open"><span class="cxg-tag ${cls}">${tag} ${name}</span> ${intro}<ul class="mini">${o.map(([st, label]) => `<li><button type="button" class="link" data-cxg-go="${st.k}">${esc(st.title)}</button> — ${esc(label)}</li>`).join('')}</ul></div>`; };
      const p1 = open(1).length;
      return `${p1 ? '' : '<div class="kc-note">✓ Everything required is answered: the IR pack is ready to download.</div>'}
        ${list(1, 'needed before the pack is ready:')}${list(2, 'leaves a gap in the deck without it:')}${list(3, 'add it if you know it:')}
        <p>From your answers SITHUB has filled in the technical parts: the nature and justification, items (CAPEX and OPEX), the cash-out by month, the milestones, the savings and volumes year by year and the depreciation. <b>🔧 Details</b> shows them all, to check or fine-tune (payments month by month, savings that change from year to year, several customers, risks and opportunities, the checklist).</p>
        <p>The checklist slides (2–3) come filled in with what SITHUB can tell from your answers; complete the rest in PowerPoint after downloading (or in Details › Checklist).</p>
        <p>${x?.id ? 'Then <b>⬇ IR pack</b> (top right) saves it and gives you the IR deck and the financial model. The payback, NPV, ROI and IRR are shown above once saved.' : 'Then save the investment (Add investment), open it again and use <b>⬇ IR pack</b> (top right) for the IR deck and the financial model.'}</p>`;
    }, fills: '' },
  ];
  // did they pick a quote that isn't the cheapest?
  function notCheapest() { const sel = ir.quotes.find((qq) => qq.selected); return !!sel && filled(sel.price) && ir.quotes.some((qq) => filled(qq.price) && Number(qq.price) < Number(sel.price)); }
  const stepState = (st) => { const due = (p) => st.reqs.filter(([pr, , , when]) => pr === p && (!when || when())); const ok = (p) => due(p).every(([, , f]) => f());
    return !st.reqs.length ? '' : !ok(1) ? '' : ok(2) ? 'ok' : 'part'; };
  let gStep = store.get('cxGuideStep', 'basics'); if (!STEPS.some((s) => s.k === gStep)) gStep = 'basics';
  const guideHtml = () => {
    const at = STEPS.findIndex((s) => s.k === gStep); const s = STEPS[at];
    const counted = STEPS.filter((st) => st.reqs.length); const done = counted.filter((st) => stepState(st)).length;
    return `<div class="cxg">
      <nav class="cxg-steps"><div class="small muted" style="margin-bottom:6px">${done} of ${counted.length} steps have what's required</div>${STEPS.map((st, i) => { const stt = stepState(st);
        return `<button type="button" data-cxg-go="${st.k}" class="${st.k === gStep ? 'on' : ''} ${stt}" title="${stt === 'part' ? 'Required answered; something important still open' : stt === 'ok' ? 'Done' : ''}"><span class="cxg-n">${stt ? '✓' : i + 1}</span>${esc(st.title)}</button>`; }).join('')}
        <div class="cxg-legend small muted">${[1, 2, 3].map((p) => `<span class="cxg-tag ${PRIO[p][2]}">${PRIO[p][0]}</span> ${PRIO[p][1]}`).join('<br>')}</div></nav>
      <section class="cxg-body"><h3 style="margin-top:0">${at + 1}. ${esc(s.title)}</h3>${s.html()}
        ${s.fills ? `<div class="cxg-fills small">📝 This fills in ${esc(s.fills)}.</div>` : ''}
        <div class="row" style="margin-top:14px">${at > 0 ? `<button type="button" data-cxg-go="${STEPS[at - 1].k}">← Back</button>` : ''}<div class="spacer"></div>${at < STEPS.length - 1 ? `<button type="button" class="primary" data-cxg-go="${STEPS[at + 1].k}">Next →</button>` : ''}</div></section></div>`;
  };
  const panes = {
    guide: () => guideHtml(),
    request: () => `
      <div class="form-grid">
        ${lbl('IR n°', inp('ir_number', { ph: 'from the corporate IR tool' }))}
        ${lbl('Business unit', `<input type="text" data-k="bu" data-t="str" list="cxir-bus" value="${esc(ir.bu)}" placeholder="${esc(meta?.bu || '')}"><datalist id="cxir-bus">${(meta?.model.bus || []).map((b) => `<option value="${esc(b)}">`).join('')}</datalist>`)}
        ${lbl('Site(s)', inp('site', { ph: meta?.site || '' }))}
        <div class="f full"><span class="f-l">Nature of the investment</span>${radio('nature', (meta?.natures || ['Building', 'Equipment', 'IT']).map((n) => [n, n]))}</div>
        <div class="f full"><span class="f-l">Justification</span>${radio('justif', (meta?.justifs || []).map((n) => [n, n]))}</div>
        <div class="f full"><span class="f-l">Is it budgeted?</span>${radio('budgeted', [['yes', 'Yes'], ['no', 'No']])}</div>
        ${lbl(`Budget: CAPEX (${esc(cur())})`, inp('budget.capex', { type: 'number' }))}
        ${lbl(`Budget: cash-out this year (${esc(cur())})`, inp('budget.cashout_year', { type: 'number' }))}
        ${lbl(`Budget: OPEX (${esc(cur())})`, inp('budget.opex', { type: 'number' }))}
        ${lbl('Budget: payback (months)', inp('budget.payback', { type: 'number' }))}
        ${lbl('Budget: ROI (%)', inp('budget.roi', { type: 'number' }))}
        <div></div>
        ${lbl('Detail the project <span class="small muted">— the deck\'s description slide; blank: the Description</span>', area('detail', 3), 'full')}
        <div class="f"><span class="f-l">Why would we invest? <span class="small muted">3 reasons</span></span>${ir.reasons.map((_, i) => inp(`reasons.${i}`, { ph: `Reason ${i + 1}` })).join('')}</div>
        <div class="f"><span class="f-l">Risks of not investing <span class="small muted">3 consequences</span></span>${ir.risks.map((_, i) => inp(`risks.${i}`, { ph: `Risk ${i + 1}` })).join('')}</div>
      </div>`,
    items: () => {
      const capex = ir.items.filter((i) => i.kind !== 'opex').reduce((a, i) => a + (Number(i.amount) || 0), 0);
      const amount = Number(getX().amount) || 0;
      return `
      <div class="cx-h">Items <span class="small muted">— what the request is made of (the deck's item list, the model's asset sheet and cash-out plan)</span></div>
      <div class="kdb-scroll"><table class="log cx-grid"><thead><tr><th>Item</th><th>Kind</th><th class="num">Qty</th><th class="num">First quote</th><th class="num">Amount (${esc(cur())})</th><th>Supplier</th><th title="Validated by purchasing">✔ Purch.</th><th></th></tr></thead><tbody>
        ${ir.items.map((it, i) => `<tr><td>${inp(`items.${i}.name`, { ph: 'e.g. DOD printer' })}</td>
          <td><select data-k="items.${i}.kind" data-t="str">${Object.entries(meta?.kinds || { equipment: 'Equipment (CAPEX)', setup: 'Set-up, transport, installation (CAPEX)', opex: 'Associated expense (OPEX)' }).map(([k, l]) => `<option value="${k}" ${it.kind === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></td>
          <td>${inp(`items.${i}.qty`, { type: 'number', w: '60px' })}</td><td title="Before negotiation (the negotiation slide)">${inp(`items.${i}.initial`, { type: 'number' })}</td><td>${inp(`items.${i}.amount`, { type: 'number' })}</td>
          <td>${inp(`items.${i}.supplier`)}</td><td class="ctr"><input type="checkbox" data-k="items.${i}.validated" data-t="bool" ${it.validated ? 'checked' : ''}></td>
          <td><button type="button" class="icon" data-cxir="del-item" data-i="${i}" title="Remove">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="gap:8px;margin:6px 0 12px"><button type="button" class="small" data-cxir="add-item">＋ Item</button>
        ${ir.items.length ? `<span class="small ${Math.abs(capex - amount) > 0.5 ? 'pl-late' : 'muted'}">CAPEX items: ${esc(money(capex, cur()))}${Math.abs(capex - amount) > 0.5 ? ` — the estimated cost is ${esc(money(amount, cur()))} <button type="button" class="link small" data-cxir="use-total">use the items' total</button>` : ''}</span>` : '<span class="small muted">No items: the investment is taken as one item.</span>'}</div>
      <div class="cx-h">Quotes <span class="small muted">— 3 for any single asset over 10 k€; tick the one chosen</span></div>
      <table class="log cx-grid"><thead><tr><th>Supplier</th><th class="num">Price (${esc(cur())})</th><th>Description / comments</th><th>Chosen</th><th></th></tr></thead><tbody>
        ${ir.quotes.map((q, i) => `<tr><td>${inp(`quotes.${i}.supplier`)}</td><td>${inp(`quotes.${i}.price`, { type: 'number' })}</td><td>${inp(`quotes.${i}.comment`)}</td>
          <td class="ctr"><input type="radio" name="cxir-quote" data-cxir="pick-quote" data-i="${i}" ${q.selected ? 'checked' : ''}></td><td><button type="button" class="icon" data-cxir="del-quote" data-i="${i}">✕</button></td></tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin:6px 0"><button type="button" class="small" data-cxir="add-quote" ${ir.quotes.length >= 6 ? 'disabled' : ''}>＋ Quote</button></div>
      ${lbl('Why this supplier <span class="small muted">— if not the best price: strategy, quality, lead time, risks</span>', area('selection_reason', 2), 'full')}
      <div class="cx-h">The chosen supplier's quote</div>${quoteBlock()}
      <div class="cx-h">Transport</div>
      <table class="log cx-grid"><thead><tr><th></th><th>Carbon footprint</th><th>Lead time</th><th class="num">Price (${esc(cur())})</th><th>Chosen</th></tr></thead><tbody>
        ${['sea', 'air'].map((k) => `<tr><td><b>${k === 'sea' ? 'Sea freight' : 'Air freight'}</b></td><td>${inp(`freight.${k}.co2`, { ph: 'e.g. 1.2 t CO₂' })}</td><td>${inp(`freight.${k}.lead`, { ph: 'e.g. 6 weeks' })}</td><td>${inp(`freight.${k}.price`, { type: 'number' })}</td>
          <td class="ctr"><input type="radio" name="cxir-freight" data-k="freight_mode" data-t="str" value="${k}" ${ir.freight_mode === k ? 'checked' : ''}></td></tr>`).join('')}
      </tbody></table>
      ${ir.freight_mode === 'air' ? lbl('Why air freight', inp('freight_reason'), 'full') : ''}
      <div class="cx-h">Negotiation <span class="small muted">— optional slide</span></div>
      <div class="form-grid">${lbl('Purchaser', inp('negotiation.purchaser'))}${lbl('Explanation', inp('negotiation.explanation'))}${lbl('Conditions (quantity, PO date…)', inp('negotiation.conditions'))}${lbl('Other gains (training, consumables…)', inp('negotiation.gains'), 'full')}</div>`;
    },
    cash: () => {
      const months = coMonths();
      const items = ir.items.length ? ir.items : null;
      const amt = (it) => Number(it.amount) || 0;
      return `
      <div class="cx-h">Milestones</div>
      <div class="form-grid">${Object.entries(meta?.milestones || { investco: 'InvestCo', po: 'PO issuance', fat: 'FAT', delivery: 'Equipment delivery', sat: 'SAT', sop: 'Start of production' }).map(([k, l]) => lbl(esc(l), inp(`milestones.${k}`, { type: 'date' }))).join('')}</div>
      <div class="form-grid" style="margin-top:8px">${lbl('Capitalisation starts <span class="small muted">— blank: start of production</span>', inp('cap_start', { type: 'month' }))}${lbl('Depreciation (years) <span class="small muted">— blank: 5</span>', inp('depreciation_years', { type: 'number', ph: '5' }))}</div>
      <div class="cx-h">Cash-out by month <span class="small muted">— what's paid when (${esc(cur())}); the model's cash-out plan and the deck's cash-out tables</span></div>
      ${items ? `<div class="row" style="gap:8px;margin-bottom:6px;flex-wrap:wrap"><label class="small">From <input type="month" id="cxir-cofrom" value="${months[0]}" style="width:auto"></label>
        <label class="small">for <select id="cxir-con" style="width:auto">${[6, 12, 18, 24, 36].map((n) => `<option ${n === ui.coN ? 'selected' : ''}>${n}</option>`).join('')}</select> months</label>
        <button type="button" class="small" data-cxir="phase" title="Equipment: 30% at the PO, 60% at delivery, 10% at SAT · set-up at delivery · OPEX at the start of production">Phase by the milestones</button>
        <button type="button" class="small" data-cxir="clear-cash">Clear</button></div>
      <div class="kdb-scroll"><table class="log cx-grid cx-cash"><thead><tr><th>Item</th>${months.map((m) => `<th class="num">${cxMonthName(m)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
        ${items.map((it, i) => { const tot = cxSum(it.cashout); const off = Object.keys(it.cashout).filter((m) => !months.includes(m)).length;
          return `<tr><td class="nowrap"><b>${esc(it.name || `Item ${i + 1}`)}</b>${it.kind === 'opex' ? ' <span class="small muted">OPEX</span>' : ''}${off ? `<div class="small muted">+ ${off} month(s) outside these</div>` : ''}</td>
          ${months.map((m) => `<td><input type="number" step="any" data-k="items.${i}.cashout.${m}" data-t="num" value="${esc(it.cashout[m] ?? '')}"></td>`).join('')}
          <td class="num nowrap ${Math.abs(tot - amt(it)) > 0.5 ? 'pl-late' : ''}" title="${Math.abs(tot - amt(it)) > 0.5 ? `Its amount is ${money(amt(it), cur())}` : ''}">${esc(money(tot, cur()))}</td></tr>`; }).join('')}
      </tbody></table></div>` : '<div class="empty small">List the items (Items & quotes) to phase what\'s paid when. Without them, the cost is put in the PO month.</div>'}
      <div class="form-grid" style="margin-top:8px">${lbl('Planning comments <span class="small muted">— blank: the key dates</span>', area('planning_comments', 2), 'full')}${lbl('Cash-out comments <span class="small muted">— payment terms…</span>', area('cashout_comments', 2), 'full')}</div>`;
    },
    case: () => {
      const ys = caseYears(); const L = meta?.lines || {};
      return `
      <div class="cx-h">Savings by year <span class="small muted">— ${esc(cur())}, savings positive, extra costs negative; the model's P&L lines</span></div>
      <div class="kdb-scroll"><table class="log cx-grid"><thead><tr><th>Line</th>${ys.map((y) => `<th class="num">${y}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>
        ${Object.entries(L).map(([k, l]) => `<tr><td class="nowrap">${esc(l)}</td>${ys.map((y) => `<td><input type="number" step="any" data-k="savings.${k}.${y}" data-t="num" value="${esc(ir.savings[k]?.[y] ?? '')}"></td>`).join('')}<td class="num">${esc(money(cxSum(ir.savings[k]), cur()))}</td></tr>`).join('')}
      </tbody></table></div>
      ${Number(getX().annual_saving) > 0 ? `<div class="row" style="margin:6px 0"><button type="button" class="small" data-cxir="from-saving">Fill shop floor labour from the annual saving (${esc(money(getX().annual_saving, cur()))})</button></div>` : ''}
      <div class="cx-h">Added volumes <span class="small muted">— for capacity cases: thousands of units a year, the price and variable cost per unit</span></div>
      <div class="kdb-scroll"><table class="log cx-grid"><thead><tr><th>Customer</th><th class="num">ASP</th><th class="num">Cost / unit</th>${ys.map((y) => `<th class="num">${y} (k)</th>`).join('')}<th></th></tr></thead><tbody>
        ${ir.growth.map((g, i) => `<tr><td>${inp(`growth.${i}.customer`)}</td><td>${inp(`growth.${i}.asp`, { type: 'number' })}</td><td>${inp(`growth.${i}.unit_cost`, { type: 'number' })}</td>
          ${ys.map((y) => `<td><input type="number" step="any" data-k="growth.${i}.volumes.${y}" data-t="num" value="${esc(g.volumes?.[y] ?? '')}"></td>`).join('')}<td><button type="button" class="icon" data-cxir="del-growth" data-i="${i}">✕</button></td></tr>`).join('')}
      </tbody></table></div>
      <div class="row" style="margin:6px 0"><button type="button" class="small" data-cxir="add-growth" ${ir.growth.length >= 9 ? 'disabled' : ''}>＋ Customer</button></div>
      <div class="cx-h">Risks & opportunities <span class="small muted">— the model's Risks & Opps sheet</span></div>
      <table class="log cx-grid"><thead><tr><th></th><th>Description</th><th class="num">Impact (k${esc(cur())})</th><th></th></tr></thead><tbody>
        ${ir.risks_opps.map((r, i) => `<tr><td><select data-k="risks_opps.${i}.kind" data-t="str"><option value="risk" ${r.kind !== 'opp' ? 'selected' : ''}>Risk</option><option value="opp" ${r.kind === 'opp' ? 'selected' : ''}>Opportunity</option></select></td>
          <td>${inp(`risks_opps.${i}.text`)}</td><td>${inp(`risks_opps.${i}.k`, { type: 'number' })}</td><td><button type="button" class="icon" data-cxir="del-ro" data-i="${i}">✕</button></td></tr>`).join('')}
      </tbody></table>
      <div class="row" style="margin:6px 0"><button type="button" class="small" data-cxir="add-ro">＋ Risk or opportunity</button></div>`;
    },
    check: () => {
      const list = meta?.deck.checklist || [];
      if (!list.length) return `<div class="empty small">${esc(meta?.deck.error || 'The checklist comes from the IR deck template: set where it\'s saved (💶 CAPEX ⋯ › IR templates).')}</div>`;
      const auto = status?.auto || {}; const A = meta.answers; const justif = ir.justif || status?.justif || '';
      const topics = [...new Set(list.map((q) => q.topic))];
      return `<p class="small muted" style="margin-top:0">Answered here, the deck's checklist slides are filled in. <b>auto</b> answers come from what's entered (as last saved); questions not asked for a ${esc(justif || 'this kind of')} investment show N/A in the deck.</p>
        ${topics.map((t) => `<div class="cx-h">${esc(t)}</div><table class="log cx-grid cx-check"><tbody>${list.filter((q) => q.topic === t).map((q) => {
          const a = ir.checklist[q.n] || {}; const au = auto[q.n]; const na = !cxApplies(q.for, justif);
          return `<tr class="${na ? 'muted' : ''}"><td class="small muted">${q.n}</td><td>${esc(q.question)}${q.for && !/^all$/i.test(q.for) ? ` <span class="small muted">(${esc(q.for)})</span>` : ''}</td>
            <td><select data-k="checklist.${q.n}.a" data-t="str"><option value="">${au ? `auto: ${esc(A[au.a])}` : na ? 'N/A (not asked)' : '—'}</option>${Object.entries(A).map(([k, l]) => `<option value="${k}" ${a.a === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${au && !a.a ? `<div class="small muted">${esc(au.why)}</div>` : ''}</td>
            <td>${inp(`checklist.${q.n}.note`, { ph: 'note' })}</td></tr>`; }).join('')}</tbody></table>`).join('')}`;
    },
  };
  // the months the cash-out grid shows
  function coMonths() {
    const ms = ir.milestones; const planned = (getX().planned_date || '').slice(0, 7);
    const known = [...ir.items.flatMap((i) => Object.keys(i.cashout || {})), ms.po?.slice(0, 7), planned].filter(Boolean).sort();
    const from = ui.coFrom || known[0] || new Date().toISOString().slice(0, 7);
    return Array.from({ length: ui.coN }, (_, k) => cxMonthAdd(from, k));
  }
  let tab = store.get('cxIrTab', 'guide'); if (!CXIR_TABS.some(([k]) => k === tab)) tab = 'guide';
  const head = () => {
    const parts = status?.parts || [];
    const R = status?.results; const k = (v) => (v === null || v === undefined ? '–' : `${Math.round(v).toLocaleString('en-GB')} k${cur()}`);
    return `<div class="cx-irhead">${x?.id ? `${parts.map((p) => `<span class="cx-ok ${p.ok ? 'ok' : ''}" title="${esc(p.text)}">${p.ok ? '✓' : '•'} ${esc(p.part)}</span>`).join('')}
      ${R ? `<div class="small" style="margin-top:4px">As the model works it out: payback <b>${R.payback_years !== null ? `${Math.round(R.payback_years * 12)} months` : '–'}</b> · NPV <b>${k(R.npv)}</b> · ROI <b>${R.roi !== null ? `${Math.round(R.roi * 100)}%` : '–'}</b> · IRR <b>${R.irr !== null ? `${Math.round(R.irr * 100)}%` : '–'}</b> <span class="muted">(as last saved)</span></div>` : status?.model_error ? `<div class="small muted" style="margin-top:4px">${esc(status.model_error)}</div>` : ''}
      ${(status?.notes || []).length ? `<details class="small"><summary class="muted">${status.notes.length} note${status.notes.length === 1 ? '' : 's'} on how it's filled in</summary><ul class="mini">${status.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}`
      : '<span class="small muted">Save the investment to download its IR pack.</span>'}</div>`;
  };
  // 💶 the return as the model works it out with what's typed so far (not saved): asked for a moment after a change
  let live = null; let liveKey = ''; let liveT = null; let liveBusy = false;
  function figBox() {
    const g = G(); const k = (v) => (v === null || v === undefined ? '–' : `${Math.round(v).toLocaleString('en-GB')} k${esc(cur())}`);
    const R = live?.results; const yrs = Number(ir.depreciation_years) || Number(g.years) || 5;
    const none = g.no_benefit === 'yes' || !R || R.roi === null || R.roi === undefined;
    const weak = !none && ((R.npv !== null && R.npv < 0) || (R.payback_years !== null && R.payback_years > yrs) || R.roi <= 0);
    const head = g.no_benefit === 'yes' ? (R && R.roi !== null && R.roi !== undefined ? '<span class="small muted">(Savings typed on 🔧 Details still count in the model: clear them there if it really saves nothing.)</span>' : '')
      : live?.model_error ? `<span class="muted">The return can't be worked out here: ${esc(live.model_error)}</span>`
      : !live ? '<span class="muted">Working out the return…</span>'
      : `<b>The return, as it stands:</b> payback <b>${R?.payback_years !== null && R?.payback_years !== undefined ? `${Math.round(R.payback_years * 12)} months` : '–'}</b> · ROI <b>${R?.roi !== null && R?.roi !== undefined ? `${Math.round(R.roi * 100)}%` : '–'}</b> · NPV <b>${k(R?.npv)}</b> · IRR <b>${R?.irr !== null && R?.irr !== undefined ? `${Math.round(R.irr * 100)}%` : '–'}</b>${liveBusy ? ' <span class="muted">…</span>' : ''}`;
    const nudge = none || weak ? `<div class="cxg-fig-warn">${none ? 'No measurable return' : weak ? `A weak return${R.npv < 0 ? ' (NPV below zero)' : R.payback_years > yrs ? ` (it pays back after ${yrs} years of use)` : ''}` : ''}: the case then rests on <b>what the business loses if we don't invest</b>. Make that clear, with figures, in the next step — <a href="javascript:void 0" data-cxg-go="notinvest">If we don't invest</a>.</div>` : '';
    return `${head}${nudge}`;
  }
  function askLive() {
    if (!(tab === 'guide' && gStep === 'benefit')) return;
    const X = getX(); const body = { id: x?.id || null, capex: { title: X.title, amount: X.amount, planned_date: X.planned_date, currency: X.currency, annual_saving: X.annual_saving, supplier: X.supplier, category: X.category }, ir };
    const key = JSON.stringify(body); if (key === liveKey) return;
    clearTimeout(liveT); liveBusy = true; const box = root.querySelector('#cxg-fig'); if (box) box.innerHTML = figBox();
    liveT = setTimeout(async () => {
      try { live = await api.post('/capex/ir/preview', body); liveKey = key; } catch (err) { live = { results: null, model_error: err.message }; }
      liveBusy = false; const b = root.querySelector('#cxg-fig'); if (b) b.innerHTML = figBox();
    }, 500);
  }
  function render() {
    const detail = store.get('cxIrDetail', 'request');
    root.innerHTML = `${head()}<div class="seg cx-irtabs"><button type="button" data-cxir-tab="guide" class="${tab === 'guide' ? 'on' : ''}">🧭 Step by step</button><button type="button" data-cxir-tab="${tab === 'guide' ? detail : tab}" class="${tab !== 'guide' ? 'on' : ''}" title="Every field, to check the result or for unusual cases">🔧 Details</button></div>
      ${tab !== 'guide' ? `<div class="cx-irsub"><span class="small muted">Every field, to check what Step by step filled in or for unusual cases:</span> <div class="seg">${CXIR_TABS.filter(([k]) => k !== 'guide').map(([k, l]) => `<button type="button" data-cxir-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : ''}
      <div class="cx-irpane">${meta ? panes[tab]() : '<div class="empty small">Reading the IR templates…</div>'}</div>`;
    joinLabels?.();
    askLive();
  }
  // typing changes the record; leaving a field that totals or layout depend on redraws (once the focus has moved on)
  const take = (el) => {
    const t = el.dataset.t; let v = t === 'bool' ? el.checked : el.value;
    if (t === 'num') v = v === '' ? null : Number(v);
    if (el.type === 'radio' && !el.checked) return;
    cxSetPath(ir, el.dataset.k, v);
  };
  const LAYOUT = /^(items\.\d+\.(amount|kind|name)|freight_mode|justif|depreciation_years|cap_start|milestones\.\w+|growth\.\d+\.customer)$|\.cashout\.|^savings\./;
  const takeG = (el) => { if (el.type === 'radio' && !el.checked) return; G()[el.dataset.g] = el.type === 'checkbox' ? (el.checked ? el.value : '') : el.value; };
  root.addEventListener('input', (e) => { const el = e.target.closest('[data-k]'); if (el) take(el); const g = e.target.closest('[data-g]'); if (g) takeG(g); });
  root.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.matches('[data-cxq]')) {
      const file = el.files?.[0]; if (!file) return;
      try {
        let body = file; let name = file.name;
        if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) {
          toast('Reading the PDF…');
          const first = await cxPdfToPng(file, 1); let shot = first;
          if (first.pages > 1) {
            const n = Number(prompt(`The PDF has ${first.pages} pages. Which one shows the quote?`, '1'));
            if (!n) return;
            if (n !== 1) shot = await cxPdfToPng(file, n);
          }
          body = shot.blob; name = `${file.name.replace(/\.pdf$/i, '')}.png`;
        } else if (!/^image\/(png|jpeg)$/.test(file.type)) { toast('A quote is a PNG or JPEG picture, or a PDF', 'error'); return; }
        const r = await fetch(`/api/capex/${x.id}/ir/quote`, { method: 'POST', body, headers: { 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(name) } });
        const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || `Couldn't add it (${r.status})`);
        status = { ...(status || {}), quote: j }; quoteV = Date.now(); toast('Quote added'); render();
      } catch (err) { toast(/vendor\/pdfjs|import/i.test(err.message) ? 'The PDF can\'t be read here (the app\'s PDF reader is missing: run the update), add a screenshot instead' : err.message, 'error'); }
      return;
    }
    if (el.id === 'cxir-cofrom') { ui.coFrom = el.value; rerender(); return; }
    if (el.id === 'cxir-con') { ui.coN = Number(el.value); rerender(); return; }
    if (el.matches('[data-g]')) { takeG(el); applyGuide(); setTimeout(rerender, 0); return; }
    if (!el.matches('[data-k]')) return;
    take(el);
    if (tab === 'guide') { applyGuide(); setTimeout(rerender, 0); return; }
    if (LAYOUT.test(el.dataset.k)) setTimeout(rerender, 0);
  });
  // keep the focus and scroll where they were across a redraw
  function rerender() {
    const k = document.activeElement?.dataset?.k; const gk = document.activeElement?.type !== 'radio' && document.activeElement?.dataset?.g; const sc = root.closest('.modal-body, #modal-body, dialog')?.scrollTop;
    render();
    if (k || gk) { const el = root.querySelector(k ? `[data-k="${CSS.escape(k)}"]` : `[data-g="${CSS.escape(gk)}"]`); if (el) { el.focus(); try { el.setSelectionRange?.(el.value.length, el.value.length); } catch { /* not a text box */ } } }
    const box = root.closest('.modal-body, #modal-body, dialog'); if (box && sc !== undefined) box.scrollTop = sc;
  }
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cxir-tab]'); if (t) { tab = t.dataset.cxirTab; store.set('cxIrTab', tab); if (tab !== 'guide') store.set('cxIrDetail', tab); render(); return; }
    const go = e.target.closest('[data-cxg-go]'); if (go) { gStep = go.dataset.cxgGo; store.set('cxGuideStep', gStep); render(); root.querySelector('.cxg-body')?.scrollIntoView({ block: 'nearest' }); return; }
    const b = e.target.closest('[data-cxir]'); if (!b) return;
    const i = Number(b.dataset.i); const a = b.dataset.cxir; const X = getX();
    if (a === 'add-item') ir.items.push({ name: '', kind: 'equipment', qty: 1, amount: null, initial: null, supplier: X.supplier || '', validated: false, cashout: {} });
    if (a === 'del-item') ir.items.splice(i, 1);
    if (a === 'use-total') { const tot = ir.items.filter((it) => it.kind !== 'opex').reduce((s, it) => s + (Number(it.amount) || 0), 0); const f = root.closest('form')?.querySelector('[name=amount]'); if (f) { f.value = tot; f.dispatchEvent(new Event('input', { bubbles: true })); } }
    if (a === 'add-quote') ir.quotes.push({ supplier: '', price: null, comment: '', selected: !ir.quotes.length });
    if (a === 'del-quote') ir.quotes.splice(i, 1);
    if (a === 'pick-quote') ir.quotes.forEach((q, k) => { q.selected = k === i; });
    if (a === 'add-growth') ir.growth.push({ customer: '', asp: null, unit_cost: null, volumes: {} });
    if (a === 'del-growth') ir.growth.splice(i, 1);
    if (a === 'add-ro') ir.risks_opps.push({ kind: 'risk', text: '', k: null });
    if (a === 'add-ni' && ir.not_investing.length < 6) ir.not_investing.push({ text: '', likelihood: '', when: '', cost: null, basis: '' });
    if (a === 'del-ni') ir.not_investing.splice(i, 1);
    if (a === 'del-ro') ir.risks_opps.splice(i, 1);
    if (a === 'quote-del') { if (!confirm('Remove the quote from this investment?')) return; api.del(`/capex/${x.id}/ir/quote`).then(() => { status = { ...(status || {}), quote: null }; render(); }).catch((err) => toast(err.message, 'error')); return; }
    if (a === 'clear-cash') ir.items.forEach((it) => { it.cashout = {}; });
    if (a === 'phase') {
      const ms = ir.milestones; const planned = (X.planned_date || new Date().toISOString()).slice(0, 7);
      const m = (d, fb) => (d ? d.slice(0, 7) : fb);
      const po = m(ms.po, planned); const del = m(ms.delivery, po); const sat = m(ms.sat || ms.sop, del); const sop = m(ms.sop || ms.sat, sat);
      for (const it of ir.items) {
        const v = Number(it.amount) || 0; it.cashout = {};
        const add = (k, share) => { if (v) it.cashout[k] = Math.round(((it.cashout[k] || 0) + v * share) * 100) / 100; };
        if (it.kind === 'equipment') { add(po, 0.3); add(del, 0.6); add(sat, 0.1); } else if (it.kind === 'setup') add(del, 1); else add(sop, 1);
      }
      ui.coFrom = [po, ...ir.items.flatMap((it) => Object.keys(it.cashout))].sort()[0];
    }
    if (a === 'from-saving') {
      const from = (ir.milestones.sop || ir.cap_start || X.planned_date || '').slice(0, 7); const fy = Number(from.slice(0, 4)); const fm = Number(from.slice(5, 7)) || 1; const dep = Number(ir.depreciation_years) || 5;
      ir.savings.labour = {}; for (const y of caseYears()) if (y >= fy && y < fy + dep + (fm > 1 ? 1 : 0)) ir.savings.labour[y] = Math.round((y === fy ? (X.annual_saving * (13 - fm)) / 12 : Number(X.annual_saving)) * 100) / 100;
    }
    if (tab === 'guide') applyGuide();
    modalFormDirty = true; rerender();
  });
  render();
  cxIrMeta().then((m) => { meta = m; render(); }).catch((err) => { meta = { model: { bus: [], error: err.message }, deck: { checklist: [], error: err.message } }; render(); });
  if (x?.id) api.get(`/capex/${x.id}/ir`).then((s) => { status = s; render(); }).catch(() => {});
  return { value: () => ir };
}
// 📄 a PDF's page as a PNG picture (pdf.js, served by SITHUB from its own install) → { blob, pages }
async function cxPdfToPng(file, pageNo = 1) {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const page = await doc.getPage(Math.min(Math.max(1, pageNo), doc.numPages));
  const vp = page.getViewport({ scale: 2 });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // the page's white margins trimmed, so the quote fills the slide's box (a little white kept around it)
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let top = height; let bottom = -1; let left = width; let right = -1;
  for (let y = 0; y < height; y += 2) for (let x0 = 0; x0 < width; x0 += 2) {
    const i = (y * width + x0) * 4; if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) continue;
    if (y < top) top = y; if (y > bottom) bottom = y; if (x0 < left) left = x0; if (x0 > right) right = x0;
  }
  let out = c;
  if (bottom > top && right > left) {
    const pad = 24; const x1 = Math.max(0, left - pad); const y1 = Math.max(0, top - pad); const w = Math.min(width, right + pad) - x1; const h = Math.min(height, bottom + pad) - y1;
    out = document.createElement('canvas'); out.width = w; out.height = h; out.getContext('2d').drawImage(c, x1, y1, w, h, 0, 0, w, h);
  }
  return { blob: await new Promise((ok) => out.toBlob(ok, 'image/png')), pages: doc.numPages };
}
// is a checklist question asked for this justification ("All", "Replacement / Obsolete", …)? (as capexir.js applies())
function cxApplies(forText, justif) {
  const t = String(forText || 'All').toLowerCase();
  if (!t || /\ball\b/.test(t) || !justif) return true;
  const j = justif.toLowerCase();
  return (/replac|obsol/.test(t) && /replac|obsol/.test(j)) || (/capacity/.test(t) && /growth|capacity/.test(j)) || (/improvement|productiv/.test(t) && /improvement|productiv/.test(j)) || (/complian/.test(t) && /complian/.test(j)) || (/footprint|strateg/.test(t) && /footprint|strateg/.test(j));
}

// 📑 Where the IR templates are saved (and the business unit and site they're filled in with): CAPEX ⋯ › IR templates
async function cxIrTemplates() {
  const s = state.settings; let meta = null;
  const body = () => `
    <div class="modal-head"><h2 style="margin:0">📑 IR templates</h2><button class="icon" data-action="close-modal">✕</button></div>
    <p class="small muted" style="margin-top:0">The corporate financial model (.xlsx) and IR deck (.pptx) each investment's <b>⬇ IR pack</b> fills in. They're read from where they're saved each time, so saving a new version there is all it takes. Changing these needs the setup right.</p>
    <form id="cxir-tpl" class="form-grid">
      <label class="f full">Financial model template<input type="text" name="capex_ir_model" value="${esc(s.capex_ir_model || '')}" placeholder="e.g. S:\\…\\IR Template – Financial model.xlsx">
        ${meta ? `<span class="small ${meta.model.error ? 'pl-late' : 'muted'}">${esc(meta.model.error || `✓ Read: ${meta.model.bus.length} business units (${meta.model.bus.join(', ')})`)}</span>` : ''}</label>
      <label class="f full">IR deck template<input type="text" name="capex_ir_deck" value="${esc(s.capex_ir_deck || '')}" placeholder="e.g. S:\\…\\IR Template – IR presentation.pptx">
        ${meta ? `<span class="small ${meta.deck.error ? 'pl-late' : 'muted'}">${esc(meta.deck.error || `✓ Read: ${meta.deck.checklist.length} checklist questions`)}</span>` : ''}</label>
      <label class="f">Business unit <span class="small muted">— the usual one</span><input type="text" name="capex_ir_bu" value="${esc(s.capex_ir_bu || '')}"></label>
      <label class="f">Site <span class="small muted">— the usual one</span><input type="text" name="capex_ir_site" value="${esc(s.capex_ir_site || '')}"></label>
      <label class="f full">File names <span class="small muted">— the deck and the model are named by this pattern</span><input type="text" name="capex_ir_name" id="cxir-name" value="${esc(s.capex_ir_name || 'InvestCo {project} {ref}')}">
        <span class="small muted">{project} the title · {ref} the short ref (C-0001) · {site} · {bu} business unit · {irn} the IR n° · {doc} IR deck / Financial model (without it, both share the name). e.g. <i id="cxir-name-eg"></i></span></label>
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Close</button><button class="primary" type="submit">Save</button></div>
    </form>`;
  const example = () => { const el = $('#cxir-name-eg'); if (!el) return;
    const v = { project: 'Second laser line', ref: 'C-0007', site: s.capex_ir_site || 'Site', bu: s.capex_ir_bu || 'BU', irn: 'IR-26-014', doc: 'IR deck' };
    el.textContent = `${($('#cxir-name').value || '').replace(/\{(\w+)\}/g, (w, k) => v[k.toLowerCase()] ?? w).replace(/\s+/g, ' ').trim()}.pptx`; };
  const draw = () => {
    openModal(body());
    example(); $('#cxir-name').oninput = example;
    $('#cxir-tpl').onsubmit = async (e) => {
      e.preventDefault();
      try { state.settings = await api.patch('/settings', Object.fromEntries(new FormData(e.target))); Object.assign(s, state.settings); meta = await cxIrMeta(true); toast('Saved'); draw(); } catch (err) { toast(err.message, 'error'); }
    };
  };
  draw();
  try { meta = await cxIrMeta(true); if (modal().open && $('#cxir-tpl')) draw(); } catch { /* shown when saved */ }
}
