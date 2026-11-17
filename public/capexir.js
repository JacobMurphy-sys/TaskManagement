// 📑 The IR pack tabs of an investment's window (💶 CAPEX): what the corporate IR deck and financial model
// need beyond the essentials — the request, items and quotes, cash-out and milestones, the business case
// and the checklist. Kept with the investment (its `ir`) and saved with it; ⬇ IR pack fills the templates.

const CXIR_TABS = [['request', 'Request'], ['items', 'Items & quotes'], ['cash', 'Cash-out & plan'], ['case', 'Business case'], ['check', 'Checklist']];
let cxIrMetaCache = null;
const cxIrMeta = async (fresh = false) => { if (!cxIrMetaCache || fresh) cxIrMetaCache = await api.get('/capex/ir/meta'); return cxIrMetaCache; };

function cxIrEmpty() {
  return { ir_number: '', bu: '', bu_leader: '', site: '', nature: '', justif: '', budgeted: '', budget: { capex: null, cashout_year: null, opex: null, payback: null, roi: null },
    cap_start: '', depreciation_years: null, detail: '', reasons: ['', '', ''], risks: ['', '', ''], items: [], quotes: [], selection_reason: '',
    freight: { sea: { co2: '', lead: '', price: null }, air: { co2: '', lead: '', price: null } }, freight_mode: '', freight_reason: '',
    negotiation: { purchaser: '', explanation: '', conditions: '', gains: '' }, milestones: { investco: '', po: '', fat: '', delivery: '', sat: '', sop: '' },
    planning_comments: '', cashout_comments: '', savings: {}, growth: [], risks_opps: [], checklist: {} };
}
function cxIrOf(x) {
  let r = {}; try { r = JSON.parse(x?.ir || '{}') || {}; } catch { r = {}; }
  const e = cxIrEmpty(); const out = { ...e, ...r };
  for (const k of ['budget', 'negotiation', 'milestones']) out[k] = { ...e[k], ...(r[k] || {}) };
  out.freight = { sea: { ...e.freight.sea, ...(r.freight?.sea || {}) }, air: { ...e.freight.air, ...(r.freight?.air || {}) } };
  for (const k of ['reasons', 'risks']) { out[k] = [...(r[k] || [])]; while (out[k].length < 3) out[k].push(''); }
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

  const panes = {
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
  let tab = store.get('cxIrTab', 'request');
  const head = () => {
    const parts = status?.parts || [];
    const R = status?.results; const k = (v) => (v === null || v === undefined ? '–' : `${Math.round(v).toLocaleString('en-GB')} k${cur()}`);
    return `<div class="cx-irhead">${x?.id ? `${parts.map((p) => `<span class="cx-ok ${p.ok ? 'ok' : ''}" title="${esc(p.text)}">${p.ok ? '✓' : '•'} ${esc(p.part)}</span>`).join('')}
      ${R ? `<div class="small" style="margin-top:4px">As the model works it out: payback <b>${R.payback_years !== null ? `${Math.round(R.payback_years * 12)} months` : '–'}</b> · NPV <b>${k(R.npv)}</b> · ROI <b>${R.roi !== null ? `${Math.round(R.roi * 100)}%` : '–'}</b> · IRR <b>${R.irr !== null ? `${Math.round(R.irr * 100)}%` : '–'}</b> <span class="muted">(as last saved)</span></div>` : status?.model_error ? `<div class="small muted" style="margin-top:4px">${esc(status.model_error)}</div>` : ''}
      ${(status?.notes || []).length ? `<details class="small"><summary class="muted">${status.notes.length} note${status.notes.length === 1 ? '' : 's'} on how it's filled in</summary><ul class="mini">${status.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>` : ''}`
      : '<span class="small muted">Save the investment to download its IR pack.</span>'}</div>`;
  };
  function render() {
    root.innerHTML = `${head()}<div class="seg cx-irtabs">${CXIR_TABS.map(([k, l]) => `<button type="button" data-cxir-tab="${k}" class="${tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="cx-irpane">${meta ? panes[tab]() : '<div class="empty small">Reading the IR templates…</div>'}</div>`;
    joinLabels?.();
  }
  // typing changes the record; leaving a field that totals or layout depend on redraws (once the focus has moved on)
  const take = (el) => {
    const t = el.dataset.t; let v = t === 'bool' ? el.checked : el.value;
    if (t === 'num') v = v === '' ? null : Number(v);
    if (el.type === 'radio' && !el.checked) return;
    cxSetPath(ir, el.dataset.k, v);
  };
  const LAYOUT = /^(items\.\d+\.(amount|kind|name)|freight_mode|justif|depreciation_years|cap_start|milestones\.\w+|growth\.\d+\.customer)$|\.cashout\.|^savings\./;
  root.addEventListener('input', (e) => { const el = e.target.closest('[data-k]'); if (el) take(el); });
  root.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'cxir-cofrom') { ui.coFrom = el.value; rerender(); return; }
    if (el.id === 'cxir-con') { ui.coN = Number(el.value); rerender(); return; }
    if (!el.matches('[data-k]')) return;
    take(el);
    if (LAYOUT.test(el.dataset.k)) setTimeout(rerender, 0);
  });
  // keep the focus and scroll where they were across a redraw
  function rerender() {
    const k = document.activeElement?.dataset?.k; const sc = root.closest('.modal-body, #modal-body, dialog')?.scrollTop;
    render();
    if (k) { const el = root.querySelector(`[data-k="${CSS.escape(k)}"]`); if (el) { el.focus(); try { el.setSelectionRange?.(el.value.length, el.value.length); } catch { /* not a text box */ } } }
    const box = root.closest('.modal-body, #modal-body, dialog'); if (box && sc !== undefined) box.scrollTop = sc;
  }
  root.addEventListener('click', (e) => {
    const t = e.target.closest('[data-cxir-tab]'); if (t) { tab = t.dataset.cxirTab; store.set('cxIrTab', tab); render(); return; }
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
    if (a === 'del-ro') ir.risks_opps.splice(i, 1);
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
    modalFormDirty = true; rerender();
  });
  render();
  cxIrMeta().then((m) => { meta = m; render(); }).catch((err) => { meta = { model: { bus: [], error: err.message }, deck: { checklist: [], error: err.message } }; render(); });
  if (x?.id) api.get(`/capex/${x.id}/ir`).then((s) => { status = s; render(); }).catch(() => {});
  return { value: () => ir };
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
      <div class="full row"><div class="spacer"></div><button type="button" data-action="close-modal">Close</button><button class="primary" type="submit">Save</button></div>
    </form>`;
  const draw = () => {
    openModal(body());
    $('#cxir-tpl').onsubmit = async (e) => {
      e.preventDefault();
      try { state.settings = await api.patch('/settings', Object.fromEntries(new FormData(e.target))); Object.assign(s, state.settings); meta = await cxIrMeta(true); toast('Saved'); draw(); } catch (err) { toast(err.message, 'error'); }
    };
  };
  draw();
  try { meta = await cxIrMeta(true); if (modal().open && $('#cxir-tpl')) draw(); } catch { /* shown when saved */ }
}
