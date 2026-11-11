'use strict';
// 📄 A project's charter on one A4 page (PDF): who leads it, when it's due and how far it's got, then the
// charter itself: problem, goals, scope and benefits on the left; team, KPIs, plan and the rest on the right.
// Long text is shortened (…) so it always fits one page; the Excel export holds it in full.
const { pdf } = require('./capex');
const charter = require('./charter');

const { pdfDoc, band, clean, fmtMoney, fmtDate, BRAND, BRAND2, INK, MUTED, LINE } = pdf;
const STATUS = { active: ['Active', '#238446'], on_hold: ['On hold', '#b86e00'], completed: ['Completed', '#430099'], archived: ['Archived', '#555555'] };
const RAG = { Green: '#238446', Yellow: '#d49b00', Red: '#c93636' };

// p: the project; x: charterExtras; spent: the costs in its currency
async function onePager(p, x, { currency = '£', spent = 0, stamp = '' } = {}) {
  const cur = p.currency || currency;
  const v = charter.values(p, x);
  const comp = charter.completeness(p, x);
  const { doc, done } = pdfDoc(`Charter ${p.project_code || ''} ${p.name}`);
  const W = doc.page.width; const L = 36; const R = W - 36;
  const [stLabel, stCol] = STATUS[p.status] || [p.status, '#555555'];
  band(doc, p.name, [p.project_code, p.category, p.sponsor && `sponsor ${p.sponsor}`, p.leader && `led by ${p.leader}`].filter(Boolean).join(' · ') || 'Project charter',
    Object.assign(new String(stLabel), { col: stCol }));

  // key figures as tiles
  let y = 92;
  const tasks = x.tasks || []; const doneN = tasks.filter((t) => t.status === 'done').length;
  const moved = p.baseline_due_at && p.due_at && String(p.baseline_due_at).slice(0, 10) !== String(p.due_at).slice(0, 10);
  const tiles = [
    ['Start', fmtDate(p.start_date), ''],
    ['Due', fmtDate(p.due_at), moved ? `baseline ${fmtDate(p.baseline_due_at)}` : ''],
    ['Tasks done', tasks.length ? `${doneN} of ${tasks.length}` : '—', tasks.length ? `${Math.round((doneN / tasks.length) * 100)}%` : ''],
    ['Budget', p.budget ? fmtMoney(p.budget, cur) : '—', spent ? `${fmtMoney(spent, cur)} spent` : ''],
    ['Charter', `${comp.pct}%`, comp.missing.length ? `${comp.missing.length} to fill in` : 'complete'],
  ];
  const tw = (R - L - 4 * 8) / 5;
  tiles.forEach(([l, val, sub], i) => {
    const tx = L + i * (tw + 8);
    doc.roundedRect(tx, y, tw, 50, 6).lineWidth(1).fillAndStroke('#f5f4fc', LINE); doc.rect(tx, y, 3, 50).fill(i ? BRAND2 : BRAND);
    doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(l.toUpperCase(), tx + 10, y + 7, { lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(13).text(clean(val), tx + 10, y + 18, { width: tw - 14, height: 16, ellipsis: true });
    if (sub) doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text(clean(sub), tx + 10, y + 36, { width: tw - 14, height: 12, ellipsis: true });
  });
  y += 62;
  if (comp.missing.length) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(clean(`Still to fill in: ${comp.missing.join(', ')}`), L, y, { width: R - L, height: 22, ellipsis: true });
    y += doc.heightOfString(clean(`Still to fill in: ${comp.missing.join(', ')}`), { width: R - L }) > 12 ? 24 : 14;
  }
  y += 4;

  const bottom = doc.page.height - 40;
  const head = (h, cx, cy, w) => {
    doc.fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text(h, cx, cy, { lineBreak: false });
    doc.moveTo(cx, cy + 13).lineTo(cx + w, cy + 13).lineWidth(1).strokeColor(BRAND2).stroke();
    return cy + 18;
  };
  // a column of sections, each given what it needs while the page allows (shared out fairly); a section is
  // [heading, text] or [heading, draw(cx, cy, w, h) → height used, need]
  const column = (sections, cx, w) => {
    const list = sections.filter((x) => (typeof x[1] === 'function' ? x[2] > 0 : x[1] && String(x[1]).trim()));
    doc.font('Helvetica').fontSize(9);
    const needs = list.map((x) => (typeof x[1] === 'function' ? x[2] : doc.heightOfString(clean(x[1]), { width: w })) + 24);
    // everything fits: each what it needs; else the short ones in full and the rest share what's left
    const room = bottom - y - 6 * list.length; const gives = needs.slice();
    if (needs.reduce((a, b) => a + b, 0) > room) {
      let left = room; let open = needs.map((_, k) => k);
      for (;;) { const share = left / open.length; const small = open.filter((k) => needs[k] <= share); if (!small.length) break; small.forEach((k) => { left -= needs[k]; }); open = open.filter((k) => needs[k] > share); if (!open.length) break; }
      open.forEach((k) => { gives[k] = Math.max(36, left / open.length); });
    }
    let cy = y;
    list.forEach((x, k) => {
      const by = head(x[0], cx, cy, w);
      if (typeof x[1] === 'function') x[1](cx, by, w, gives[k] - 24);
      else doc.fillColor(INK).font('Helvetica').fontSize(9).text(clean(x[1]), cx, by, { width: w, height: gives[k] - 22, ellipsis: true });
      cy += gives[k] + 6;
    });
  };
  const LW = (R - L) * 0.56; const RX = L + LW + 18; const RW = R - RX;

  // left: the case for the project
  const scope = (cx, cy, w, h) => {
    const hw = (w - 12) / 2;
    [['In scope', p.in_scope], ['Out of scope', p.out_scope]].forEach(([l, t], i) => {
      const sx = cx + i * (hw + 12);
      doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8).text(l.toUpperCase(), sx, cy, { lineBreak: false });
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(clean(t) || '—', sx, cy + 11, { width: hw, height: Math.max(10, h - 12), ellipsis: true });
    });
  };
  doc.font('Helvetica').fontSize(9);
  const scopeNeed = (p.in_scope || p.out_scope) ? Math.max(...[p.in_scope, p.out_scope].map((t) => doc.heightOfString(clean(t) || '—', { width: (LW - 12) / 2 }))) + 12 : 0;
  column([
    ['Problem definition', p.problem], ['Goals of the project', p.goals], ['Scope', scope, scopeNeed],
    ['Quantified business benefits', p.benefits_quantified], ['Not quantified business benefits', p.benefits_other],
  ], L, LW);

  // right: who, what's measured, the plan, the rest
  const lines = (rows, lineH = 13) => (cx, cy, w, h) => {
    const fit = Math.max(1, Math.floor(h / lineH)); const shown = rows.length > fit ? rows.slice(0, fit - 1) : rows;
    shown.forEach((r, i) => r(cx, cy + i * lineH, w));
    if (rows.length > shown.length) doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`… and ${rows.length - shown.length} more`, cx, cy + shown.length * lineH, { lineBreak: false });
  };
  const team = x.team.map((m) => (cx, cy, w) => {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(clean(m.name), cx, cy, { width: w * 0.45, height: 12, ellipsis: true });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(clean([m.role, m.capacity && `capacity ${m.capacity}`].filter(Boolean).join(' · ')), cx + w * 0.47, cy + 0.5, { width: w * 0.53, height: 12, ellipsis: true });
  });
  const kpis = x.kpis.map((k) => (cx, cy, w) => {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(clean(`${k.name}${k.unit ? ` (${k.unit})` : ''}`), cx, cy, { width: w * 0.5, height: 12, ellipsis: true });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(clean(`${k.baseline || '?'} > ${k.target || '?'}${k.current ? `, now ${k.current}` : ''}`), cx + w * 0.52, cy + 0.5, { width: w * 0.48, height: 12, ellipsis: true });
  });
  const plan = v.timeline.sub.map((s) => (cx, cy, w) => {
    doc.circle(cx + 4, cy + 4.5, 3.5).fill(RAG[s.status] || MUTED);
    doc.fillColor(s.done ? MUTED : INK).font('Helvetica').fontSize(9).text(clean(s.title), cx + 12, cy, { width: w * 0.62 - 12, height: 12, ellipsis: true });
    doc.fillColor(MUTED).fontSize(8.5).text(s.done ? `done ${fmtDate(s.completed)}` : s.due ? `due ${fmtDate(s.due)}` : 'no date', cx + w * 0.64, cy + 0.5, { width: w * 0.36, align: 'right', lineBreak: false });
  });
  const facts = [['Policy deployment', p.policy_deployment], ['Gross margin effect', p.gm_effect]].filter(([, t]) => t && String(t).trim());
  const factRows = facts.map(([l, t]) => (cx, cy, w) => {
    doc.fillColor(MUTED).font('Helvetica').fontSize(8.5).text(l, cx, cy, { width: 92, lineBreak: false });
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(9).text(clean(t).replace(/\s+/g, ' '), cx + 94, cy, { width: w - 94, height: 12, ellipsis: true });
  });
  column([
    ['Team', lines(team), team.length * 13], ['Improvement KPIs', lines(kpis), kpis.length * 13],
    [x.phases?.length ? 'Phases' : 'Milestones', lines(plan), plan.length * 13], ['Other details', lines(factRows, 15), factRows.length * 15], ['Next action', p.next_action],
  ], RX, RW);

  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`SITHUB · project charter · ${clean(stamp)}`, L, doc.page.height - 24, { width: R - L, align: 'right', lineBreak: false });
  doc.end(); return done;
}

module.exports = { onePager };
