'use strict';
// 📈 The quality pack: the Quality team's three monthly charts, drawn to look like their Excel ones (white,
// Excel's fonts and colours, two axes where theirs have two), and copied as a picture into PowerPoint with
// one button. Everything is drawn with inline attributes, so the picture copied is exactly the one shown.
// Loaded before quality.js; uses app.js's helpers.

const QX = {
  font: "Aptos Narrow, Aptos, Calibri, Carlito, 'Segoe UI', Arial, sans-serif",
  text: '#595959', title: '#595959', grid: '#D9D9D9', axis: '#BFBFBF',
  purple: '#43009A', yellow: '#FFC000', blue: '#00A3E0', lightBlue: '#00B0F0', red: '#FF0000', green: '#00B050',
  grey: '#808080', violet: '#7030A0', greyBox: '#BFBFBF', violetBox: '#D9C3F2',
};
const qxEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// a "nice" axis: 0 → max in steps of 1, 2 or 5 × 10^n
function qxAxis(max, { ticks = 7, min = 0, steps = [1, 2, 2.5, 5, 10] } = {}) {
  const span = Math.max(max - min, 1e-9);
  const raw = span / ticks; const p = 10 ** Math.floor(Math.log10(raw));
  const step = steps.map((m) => m * p).find((s) => s >= raw) || 10 * p;
  return { min, max: Math.ceil(max / step - 1e-9) * step || step, step };
}
const qxNum = (v, step) => { const dec = (String(+step.toFixed(6)).split('.')[1] || '').length; return Number(v.toFixed(Math.min(dec, 4))).toString(); }; // as many decimals as the step has

