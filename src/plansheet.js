'use strict';
// 📄 Generate plan: the operator sheets as a PDF (A4), drawn from the model the Planning page
// builds — a sheet per cell (or Otto list), or all side by side, each row with a tick box, its
// place in the order, the work order, customer, cards and deadline, colour-coded.
//
// model = { layout: 'pages' | 'side', method, test, stamp, title, running_legend,
//   pages: [{ sections: [{ name, overdue, empty, rows: [{ no, running, wo, suffix, note, customer,
//            hot, pinned, qty, cls: late|today|tomorrow|later, tag, time }] }] }],
//   spec: [{ h1 | h2 | p | note: text } | { ul | ol: [text] }] }   (text may hold **bold**)

const PDFDocument = require('pdfkit');

const ACCENT = '#7382e6';
const C = { late: '#fde2e2', today: '#fff4d6', lateTag: '#c62828', todayTag: '#f9a825', tomorrow: '#1f6feb', grey: '#555555', line: '#bbbbbb', ink: '#111111' };
const M = 28; // page margin (10 mm)
// Side by side the deadline is one coloured pill — always the date and time, the colour saying
// late / today / tomorrow.
const pillText = (r) => {
  if (r.day) return [r.day, String(r.time || '').replace(/^\d{1,2}\/\d{1,2} /, '')].filter(Boolean).join(' ');
  return r.cls === 'later' || r.cls === 'late' ? [r.cls === 'later' ? r.tag : '', r.time].filter(Boolean).join(' ') : r.time || r.tag;
};

// Only characters the built-in PDF fonts have (WinAnsi): arrows, emoji and the like are replaced.
const clean = (s) => String(s ?? '').replace(/≈/g, '~').replace(/[▶►]/g, '>').replace(/[^\x20-\x7E -ÿ–—‘’“”•…€]/gu, '').trim();

