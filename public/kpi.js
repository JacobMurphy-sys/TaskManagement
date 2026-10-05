'use strict';
// 📊 KPIs: weekly snapshots of the CI workbook — the A3 Weekly Report exactly as laid
// out (values, conditional format colours, charts drawn from their stored values) and
// the Database sheet — plus the disconnected A3 export (values only, charts as
// pictures). Loaded before app.js; uses its helpers.

const kpiState = { zoom: null };

async function renderKpi(arg, tab) {
  if (arg === 'calc') return renderKpiCalc();
  const [weeks, settings, year] = await Promise.all([api.get('/kpi/snapshots'), api.get('/settings'), api.get('/kpi/weeks').catch(() => null)]);
  const id = Number(arg) || weeks[0]?.id || null;
  const view = tab === 'database' ? 'database' : 'a3';
  const snap = id ? await api.get(`/kpi/snapshots/${id}`).catch((err) => { toast(err.message, 'error'); return null; }) : null;
  const setupMissing = !settings.kpi_workbook_path || !settings.kpi_export_dir;
  const notes = snap ? kpiNotices(snap) : { info: [], actions: [] };
  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 KPIs</h1>
      ${year?.weeks?.length ? `<select id="kpi-week" title="Reporting week — any week of ${year.year}: from Excel, or built by the CI Manager from the source figures">
          ${year.weeks.map((w) => `<option value="${w.a3 ? w.a3.id : `build:${esc(w.week)}`}" ${w.a3 && w.a3.id === snap?.id ? 'selected' : ''}>${esc(w.week)} · ${esc(w.month)}${w.a3 ? (w.a3.origin === 'ci' ? ' — CI Manager' : ' — Excel') : ''}</option>`).join('')}
          ${weeks.filter((w) => !year.weeks.some((y) => y.a3?.id === w.id)).map((w) => `<option value="${w.id}" ${w.id === snap?.id ? 'selected' : ''}>${esc(w.week)}${w.month ? ` · ${esc(w.month)}` : ''} — ${w.origin === 'ci' ? 'CI Manager' : 'Excel'}</option>`).join('')}</select>`
        : weeks.length ? `<select id="kpi-week" title="Reporting week">${weeks.map((w) => `<option value="${w.id}" ${w.id === snap?.id ? 'selected' : ''}>${esc(w.week)}${w.month ? ` · ${esc(w.month)}` : ''}</option>`).join('')}</select>` : ''}
      <div class="seg">${snap ? `<a href="#/kpi/${snap.id}" class="${view === 'a3' ? 'on' : ''}">A3 Weekly Report</a><a href="#/kpi/${snap.id}/database" class="${view === 'database' ? 'on' : ''}">Database</a>` : ''}<a href="#/kpi/calc" title="Worked out by the CI Manager from the source files">From sources</a></div>
      <div class="spacer"></div>
      ${settings.kpi_workbook_path ? '<button class="primary" data-kpi="load-path" title="Read the workbook from where it\'s saved">📥 Load this week</button>' : ''}
      <label class="button" title="Choose a copy of the workbook">📂 Load file…<input type="file" accept=".xlsm,.xlsx" hidden id="kpi-file"></label>
      ${snap ? `<button data-kpi="save" ${settings.kpi_export_dir ? '' : 'disabled title="Set the export folder in ⚙ Setup first"'}>💾 Save A3 to folder</button>
        <button data-kpi="download" title="Download the A3 (values only, charts as pictures)">⬇ A3</button>` : ''}
      <button data-kpi="setup" title="Where the workbook is and where the A3 is saved">⚙ Setup</button>
    </div>
    <div id="kpi-setup" class="card kpi-setup" ${setupMissing && !weeks.length ? '' : 'hidden'}>${kpiSetupHtml(settings)}</div>
    ${notes.actions.length ? `<div class="kpi-actions">${notes.actions.map((a) => `<div class="kpi-action"><span>⚠ ${a.text}</span>${a.buttons}</div>`).join('')}</div>` : ''}
    ${snap ? `<div class="kpi-meta small muted">${esc(snap.week)} · ${snap.origin === 'ci' ? `built ${esc(fmtDateTime(snap.loaded_at))} from the source figures` : `loaded ${esc(fmtDateTime(snap.loaded_at))} from Excel`}
        <details class="kpi-info"><summary title="Where this A3 came from">ⓘ</summary><div class="kpi-info-pop card">${notes.info.map((t) => `<div>${t}</div>`).join('')}</div></details>
        <button class="link small" data-kpi="rebuild" title="${snap.origin === 'ci' ? 'Build it again from the latest source figures' : 'Replace the Excel copy with the CI Manager\'s own figures for this week'}">🔄 ${snap.origin === 'ci' ? 'Rebuild' : 'Build from sources instead'}</button>
        ${snap.exported_to ? ` · <span title="${esc(snap.exported_to)}">💾 saved ${esc(fmtDateTime(snap.exported_at))}</span>` : ''}
        ${snap.errors?.length ? ` · <span class="chip overdue" title="${esc(snap.errors.join('\n'))}">⚠ ${snap.errors.length} cell${snap.errors.length === 1 ? '' : 's'} with errors</span>` : ''}
        <span class="spacer"></span>
        ${view === 'a3' ? `<button class="${kpiState.editing ? 'primary' : ''} small" data-kpi="edit" ${snap.views.a3.edit ? '' : 'disabled title="Load this week again (📥) to edit it — it was loaded before editing was possible"'}>✎ ${kpiState.editing ? 'Done editing' : 'Edit A3'}${Object.keys(snap.edits || {}).length ? ` <span class="chip">${Object.keys(snap.edits).length}</span>` : ''}</button>` : ''}
        <span class="kpi-zoom">🔍 <input type="range" id="kpi-zoom" min="25" max="150" step="5"> <button class="link small" data-kpi="fit">Fit</button></span>
        <button class="link small danger" data-kpi="delete" title="Remove this week from the CI Manager">Remove week</button></div>
      ${view === 'a3' && kpiState.editing ? `<div class="kc-note kpi-edit-bar">✎ <b>Editing ${esc(snap.week)}</b> — click a text box to change it, a coloured figure to set it green, yellow or red, or a trend arrow to pick ▲ ▬ ▼ (each with its colour).
          Changes are kept with this week (also after 🔄 Rebuild) and go into the saved A3. <span class="kpi-ed-key">Changed by hand</span>
          ${snap.text_from ? `<button class="small" data-kpi="copy-text" title="Fill this week's text boxes with the text typed for ${esc(snap.text_from)}">⇩ Start from ${esc(snap.text_from)}'s text</button>` : ''}
          ${Object.keys(snap.edits || {}).length ? '<button class="small link danger" data-kpi="reset-edits">Undo all changes</button>' : ''}</div>` : ''}
      <div class="kpi-sheet-wrap card" id="kpi-wrap"><div id="kpi-sheet"></div></div>`
    : `<div class="card lib-empty"><h2>Weekly KPIs from the CI workbook</h2>
        <p>Load the workbook after refreshing it and choosing the reporting week. The CI Manager keeps a copy of that week's
          <b>A3 Weekly Report</b> and <b>Database</b> exactly as they look in Excel, and saves the A3 as a disconnected file —
          values and colours only, charts as pictures, no formulas, links or macros.</p>
        <p class="small muted">Nothing in the workbook is changed. Only the week it's showing is read, so load it once per week.</p></div>`}`;

  $('#kpi-week')?.addEventListener('change', async (e) => {
    const v = e.target.value;
    if (v.startsWith('build:')) { await kpiBuild(v.slice(6), false, e.target, view); return; }
    location.hash = `#/kpi/${v}${view === 'database' ? '/database' : ''}`;
  });
  $('#kpi-file').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) await kpiLoad(() => fetch('/api/kpi/load', { method: 'POST', body: f,
      headers: { 'Content-Type': 'application/octet-stream', 'X-Requested-With': 'TaskManager', 'X-File-Name': encodeURIComponent(f.name), 'X-File-Modified': new Date(f.lastModified).toISOString() } }));
    e.target.value = '';
  });
  wireKpiSetup(settings);
  main().onclick = async (e) => {
    if (!e.target.closest('.kpi-info')) $$('.kpi-info[open]').forEach((d) => { d.open = false; });
    const b = e.target.closest('[data-kpi]');
    if (!b) return;
    const what = b.dataset.kpi;
    if (what === 'setup') { const s = $('#kpi-setup'); s.hidden = !s.hidden; return; }
    if (what === 'load-path') return kpiLoad(() => fetch('/api/kpi/load-path', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TaskManager' } }), b);
    if (what === 'fit') { kpiState.zoom = null; store.set('kpiZoom', null); applyZoom(); return; }
    if (!snap) return;
    if (what === 'edit') { kpiState.editing = !kpiState.editing; await route(); return; }
    if (what === 'copy-text') {
      try { const r = await api.post(`/kpi/edits/${snap.week}/copy`, { from: snap.text_from }); toast(`${r.copied} text box${r.copied === 1 ? '' : 'es'} filled from ${snap.text_from}`); } catch (err) { toast(err.message, 'error'); }
      await route(); return;
    }
    if (what === 'reset-edits') {
      if (!confirm(`Undo every change made by hand on ${snap.week}'s A3? Its text and colours go back to what the workbook and the formulas give.`)) return;
      try { await api.del(`/kpi/edits/${snap.week}`); toast('Changes undone'); } catch (err) { toast(err.message, 'error'); }
      await route(); return;
    }
    if (what === 'rebuild') {
      if (snap.origin !== 'ci' && !confirm(`Replace the Excel copy of ${snap.week} with an A3 built from the CI Manager's own figures?`)) return;
      await kpiBuild(snap.week, snap.origin !== 'ci', b, view);
      return;
    }
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
  const paint = () => {
    const m = view === 'a3' ? withKpiEdits(model, snap.edits) : model;
    sheetEl.innerHTML = sheetViewHtml(m, 'kpi-sheet');
    drawSheetCharts(sheetEl, m);
    if (view === 'a3' && kpiState.editing && model.edit) {
      sheetEl.classList.add('kpi-editing');
      $$('[data-cell]', sheetEl).forEach((el) => {
        const [r, c] = el.dataset.cell.split(':').map(Number);
        const ref = xlRef(r, c); const k = model.edit[ref];
        if (!k) return;
        el.dataset.ref = ref;
        el.classList.add(k.includes('t') ? 'ed-t' : 'ed-c');
        if (snap.edits?.[ref]) el.classList.add('ed-done');
      });
    } else sheetEl.classList.remove('kpi-editing');
  };
  paint();
  sheetEl.onclick = (e) => {
    const el = kpiState.editing && view === 'a3' && e.target.closest('[data-ref]');
    if (!el) return;
    kpiEditCell(snap, model, el, async (edits) => { snap.edits = edits; paint(); });
  };
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
    return `<div class="xc xs${s}${text ? ' xt' : ''}${m.styles[s].includes('pre-wrap') ? ' xw' : ''}" data-cell="${row}:${col}" style="left:${left}px;top:${top}px;width:${w}px;height:${h}px;${turn}">${text ? `<span>${esc(text)}</span>` : ''}</div>`;
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

// ---- From sources: the CI Manager's own figures, checked against Excel's ---------------------

// [key, heading, group (starts a new group), typed in each week]
// Source: the figures the KPIs are made from, in the Database sheet's order.
const KPI_SOURCE_COLS = [
  ['perso_ps', 'PS', 'Perso Vol'], ['perso_isi', 'ISI'], ['perso_pin', 'PIN'], ['perso_total', 'Total'], ['scrap', 'Scrap'],
  ['shipped_ps', 'PS', 'Shipped Vol'], ['shipped_isi', 'ISI'], ['shipped_pin', 'PIN'], ['shipped_total', 'Total'], ['otd_internal', 'Delay Int.'], ['otd_external', 'Delay Ext.'],
  ['hours', 'Hours', 'HR', true], ['contract', 'Contract', null, true], ['temps', 'Temps', null, true],
  ['cc_critical', 'Critical', 'Quality', true], ['cc_major', 'Major', null, true], ['cc_minor', 'Minor', null, true], ['complaints', 'Total'],
];
// KPI: what's reported.
const KPI_KPI_COLS = [
  ['otd_sc', 'OTD SC', 'OTD'], ['otd_global', 'OTD Global'], ['cpms', 'CPMS', 'Quality'], ['scrap_rate', 'Scrap %', 'Scrap'],
  ['productivity', 'Productivity', 'HR'], ['hc', 'Headcount'],
];
const KPI_PCT = { otd_sc: 2, otd_global: 2, scrap_rate: 2 };
const kpiFmt = (key, v) => {
  if (v === null || v === undefined || v === '') return '';
  if (KPI_PCT[key] !== undefined) return `${(v * 100).toFixed(KPI_PCT[key])}%`;
  if (['scrap', 'cc_critical', 'cc_major', 'cc_minor', 'complaints', 'contract', 'temps', 'hc'].includes(key)) return Math.round(v * 100) / 100 === Math.round(v) ? Math.round(v).toLocaleString('en-GB') : v.toLocaleString('en-GB');
  if (key === 'hours') return v.toLocaleString('en-GB', { maximumFractionDigits: 2 });
  if (key === 'cpms') return v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v.toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
};

async function renderKpiCalc() {
  const year = Number(store.get('kpiYear', new Date().getFullYear()));
  const [calc, settings] = await Promise.all([api.get(`/kpi/calc?year=${year}`), api.get('/settings')]);
  const xl = calc.excel?.weeks || null;
  let checked = 0; let differ = 0;
  const same = (a, b) => Math.abs((a || 0) - (b || 0)) < 1e-6 * Math.max(1, Math.abs(b || 0));
  const rowHtml = (w, cols, edit = false) => {
    const ex = xl?.[w.week];
    const empty = cols.every(([k]) => !w[k]);
    let rowDiff = false;
    const cells = cols.map(([k, , group, manual], i) => {
      let cls = ''; let title = '';
      if (ex && ex[k] !== null && ex[k] !== undefined) {
        checked++;
        if (same(w[k], ex[k])) cls = 'kc-ok';
        else { cls = 'kc-diff'; differ++; rowDiff = true; title = `Excel: ${kpiFmt(k, ex[k])}`; }
      }
      const drill = (k === 'otd_internal' || k === 'otd_external') && w[k] ? ` data-kc-otd="${esc(w.week)}"` : '';
      return `<td class="num ${cls}${group && i ? ' kc-sep' : ''}${manual ? ' kc-manual' : ''}${drill ? ' kc-click' : ''}"${drill} ${title ? `title="${esc(title)}"` : (drill ? 'title="Show the OTD report rows"' : '')}>${kpiFmt(k, w[k])}${cls === 'kc-diff' ? `<span class="kc-was">${esc(kpiFmt(k, ex[k]))}</span>` : ''}</td>`;
    }).join('');
    return `<tr class="${empty ? 'kc-empty' : ''} ${rowDiff ? 'kc-rowdiff' : ''} ${w.week === calc.excel?.week ? 'kc-current' : ''}"><td>${esc(w.month)}</td><td><b>${esc(w.week)}</b></td>${cells}${edit ? `<td><button class="icon" data-kc-edit="${esc(w.week)}" title="Type in this week's figures">✎</button></td>` : ''}</tr>`;
  };
  const tab = store.get('kcTab', 'source') === 'kpi' ? 'kpi' : 'source';
  const sourceBody = calc.weeks.map((w) => rowHtml(w, KPI_SOURCE_COLS, true)).join('');
  const sourceChecked = checked; const sourceDiffer = differ;
  const kpiBody = calc.weeks.map((w) => rowHtml(w, KPI_KPI_COLS)).join('');
  const cols = tab === 'kpi' ? KPI_KPI_COLS : KPI_SOURCE_COLS;
  const shown = tab === 'kpi' ? { checked: checked - sourceChecked, differ: differ - sourceDiffer } : { checked: sourceChecked, differ: sourceDiffer };
  const groups = []; cols.forEach(([, , g]) => { if (g) groups.push({ g, n: 1 }); else groups[groups.length - 1].n++; });
  const otherDiffer = tab === 'kpi' ? sourceDiffer : differ - sourceDiffer;
  const unlisted = calc.unlisted.filter((u) => u.qty);
  const srcRow = (s) => `<tr data-src="${s.source}">
      <td><b>${esc(s.label)}</b><div class="small muted">${esc(s.default_file)}</div></td>
      <td><input type="text" name="kpi_src_${s.source}" value="${esc(settings[`kpi_src_${s.source}`] || '')}" placeholder="Blank: the workbook's ${esc(s.workbook_sheet)} sheet" title="Full path, e.g. S:\\…\\Source Data\\${esc(s.default_file)}"></td>
      <td class="small">${s.imported_at ? `${esc(fmtDateTime(s.imported_at))}<div class="muted">${s.file && /\.xlsm$/i.test(s.file) && !settings[`kpi_src_${s.source}`] ? `from the workbook's ${esc(s.workbook_sheet)}` : 'from the file'}</div>` : '<span class="muted">not read yet</span>'}</td>
      <td class="small">${s.modified ? esc(fmtDateTime(s.modified)) : ''}</td>
      <td class="num">${s.rows ? s.rows.toLocaleString('en-GB') : ''}${s.skipped ? `<div class="small muted" title="Rows without a date">${s.skipped.toLocaleString('en-GB')} undated</div>` : ''}</td>
      <td class="small">${s.first_day ? `${esc(s.first_day)} → ${esc(s.last_day)}` : ''}</td></tr>`;
  main().innerHTML = `
    <div class="kanban-tools kpi-tools"><h1 style="margin:0">📊 KPIs</h1>
      <div class="seg"><a href="#/kpi">A3 Weekly Report</a><a href="#/kpi/${calc.excel?.id || ''}/database">Database</a><a href="#/kpi/calc" class="on">From sources</a></div>
      <select id="kc-year" title="Year">${[year - 1, year, year + 1].map((y) => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select>
      <div class="spacer"></div>
      <button class="primary" data-kc="import" title="Read the source files that changed since last time">📥 Read changed files</button>
      <button data-kc="force" title="Read every source file again">Read all again</button>
    </div>
    <div class="card kc-sources">
      <h2 style="margin-top:0">Source files <span class="muted small">— the hourly exports the KPIs are worked out from</span></h2>
      <table class="log"><thead><tr><th>Source</th><th>File</th><th>Last read</th><th>File saved</th><th class="num">Rows</th><th>Dates</th></tr></thead>
        <tbody>${calc.sources.map(srcRow).join('')}</tbody></table>
      <h3 class="kc-sub">Customer forecasts <span class="muted small">— read each time an A3 is built (month and year forecast per customer, the forecast rows)</span></h3>
      <table class="log"><thead><tr><th>Forecast</th><th>File</th><th>File saved</th></tr></thead><tbody>
        ${(calc.forecasts || []).map((f) => `<tr><td><b>${esc(f.label)}</b><div class="small muted">${esc(f.default_file)} · sheet ${esc(f.sheet)}</div></td>
          <td><input type="text" name="kpi_fc_${esc(f.key)}" value="${esc(f.path || '')}" placeholder="Blank: the workbook's ${esc(f.workbook_sheet)} sheet, as Excel last refreshed it" title="Full path, e.g. S:\\public\\Forecast Central\\${esc(f.default_file)}"></td>
          <td class="small">${f.path ? (f.found ? esc(fmtDateTime(f.modified)) : '<span style="color:var(--danger)">⚠ can\'t find this file</span>') : '<span class="muted">the workbook\'s copy</span>'}</td></tr>`).join('')}</tbody></table>
      <p class="small muted">Leave a file blank to use the matching import sheet of the CI workbook (⚙ Setup on the A3 tab) — handy until the paths are set.
        Only files saved since the last read are read again. Nothing is changed in any file.</p>
      <label class="row small"><input type="checkbox" id="kc-weekends" ${calc.split_weekends ? 'checked' : ''}>
        Count Saturdays and Sundays of a week split across two months in their own month's part (W…_1 / W…_2). Excel leaves them out.</label>
      ${calc.split_weekends ? '<div class="kc-note">Weekend work in split weeks is counted, so those weeks differ from Excel\'s figures by exactly that work.</div>' : ''}
      ${unlisted.length && !calc.split_weekends ? `<div class="kc-note">⚠ Not in Excel's report: weekend work in split weeks — ${unlisted.map((u) => `<b>${esc(u.week)}</b> ${esc(u.source === 'remakes' ? `${u.qty} scrap` : `${(u.qty / 1000).toFixed(1)}K ${u.source === 'perso' ? 'persoed' : 'shipped'}`)}`).join(', ')}.</div>` : ''}
    </div>
    <div class="card" style="margin-top:12px">
      <div class="row">
        <div class="seg kc-tabs"><button type="button" data-kc-tab="source" class="${tab === 'source' ? 'on' : ''}">Source</button><button type="button" data-kc-tab="kpi" class="${tab === 'kpi' ? 'on' : ''}">KPI</button></div>
        ${xl ? `<span class="kc-summary ${shown.differ ? 'bad' : 'good'}">${shown.differ ? `⚠ ${shown.differ} of ${shown.checked} figures differ from Excel` : `✔ All ${shown.checked} figures match Excel`}</span>
          ${otherDiffer ? `<span class="small muted">(${otherDiffer} on the ${tab === 'kpi' ? 'Source' : 'KPI'} tab)</span>` : ''}` : ''}
        <div class="spacer"></div>
        <label class="small row"><input type="checkbox" id="kc-only" ${store.get('kcOnly', false) ? 'checked' : ''}> Only weeks that differ</label>
        ${tab === 'source' ? '<button data-kc-copy title="Fill weeks with nothing typed in yet from Excel\'s Database sheet (the loaded week)">⇩ Copy typed-in figures from Excel</button>' : ''}</div>
      <p class="small muted">${tab === 'source'
        ? `Volumes in kU (thousands), scrap in units. Delays come from the OTD report (click one to see its rows). <span class="kc-manual-key">Shaded</span> columns are typed in each week with ✎ — HR (hours from Protime) and complaints (until the Salesforce export is ready).`
        : 'OTD SC = 1 − internal delays ÷ cards shipped (OTD Global includes external delays) · CPMS = complaints per million cards shipped · Scrap % = scrap ÷ cards persoed · Productivity = cards persoed per working hour · Headcount = contract + temps.'}
        ${calc.excel ? (xl ? ` Checked against Excel's Database sheet (${esc(calc.excel.week)}, loaded ${esc(fmtDateTime(calc.excel.loaded_at))}): green = same, red = different, with Excel's figure underneath.` : ' Load the week again on the A3 tab to check these against Excel.') : ' Load a week on the A3 tab to check these against Excel.'}</p>
      ${tab === 'source' && calc.otd_uncounted?.length ? `<div class="kc-note">⚠ ${calc.otd_uncounted.length} OTD row${calc.otd_uncounted.length === 1 ? ' isn\'t' : 's aren\'t'} counted in any week (${(calc.otd_uncounted.reduce((t, r) => t + (r.qty || 0), 0) / 1000).toFixed(1)}K):
          the Week column is empty, isn't a week number, or names a split week without saying which part (_1 / _2). Excel doesn't count them either. Fill in the week in the OTD report and read it again.
        <details><summary class="small">Show them</summary><table class="log small"><thead><tr><th>Customer</th><th>Type</th><th class="num">Volume</th><th>Date</th><th>Week typed</th><th>Month</th><th>Reason</th><th>Why</th><th>Week of the date</th></tr></thead><tbody>
        ${calc.otd_uncounted.map((c) => `<tr><td>${esc(c.customer || '')}</td><td>${esc(c.type || '')}</td><td class="num">${(c.qty || 0).toLocaleString('en-GB')}</td><td>${esc(c.date || '')}</td><td>${esc(c.week_typed || '—')}</td><td>${esc(c.month ?? '')}</td><td>${esc(c.reason || '')}</td><td>${esc(c.why)}</td><td class="muted">${esc(c.date_week || '')}</td></tr>`).join('')}</tbody></table></details></div>` : ''}
      ${tab === 'source' && calc.otd_checks?.length ? `<div class="kc-note">⚠ ${calc.otd_checks.length} row${calc.otd_checks.length === 1 ? '' : 's'} in the OTD report have a date that doesn't fall in the week typed next to it${calc.otd_checks.every((c) => c.swapped) ? ' — in every case the day and month are swapped (e.g. 8 March entered for 3 August)' : ''}. The typed week is used, as Excel does.
        <details><summary class="small">Show them</summary><table class="log small"><thead><tr><th>Customer</th><th>Type</th><th class="num">Qty</th><th>Date entered</th><th>Week typed</th><th>Week of that date</th></tr></thead><tbody>
        ${calc.otd_checks.map((c) => `<tr><td>${esc(c.customer || '')}</td><td>${esc(c.type || '')}</td><td class="num">${c.qty.toLocaleString('en-GB')}</td><td>${esc(c.date)}${c.swapped ? ' <span class="muted">(day/month swapped?)</span>' : ''}</td><td>${esc(c.typed_week)}</td><td>${esc(c.date_week)}</td></tr>`).join('')}</tbody></table></details></div>` : ''}
      <div class="kc-wrap"><table class="log kc-table kc-compact ${tab === 'kpi' ? 'kc-kpi' : ''} ${store.get('kcOnly', false) ? 'kc-only' : ''}" id="kc-table"><thead>
        <tr><th></th><th></th>${groups.map((g, i) => `<th colspan="${g.n}" class="kc-group${i ? ' kc-sep' : ''}">${esc(g.g)}</th>`).join('')}${tab === 'source' ? '<th></th>' : ''}</tr>
        <tr><th>Month</th><th>Week</th>${cols.map(([, l, g, manual], i) => `<th class="num${g && i ? ' kc-sep' : ''}${manual ? ' kc-manual' : ''}">${esc(l)}</th>`).join('')}${tab === 'source' ? '<th></th>' : ''}</tr></thead>
        <tbody>${tab === 'kpi' ? kpiBody : sourceBody}</tbody></table></div>
    </div>`;
  $('#kc-year').addEventListener('change', (e) => { store.set('kpiYear', Number(e.target.value)); renderKpiCalc(); });
  $('#kc-only').addEventListener('change', (e) => { store.set('kcOnly', e.target.checked); $('#kc-table').classList.toggle('kc-only', e.target.checked); });
  $('#kc-weekends').addEventListener('change', async (e) => {
    try { await api.post('/kpi/calc/weekends', { split: e.target.checked }); toast(e.target.checked ? 'Weekend days now counted in their month\'s part' : 'Weekend days of split weeks left out, as in Excel'); } catch (err) { toast(err.message, 'error'); }
    renderKpiCalc();
  });
  $$('.kc-sources input[type=text]').forEach((el) => el.addEventListener('change', async () => {
    try {
      await api.patch('/settings', { [el.name]: el.value.trim().replace(/^"|"$/g, '') });
      toast(el.name.startsWith('kpi_fc_') ? 'Saved — used the next time an A3 is built (🔄 Rebuild)' : 'Saved — read the files to use it');
      if (el.name.startsWith('kpi_fc_')) renderKpiCalc();
    } catch (err) { toast(err.message, 'error'); }
  }));
  main().onclick = async (e) => {
    const tb = e.target.closest('[data-kc-tab]');
    if (tb) { store.set('kcTab', tb.dataset.kcTab); renderKpiCalc(); return; }
    const od = e.target.closest('[data-kc-otd]');
    if (od) { kpiOtdRows(od.dataset.kcOtd); return; }
    const ed = e.target.closest('[data-kc-edit]');
    if (ed) { kpiWeekForm(calc.weeks.find((w) => w.week === ed.dataset.kcEdit)); return; }
    if (e.target.closest('[data-kc-copy]')) {
      try { const r = await api.post('/kpi/manual/from-excel', {}); toast(r.weeks ? `Copied ${r.fields} figures for ${r.weeks} weeks from Excel` : 'Nothing to copy — every week already has its figures'); } catch (err) { toast(err.message, 'error'); }
      renderKpiCalc();
      return;
    }
    const b = e.target.closest('[data-kc]');
    if (!b) return;
    b.disabled = true;
    b.textContent = '⏳ Reading…';
    try {
      const res = await api.post('/kpi/calc/import', { force: b.dataset.kc === 'force' });
      const bad = res.filter((r) => r.status === 'error' || r.status === 'missing');
      const done = res.filter((r) => r.status === 'imported');
      toast(bad.length ? bad.map((r) => `${r.source}: ${r.error || `can't find ${r.file}`}`).join(' · ')
        : done.length ? `Read ${done.map((r) => `${r.source} (${r.rows.toLocaleString('en-GB')} rows)`).join(', ')}` : 'Nothing changed since the last read', bad.length ? 'error' : '');
    } catch (err) { toast(err.message, 'error'); }
    renderKpiCalc();
  };
}

// A week's typed-in figures: HR from Protime and complaints.
function kpiWeekForm(w) {
  const days = ['Sunday (night)', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const pt = w.protime || [];
  const v = (x) => (x === null || x === undefined ? '' : x);
  openModal(`<h2>${esc(w.week)} <span class="muted small">${esc(w.month)}</span></h2>
    <form id="kpi-week-form" class="stack">
      <fieldset class="kw-set"><legend>Working hours — Protime “Present/total”</legend>
        <div class="kw-days">${days.map((d, i) => `<label class="f">${d}<input type="number" step="0.01" min="0" name="pt${i}" value="${esc(v(pt[i]))}"></label>`).join('')}</div>
        <div class="row small"><span class="muted">(Sun + Mon + … + Fri) × 7.5 + 37.5 =</span> <b id="kw-hours-calc"></b>
          <span class="spacer"></span><label class="row">or hours <input type="number" step="0.01" min="0" name="hours" value="${esc(v(w.hours))}" style="width:110px"></label></div>
      </fieldset>
      <fieldset class="kw-set"><legend>Headcount (direct employees)</legend>
        <div class="row"><label class="f">Contract<input type="number" step="1" min="0" name="contract" value="${esc(v(w.contract))}"></label>
          <label class="f">Temps<input type="number" step="1" min="0" name="temps" value="${esc(v(w.temps))}"></label></div>
      </fieldset>
      <fieldset class="kw-set"><legend>Customer complaints opened this week</legend>
        <div class="row"><label class="f">Critical<input type="number" step="1" min="0" name="cc_critical" value="${esc(v(w.cc_critical))}"></label>
          <label class="f">Major<input type="number" step="1" min="0" name="cc_major" value="${esc(v(w.cc_major))}"></label>
          <label class="f">Minor<input type="number" step="1" min="0" name="cc_minor" value="${esc(v(w.cc_minor))}"></label></div>
      </fieldset>
      <div class="row"><div class="spacer"></div><button type="button" onclick="closeModal()">Cancel</button><button class="primary" type="submit">Save</button></div>
    </form>`);
  const form = $('#kpi-week-form');
  const calcHours = () => {
    const n = days.map((_, i) => form[`pt${i}`].value).filter((x) => x !== '').map(Number);
    $('#kw-hours-calc').textContent = n.length ? (n.reduce((a, b) => a + b, 0) * 7.5 + 37.5).toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '—';
    form.hours.disabled = n.length > 0;
  };
  form.addEventListener('input', calcHours);
  calcHours();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { protime: days.map((_, i) => form[`pt${i}`].value), contract: form.contract.value, temps: form.temps.value,
      cc_critical: form.cc_critical.value, cc_major: form.cc_major.value, cc_minor: form.cc_minor.value };
    if (!body.protime.some((x) => x !== '')) body.hours = form.hours.value;
    try {
      await api.put(`/kpi/manual/${encodeURIComponent(w.week)}`, body);
      toast(`${w.week} saved`);
      state.modalDirty = true;
      closeModal();
    } catch (err) { toast(err.message, 'error'); }
  });
}

// The OTD report rows behind a week's delays.
async function kpiOtdRows(week) {
  const rows = await api.get(`/kpi/calc/otd?week=${encodeURIComponent(week)}`);
  const sum = (t) => rows.filter((r) => String(r.type || '').toLowerCase() === t).reduce((a, r) => a + (r.qty || 0), 0);
  openModal(`<h2>OTD report — ${esc(week)}</h2>
    <p class="small muted">Rows counted in ${esc(week)}: the week typed in the report's Week column. Internal ${sum('internal').toLocaleString('en-GB')} · External ${sum('external').toLocaleString('en-GB')}.
      Rows whose Type is neither Internal nor External aren't added up.</p>
    <table class="log small"><thead><tr><th>Customer</th><th class="num">Volume</th><th>Type</th><th>Date</th><th>Week typed</th><th>Month</th><th>Reason</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td>${esc(r.customer || '')}</td><td class="num">${(r.qty || 0).toLocaleString('en-GB')}</td><td>${esc(r.type || '')}</td>
        <td>${esc(r.date || '')}${r.date && r.date_week && r.date_week !== week ? ` <span class="chip overdue" title="This date is in ${esc(r.date_week)}">≠ week</span>` : ''}</td>
        <td>${esc(r.week_typed ?? '')}</td><td>${esc(r.month ?? '')}</td><td>${esc(r.reason || '')}</td></tr>`).join('')}</tbody></table>
    <div class="row" style="margin-top:12px"><div class="spacer"></div><button onclick="closeModal()">Close</button></div>`, { wide: true });
}

// Builds (or rebuilds) a week's A3 from the source figures and shows it.
async function kpiBuild(week, replace, el, view) {
  if (el) el.disabled = true;
  toast(`Building ${week}…`);
  try {
    const r = await api.post('/kpi/build', { week, replace });
    toast(`${week} built from the source figures${r.flags?.length ? ' — see the notes above it' : ''}`);
    const target = `#/kpi/${r.id}${view === 'database' ? '/database' : ''}`;
    if (location.hash === target) await route(); else location.hash = target;
  } catch (err) { toast(err.message, 'error'); if (el) el.disabled = false; await route(); }
}

// ---- changes made by hand on the A3 ----------------------------------------------------------

const KPI_COLOURS = [['green', '00B050', 'Green'], ['yellow', 'FFC000', 'Yellow'], ['red', 'FF0000', 'Red']];
// trend symbols: the symbol and its colour go together
const KPI_SYMBOLS = [['▲', '00B050', 'Up — green'], ['▬', 'FFC000', 'Level — yellow'], ['▼', 'FF0000', 'Down — red']];
const xlRef = (row, col) => { let s = ''; for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return `${s}${row}`; };

// The sheet view with a week's edits in: typed text in place, chosen colours as text colour
// (or fill, where the conditional format sets the fill).
function withKpiEdits(m, edits) {
  if (!edits || !Object.keys(edits).length) return m;
  const styles = [...m.styles];
  const restyle = (s, prop, hex) => {
    const css = `${styles[s].split(';').filter((d) => !d.startsWith(`${prop}:`)).join(';')};${prop}:#${hex}`;
    const at = styles.indexOf(css);
    if (at >= 0) return at;
    styles.push(css);
    return styles.length - 1;
  };
  const cells = m.cells.map((c) => {
    const ref = xlRef(c[0], c[1]); const e = edits[ref];
    if (!e) return c;
    const n = [...c];
    if (e.text !== null && e.text !== undefined) n[2] = e.text;
    if (e.color) n[3] = restyle(n[3], (m.edit?.[ref] || '').includes('b') ? 'background' : 'color', e.color);
    return n;
  });
  return { ...m, cells, styles };
}

// The little editor over a cell: its text (a typed box) and/or its colour (a KPI).
function kpiEditCell(snap, model, el, done) {
  $('#kpi-pop')?.remove();
  const ref = el.dataset.ref; const kind = model.edit[ref] || '';
  const cur = snap.edits?.[ref] || {};
  const original = model.cells.find((c) => c[0] === Number(el.dataset.cell.split(':')[0]) && c[1] === Number(el.dataset.cell.split(':')[1]))?.[2] ?? '';
  const text = cur.text ?? original;
  const pop = document.createElement('div');
  pop.id = 'kpi-pop';
  pop.className = 'kpi-pop card';
  pop.innerHTML = `<div class="row small muted"><b>${esc(ref)}</b><span class="spacer"></span>${cur.text !== undefined && cur.text !== null || cur.color ? '<span class="kpi-ed-key">changed by hand</span>' : ''}</div>
    ${kind.includes('t') ? `<textarea rows="${Math.min(12, Math.max(3, text.split('\n').length + 1))}">${esc(text)}</textarea>
      ${cur.text !== null && cur.text !== undefined ? `<div class="small muted">Was: ${original ? esc(original.length > 120 ? `${original.slice(0, 120)}…` : original) : '<i>empty</i>'}</div>` : ''}` : ''}
    ${kind.includes('s') ? `<div class="kpi-swatches">${KPI_SYMBOLS.map(([sym, hex, label]) => `<button type="button" data-symbol="${sym}" class="${cur.text === sym ? 'on' : ''}" title="${label}"><b style="color:#${hex}">${sym}</b>${label.split(' — ')[0]}</button>`).join('')}
      <button type="button" data-symbol="" class="${cur.text ? '' : 'on'}" title="As the workbook's formula gives it">Automatic</button></div>`
    : /[fb]/.test(kind) ? `<div class="kpi-swatches">${KPI_COLOURS.map(([name, hex, label]) => `<button type="button" data-colour="${name}" class="${cur.color === hex ? 'on' : ''}" title="${label}"><i style="background:#${hex}"></i>${label}</button>`).join('')}
      <button type="button" data-colour="" class="${cur.color ? '' : 'on'}" title="As the conditional format colours it">Automatic</button></div>` : ''}
    <div class="row">${kind.includes('t') ? '<button class="primary small" data-pop="save">Save</button>' : ''}
      ${cur.text !== null && cur.text !== undefined ? '<button class="small link" data-pop="revert" title="Put back the workbook\'s text">Put back the original text</button>' : ''}
      <span class="spacer"></span><button class="small" data-pop="close">${kind.includes('t') ? 'Cancel' : 'Close'}</button></div>`;
  document.body.append(pop);
  const r = el.getBoundingClientRect();
  const w = Math.min(Math.max(r.width + 16, kind.includes('t') ? 360 : 260), window.innerWidth - 16);
  pop.style.width = `${w}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left - 8, window.innerWidth - w - 8))}px`;
  const ph = pop.offsetHeight;
  pop.style.top = `${r.bottom + 6 + ph < window.innerHeight ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;
  const ta = $('textarea', pop);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  const close = () => { pop.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', keys, true); };
  const outside = (e) => { if (!pop.contains(e.target)) close(); };
  const save = async (body) => {
    try { const edits = await api.put(`/kpi/edits/${snap.week}`, { ref, ...body }); close(); await done(edits); } catch (err) { toast(err.message, 'error'); }
  };
  const saveText = () => save({ text: ta.value === original ? null : ta.value });
  const keys = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && ta) { e.preventDefault(); saveText(); }
  };
  setTimeout(() => { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', keys, true); });
  pop.addEventListener('click', (e) => {
    const sy = e.target.closest('[data-symbol]');
    if (sy) {
      const sym = KPI_SYMBOLS.find(([x]) => x === sy.dataset.symbol);
      return save(sym ? { text: sym[0], color: sym[1] } : { text: null, color: null });
    }
    const sw = e.target.closest('[data-colour]');
    if (sw) {
      const colour = sw.dataset.colour || null;
      return save(ta && ta.value !== text ? { color: colour, text: ta.value === original ? null : ta.value } : { color: colour });
    }
    const b = e.target.closest('[data-pop]');
    if (!b) return;
    if (b.dataset.pop === 'close') close();
    if (b.dataset.pop === 'save') saveText();
    if (b.dataset.pop === 'revert') save({ text: null });
  });
}

// What's said about a week's A3: notes about where its parts came from (behind ⓘ), and
// notices that need something done (shown above it, each with its action).
function kpiNotices(snap) {
  const info = []; const actions = [];
  const hasText = Object.values(snap.edits || {}).some((e) => e.text !== null && e.text !== undefined && !/^[▲▼▬]$/.test(e.text));
  if (snap.origin === 'ci') {
    info.push(`Built ${esc(fmtDateTime(snap.loaded_at))} by the CI Manager from the source figures, with the workbook's formulas and layout${snap.template_week ? ` (template: the workbook loaded for ${esc(snap.template_week)})` : ''}.`);
  } else {
    info.push(`Loaded ${esc(fmtDateTime(snap.loaded_at))} from ${esc(snap.source_name || 'the workbook')}${snap.source_modified ? ` (saved ${esc(fmtDateTime(snap.source_modified))})` : ''}.`);
  }
  for (const f of snap.flags || []) {
    if (f.part === 'text') {
      const from = snap.template_week || 'the template';
      if (hasText) info.push(`Typed text: changed for this week; boxes not changed are the workbook's, from ${esc(from)}.`);
      else if (!kpiState.editing) {
        actions.push({ text: `The text boxes (executive summary, comments…) still show ${esc(from)}'s text.`,
          buttons: `<button class="small" data-kpi="edit">✎ Update the text</button>${snap.text_from ? `<button class="small" data-kpi="copy-text" title="Fill the text boxes with what was typed for ${esc(snap.text_from)}">⇩ Use ${esc(snap.text_from)}'s text</button>` : ''}` });
      }
    } else if (f.part === 'forecast') {
      actions.push({ text: esc(f.text), buttons: '<a class="button small" href="#/kpi/calc">Set the forecast files</a>' });
    } else info.push(esc(f.text));
  }
  if (snap.exported_to) info.push(`A3 saved ${esc(fmtDateTime(snap.exported_at))} to <code>${esc(snap.exported_to)}</code>.`);
  return { info, actions };
}
