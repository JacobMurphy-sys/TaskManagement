// 📣 SIM's drawings, shared by the page (sim.js) and the server (simauto.js, the automatic picture): the month-to-date
// line charts, and the whole SIM as one picture (an SVG the server turns into a PNG). In the browser its functions are
// globals; in Node it's a module.
(function (root) {
  const SIM_COL = { green: '#00B050', yellow: '#FFC000', red: '#FF0000' }; // the A3's arrow colours
  const simPct = (v, dp = 1) => (v === null || v === undefined ? '–' : `${(v * 100).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp })}%`);
  const simNum = (v, dp = 0) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
  const simFmt = { quality: (v) => simNum(v, 2), scrap: (v) => simPct(v, 2), otd: (v) => simPct(v, 1) };
  const xesc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dayTitle = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

  // the four charts of a SIM (GET /sim's answer): what each draws
  function simChartSpecs(d) {
    const T = d.topics;
    return [
      { id: 'sim-c-quality', topic: 'quality', rows: T.quality.by_day, series: [{ val: (r) => r.value, colour: (r) => r.colour }], target: T.quality.target, better: 'down', f: simFmt.quality },
      { id: 'sim-c-safety', topic: 'safety', rows: T.safety.by_day, series: [{ key: 'ac', label: 'AC', col: SIM_COL.red }, { key: 'nm', label: 'NM', col: '#d9a400' }, { key: 'sc', label: 'SC', col: '#8a90ad' }].map((x) => ({ ...x, val: (r) => (r.worked || r[x.key] ? r[x.key] ?? 0 : null), colour: () => null })),
        target: 0, better: 'down', f: (v) => String(Math.round(v)), targetLabel: '0 AC', integer: true },
      { id: 'sim-c-scrap', topic: 'scrap', rows: T.scrap.by_day, series: [{ val: (r) => r.value, colour: (r) => r.colour }], target: T.scrap.target, better: 'down', f: simFmt.scrap },
      { id: 'sim-c-otd', topic: 'otd', rows: T.otd.by_day, series: [{ val: (r) => r.value, colour: (r) => r.colour }], target: T.otd.target, better: 'up', f: simFmt.otd },
    ];
  }

  // The month to date as a line chart, W × H: a line per series through the days with a figure (joined up over the
  // days without one), each day's point in its result's colour, the target dashed with its tag in the left margin and
  // the side that meets it shaded, the day shown highlighted, the days off target with their figure; each day's column
  // carries data-sim-day (the page opens that day on a click). Returns the <svg>.
  function simChartSvg(c, day, W, H, o = {}) {
    const accent = o.accent || 'var(--accent)'; const muted = o.muted || 'var(--muted)';
    const L = 70; const R = 10; const Tp = 8; const B = 18; const n = c.rows.length || 1;
    const step = (W - L - R) / Math.max(1, n - 1 || 1); const xOf = (i) => (n === 1 ? L + (W - L - R) / 2 : L + i * step);
    const vals = c.rows.flatMap((r) => c.series.map((s) => s.val(r))).filter((v) => v !== null && v !== undefined);
    const tg = c.target;
    let lo = 0; let hi = Math.max(...vals, tg ?? 0, c.integer ? 2 : 0);
    if (c.better === 'up') { lo = Math.max(0, Math.min(Math.min(...(vals.length ? vals : [tg ?? 0.9]), tg ?? 1) - 0.02, 0.98)); hi = 1; }
    if (hi <= lo) hi = lo + (c.integer ? 2 : 1);
    const top = hi; hi += (hi - lo) * (c.better === 'up' ? 0.06 : 0.1); // headroom (a share can't pass 100%: its top label stays at it)
    const yOf = (v) => Tp + (1 - (v - lo) / (hi - lo)) * (H - Tp - B);
    const parts = [];
    // the side that meets the target, shaded
    if (tg !== null && tg !== undefined) {
      const yt = yOf(tg);
      parts.push(c.better === 'down' ? `<rect x="${L}" y="${yt}" width="${W - L - R}" height="${H - B - yt}" class="sim-okzone"/>` : `<rect x="${L}" y="${Tp}" width="${W - L - R}" height="${yt - Tp}" class="sim-okzone"/>`);
    }
    // the day shown, and the days along the bottom (weekends and holidays paler)
    c.rows.forEach((r, i) => {
      const x = xOf(i); const w = n === 1 ? 30 : step;
      if (r.day === day) parts.push(`<rect x="${x - w / 2}" y="${Tp}" width="${w}" height="${H - Tp - B}" class="sim-selbg"/>`);
      const every = step < 16 ? 2 : 1;
      if (i % every === 0 || r.day === day) parts.push(`<text x="${x}" y="${H - 5}" class="sim-ax${r.worked ? '' : ' off'}${r.day === day ? ' sel' : ''}">${Number(r.day.slice(8))}</text>`);
    });
    // y axis: bottom, top (left out where the target's tag sits)
    const clear = (v) => tg === null || tg === undefined || Math.abs(yOf(v) - yOf(tg)) > 30;
    parts.push(`${clear(lo) ? `<text x="${L - 6}" y="${yOf(lo) + 3}" class="sim-yax">${c.f(lo)}</text>` : ''}${clear(top) ? `<text x="${L - 6}" y="${yOf(top) + 3}" class="sim-yax">${c.f(top)}</text>` : ''}<line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" class="sim-base"/>`);
    // the target: in the left margin, on the line, so it never covers a day's point
    if (tg !== null && tg !== undefined) {
      const yt = yOf(tg); const label = c.targetLabel || `${c.better === 'down' ? '≤' : '≥'} ${c.f(tg)}`;
      const tw = L - 6; const by = Math.min(H - B - 8, Math.max(Tp + 1, yt - 7.5));
      parts.push(`<line x1="${L}" x2="${W - R}" y1="${yt}" y2="${yt}" class="sim-target"/><rect x="2" y="${by}" width="${tw}" height="15" rx="4" class="sim-tbox"><title>Target ${xesc(label)}</title></rect><text x="${2 + tw / 2}" y="${by + 11}" class="sim-tlabel">${xesc(label)}</text><text x="${L - 6}" y="${by - 3 < Tp + 4 ? by + 25 : by - 3}" class="sim-tword">TARGET</text>`);
    }
    // the lines and their points; the days off target (yellow or red) get their figure by them, drawn last
    const labels = [];
    for (const s of c.series) {
      let path = '';
      c.rows.forEach((r, i) => { const v = s.val(r); if (v === null || v === undefined) return; path += `${path ? 'L' : 'M'}${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`; });
      if (path) parts.push(`<path d="${path}" class="sim-line" style="stroke:${s.col || accent}"/>`);
      c.rows.forEach((r, i) => {
        const v = s.val(r); if (v === null || v === undefined) return;
        if (s.key && !v && r.day !== day) return; // a count of 0: no dot
        const col = s.col || SIM_COL[s.colour(r)] || muted; const sel = r.day === day;
        parts.push(`<circle cx="${xOf(i)}" cy="${yOf(v)}" r="${sel ? 5.5 : 3.5}" fill="${col}" class="sim-dot${sel ? ' sel' : ''}"><title>${xesc(dayTitle(r.day))}: ${s.label ? `${s.label} ` : ''}${c.f(v)}</title></circle>`);
        const zone = s.key ? (v > 0 && (s.key === 'ac' ? 'red' : s.key === 'nm' ? 'yellow' : null)) : s.colour(r);
        if (zone !== 'yellow' && zone !== 'red') return;
        const x = xOf(i); const y = yOf(v); const below = c.better === 'up';
        const txt = c.f(v); const tw = txt.length * 6.2 + 2;
        // the points either side on this line: a label mustn't sit on the line running to them
        const near = (dir) => { for (let j = i + dir; j >= 0 && j < c.rows.length; j += dir) { const w = s.val(c.rows[j]); if (w !== null && w !== undefined) return { x: xOf(j), y: yOf(w) }; } return null; };
        const nbs = [near(-1), near(1)].filter(Boolean);
        const hits = (x1, x2, y1, y2) => nbs.some((nb) => { // the line's part over the box's width spans a range of heights
          const a = Math.max(x1, Math.min(x, nb.x)); const b = Math.min(x2, Math.max(x, nb.x));
          if (a > b) return false;
          const at = (px) => y + ((nb.y - y) * (px - x)) / (nb.x - x);
          return Math.max(at(a), at(b)) >= y1 - 2 && Math.min(at(a), at(b)) <= y2 + 2;
        });
        // where it can go, best first: on the side away from the target, then beside the point (right, then left)
        const vy = below ? y + 15 : y - 8; const vx1 = Math.max(L, Math.min(W - R - tw, x - tw / 2));
        const sy = Math.min(H - B - 3, Math.max(Tp + 9, y + 3.5));
        const spots = [
          { ok: (below ? H - B - y >= 17 : y - Tp >= 15) && !hits(vx1, vx1 + tw, vy - 10, vy), x: vx1 + tw / 2, y: vy, anchor: 'middle' },
          { ok: x + 8 + tw <= W - R && !hits(x + 6, x + 8 + tw, sy - 10, sy), x: x + 8, y: sy, anchor: 'start' },
          { ok: x - 8 - tw >= L && !hits(x - 8 - tw, x - 6, sy - 10, sy), x: x - 8, y: sy, anchor: 'end' },
        ];
        const at = spots.find((p) => p.ok) || { x: vx1 + tw / 2, y: Math.min(H - B - 3, Math.max(Tp + 9, vy)), anchor: 'middle' };
        labels.push(`<text x="${at.x}" y="${at.y}" text-anchor="${at.anchor}" class="sim-dlabel sim-dl-${zone}">${xesc(txt)}</text>`);
      });
    }
    parts.push(...labels);
    if (c.series.some((s) => s.label)) parts.push(`<g class="sim-legend">${c.series.map((s, i) => `<g transform="translate(${L + 6 + i * 44},${Tp + 6})"><line x1="0" x2="12" y1="0" y2="0" style="stroke:${s.col}" class="sim-line"/><text x="16" y="3">${s.label}</text></g>`).join('')}</g>`);
    if (!o.picture) c.rows.forEach((r, i) => { const w = n === 1 ? 30 : step; parts.push(`<rect x="${xOf(i) - w / 2}" y="0" width="${w}" height="${H}" fill="transparent" class="sim-hit" data-sim-day="${r.day}"><title>${xesc(dayTitle(r.day))}</title></rect>`); });
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="The month to date, day by day">${parts.join('')}</svg>`;
  }

  // ---- the whole SIM as one picture (W × H, light), for the automatic PNG ----------------------------------------
  const P = { ink: '#1d1f2b', muted: '#6b7085', border: '#d9dce8', accent: '#430099', bg: '#f4f5fa', panel: '#ffffff', okzone: '#e3f5ea', sel: '#ecebfb' };
  const TINT = { green: ['#e0f5e9', '#00B050', '#00a04a'], yellow: ['#fff4d6', '#FFC000', '#b38600'], red: ['#ffe3e3', '#FF0000', '#e00000'] };
  const FONT = "'Segoe UI', Arial, Helvetica, sans-serif";
  const CHART_CSS = `.sim-okzone{fill:${P.okzone}}.sim-selbg{fill:${P.sel}}.sim-ax{font-size:10px;text-anchor:middle;fill:${P.muted}}.sim-ax.off{fill:#b4b8c8}.sim-ax.sel{fill:${P.accent};font-weight:700}
.sim-yax{font-size:10px;text-anchor:end;fill:${P.muted}}.sim-target{stroke:${P.ink};stroke-dasharray:6 4;stroke-width:1.6}.sim-tbox{fill:${P.ink}}.sim-tlabel{font-size:10.5px;font-weight:700;text-anchor:middle;fill:#ffffff}
.sim-tword{font-size:9px;font-weight:700;text-anchor:end;fill:${P.ink}}.sim-base{stroke:${P.border};stroke-width:1}.sim-line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.sim-dot{stroke:#ffffff;stroke-width:1.2}.sim-dot.sel{stroke:${P.ink};stroke-width:2}.sim-legend text{font-size:10px;fill:${P.muted}}
.sim-dlabel{font-size:10.5px;font-weight:700;paint-order:stroke;stroke:#ffffff;stroke-width:3px;stroke-linejoin:round}.sim-dl-red{fill:#e00000}.sim-dl-yellow{fill:#b38600}`;
  // a line of text cut to fit w px at size px (roughly: an average letter is about half the size wide)
  const fit = (s, w, size) => { s = String(s ?? ''); const max = Math.max(4, Math.floor(w / (size * 0.53))); return s.length > max ? `${s.slice(0, max - 1)}…` : s; };
  const text = (x, y, s, { size = 14, fill = P.ink, weight = 400, anchor = 'start', w = 0 } = {}) => `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${xesc(w ? fit(s, w, size) : s)}</text>`;

  function simPictureSvg(d, o = {}) {
    const W = o.W || 1920; const H = o.H || 1080; const pad = 22; const gap = 16; const headH = 58;
    const T = d.topics; const specs = simChartSpecs(d);
    const short = (dd) => new Date(`${dd}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const vol = (t, n, what) => (n || (t.read_to && t.read_to >= d.day) ? `${simNum(n)} ${what}` : { s: `${what} not read yet${t.read_to ? ` (to ${short(t.read_to)})` : ''}`, fill: '#e00000' });
    const tgt = (t, f) => (t.target === null || t.target === undefined ? { s: 'no target set', fill: P.muted } : `target ${t.better === 'down' ? '≤' : '≥'} ${f(t.target)}`);
    const mtd = (t, f) => ({ s: `Month to date ${f(t.mtd.value)}`, fill: t.mtd.colour ? TINT[t.mtd.colour][2] : P.ink });
    const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const q = T.quality; const s = T.safety; const sc = T.scrap; const ot = T.otd;
    // each panel: its result, the facts beside it, and its lists (title, rows of [line, under])
    const panels = [
      { key: 'quality', title: 'Quality', unit: 'CPMS: customer complaints per million cards shipped', colour: q.colour, big: simFmt.quality(q.value),
        facts: [[pl(q.complaints.length, 'complaint', 'complaints'), vol(q, q.shipped, 'cards shipped')], tgt(q, simFmt.quality), mtd(q, simFmt.quality), `Internal reports ${q.internal.length} (month: ${q.mtd.internal})`],
        lists: [['Customer complaints opened', q.complaints.map((c) => [`${c.ref || '—'}  ${c.customer || ''}${c.severity ? ` · ${c.severity}` : ''}`, c.summary]), 'None opened that day.'],
          ['Internal reports', q.internal.map((r) => [`${r.area ? `${r.area} · ` : ''}${r.text}`, r.created_by]), 'None noted.']] },
      { key: 'safety', title: 'Safety', unit: 'safety concern forms by incident date', colour: s.colour, big: String(s.ac), small: s.ac === 1 ? 'accident' : 'accidents',
        facts: [`${pl(s.nm, 'near miss', 'near misses')} · ${pl(s.sc, 'safety concern', 'safety concerns')}`, { s: s.rule, fill: P.muted }, { s: `Month to date ${s.mtd.ac} AC · ${s.mtd.nm} NM · ${s.mtd.sc} SC`, fill: s.mtd.ac ? '#e00000' : P.ink }],
        lists: [['Forms that day', s.forms.map((f) => [`${f.kind}  ${f.location || ''}${f.detail ? ` · ${f.detail}` : ''}`, f.description]), 'No forms that day.']] },
      { key: 'scrap', title: 'Scrap', unit: 'scrap rate: scrap ÷ cards persoed', colour: sc.colour, big: simFmt.scrap(sc.value),
        facts: [[`${simNum(sc.scrap)} cards scrapped`, vol(sc, sc.persoed, 'persoed')], tgt(sc, simFmt.scrap), mtd(sc, simFmt.scrap), { s: `${simNum(sc.mtd.scrap)} scrapped of ${simNum(sc.mtd.persoed)} this month`, fill: P.muted }],
        lists: [['Top 5 scrap that day', sc.top.map((t) => [`${simNum(t.qty)}   ${t.wo || '—'}  ${t.customer || ''}${t.name ? ` ${t.name}` : ''}`, `${t.cause || ''}${t.item ? ` · ${t.item}` : ''}`]), 'No scrap that day.']] },
      { key: 'otd', title: 'OTD', unit: 'OTD SC: 1 − SC delays ÷ cards shipped', colour: ot.colour, big: simFmt.otd(ot.value),
        facts: [[`${simNum(ot.sc)} SC delays · ${simNum(ot.customer)} customer`, vol(ot, ot.shipped, 'shipped')], tgt(ot, simFmt.otd), mtd(ot, simFmt.otd),
          ot.undated.rows ? { s: `${pl(ot.undated.rows, 'delay', 'delays')} of ${ot.undated.week} without a date (${simNum(ot.undated.qty)} cards)`, fill: '#e00000' } : null],
        lists: [['Delays that day', ot.delays.map((x) => [`${simNum(x.qty)}   ${x.kind}  ${x.customer || ''}${x.wo ? ` · ${x.wo}` : ''}`, x.reason]), 'No dated delays that day.'],
          ['Late work orders due that day', ot.late_wos.map((j) => [`${simNum(j.qty)}   ${j.wo}  ${j.customer || ''}${j.name ? ` ${j.name}` : ''}`, j.open ? `still open, ${simNum(j.late_hours, 1)} h past its deadline` : `finished ${simNum(j.late_hours, 1)} h late`]), 'None late (from the planner).']] },
    ];
    const pw = (W - 2 * pad - gap) / 2; const ph = (H - headH - pad - gap) / 2;
    const out = [];
    out.push(`<rect width="${W}" height="${H}" fill="${P.bg}"/>`);
    out.push(text(pad, 40, 'SIM', { size: 30, weight: 800, fill: P.accent }));
    out.push(text(pad + 78, 40, `${d.label}${d.day === d.default_day ? ' · last working day' : ''}`, { size: 22, weight: 700 }));
    if (o.stamp) out.push(text(W - pad, 40, o.stamp, { size: 14, fill: P.muted, anchor: 'end' }));
    panels.forEach((p, k) => {
      const x0 = pad + (k % 2) * (pw + gap); const y0 = headH + Math.floor(k / 2) * (ph + gap);
      out.push(`<rect x="${x0}" y="${y0}" width="${pw}" height="${ph}" rx="12" fill="${P.panel}" stroke="${P.border}"/>`);
      // as on the page: Scrap and OTD keep their lists in a column down the right; Quality and Safety give the chart
      // the full width with a strip of their lists along the bottom
      const side = p.key === 'scrap' || p.key === 'otd';
      const listX = side ? x0 + pw * 0.64 : x0 + pw - 8; const leftW = listX - x0 - 18;
      const stripH = side ? 0 : Math.round(ph * 0.24);
      out.push(text(x0 + 18, y0 + 34, p.title, { size: 24, weight: 800 }));
      out.push(text(x0 + 18 + p.title.length * 14 + 14, y0 + 33, p.unit, { size: 13, fill: P.muted, w: leftW - p.title.length * 14 - 30 }));
      // the result: big, in its colour
      const [bg, bd, fg] = p.colour ? TINT[p.colour] : ['#f0f1f6', P.border, P.ink];
      const bx = x0 + 18; const by = y0 + 50; const bw = 200; const bh = 96;
      out.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="12" fill="${bg}" stroke="${bd}" stroke-width="2"/>`);
      if (p.small) out.push(`<text x="${bx + bw / 2}" y="${by + 64}" text-anchor="middle" fill="${fg}" font-weight="800"><tspan font-size="50">${xesc(p.big)}</tspan><tspan font-size="20" dx="8">${xesc(p.small)}</tspan></text>`);
      else out.push(text(bx + bw / 2, by + 64, p.big, { size: p.big.length > 6 ? 44 : 50, weight: 800, fill: fg, anchor: 'middle' }));
      // the facts beside it (a line can be a run of parts, each plain or coloured)
      let fy = by + 22; const fx = bx + bw + 18; const fw = listX - fx - 10;
      for (const line of p.facts.filter(Boolean)) {
        const bits = (Array.isArray(line) ? line : [line]).map((b) => (typeof b === 'string' ? { s: b, fill: P.ink } : b));
        let used = 0; // letters so far: each part is cut to what's left of the width
        out.push(`<text x="${fx}" y="${fy}" font-size="15">${bits.map((b, i) => { const sep = i ? ' · ' : ''; const t = fit(b.s, Math.max(60, fw - (used + sep.length) * 15 * 0.53), 15); used += sep.length + t.length; return `<tspan fill="${b.fill}">${sep}${xesc(t)}</tspan>`; }).join('')}</text>`);
        fy += 22;
      }
      // the chart, scaled up a little from the page's (its lettering stays readable on a big screen)
      const cx = x0 + 8; const cy = by + bh + 14; const cw = listX - cx - (side ? 14 : 10); const ch = y0 + ph - stripH - cy - 12; const zoom = 1.3;
      out.push(simChartSvg(specs[k], d.day, Math.round(cw / zoom), Math.round(ch / zoom), { accent: P.accent, muted: P.muted, picture: true })
        .replace('<svg ', `<svg x="${cx}" y="${cy}" preserveAspectRatio="none" `).replace(/width="(\d+)" height="(\d+)"/, `width="${cw}" height="${ch}"`));
      // a list: its title, then its rows (a line and one under it) while they fit, then how many more
      const drawList = (lx, ly, lw, bottom, [title, rows, empty], room = 99) => {
        out.push(text(lx, ly, title, { size: 15, weight: 700, fill: P.accent, w: lw })); ly += 22;
        if (!rows.length) { out.push(text(lx, ly, empty, { size: 13, fill: P.muted, w: lw })); return ly + 20; }
        let shown = 0;
        for (const [line, under] of rows) {
          if (shown >= room || ly + (under ? 38 : 20) > bottom) break;
          out.push(text(lx, ly, line, { size: 14, weight: 600, w: lw })); ly += 18;
          if (under) { out.push(text(lx, ly, under, { size: 12, fill: P.muted, w: lw })); ly += 18; }
          out.push(`<line x1="${lx}" x2="${lx + lw}" y1="${ly - 9}" y2="${ly - 9}" stroke="${P.border}" stroke-width="0.8"/>`); ly += 6;
          shown += 1;
        }
        if (shown < rows.length) { out.push(text(lx, Math.min(ly, bottom), `+ ${rows.length - shown} more`, { size: 12, fill: P.muted })); ly += 18; }
        return ly;
      };
      const bottom = y0 + ph - 14;
      if (side) {
        // down the right: the lists one under the other (the first leaves room for the next)
        out.push(`<line x1="${listX - 10}" x2="${listX - 10}" y1="${y0 + 16}" y2="${y0 + ph - 16}" stroke="${P.border}"/>`);
        const lw = x0 + pw - listX - 16; let ly = y0 + 34;
        p.lists.forEach((l, li) => {
          if (ly > bottom - 30) return;
          if (li) ly += 10;
          ly = drawList(listX, ly, lw, bottom, l, li < p.lists.length - 1 ? Math.max(1, Math.floor((bottom - ly) / 2 / 40)) : 99);
        });
      } else {
        // the strip along the bottom: the lists side by side
        const sy = y0 + ph - stripH; const n = p.lists.length; const sx = x0 + 18; const sw = pw - 36; const cg = 24;
        out.push(`<line x1="${sx}" x2="${sx + sw}" y1="${sy}" y2="${sy}" stroke="${P.border}"/>`);
        const colW = (sw - cg * (n - 1)) / n;
        p.lists.forEach((l, li) => drawList(sx + li * (colW + cg), sy + 22, colW, bottom, l));
      }
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}"><style>${CHART_CSS}</style>${out.join('')}</svg>`;
  }

  const api = { SIM_COL, simPct, simNum, simFmt, simChartSpecs, simChartSvg, simPictureSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else Object.assign(root, api);
}(typeof window !== 'undefined' ? window : globalThis));
