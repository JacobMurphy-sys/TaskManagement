'use strict';
// 📊 KPIs: weekly snapshots of the CI workbook — the A3 Weekly Report exactly as laid
// out (values, conditional format colours, charts drawn from their stored values) and
// the Database sheet — plus the disconnected A3 export (values only, charts as
// pictures). Loaded before app.js; uses its helpers.

const kpiState = { zoom: null };

async function renderKpi(arg, tab) {
  const [weeks, settings] = await Promise.all([api.get('/kpi/snapshots'), api.get('/settings')]);
  const id = Number(arg) || weeks[0]?.id || null;
  const view = tab === 'database' ? 'database' : 'a3';
  const snap = id ? await api.get(`/kpi/snapshots/${id}`).catch((err) => { toast(err.message, 'error'); return null; }) : null;
  const setupMissing = !settings.kpi_workbook_path || !settings.kpi_export_dir;
  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 KPIs</h1>
      ${weeks.length ? `<select id="kpi-week" title="Reporting week">${weeks.map((w) => `<option value="${w.id}" ${w.id === snap?.id ? 'selected' : ''}>${esc(w.week)}${w.month ? ` · ${esc(w.month)}` : ''}</option>`).join('')}</select>` : ''}
      ${snap ? `<div class="seg"><a href="#/kpi/${snap.id}" class="${view === 'a3' ? 'on' : ''}">A3 Weekly Report</a><a href="#/kpi/${snap.id}/database" class="${view === 'database' ? 'on' : ''}">Database</a></div>` : ''}
      <div class="spacer"></div>
      ${settings.kpi_workbook_path ? '<button class="primary" data-kpi="load-path" title="Read the workbook from where it\'s saved">📥 Load this week</button>' : ''}
      <label class="button" title="Choose a copy of the workbook">📂 Load file…<input type="file" accept=".xlsm,.xlsx" hidden id="kpi-file"></label>
      ${snap ? `<button data-kpi="save" ${settings.kpi_export_dir ? '' : 'disabled title="Set the export folder in ⚙ Setup first"'}>💾 Save A3 to folder</button>
        <button data-kpi="download" title="Download the A3 (values only, charts as pictures)">⬇ A3</button>` : ''}
      <button data-kpi="setup" title="Where the workbook is and where the A3 is saved">⚙ Setup</button>
    </div>
    <div id="kpi-setup" class="card kpi-setup" ${setupMissing && !weeks.length ? '' : 'hidden'}>${kpiSetupHtml(settings)}</div>
    ${snap ? `<div class="kpi-meta small muted">${esc(snap.week)} · loaded ${esc(fmtDateTime(snap.loaded_at))} from ${esc(snap.source_name || 'the workbook')}
        ${snap.source_modified ? ` (saved ${esc(fmtDateTime(snap.source_modified))})` : ''}
        ${snap.exported_to ? ` · A3 saved ${esc(fmtDateTime(snap.exported_at))} to <code>${esc(snap.exported_to)}</code>` : ''}
        ${snap.errors?.length ? ` · <span class="chip overdue" title="${esc(snap.errors.join('\n'))}">⚠ ${snap.errors.length} cell${snap.errors.length === 1 ? '' : 's'} with errors</span>` : ''}
        <span class="spacer"></span><span class="kpi-zoom">🔍 <input type="range" id="kpi-zoom" min="25" max="150" step="5"> <button class="link small" data-kpi="fit">Fit</button></span>
        <button class="link small danger" data-kpi="delete" title="Remove this week from the CI Manager">Remove week</button></div>
      <div class="kpi-sheet-wrap card" id="kpi-wrap"><div id="kpi-sheet"></div></div>`
    : `<div class="card lib-empty"><h2>Weekly KPIs from the CI workbook</h2>
        <p>Load the workbook after refreshing it and choosing the reporting week. The CI Manager keeps a copy of that week's
          <b>A3 Weekly Report</b> and <b>Database</b> exactly as they look in Excel, and saves the A3 as a disconnected file —
          values and colours only, charts as pictures, no formulas, links or macros.</p>
        <p class="small muted">Nothing in the workbook is changed. Only the week it's showing is read, so load it once per week.</p></div>`}`;

  $('#kpi-week')?.addEventListener('change', (e) => { location.hash = `#/kpi/${e.target.value}${view === 'database' ? '/database' : ''}`; });
  $('#kpi-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await kpiLoad(() => fetch('/api/kpi/load', { method: 'POST', body: f,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name), 'X-File-Modified': new Date(f.lastModified).toISOString() } }));
    e.target.value = '';
  });
  wireKpiSetup(settings);
  main().onclick = async (e) => {
    const b = e.target.closest('[data-kpi]');
    if (!b) return;
    const what = b.dataset.kpi;
    if (what === 'setup') { const s = $('#kpi-setup'); s.hidden = !s.hidden; return; }
    if (what === 'load-path') return kpiLoad(() => fetch('/api/kpi/load-path', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } }), b);
    if (what === 'fit') { kpiState.zoom = null; store.set('kpiZoom', null); applyZoom(); return; }
    if (!snap) return;
    if (what === 'delete') {
      if (!confirm(`Remove ${snap.week} from the CI Manager? The workbook and any saved A3 files aren't touched.`)) return;
      await api.del(`/kpi/snapshots/${snap.id}`);
      toast(`${snap.week} removed`);
      location.hash = '#/kpi';
      return;
    }
    if (what === 'save' || what === 'download') await kpiExport(snap, what === 'save', b);
  };
  if (!snap) return;
  const model = snap.views[view] || snap.views.a3;
  const sheetEl = $('#kpi-sheet');
  sheetEl.innerHTML = sheetViewHtml(model, 'kpi-sheet');
  drawSheetCharts(sheetEl, model);
  kpiState.zoom = store.get('kpiZoom', null);
  const zoomEl = $('#kpi-zoom');
  const applyZoom = () => {
    const wrap = $('#kpi-wrap');
    if (!wrap) return;
    const fit = Math.max(0.25, Math.min(1.5, (wrap.clientWidth - 24) / Math.max(1, model.x[model.x.length - 1])));
    const z = view === 'database' ? (kpiState.zoom ?? 1) : (kpiState.zoom ?? fit);
    sheetEl.style.transform = `scale(${z})`;
    sheetEl.style.width = `${model.x[model.x.length - 1]}px`;
    sheetEl.parentElement.style.height = `${model.y[model.y.length - 1] * z + 24}px`;
    zoomEl.value = Math.round(z * 100);
    zoomEl.title = `${Math.round(z * 100)}%`;
  };
  zoomEl.addEventListener('input', () => { kpiState.zoom = Number(zoomEl.value) / 100; store.set('kpiZoom', kpiState.zoom); applyZoom(); });
  applyZoom();
  window.onresize = () => { if ($('#kpi-wrap')) applyZoom(); };
}