// A combined chart like Excel's: clustered bars and lines over categories, a left and an optional right axis.
// spec: { title, titleAlign, W, H, cats, rotate, legend: 'top' | 'bottom', left: { max, min, fmt, title }, right: {…},
//         bars: [{ name, color, axis, values, labels: { box } }], lines: [{ name, color, axis, values, width }] }
function qxChart(spec) {
  const { W = 760, H = 400 } = spec;
  const titleH = 40; const legendH = 30;
  const top = titleH + (spec.legend === 'top' ? legendH + 6 : 6);
  const catH = spec.rotate ? 48 : 26;
  const bottom = H - catH - (spec.legend === 'bottom' ? legendH : 8);
  const leftW = 44 + (spec.left.title ? 18 : 0);
  const rightW = spec.right ? 50 + (spec.right.title ? 18 : 0) : 18;
  const x0 = leftW; const x1 = W - rightW; const n = spec.cats.length; const cw = (x1 - x0) / n;
  const yOf = (ax, v) => bottom - ((Math.max(ax.min || 0, Math.min(ax.max, v)) - (ax.min || 0)) / (ax.max - (ax.min || 0))) * (bottom - top);
  const t = (x, y, s, o = {}) => `<text x="${x}" y="${y}" fill="${o.fill || QX.text}" font-family="${QX.font}" font-size="${o.size || 12}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ` font-weight="${o.weight}"` : ''}${o.transform ? ` transform="${o.transform}"` : ''}>${qxEsc(s)}</text>`;
  const out = [`<rect x="0" y="0" width="${W}" height="${H}" fill="#FFFFFF"/>`];
  out.push(t(spec.titleAlign === 'left' ? 22 : W / 2, 27, spec.title, { size: spec.titleAlign === 'left' ? 15 : 17, anchor: spec.titleAlign === 'left' ? 'start' : 'middle', fill: QX.title }));
  // the left axis: gridlines and labels
  const L = spec.left;
  for (let v = L.min || 0; v <= L.max + 1e-9; v += L.step) {
    const y = yOf(L, v);
    out.push(`<line x1="${x0}" x2="${x1}" y1="${y}" y2="${y}" stroke="${QX.grid}" stroke-width="1"/>`, t(x0 - 8, y + 4, L.fmt ? L.fmt(v) : qxNum(v, L.step), { anchor: 'end' }));
  }
  if (L.title) out.push(t(16, (top + bottom) / 2, L.title, { anchor: 'middle', transform: `rotate(-90 16 ${(top + bottom) / 2})` }));
  const R = spec.right;
  if (R) {
    for (let v = R.min || 0; v <= R.max + 1e-9; v += R.step) out.push(t(x1 + 8, yOf(R, v) + 4, R.fmt ? R.fmt(v) : qxNum(v, R.step)));
    if (R.title) out.push(t(W - 12, (top + bottom) / 2, R.title, { anchor: 'middle', transform: `rotate(-90 ${W - 12} ${(top + bottom) / 2})` }));
  }
  // categories
  spec.cats.forEach((c, i) => {
    const cx = x0 + cw * (i + 0.5);
    out.push(spec.rotate ? t(cx + 4, bottom + 14, c, { anchor: 'end', transform: `rotate(-45 ${cx + 4} ${bottom + 14})` }) : t(cx, bottom + 18, c, { anchor: 'middle' }));
  });
  // bars: those with a value at a category share its width (clustered, as Excel does)
  const bars = spec.bars || []; const labels = [];
  spec.cats.forEach((_, i) => {
    const here = bars.filter((b) => b.values[i] !== null && b.values[i] !== undefined);
    if (!here.length) return;
    const gw = cw * (spec.gap ?? 0.5); const bw = Math.min(spec.barMax || 30, gw / here.length);
    const gx = x0 + cw * (i + 0.5) - (bw * here.length) / 2;
    here.forEach((b, j) => {
      const ax = b.axis === 'right' ? R : L; const v = b.values[i];
      const y = yOf(ax, v); const x = gx + j * bw;
      if (v > 0) out.push(`<rect x="${x + 1}" y="${y}" width="${Math.max(1, bw - 2)}" height="${Math.max(0, yOf(ax, ax.min || 0) - y)}" fill="${b.color}"/>`);
      if (b.labels) labels.push({ x: x + bw / 2, y, text: b.labels.fmt ? b.labels.fmt(v) : String(Math.round(v)), box: b.labels.box });
    });
  });
  // lines: a value per category (null leaves a gap)
  for (const ln of spec.lines || []) {
    const ax = ln.axis === 'right' ? R : L; let d = ''; let pen = false;
    ln.values.forEach((v, i) => {
      if (v === null || v === undefined || i >= (ln.upTo ?? n)) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${(x0 + cw * (i + 0.5)).toFixed(1)},${yOf(ax, v).toFixed(1)} `; pen = true;
    });
    if (ln.flat) d = `M${x0 + cw * 0.5},${yOf(ax, ln.flat)} L${x0 + cw * ((ln.upTo ?? n) - 0.5)},${yOf(ax, ln.flat)}`;
    if (d) out.push(`<path d="${d}" fill="none" stroke="${ln.color}" stroke-width="${ln.width || 2.5}" stroke-linejoin="round" stroke-linecap="round"/>`);
  }
  // data labels in their little boxes, above the bars
  for (const lb of labels) {
    const w = 8 + lb.text.length * 7; const y = lb.y - 22;
    out.push(`<rect x="${lb.x - w / 2}" y="${y}" width="${w}" height="16" fill="${lb.box}"/>`, t(lb.x, y + 12, lb.text, { anchor: 'middle', size: 11 }));
  }
  out.push(`<line x1="${x0}" x2="${x1}" y1="${bottom}" y2="${bottom}" stroke="${QX.axis}" stroke-width="1"/>`);
  // the legend
  const items = spec.legendItems;
  const widths = items.map((it) => 26 + it.name.length * 6.6);
  const total = widths.reduce((a, b) => a + b, 0) + (items.length - 1) * (spec.legend === 'top' ? 40 : 14);
  let lx = spec.legend === 'top' ? Math.max(x0, (W - total) / 2) : (W - total) / 2;
  const ly = spec.legend === 'top' ? titleH + 14 : H - 12;
  items.forEach((it, i) => {
    out.push(it.kind === 'line' ? `<line x1="${lx}" x2="${lx + 18}" y1="${ly - 4}" y2="${ly - 4}" stroke="${it.color}" stroke-width="2.5"/>` : `<rect x="${lx + 4}" y="${ly - 9}" width="10" height="10" fill="${it.color}"/>`,
      t(lx + 22, ly, it.name, { size: 11.5 }));
    lx += widths[i] + (spec.legend === 'top' ? 40 : 14);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${QX.font}">${out.join('')}</svg>`;
}

// ---- the three charts --------------------------------------------------------------------------------
function qxPackCharts(p, titles = {}) {
  const months = p.months.map((m) => m.month); const cats = [...months, p.ytd.month];
  const n = months.length; const pad = (vals, ytd = null) => [...vals, ytd];
  const pct = (v) => `${Math.round(v * 100)}%`;
  const clamp = (v) => (v === null ? null : Math.max(0, v));
  const vol = p.months.map((m) => m.shipped / 1e6);
  const otd = qxChart({
    title: titles.otd || 'Complaints OTD', W: 820, H: 420, cats, legend: 'bottom', gap: 0.42, barMax: 34,
    left: qxAxis(Math.max(0.2, ...vol) * 1.08, { steps: [1, 2, 5, 10] }), right: { min: 0, max: 1, step: 0.1, fmt: pct },
    bars: [{ name: 'Volume', color: QX.purple, values: pad(vol) },
      { name: 'OTD SC YTD', color: QX.yellow, axis: 'right', values: pad(months.map(() => null), clamp(p.ytd.otd_sc)) },
      { name: 'OTD C YTD', color: QX.blue, axis: 'right', values: pad(months.map(() => null), clamp(p.ytd.otd_c)) }],
    lines: [{ name: 'OTD SC', color: QX.lightBlue, axis: 'right', values: pad(p.months.map((m) => clamp(m.otd_sc))) },
      { name: 'OTD C', color: QX.yellow, axis: 'right', values: pad(p.months.map((m) => clamp(m.otd_c))) },
      { name: 'Target', color: QX.red, axis: 'right', flat: p.targets.otd, upTo: n, values: [] }],
    legendItems: [{ name: 'Volume', color: QX.purple }, { name: 'OTD SC YTD', color: QX.yellow }, { name: 'OTD C YTD', color: QX.blue },
      { name: 'OTD SC', color: QX.lightBlue, kind: 'line' }, { name: 'OTD C', color: QX.yellow, kind: 'line' }, { name: 'Target', color: QX.red, kind: 'line' }],
  });
  const cpmsVals = p.months.map((m) => m.cpms);
  const rmax = Math.max(p.targets.cpms, p.ytd.cpms || 0, ...cpmsVals.filter((v) => v !== null)) * 1.1 || 1;
  const cpms = qxChart({
    title: titles.cpms || 'CPMS Quality', W: 820, H: 420, cats, rotate: true, legend: 'bottom', gap: 0.3, barMax: 22,
    left: { ...qxAxis(Math.max(1, ...p.months.map((m) => m.cc)) * 1.2, { ticks: 5 }), title: '# of CC Quality' }, right: { ...qxAxis(rmax, { ticks: 10 }), title: 'CPMS' },
    bars: [{ name: 'CC Quality SC', color: QX.green, values: pad(p.months.map((m) => m.cc)) },
      { name: 'CPMS Quality YTD', color: QX.yellow, axis: 'right', values: pad(months.map(() => null), p.ytd.cpms) }],
    lines: [{ name: 'CPMS Quality SC', color: QX.yellow, axis: 'right', values: pad(cpmsVals.map((v) => (v === null ? null : v))), upTo: n },
      { name: 'Target CPMS', color: QX.red, axis: 'right', flat: p.targets.cpms, upTo: n, values: [] }],
    legendItems: [{ name: 'CC Quality SC', color: QX.green }, { name: 'CPMS Quality YTD', color: QX.yellow }, { name: 'CPMS Quality SC', color: QX.yellow, kind: 'line' }, { name: 'Target CPMS', color: QX.red, kind: 'line' }],
  });
  const lmax = Math.max(p.targets.contain, p.targets.communicate, ...p.months.map((m) => Math.max(m.contain, m.communicate))) * 1.15;
  const lead = qxChart({
    title: titles.lead || 'Lead Time Service Center', titleAlign: 'left', W: 1100, H: 330, cats: months, legend: 'top', gap: 0.5, barMax: 32,
    left: qxAxis(lmax, { ticks: 5 }),
    bars: [{ name: 'Lead Time to be Contained', color: QX.grey, values: p.months.map((m) => m.contain), labels: { box: QX.greyBox, fmt: (v) => String(Math.round(v)) } },
      { name: 'Lead Time to be Communicated', color: QX.violet, values: p.months.map((m) => m.communicate), labels: { box: QX.violetBox, fmt: (v) => String(Math.round(v)) } }],
    lines: [{ name: 'Target Lead Time to be Contained', color: QX.violet, flat: p.targets.contain, values: [] },
      { name: 'Target Lead Time to be Communicated', color: QX.grey, flat: p.targets.communicate, values: [] }],
    legendItems: [{ name: 'Lead Time to be Contained', color: QX.grey }, { name: 'Lead Time to be Communicated', color: QX.violet },
      { name: 'Target Lead Time to be Contained', color: QX.violet, kind: 'line' }, { name: 'Target Lead Time to be Communicated', color: QX.grey, kind: 'line' }],
  });
  return [['otd', titles.otd || 'Complaints OTD', otd], ['cpms', titles.cpms || 'CPMS Quality', cpms], ['lead', titles.lead || 'Lead Time Service Center', lead]];
}

// ---- 📋 copy into PowerPoint, ⬇ save as a picture ------------------------------------------------------
// The chart as a PNG, twice its size (sharp on the slide).
function qxPng(svg, scale = 2) {
  return new Promise((resolve, reject) => {
    const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/); const w = Number(m[1]); const h = Number(m[2]);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = w * scale; c.height = h * scale;
      const g = c.getContext('2d'); g.scale(scale, scale); g.drawImage(img, 0, 0, w, h);
      c.toBlob((b) => (b ? resolve({ blob: b, w, h }) : reject(new Error('Couldn\'t make the picture'))), 'image/png');
    };
    img.onerror = () => reject(new Error('Couldn\'t draw the chart'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}
const qxDataUrl = (blob) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); });
// Copies the chart as a picture. Over https (or on the server PC itself) the browser lets a page put an image on
// the clipboard; over plain http it doesn't, so the picture goes as a web-page image, which Office pastes as a picture.
// ready: the picture made beforehand ({ blob, w, h, url }), so the copy happens straight away, still part of the click.
const qxReady = (svg) => qxPng(svg).then(async (x) => ({ ...x, url: await qxDataUrl(x.blob) }));
async function qxCopy(svg, ready = null) {
  if (window.isSecureContext && navigator.clipboard?.write && window.ClipboardItem) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': ready ? Promise.resolve(ready.blob) : qxPng(svg).then((x) => x.blob) })]); return 'image'; } catch { /* the fallback below */ }
  }
  const { w, h, url } = ready || await qxReady(svg);
  let done = false;
  const onCopy = (e) => { e.clipboardData.setData('text/html', `<img src="${url}" width="${w}" height="${h}" alt="chart">`); e.clipboardData.setData('text/plain', ''); e.preventDefault(); done = true; };
  document.addEventListener('copy', onCopy);
  try { document.execCommand('copy'); } finally { document.removeEventListener('copy', onCopy); }
  if (!done) throw new Error('The browser didn\'t allow copying — use ⬇ PNG and insert the picture instead');
  return 'html';
}
async function qxDownload(svg, name) {
  const { blob } = await qxPng(svg);
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${name}.png`; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