function renderPlanPdf(model) {
  const side = model.layout === 'side';
  const doc = new PDFDocument({ size: 'A4', layout: side ? 'landscape' : 'portrait', margin: M, autoFirstPage: false, bufferPages: true,
    info: { Title: clean(model.title || 'Production plan'), Creator: 'CI Manager' } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const W = () => doc.page.width; const H = () => doc.page.height;
  const legendH = 16;
  const tw = (font, size, s) => doc.font(font).fontSize(size).widthOfString(clean(s));

  // the legend and the printed time, at the foot of each sheet page
  const legend = () => {
    const y = H() - M - 9; let x = M;
    doc.lineWidth(0.5);
    const sw = (fill, stroke, label) => { doc.rect(x, y, 8, 8).fillAndStroke(fill, stroke); doc.fillColor(C.ink).font('Helvetica').fontSize(7).text(label, x + 11, y + 1, { lineBreak: false }); x += 11 + tw('Helvetica', 7, label) + 12; };
    sw(C.late, '#999999', 'late'); sw(C.today, '#999999', 'due today'); sw('#ffffff', C.tomorrow, 'tomorrow');
    if (model.running_legend) { doc.save().moveTo(x, y).lineTo(x + 7, y + 4).lineTo(x, y + 8).fill(C.ink).restore(); doc.fillColor(C.ink).font('Helvetica').fontSize(7).text('running', x + 10, y + 1, { lineBreak: false }); x += 10 + tw('Helvetica', 7, 'running') + 12; }
    doc.circle(x + 4, y + 4, 4).fill(C.ink); doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6).text('!', x + 2.6, y + 1.6, { lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica').fontSize(7).text('high priority', x + 11, y + 1, { lineBreak: false }); x += 11 + tw('Helvetica', 7, 'high priority') + 12;
    doc.rect(x, y, 8, 8).lineWidth(1).stroke(C.ink); doc.fillColor(C.ink).font('Helvetica').fontSize(7).text('tick when done', x + 11, y + 1, { lineBreak: false });
    const st = `Printed ${clean(model.stamp)}`;
    doc.fillColor('#777777').font('Helvetica').fontSize(7).text(st, W() - M - tw('Helvetica', 7, st), y + 1, { lineBreak: false });
  };

  // Column widths for a section's rows at font size f (the work order column takes what's left).
  const sfx = side ? 0.8 : 1; // the PER / job suffix, a little smaller side by side
  const widthsAt = (rows, f) => {
    const tagF = f * 0.72;
    if (side) {
      const max = (fn) => rows.reduce((m, r) => Math.max(m, fn(r)), 0);
      return {
        box: f * 1.25 + 3, no: Math.max(tw('Helvetica-Bold', f, '00'), max((r) => tw('Helvetica-Bold', f, r.no))) + 4,
        wo: max((r) => Math.max(tw('Courier-Bold', f, r.wo) + tw('Courier', f * sfx, r.suffix), r.note ? tw('Helvetica', f * 0.66, r.note) : 0)) + 5,
        cust: max((r) => tw('Helvetica-Bold', f, r.customer) + (r.hot ? f + 2 : 0) + (r.pinned ? tw('Helvetica-Bold', f * 0.6, 'PIN') + 6 : 0)) + 5,
        qty: max((r) => tw('Helvetica-Bold', f, r.qty)) + 6,
        tag: max((r) => tw('Helvetica-Bold', f * 0.85, pillText(r))) + 8, time: 0, gap: 0,
      };
    }
    const max = (fn) => rows.reduce((m, r) => Math.max(m, fn(r)), 0);
    return {
      box: f * 1.25 + 5,
      no: Math.max(tw('Helvetica-Bold', f, '00'), max((r) => tw('Helvetica-Bold', f, r.no))) + 6,
      wo: max((r) => Math.max(tw('Courier-Bold', f, r.wo) + tw('Courier', f, r.suffix), r.note ? tw('Helvetica', f * 0.66, r.note) : 0)) + 8,
      cust: max((r) => tw('Helvetica-Bold', f, r.customer) + (r.hot ? f + 3 : 0) + (r.pinned ? tw('Helvetica-Bold', f * 0.6, 'PIN') + 7 : 0)) + 8,
      qty: max((r) => tw('Helvetica-Bold', f, r.qty)) + 8,
      tag: max((r) => tw('Helvetica-Bold', tagF, r.tag)) + 10,
      time: max((r) => tw('Helvetica', f, r.time)) + 4, gap: 4,
    };
  };
  // the font size and widths that fit the column width (smaller text when columns are narrow)
  const fit = (rows, colW, base) => {
    let f = base; let w = widthsAt(rows, f);
    const sum = (x) => x.box + x.no + x.wo + x.cust + x.qty + x.tag + x.gap + x.time;
    for (let i = 0; i < 8 && sum(w) > colW && f > 5; i++) { f = Math.max(5, f * (colW / sum(w)) * 0.99); w = widthsAt(rows, f); }
    w.wo += Math.max(0, colW - sum(w)); // spare room to the work order column
    return { f, w };
  };

  // One section's header at (x, y) in a column of width colW; returns the y below it.
  const header = (s, x, y, colW, cont) => {
    doc.rect(x, y, colW, side ? 5 : 7).fill(ACCENT);
    y += side ? 9 : 12;
    const nameF = side ? 18 : 30;
    if (model.method) {
      const t = `${clean(model.method).toUpperCase()}${model.test ? ' · TEST' : ''}`;
      const tf = side ? 5.5 : 7; const w = tw('Helvetica-Bold', tf, t) + 8;
      doc.roundedRect(x + colW - w, y, w, tf + 5, 2).lineWidth(0.6).stroke('#999999');
      doc.fillColor(C.grey).font('Helvetica-Bold').fontSize(tf).text(t, x + colW - w + 4, y + 2.6, { lineBreak: false });
    }
    let name = clean(s.name).toUpperCase(); const nameMax = colW - (model.method ? (side ? 50 : 70) : 0);
    let nf = nameF; while (nf > 8 && tw('Helvetica-Bold', nf, name) > nameMax) nf -= 1;
    doc.fillColor(ACCENT).font('Helvetica-Bold').fontSize(nf).text(name, x, y, { lineBreak: false });
    if (cont) { const cw = tw('Helvetica-Bold', nf, name); doc.fillColor(C.grey).font('Helvetica').fontSize(nf * 0.45).text('(continued)', x + cw + 6, y + nf * 0.45, { lineBreak: false }); }
    y += nf * 1.05;
    if (s.overdue) {
      const bf = side ? 7.5 : 10; const bw = tw('Helvetica-Bold', bf, 'OVERDUE') + 12;
      doc.roundedRect(x, y + 1, bw, bf + 6, 2.5).fill(C.lateTag);
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(bf).text('OVERDUE', x + 6, y + 4, { lineBreak: false });
      y += bf + 9;
    }
    doc.moveTo(x, y + 2).lineTo(x + colW, y + 2).lineWidth(1.4).stroke(C.ink);
    return y + 6;
  };

  const rowH = (r, f) => f * 1.95 + (r.note ? f * 0.62 : 0);
  // One row at (x, y); returns its height.
  const row = (r, x, y, colW, f, w) => {
    const h = rowH(r, f);
    if (r.cls === 'late' || r.cls === 'today') doc.rect(x, y, colW, h).fill(r.cls === 'late' ? C.late : C.today);
    doc.moveTo(x, y + h).lineTo(x + colW, y + h).lineWidth(0.5).stroke(C.line);
    const mid = y + h / 2; const ty = (size) => mid - size * 0.36 - (r.note ? f * 0.3 : 0);
    let cx = x + 2;
    const b = f * 1.1; doc.roundedRect(cx, mid - b / 2, b, b, 1.5).lineWidth(Math.max(0.8, f * 0.1)).stroke(C.ink); cx += w.box;
    if (r.running) doc.save().moveTo(cx + w.no - f * 0.9 - 3, mid - f * 0.4).lineTo(cx + w.no - 3, mid).lineTo(cx + w.no - f * 0.9 - 3, mid + f * 0.4).fill(C.ink).restore();
    else doc.fillColor('#666666').font('Helvetica-Bold').fontSize(f).text(clean(r.no), cx - 3, ty(f), { width: w.no, align: 'right', lineBreak: false });
    cx += w.no + 3;
    doc.fillColor(C.ink).font('Courier-Bold').fontSize(f).text(clean(r.wo), cx, ty(f), { lineBreak: false, continued: !!r.suffix });
    if (r.suffix) doc.fillColor(C.grey).font('Courier').fontSize(f * sfx).text(clean(r.suffix), { lineBreak: false });
    if (r.note) doc.fillColor(C.grey).font('Helvetica').fontSize(f * 0.66).text(clean(r.note), cx, ty(f) + f * 1.1, { lineBreak: false });
    cx += w.wo - 3;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(f).text(clean(r.customer), cx, ty(f), { lineBreak: false });
    let px = cx + tw('Helvetica-Bold', f, r.customer) + 3;
    if (r.hot) { doc.circle(px + f * 0.45, mid - (r.note ? f * 0.3 : 0), f * 0.45).fill(C.ink); doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(f * 0.7).text('!', px + f * 0.45 - tw('Helvetica-Bold', f * 0.7, '!') / 2, ty(f * 0.7) + 0.2, { lineBreak: false }); px += f + 3; }
    if (r.pinned) { const pf = f * 0.6; const pw = tw('Helvetica-Bold', pf, 'PIN') + 5; doc.roundedRect(px, mid - pf * 0.75 - (r.note ? f * 0.3 : 0), pw, pf * 1.5, 1.5).lineWidth(0.6).stroke(C.grey); doc.fillColor(C.grey).font('Helvetica-Bold').fontSize(pf).text('PIN', px + 2.5, ty(pf), { lineBreak: false }); }
    cx += w.cust;
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(f).text(clean(r.qty), cx - 2, ty(f), { width: w.qty, align: 'right', lineBreak: false });
    cx += w.qty;
    // the deadline tag (LATE / TODAY / TOMORROW / date) and the time, right-aligned — side by side
    // one pill with the time in it
    if (side) {
      const pf = f * 0.85; const ph = pf * 1.75; const py = mid - ph / 2 - (r.note ? f * 0.3 : 0);
      const pw = w.tag - 3; const px2 = x + colW - pw;
      if (r.cls === 'late') doc.roundedRect(px2, py, pw, ph, 2).fill(C.lateTag);
      else if (r.cls === 'today') doc.roundedRect(px2, py, pw, ph, 2).fill(C.todayTag);
      else doc.roundedRect(px2, py, pw, ph, 2).lineWidth(0.8).stroke(r.cls === 'tomorrow' ? C.tomorrow : '#999999');
      doc.fillColor(r.cls === 'late' ? '#ffffff' : r.cls === 'tomorrow' ? C.tomorrow : C.ink).font('Helvetica-Bold').fontSize(pf)
        .text(clean(pillText(r)), px2, py + (ph - pf) / 2 + 0.5, { width: pw, align: 'center', lineBreak: false });
      return h;
    }
    const tagF = f * 0.72; const tagH = tagF * 1.9; const tagY = mid - tagH / 2 - (r.note ? f * 0.3 : 0);
    const tagX = x + colW - w.time - w.tag; const tagW = w.tag - 4;
    if (r.cls === 'late') doc.roundedRect(tagX, tagY, tagW, tagH, 2).fill(C.lateTag);
    else if (r.cls === 'today') doc.roundedRect(tagX, tagY, tagW, tagH, 2).fill(C.todayTag);
    else doc.roundedRect(tagX, tagY, tagW, tagH, 2).lineWidth(0.9).stroke(r.cls === 'tomorrow' ? C.tomorrow : '#999999');
    doc.fillColor(r.cls === 'late' ? '#ffffff' : r.cls === 'tomorrow' ? C.tomorrow : C.ink).font('Helvetica-Bold').fontSize(tagF)
      .text(clean(r.tag), tagX, tagY + (tagH - tagF) / 2 + 0.6, { width: tagW, align: 'center', lineBreak: false });
    doc.fillColor(C.ink).font('Helvetica').fontSize(f).text(clean(r.time), x + colW - w.time, ty(f), { width: w.time, align: 'right', lineBreak: false });
    return h;
  };

  // Lays out a group of sections side by side (one, for a page per cell), page after page until
  // every row is down.
  const sheetPages = (sections) => {
    const n = Math.max(1, sections.length);
    const gap = side ? 9 : 0;
    const left = sections.map((s) => s.rows.slice());
    let cont = false;
    do {
      doc.addPage();
      const colW = (W() - 2 * M - gap * (n - 1)) / n;
      const bottom = H() - M - legendH - 4;
      sections.forEach((s, i) => {
        if (cont && !left[i].length) return;
        const x = M + i * (colW + gap);
        let y = header(s, x, M, colW, cont);
        if (!s.rows.length) { doc.fillColor(C.grey).font('Helvetica').fontSize(side ? 10 : 14).text(clean(s.empty || 'Nothing open.'), x, y + 8, { lineBreak: false }); return; }
        const { f, w } = fit(s.rows, colW, side ? 9.5 : 13);
        while (left[i].length && y + rowH(left[i][0], f) <= bottom) y += row(left[i].shift(), x, y, colW, f, w);
      });
      legend();
      cont = true;
    } while (left.some((l) => l.length));
  };

  // 🧪 the testing page: headings, paragraphs and lists, **bold** where marked
  const rich = (text, x, width, size, opts = {}) => {
    const parts = clean(text).split(/\*\*/);
    parts.forEach((p, i) => {
      doc.font(i % 2 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(opts.color || C.ink);
      const last = i === parts.length - 1;
      if (i === 0) doc.text(p, x, doc.y, { width, continued: !last, lineGap: 2 });
      else doc.text(p, { continued: !last, lineGap: 2 });
    });
  };
  const specPage = (blocks) => {
    doc.addPage({ size: 'A4', layout: 'portrait', margin: M });
    const width = W() - 2 * M; doc.y = M;
    for (const b of blocks) {
      if (b.h1) { doc.font('Helvetica-Bold').fontSize(18).fillColor(C.ink).text(clean(b.h1), M, doc.y, { width }); doc.moveDown(0.2); }
      else if (b.h2) { doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(12).fillColor(C.ink).text(clean(b.h2), M, doc.y, { width }); doc.moveTo(M, doc.y + 1).lineTo(M + width, doc.y + 1).lineWidth(0.6).stroke('#999999'); doc.moveDown(0.4); }
      else if (b.note) { rich(b.note, M, width, 8.5, { color: C.grey }); doc.moveDown(0.3); }
      else if (b.p) { rich(b.p, M, width, 10.5); doc.moveDown(0.3); }
      else if (b.ul || b.ol) {
        (b.ul || b.ol).forEach((t, i) => {
          const mark = b.ol ? `${i + 1}.` : '•'; const y = doc.y;
          doc.font('Helvetica').fontSize(10.5).fillColor(C.ink).text(mark, M + 6, y, { width: 14, lineBreak: false });
          doc.y = y; rich(t, M + 22, width - 22, 10.5); doc.moveDown(0.25);
        });
      }
    }
  };

  const pages = model.pages || [];
  if (!pages.length || pages.every((p) => !p.sections.length)) {
    doc.addPage(); doc.fillColor(C.grey).font('Helvetica').fontSize(20).text('No open work orders.', M, H() / 2 - 10, { width: W() - 2 * M, align: 'center' });
  }
  for (const p of pages) if (p.sections.length) sheetPages(p.sections);
  if (model.spec?.length) specPage(model.spec);
  doc.end();
  return done;
}

module.exports = { renderPlanPdf, clean };