function kpiSetupHtml(s) {
  return `<h2 style="margin-top:0">Setup</h2>
    <div class="form-grid">
      <label class="f full">Workbook (where it's saved)<input type="text" name="kpi_workbook_path" value="${esc(s.kpi_workbook_path)}" placeholder="e.g. S:\\…\\CI Hub.xlsm">
        <span class="small muted">Used by 📥 Load this week. Save the workbook in Excel after refreshing and picking the week — the CI Manager reads the values Excel saved.</span></label>
      <label class="f full">Save the A3 in<input type="text" name="kpi_export_dir" value="${esc(s.kpi_export_dir)}" placeholder="e.g. S:\\…\\Weekly - Monthly OPS Report\\{year}\\Weekly\\WK{wk}">
        <span class="small muted">{year} → 2026, {wk} → 39, {week} → W2639. Missing folders are created.</span></label>
      <label class="f">File name<input type="text" name="kpi_export_name" value="${esc(s.kpi_export_name)}" placeholder="A3 {year} WK{wk}.xlsx"></label>
      <label class="f">A3 sheet<input type="text" name="kpi_a3_sheet" value="${esc(s.kpi_a3_sheet)}"></label>
      <label class="f">Database sheet<input type="text" name="kpi_db_sheet" value="${esc(s.kpi_db_sheet)}"></label>
      <label class="f">Reporting week cell (on the Database sheet)<input type="text" name="kpi_week_cell" value="${esc(s.kpi_week_cell)}"></label>
    </div>`;
}
function wireKpiSetup() {
  $$('#kpi-setup input').forEach((el) => el.addEventListener('change', async () => {
    try { await api.patch('/settings', { [el.name]: el.value }); toast('Saved'); } catch (err) { toast(err.message, 'error'); }
    if (el.name === 'kpi_workbook_path' || el.name === 'kpi_export_dir') { // buttons depend on these
      await route();
      if ($('#kpi-setup')) $('#kpi-setup').hidden = false;
    }
  }));
}

async function kpiLoad(send, btn) {
  if (btn) btn.disabled = true;
  toast('Reading the workbook…');
  try {
    const res = await send();
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || res.statusText);
    toast(`${d.week} ${d.replaced ? 'reloaded' : 'loaded'}${d.errors?.length ? ` — ${d.errors.length} cell(s) show errors in the A3` : ''}`, d.errors?.length ? 'error' : '');
    location.hash = `#/kpi/${d.id}`;
    if (location.hash === `#/kpi/${d.id}`) await route();
  } catch (err) { toast(err.message, 'error'); } finally { if (btn) btn.disabled = false; }
}

// Draws each A3 chart at its size (twice the pixels, for print) and sends the PNGs.
async function kpiExport(snap, save, btn) {
  btn.disabled = true;
  try {
    const charts = {};
    for (const c of snap.views.a3.charts) {
      const canvas = document.createElement('canvas');
      drawChart(canvas, c.spec, c.w, c.h, 2);
      charts[c.index] = canvas.toDataURL('image/png');
    }
    const res = await fetch(`/api/kpi/snapshots/${snap.id}/export`, { method: 'POST', body: JSON.stringify({ save, charts }),
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || res.statusText); }
    const blob = await res.blob();
    const savedTo = res.headers.get('X-Saved-To');
    if (save) {
      toast(`A3 saved to ${decodeURIComponent(savedTo || '')}`);
      await route();
    } else {
      const name = decodeURIComponent((res.headers.get('Content-Disposition') || '').match(/filename\*=UTF-8''([^;]+)/)?.[1] || `A3 ${snap.week}.xlsx`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
}

// ---- a sheet as it looks in Excel -----------------------------------------------------------

function sheetViewHtml(m, scope) {
  const W = m.x[m.x.length - 1]; const H = m.y[m.y.length - 1];
  const grid = m.showGrid ? `<svg class="xs-grid" width="${W}" height="${H}" aria-hidden="true">
      ${m.x.map((x) => `<line x1="${x + 0.5}" y1="0" x2="${x + 0.5}" y2="${H}"/>`).join('')}${m.y.map((y) => `<line x1="0" y1="${y + 0.5}" x2="${W}" y2="${y + 0.5}"/>`).join('')}</svg>` : '';
  const css = m.styles.map((s, i) => `#${scope} .xs${i}{${s}}`).join('\n');
  const cells = m.cells.map(([row, col, text, s, rs, cs, rot]) => {
    const left = m.x[col - 1]; const top = m.y[row - 1];
    const w = m.x[Math.min(col - 1 + cs, m.x.length - 1)] - left; const h = m.y[Math.min(row - 1 + rs, m.y.length - 1)] - top;
    if (w <= 0 || h <= 0) return '';
    const turn = rot === 255 ? 'writing-mode:vertical-lr;text-orientation:upright;' : rot ? `writing-mode:vertical-rl;${rot > 90 ? '' : 'transform:rotate(180deg);'}` : '';
    return `<div class="xc xs${s}${text ? ' xt' : ''}${m.styles[s].includes('pre-wrap') ? ' xw' : ''}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;${turn}">${text ? `<span>${esc(text)}</span>` : ''}</div>`;
  }).join('');
  const images = m.images.map((im) => `<img class="xi" src="${im.src}" alt="" style="left:${im.x}px;top:${im.y}px;width:${im.w}px;height:${im.h}px">`).join('');
  const charts = m.charts.map((c, i) => `<canvas class="xchart" data-chart="${i}" style="left:${c.x}px;top:${c.y}px;width:${c.w}px;height:${c.h}px"></canvas>`).join('');
  return `<style>${css}</style><div class="xsheet" style="width:${W}px;height:${H}px">${grid}${cells}${images}${charts}</div>`;
}

function drawSheetCharts(root, m) {
  $$('canvas[data-chart]', root).forEach((cv) => {
    const c = m.charts[Number(cv.dataset.chart)];
    try { drawChart(cv, c.spec, c.w, c.h, Math.max(2, window.devicePixelRatio || 1)); } catch (err) { console.error(err); }
  });
}

// ---- charts, drawn from the values stored with them ------------------------------------------

function drawChart(canvas, spec, W, H, scale = 2) {
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  const g = canvas.getContext('2d');
  g.scale(scale, scale);
  const pt = (p) => (p * 96) / 72;
  const font = (size, bold) => `${bold ? 'bold ' : ''}${pt(size).toFixed(2)}px "${spec.font}", Calibri, Arial, sans-serif`;
  const hex = (c, a) => (c ? (c.length === 8 ? `#${c}` : `#${c}`) : 'transparent') + (a ? '' : '');
  g.textBaseline = 'middle';
  // chart area
  if (spec.background) { g.fillStyle = hex(spec.background); g.fillRect(0, 0, W, H); }
  if (spec.border && spec.border.color !== null) {
    g.strokeStyle = hex(spec.border.color || 'D9D9D9'); g.lineWidth = Math.max(0.75, spec.border.width || 0.75);
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
  }
  let top = 6; let bottom = H - 6; let left = 6; let right = W - 6;
  if (spec.title?.text) {
    g.font = font(spec.title.size, spec.title.bold); g.fillStyle = hex(spec.title.color); g.textAlign = 'center';
    const lh = pt(spec.title.size) * 1.25;
    g.fillText(spec.title.text, W / 2, top + lh / 2);
    top += lh + 4;
  }
  const allSeries = spec.groups.flatMap((gr) => gr.series.map((s) => ({ s, kind: gr.kind })));
  // legend
  if (spec.legend) {
    const L = spec.legend;
    const entries = allSeries.filter((_, i) => !L.deleted.includes(i));
    g.font = font(L.size);
    const sw = pt(L.size) * 1.2; const gap = 8;
    const widths = entries.map((e) => sw + 4 + g.measureText(e.s.name).width);
    const lh = pt(L.size) * 1.5;
    if (L.pos === 'b' || L.pos === 't') {
      const rows = []; let row = []; let rw = 0;
      entries.forEach((e, i) => { if (row.length && rw + widths[i] + gap > W - 20) { rows.push(row); row = []; rw = 0; } row.push(i); rw += widths[i] + gap; });
      if (row.length) rows.push(row);
      const blockH = rows.length * lh;
      let y0 = L.pos === 'b' ? bottom - blockH : top;
      rows.forEach((r) => {
        const total = r.reduce((t, i) => t + widths[i] + gap, -gap);
        let x0 = (W - total) / 2;
        r.forEach((i) => { legendKey(g, entries[i], x0, y0 + lh / 2, sw); g.fillStyle = hex(L.color); g.textAlign = 'left'; g.fillText(entries[i].s.name, x0 + sw + 4, y0 + lh / 2); x0 += widths[i] + gap; });
        y0 += lh;
      });
      if (L.pos === 'b') bottom -= blockH + 4; else top += blockH + 4;
    } else {
      const colW = Math.max(0, ...widths) + 8;
      const x0 = L.pos === 'l' ? left : right - colW;
      let y0 = (top + bottom) / 2 - (entries.length * lh) / 2;
      entries.forEach((e) => { legendKey(g, e, x0, y0 + lh / 2, sw); g.fillStyle = hex(L.color); g.textAlign = 'left'; g.fillText(e.s.name, x0 + sw + 4, y0 + lh / 2); y0 += lh; });
      if (L.pos === 'l') left += colW + 4; else right -= colW + 4;
    }
  }
  const pies = spec.groups.filter((gr) => gr.kind === 'pie' || gr.kind === 'doughnut');
  if (pies.length) { drawPie(g, pies[0], { left, top, right, bottom }, font, hex); return; }

  // axes
  const axes = spec.axes;
  const valAxes = [...new Set(spec.groups.map((gr) => gr.valAx).filter(Boolean))].map((id) => ({ id, ax: axes[id] }));
  const catAxis = axes[spec.groups[0]?.catAx];
  const n = Math.max(1, ...allSeries.map((e) => Math.max(e.s.vals.length, e.s.cats.length)));
  const cats = (allSeries.find((e) => e.s.cats.length)?.s.cats || []).map((c, i) => c ?? String(i + 1));
  let plot;
  if (spec.plotLayout) {
    plot = { x: spec.plotLayout.x * W, y: spec.plotLayout.y * H, w: spec.plotLayout.w * W, h: spec.plotLayout.h * H };
  } else {
    let pl = left; let pr = right; let pb = bottom;
    for (const { ax } of valAxes) {
      if (!ax || ax.deleted || ax.tickLabels === 'none') continue;
      g.font = font(ax.size);
      const w = Math.max(0, ...(ax.ticks || []).map((t) => g.measureText(t.text).width)) + 8;
      if (ax.pos === 'r') pr -= w; else pl += w;
    }
    if (catAxis && !catAxis.deleted && catAxis.tickLabels !== 'none') pb -= pt(catAxis.size) * 1.6 + 4;
    plot = { x: pl, y: top + 4, w: Math.max(10, pr - pl), h: Math.max(10, pb - top - 4) };
  }
  if (spec.plotFill) { g.fillStyle = hex(spec.plotFill); g.fillRect(plot.x, plot.y, plot.w, plot.h); }
  const yOf = (ax, v) => { const s = ax?.scale || { min: 0, max: 1 }; const t = (v - s.min) / ((s.max - s.min) || 1); return plot.y + plot.h - Math.max(0, Math.min(1, ax?.reverse ? 1 - t : t)) * plot.h; };
  // gridlines and value labels
  for (const { ax } of valAxes) {
    if (!ax?.ticks) continue;
    if (ax.gridlines) {
      g.strokeStyle = hex(ax.gridColor || 'D9D9D9'); g.lineWidth = 0.75;
      for (const t of ax.ticks) { const y = Math.round(yOf(ax, t.v)) + 0.5; g.beginPath(); g.moveTo(plot.x, y); g.lineTo(plot.x + plot.w, y); g.stroke(); }
    }
    if (!ax.deleted && ax.tickLabels !== 'none') {
      g.font = font(ax.size); g.fillStyle = hex(ax.color); g.textAlign = ax.pos === 'r' ? 'left' : 'right';
      for (const t of ax.ticks) g.fillText(t.text, ax.pos === 'r' ? plot.x + plot.w + 4 : plot.x - 4, yOf(ax, t.v));
    }
  }
  // category axis line and labels
  const slot = plot.w / n;
  if (catAxis && !catAxis.deleted) {
    const zeroAx = valAxes[0]?.ax;
    const yBase = zeroAx?.scale && zeroAx.scale.min < 0 && zeroAx.scale.max > 0 ? yOf(zeroAx, 0) : plot.y + plot.h;
    if (catAxis.line !== null) { g.strokeStyle = hex(catAxis.line?.color || 'BFBFBF'); g.lineWidth = 0.75; g.beginPath(); g.moveTo(plot.x, Math.round(yBase) + 0.5); g.lineTo(plot.x + plot.w, Math.round(yBase) + 0.5); g.stroke(); }
    if (catAxis.tickLabels !== 'none') {
      g.font = font(catAxis.size); g.fillStyle = hex(catAxis.color); g.textAlign = 'center';
      const widest = Math.max(1, ...cats.map((c) => g.measureText(String(c)).width));
      const every = Math.max(1, Math.ceil((widest + 6) / slot));
      const ly = plot.y + plot.h + pt(catAxis.size) * 0.9 + 2;
      cats.forEach((c, i) => { if (i % every === 0) g.fillText(String(c), plot.x + slot * (i + 0.5), ly); });
    }
  }
  // series
  const labels = [];
  for (const gr of spec.groups) {
    const ax = axes[gr.valAx];
    if (gr.kind === 'bar' || gr.kind === 'area') {
      const k = gr.series.length;
      const stacked = /stacked/i.test(gr.grouping);
      const overlap = stacked ? 100 : gr.overlap;
      const units = stacked ? 1 : k - ((k - 1) * overlap) / 100;
      const barW = slot / (units + gr.gapWidth / 100);
      const pos = Array(n).fill(0); const neg = Array(n).fill(0);
      const totals = gr.grouping === 'percentStacked' ? Array.from({ length: n }, (_, i) => gr.series.reduce((t, s) => t + Math.abs(s.vals[i] || 0), 0) || 1) : null;
      gr.series.forEach((s, si) => {
        for (let i = 0; i < n; i++) {
          let v = s.vals[i];
          if (v === null || v === undefined) continue;
          if (totals) v /= totals[i];
          const base = stacked ? (v >= 0 ? pos[i] : neg[i]) : 0;
          const end = base + v;
          if (stacked) { if (v >= 0) pos[i] = end; else neg[i] = end; }
          const x0 = plot.x + slot * i + (slot - barW * units) / 2 + (stacked ? 0 : si * barW * (1 - overlap / 100));
          const y1 = yOf(ax, Math.max(base, end)); const y2 = yOf(ax, Math.min(base, end));
          const fill = s.points.find((p) => p.idx === i)?.fill ?? s.color;
          if (fill) { g.fillStyle = hex(fill); g.fillRect(x0, y1, barW, Math.max(0, y2 - y1)); }
          if (s.line?.color) { g.strokeStyle = hex(s.line.color); g.lineWidth = s.line.width || 0.75; g.strokeRect(x0, y1, barW, Math.max(0, y2 - y1)); }
          if (s.labelText[i]) {
            const p = s.labels.pos || (stacked ? 'ctr' : 'outEnd');
            const ly = p === 'ctr' ? (y1 + y2) / 2 : p === 'inEnd' ? y1 + pt(s.labels.size) : p === 'inBase' ? y2 - pt(s.labels.size) : y1 - pt(s.labels.size) * 0.8;
            labels.push({ text: s.labelText[i], x: x0 + barW / 2, y: ly, size: s.labels.size, color: s.labels.color, bold: s.labels.bold, align: 'center' });
          }
        }
      });
    } else if (gr.kind === 'line' || gr.kind === 'scatter' || gr.kind === 'radar') {
      const stacked = /stacked/i.test(gr.grouping);
      const acc = Array(n).fill(0);
      gr.series.forEach((s) => {
        const pts = [];
        for (let i = 0; i < n; i++) {
          let v = s.vals[i];
          if (v === null || v === undefined) { pts.push(null); continue; }
          if (stacked) { acc[i] += v; v = acc[i]; }
          pts.push({ x: plot.x + slot * (i + 0.5), y: yOf(ax, v), i });
        }
        const lineColor = s.line === null ? null : (s.line?.color || s.color);
        if (lineColor) {
          g.strokeStyle = hex(lineColor); g.lineWidth = s.line?.width || 2.25; g.lineJoin = 'round'; g.lineCap = 'round';
          g.setLineDash(s.line?.dash && s.line.dash !== 'solid' ? (/dot/i.test(s.line.dash) ? [1, 3] : [6, 4]) : []);
          g.beginPath();
          let started = false;
          for (const p of pts) {
            if (!p) { if (spec.dispBlanksAs !== 'span') started = false; continue; }
            if (!started) { g.moveTo(p.x, p.y); started = true; } else g.lineTo(p.x, p.y);
          }
          g.stroke(); g.setLineDash([]);
        }
        const sym = s.marker?.symbol || 'none';
        if (sym !== 'none') {
          const r = (s.marker.size || 5) / 2 + 0.5;
          for (const p of pts) {
            if (!p) continue;
            g.fillStyle = hex(s.marker.fill || lineColor || s.color); g.strokeStyle = hex(s.marker.line?.color || lineColor || s.color); g.lineWidth = 0.75;
            g.beginPath();
            if (sym === 'square') g.rect(p.x - r, p.y - r, r * 2, r * 2);
            else if (sym === 'diamond') { g.moveTo(p.x, p.y - r); g.lineTo(p.x + r, p.y); g.lineTo(p.x, p.y + r); g.lineTo(p.x - r, p.y); g.closePath(); }
            else if (sym === 'triangle') { g.moveTo(p.x, p.y - r); g.lineTo(p.x + r, p.y + r); g.lineTo(p.x - r, p.y + r); g.closePath(); }
            else g.arc(p.x, p.y, r, 0, Math.PI * 2);
            g.fill(); g.stroke();
          }
        }
        for (const p of pts) {
          if (!p || !s.labelText[p.i]) continue;
          const pos = s.labels.pos || 'r';
          const off = pt(s.labels.size) * 0.9 + 2;
          labels.push({ text: s.labelText[p.i], x: p.x + (pos === 'r' ? off : pos === 'l' ? -off : 0), y: p.y + (pos === 't' ? -off : pos === 'b' ? off : 0),
            size: s.labels.size, color: s.labels.color, bold: s.labels.bold, align: pos === 'r' ? 'left' : pos === 'l' ? 'right' : 'center' });
        }
      });
    }
  }
  for (const l of labels) { g.font = font(l.size, l.bold); g.fillStyle = hex(l.color); g.textAlign = l.align; g.fillText(l.text, l.x, l.y); }
}

function legendKey(g, e, x, y, sw) {
  const c = e.s.color || e.s.fallback;
  if (e.kind === 'line') {
    g.strokeStyle = `#${e.s.line?.color || c}`; g.lineWidth = Math.min(3, e.s.line?.width || 2.25);
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + sw, y); g.stroke();
  } else { g.fillStyle = `#${c}`; g.fillRect(x + sw * 0.15, y - sw * 0.35, sw * 0.7, sw * 0.7); }
}

function drawPie(g, gr, box, font, hex) {
  const s = gr.series[0];
  if (!s) return;
  const vals = s.vals.map((v) => Math.max(0, v || 0));
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const cx = (box.left + box.right) / 2; const cy = (box.top + box.bottom) / 2;
  const r = Math.max(5, Math.min(box.right - box.left, box.bottom - box.top) / 2 - 4);
  let a = -Math.PI / 2 + (gr.firstSliceAng * Math.PI) / 180;
  const palette = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];
  vals.forEach((v, i) => {
    const b = a + (v / total) * Math.PI * 2;
    g.fillStyle = hex(s.points.find((p) => p.idx === i)?.fill || palette[i % palette.length]);
    g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, r, a, b); g.closePath(); g.fill();
    if (s.labelText[i]) { const m = (a + b) / 2; g.font = font(s.labels.size, s.labels.bold); g.fillStyle = hex(s.labels.color); g.textAlign = 'center'; g.fillText(s.labelText[i], cx + Math.cos(m) * r * 0.65, cy + Math.sin(m) * r * 0.65); }
    a = b;
  });
  if (gr.kind === 'doughnut') { g.globalCompositeOperation = 'destination-out'; g.beginPath(); g.arc(cx, cy, (r * gr.holeSize) / 100, 0, Math.PI * 2); g.fill(); g.globalCompositeOperation = 'source-over'; }
}
