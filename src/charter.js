// Project charter: the fields of the standard project template, how complete a
// project's charter is, and filling the user's own Excel template with it.
//
// Template filling: the uploaded .xlsx is read, each field's label ("Problem
// definition:", "Management Sponsor:", …) is found, and the value is written to
// the box beside or beneath it, or under the label when the label sits at the top
// of its box. Timeline grids ("Sub projects" / "Action agreed" with month columns)
// are filled from the project's tasks. The user can correct any cell on the
// Settings page. Everything else in the workbook (styles, merges, other sheets,
// formulas) is left untouched.
const { buildXlsx, zip, readZip, xmlEsc, excelSerial } = require('./xlsx');

// key -> label, and the regex used to find its label in a template.
const FIELDS = {
  name: { label: 'Project title', find: /project\s*title/i },
  problem: { label: 'Problem definition', find: /problem\s*(definition|statement)?/i },
  goals: { label: 'Goals of the project', find: /goals?\b/i },
  team: { label: 'Team (incl. capacity p.p.)', find: /^team\b/i },
  in_scope: { label: 'In scope', find: /^in\s*scope/i },
  out_scope: { label: 'Out of scope', find: /out\s*of\s*scope/i },
  benefits_quantified: { label: 'Quantified business benefits', find: /^quantified/i },
  benefits_other: { label: 'Not quantified business benefits', find: /not\s*quantified|non[-\s]*quantified|unquantified/i },
  sponsor: { label: 'Management sponsor', find: /sponsor/i },
  leader: { label: 'Project leader', find: /project\s*lead(er)?|project\s*manager/i },
  date: { label: 'Current date', find: /current\s*date|^date\b/i },
  policy_deployment: { label: 'Policy deployment', find: /policy/i },
  category: { label: 'Category', find: /^category/i },
  gm_effect: { label: 'Gross margin effect', find: /gross\s*margin/i },
  project_code: { label: 'Project ID', find: /project\s*(id|no\.?|number|code)\b/i },
  kpis: { label: 'Improvement KPIs', find: /\bkpis?\b/i },
  milestones: { label: 'Milestone / phase plan', find: /timeline|milestone|phases?\b|time\s*plan|planning/i },
};
const FIELD_LIST = Object.entries(FIELDS).map(([key, f]) => ({ key, label: f.label }));
// Needed to create a project; the rest can follow.
const REQUIRED = { name: 'Project title', problem: 'Problem definition', goals: 'Goals of the project',
  sponsor: 'Management sponsor', leader: 'Project leader' };

// ---- completeness ------------------------------------------------------------

function completeness(p, extras) {
  const checks = {
    name: p.name, problem: p.problem, goals: p.goals, sponsor: p.sponsor, leader: p.leader,
    project_code: p.project_code, policy_deployment: p.policy_deployment, category: p.category, gm_effect: p.gm_effect,
    in_scope: p.in_scope, out_scope: p.out_scope, benefits_quantified: p.benefits_quantified, benefits_other: p.benefits_other,
    team: extras.team.length, kpis: extras.kpis.length, milestones: extras.milestones.some((m) => m.due_at),
  };
  const missing = Object.entries(checks).filter(([, v]) => !(typeof v === 'string' ? v.trim() : v)).map(([k]) => k);
  const total = Object.keys(checks).length;
  return {
    pct: Math.round(((total - missing.length) / total) * 100),
    missing: missing.map((k) => FIELDS[k].label),
    missing_required: missing.filter((k) => REQUIRED[k]).map((k) => FIELDS[k].label),
  };
}

// ---- status (Red / Yellow / Green) -----------------------------------------------

const localKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayKey = (iso) => (iso ? (iso.length === 10 ? iso : localKey(new Date(iso))) : null);

// Red: overdue. Yellow: blocked, or due within a week and not started. Green: otherwise (or done).
function ragStatus(t, today = localKey(new Date())) {
  if (t.status === 'done') return 'Green';
  const due = dayKey(t.due_at);
  if (due && due < today) return 'Red';
  const week = new Date(`${today}T12:00`); week.setDate(week.getDate() + 7);
  if (t.status === 'blocked' || (t.status === 'todo' && due && due <= localKey(week))) return 'Yellow';
  return 'Green';
}

// ---- values written into the template ------------------------------------------

const d = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function values(p, extras) {
  const snapshot = typeof p.baseline_snapshot === 'string' ? JSON.parse(p.baseline_snapshot) : p.baseline_snapshot;
  const baseline = new Map(((snapshot) || { tasks: [] }).tasks.map((t) => [t.id, t]));
  const row = (t) => ({
    title: t.title, owner: t.owner || '', due: dayKey(t.due_at), start: t.start_date || null,
    actual_start: dayKey(t.actual_start), completed: dayKey(t.completed_at), status: ragStatus(t), done: t.status === 'done',
  });
  const all = extras.tasks || [];
  const top = all.filter((t) => !t.parent_id);
  const topIds = new Set(top.map((t) => t.id));
  // Actions: subtasks, open ones first by due date, then the most recently finished.
  const actions = all.filter((t) => t.parent_id && topIds.has(t.parent_id)).sort((a, b) => (a.status === 'done') - (b.status === 'done')
    || String(a.due_at || '9').localeCompare(String(b.due_at || '9')) || String(b.completed_at || '').localeCompare(String(a.completed_at || '')));
  return {
    name: p.name,
    problem: p.problem || '',
    goals: p.goals || '',
    team: extras.team.map((m) => [m.name, m.role, m.capacity && `capacity ${m.capacity}`].filter(Boolean).join(' – ')).join('\n'),
    in_scope: p.in_scope || '',
    out_scope: p.out_scope || '',
    benefits_quantified: p.benefits_quantified || '',
    benefits_other: p.benefits_other || '',
    sponsor: p.sponsor || '',
    leader: p.leader || '',
    date: new Date().toLocaleDateString('en-GB'),
    policy_deployment: p.policy_deployment || '',
    category: p.category || '',
    gm_effect: p.gm_effect || '',
    project_code: p.project_code || '',
    kpis: extras.kpis.map((k) => `${k.name}${k.unit ? ` (${k.unit})` : ''}: ${k.baseline || '?'} → ${k.target || '?'}${k.current ? ` (now ${k.current})` : ''}`).join('\n'),
    milestones: extras.milestones.map((m) => {
      const b = baseline.get(m.id);
      const parts = [m.due_at ? `due ${d(m.due_at)}` : 'no date'];
      if (m.owner) parts.unshift(m.owner);
      if (b && b.due_at && m.due_at && d(b.due_at) !== d(m.due_at)) parts.push(`baseline ${d(b.due_at)}`);
      if (m.status === 'done') parts.push(`done ${d(m.completed_at)}`);
      return `${m.title}: ${parts.join(', ')}`;
    }).join('\n'),
    timeline: {
      sub: top.map(row),
      actions: actions.map(row),
      start_year: Number((p.start_date || [...all.map((t) => t.start_date || dayKey(t.due_at))].filter(Boolean).sort()[0] || localKey(new Date())).slice(0, 4)),
    },
  };
}

// A simple workbook with the charter, used until a template is uploaded.
function plainWorkbook(v) {
  const rows = FIELD_LIST.map((f) => [f.label, v[f.key]]);
  const plan = (list) => list.map((t) => [t.title, t.owner, t.start, t.due, t.actual_start, t.completed, t.status]);
  const planCols = [{ header: 'Task', width: 40 }, { header: 'Owner', width: 18 }, { header: 'Planned start', type: 'date', width: 13 },
    { header: 'Planned complete', type: 'date', width: 15 }, { header: 'Actual start', type: 'date', width: 13 },
    { header: 'Completed', type: 'date', width: 12 }, { header: 'Status', width: 9 }];
  return buildXlsx([
    { name: 'Charter', columns: [{ header: 'Field', width: 30 }, { header: 'Value', type: 'wrap', width: 100 }], rows },
    { name: 'Sub projects', columns: planCols, rows: plan(v.timeline.sub) },
    { name: 'Actions agreed', columns: planCols, rows: plan(v.timeline.actions) },
  ]);
}

// ---- reading a template -----------------------------------------------------------

const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colNum = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colLetters = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const parseRef = (ref) => { const m = ref.match(/^([A-Z]+)(\d+)$/); return { col: colNum(m[1]), row: Number(m[2]) }; };
const refOf = (col, row) => `${colLetters(col)}${row}`;
const CELL_RE = /<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function readTemplate(buf) {
  const files = readZip(buf);
  const str = (name) => (files[name] ? files[name].toString('utf8') : '');
  if (!files['xl/workbook.xml']) throw new Error('no workbook inside');
  const shared = [...str('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const rels = Object.fromEntries([...str('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = m[0].match(/Id="([^"]+)"/)[1];
    const target = m[0].match(/Target="([^"]+)"/)[1];
    return [id, target.startsWith('/') ? target.slice(1) : `xl/${target}`];
  }));
  const sheets = [...str('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = decode(m[0].match(/name="([^"]*)"/)[1]);
    const hidden = /state="(hidden|veryHidden)"/.test(m[0]);
    const rid = m[0].match(/r:id="([^"]+)"/)[1];
    const file = rels[rid];
    const xml = str(file);
    const cells = new Map(); // ref -> text (labels, numbers)
    const filled = new Set(); // refs holding any value or formula
    for (const c of xml.matchAll(CELL_RE)) {
      const attrs = c[2];
      const inner = c[3] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let text = '';
      if (type === 's') text = shared[Number((inner.match(/<v>(\d+)<\/v>/) || [])[1])] || '';
      else if (type === 'inlineStr') text = textOf(inner);
      else text = decode((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      if (text.trim() || /<f[\s>]/.test(inner)) filled.add(c[1]);
      if (text.trim()) cells.set(c[1], text.trim());
    }
    const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((mm) => {
      const a = parseRef(mm[1]);
      const b = parseRef(mm[2]);
      return { top: a.row, left: a.col, bottom: b.row, right: b.col };
    });
    // Columns that are hidden or practically zero-width can't hold a value.
    const narrow = new Set();
    for (const col of xml.matchAll(/<col\b[^>]*>/g)) {
      const min = Number((col[0].match(/min="(\d+)"/) || [])[1]);
      const max = Number((col[0].match(/max="(\d+)"/) || [])[1]);
      const width = Number((col[0].match(/width="([\d.]+)"/) || [])[1] || 10);
      if (/hidden="(1|true)"/.test(col[0]) || width < 1) for (let i = min; i <= max; i++) narrow.add(i);
    }
    const validations = [...xml.matchAll(/<dataValidation\b([^>]*)>([\s\S]*?)<\/dataValidation>/g)].map((v) => {
      const list = (v[2].match(/<formula1>"([^<]*)"<\/formula1>/) || [])[1];
      const sqref = (v[1].match(/sqref="([^"]+)"/) || [])[1] || '';
      return list ? { refs: sqref.split(/\s+/), items: decode(list).split(',').map((x) => x.trim()).filter(Boolean) } : null;
    }).filter(Boolean);
    return { name, hidden, file, cells, filled, merges, narrow, validations };
  });
  return { files, sheets, shared };
}

const mergeAt = (sheet, col, row) => sheet.merges.find((m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right);
const areaOf = (sheet, ref) => { const { col, row } = parseRef(ref); return mergeAt(sheet, col, row) || { top: row, bottom: row, left: col, right: col }; };
const isFree = (sheet, col, row) => {
  if (sheet.narrow.has(col)) return false;
  const m = mergeAt(sheet, col, row);
  const tl = m ? refOf(m.left, m.top) : refOf(col, row);
  return !sheet.filled.has(tl) && (!m || (m.left === col && m.top === row));
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'ma[yj]', 'jun', 'jul', 'aug', 'sep', 'o[ck]t', 'nov', 'de[cz]'];
const monthIndex = (text) => MONTHS.findIndex((m) => new RegExp(`^${m}`, 'i').test(text.trim()));

// Finds timeline grids: a header row with "#", a name column ("Sub projects",
// "Action agreed", …), "Owner", month columns under year cells, plus
// "Planned complete date" and "Status" columns nearby.
function detectTimelines(sheet) {
  const grids = [];
  for (const [ref, text] of sheet.cells) {
    const kind = /^sub[\s-]*projects?$/i.test(text) ? 'sub' : /^actions?(\s+agreed)?$|^activit(y|ies)$/i.test(text) ? 'actions' : null;
    if (!kind) continue;
    const { col: nameCol, row } = parseRef(ref);
    const inRow = (re, r = row) => [...sheet.cells].filter(([k, t]) => parseRef(k).row === r && re.test(t)).map(([k]) => parseRef(k).col);
    const months = [...sheet.cells].filter(([k, t]) => parseRef(k).row === row && monthIndex(t) >= 0)
      .map(([k, t]) => ({ col: parseRef(k).col, month: monthIndex(t) })).sort((a, b) => a.col - b.col);
    if (months.length < 3) continue;
    // Year cells: numbers in the rows just above the month row; each covers the months to its right.
    const years = [];
    for (let r = row - 1; r >= row - 2 && !years.length; r--) {
      for (const [k, t] of sheet.cells) {
        const p = parseRef(k);
        if (p.row === r && /^(19|20)\d\d$/.test(t) && p.col >= months[0].col - 1) years.push({ ref: k, col: p.col, year: Number(t) });
      }
    }
    years.sort((a, b) => a.col - b.col);
    let yearOffset = -1;
    let prevMonth = 12;
    const monthCols = months.map((m) => {
      if (m.month <= prevMonth) yearOffset += 1; // wrapped round to January
      prevMonth = m.month;
      return { col: m.col, month: m.month, yearOffset };
    });
    const near = (re) => { for (let r = row; r >= row - 3; r--) { const c = inRow(re, r); if (c.length) return c[0]; } return null; };
    const hashCol = near(/^#$|^no\.?$|^nr\.?$/i);
    // Rows: from the header down, while the "#" column (or the name column) is filled.
    const rows = [];
    for (let r = row + 1; r < row + 200; r++) {
      const key = hashCol ? refOf(hashCol, r) : refOf(nameCol, r);
      if (!sheet.filled.has(key)) break;
      rows.push(r);
    }
    if (!rows.length) continue;
    grids.push({
      kind, title: text, sheet: sheet.name, header_row: row, rows, name_col: nameCol,
      owner_col: inRow(/^owner|^resp/i)[0] || null,
      planned_col: near(/planned.*(complete|finish|end)|^due|^deadline/i),
      status_col: near(/^status/i),
      months: monthCols,
      years: years.map((y, i) => ({ ref: y.ref, offset: i })),
    });
  }
  return grids;
}

// Finds each field's label and picks where its value should go.
function detectMapping(template) {
  const mapping = {};
  const grids = template.sheets.flatMap((sh) => (sh.hidden ? [] : detectTimelines(sh)));
  // Visible sheets first, so a hidden copy of a form isn't picked by mistake.
  const sheets = [...template.sheets].sort((a, b) => a.hidden - b.hidden);
  for (const [key, f] of Object.entries(FIELDS)) {
    if (key === 'milestones' && grids.length) continue; // filled as timeline grids instead
    for (const sheet of sheets) {
      const hit = [...sheet.cells.entries()].find(([, text]) => text.length < 60 && f.find.test(text.replace(/[:：]\s*$/, '')));
      if (!hit) continue;
      const [ref, labelText] = hit;
      const area = areaOf(sheet, ref);
      const below = { col: area.left, row: area.bottom + 1 };
      const right = { col: area.right + 1, row: area.top };
      const canBelow = isFree(sheet, below.col, below.row);
      const canRight = isFree(sheet, right.col, right.row);
      const rightIsBox = canRight && !!mergeAt(sheet, right.col, right.row);
      const rawLabel = sheet.cells.get(ref);
      let target;
      if (rightIsBox) target = { cell: refOf(right.col, right.row), mode: 'replace' }; // a value box beside the label
      else if (area.bottom - area.top >= 2) target = { cell: ref, mode: 'append' }; // label at the top of a tall box
      else if (canBelow) target = { cell: refOf(below.col, below.row), mode: 'replace' };
      else if (/\n\s*$/.test(labelText) || /[:：]\s*$/.test(rawLabel) || !canRight) target = { cell: ref, mode: 'append' };
      else target = { cell: refOf(right.col, right.row), mode: 'replace' };
      mapping[key] = { sheet: sheet.name, ...target, label_cell: ref };
      break;
    }
  }
  return mapping;
}

// Pick-list values a template offers for a mapped cell (e.g. Category's dropdown).
function validationList(template, m) {
  const sheet = m && template.sheets.find((sh) => sh.name === m.sheet);
  if (!sheet) return [];
  const { col, row } = parseRef(m.cell);
  const inRange = (range) => {
    const [a, b = a] = range.split(':').map(parseRef);
    return row >= a.row && row <= b.row && col >= a.col && col <= b.col;
  };
  return (sheet.validations.find((v) => v.refs.some(inRange)) || { items: [] }).items;
}

// ---- writing values into the template -----------------------------------------------

// Style variants (wrap text / background fill) cloned from a cell's existing style.
function styleVariant(styles, s, { wrap = false, fill = null } = {}, cache) {
  const key = `${s}|${wrap}|${fill}`;
  if (cache.has(key)) return cache.get(key);
  const m = styles.xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!m) return s;
  const xfs = [...m[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((x) => x[0]);
  let xf = xfs[s] || xfs[0] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
  if (wrap) {
    if (/<alignment\b/.test(xf)) xf = xf.replace(/<alignment\b([^>]*?)\/?>/, (a, attrs) => `<alignment${attrs.replace(/\s(wrapText|vertical)="[^"]*"/g, '')} wrapText="1" vertical="top"/>`);
    else if (xf.endsWith('/>')) xf = `${xf.slice(0, -2)}><alignment wrapText="1" vertical="top"/></xf>`;
    else xf = xf.replace('</xf>', '<alignment wrapText="1" vertical="top"/></xf>');
    xf = xf.replace(/\sapplyAlignment="[^"]*"/, '').replace(/^<xf\b/, '<xf applyAlignment="1"');
  }
  if (fill) {
    const fm = styles.xml.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/);
    if (fm) {
      const fillId = [...fm[1].matchAll(/<fill\b[^>]*?(?:\/>|>[\s\S]*?<\/fill>)/g)].length;
      styles.xml = styles.xml.replace(fm[0], fm[0]
        .replace('</fills>', `<fill><patternFill patternType="solid"><fgColor rgb="${fill}"/><bgColor indexed="64"/></patternFill></fill></fills>`)
        .replace(/(<fills\b[^>]*count=")\d+"/, `$1${fillId + 1}"`));
      xf = xf.replace(/\sfillId="\d+"/, ` fillId="${fillId}"`).replace(/\sapplyFill="[^"]*"/, '').replace(/^<xf\b/, '<xf applyFill="1"');
    }
  }
  const cellXfs = styles.xml.match(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/)[0];
  const index = [...cellXfs.matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].length;
  styles.xml = styles.xml.replace(cellXfs, cellXfs.replace('</cellXfs>', `${xf}</cellXfs>`).replace(/(<cellXfs\b[^>]*count=")\d+"/, `$1${index + 1}"`));
  cache.set(key, index);
  return index;
}

const styleOf = (xml, ref) => {
  const m = xml.match(new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>)`));
  const s = m && (m[1].match(/\bs="(\d+)"/) || [])[1];
  return s !== undefined && s !== null ? Number(s) : null;
};

// Writes text (or a number) into a cell, creating the cell / row if needed.
function setCell(xml, ref, value, style) {
  const { col, row } = parseRef(ref);
  const sAttr = style !== null && style !== undefined ? ` s="${style}"` : '';
  const cellXml = value === null ? `<c r="${ref}"${sAttr}/>`
    : typeof value === 'number' ? `<c r="${ref}"${sAttr}><v>${value}</v></c>`
      : `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(value)}</t></is></c>`;
  const cellRe = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`);
  if (cellRe.test(xml)) return xml.replace(cellRe, cellXml);
  const rowRe = new RegExp(`<row r="${row}"([^>]*?)(/>|>([\\s\\S]*?)</row>)`);
  const rm = xml.match(rowRe);
  if (rm) {
    const inner = rm[3] || '';
    const cells = [...inner.matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)];
    const after = cells.find((c) => colNum(c[1]) > col);
    const newInner = after ? inner.replace(after[0], cellXml + after[0]) : inner + cellXml;
    return xml.replace(rm[0], `<row r="${row}"${rm[1]}>${newInner}</row>`);
  }
  const rows = [...xml.matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)];
  const nextRow = rows.find((r) => Number(r[1]) > row);
  const newRow = `<row r="${row}">${cellXml}</row>`;
  if (nextRow) return xml.replace(nextRow[0], newRow + nextRow[0]);
  if (/<sheetData\s*\/>/.test(xml)) return xml.replace(/<sheetData\s*\/>/, `<sheetData>${newRow}</sheetData>`);
  return xml.replace('</sheetData>', `${newRow}</sheetData>`);
}

const FILL = { planned: 'FFDCE6F2', Green: 'FFC6EFCE', Yellow: 'FFFFEB9C', Red: 'FFFFC7CE' };

// Fills one timeline grid (Sub projects / Action agreed) from task rows.
function fillGrid(xml, grid, list, startYear, styles, cache) {
  const monthOf = (key) => (key ? { y: Number(key.slice(0, 4)), m: Number(key.slice(5, 7)) - 1 } : null);
  for (const y of grid.years) xml = setCell(xml, y.ref, startYear + y.offset, styleOf(xml, y.ref));
  let items = list;
  if (list.length > grid.rows.length) {
    items = list.slice(0, grid.rows.length - 1);
    items.push({ title: `+ ${list.length - items.length} more in the Task Manager`, more: true });
  }
  grid.rows.forEach((r, i) => {
    const t = items[i];
    if (!t) return;
    const put = (col, v, opts) => {
      if (!col) return;
      const ref = refOf(col, r);
      const base = styleOf(xml, ref);
      xml = setCell(xml, ref, v, opts ? styleVariant(styles, base ?? 0, opts, cache) : base);
    };
    put(grid.name_col, t.title);
    if (t.more) return;
    put(grid.owner_col, t.owner || '');
    if (grid.planned_col && t.due) put(grid.planned_col, Math.floor(excelSerial(t.due, false)));
    if (grid.status_col) put(grid.status_col, t.done ? 'Complete' : t.status, { fill: FILL[t.status] });
    const from = monthOf(t.start || t.due);
    const to = monthOf(t.due);
    const started = monthOf(t.actual_start);
    const doneAt = monthOf(t.completed);
    for (const mc of grid.months) {
      const y = startYear + mc.yearOffset;
      const idx = y * 12 + mc.month;
      const inPlan = from && to && idx >= from.y * 12 + from.m && idx <= to.y * 12 + to.m;
      let mark = '';
      if (started && idx === started.y * 12 + started.m) mark = 'S';
      if (doneAt && idx === doneAt.y * 12 + doneAt.m) mark = 'x';
      if (mark || inPlan) put(mc.col, mark || null, inPlan ? { fill: FILL.planned } : null);
    }
  });
  return xml;
}

function fillTemplate(buf, mapping, vals) {
  const t = readTemplate(buf);
  const files = { ...t.files };
  const sheetXml = Object.fromEntries(t.sheets.map((sh) => [sh.name, files[sh.file].toString('utf8')]));
  const styles = { xml: files['xl/styles.xml'] ? files['xl/styles.xml'].toString('utf8') : '' };
  const cache = new Map();
  for (const [key, m] of Object.entries(mapping)) {
    const sheet = t.sheets.find((sh) => sh.name === m.sheet);
    if (!sheet || !FIELDS[key]) continue;
    const value = String(vals[key] ?? '');
    const existing = sheet.cells.get(m.cell) || '';
    if (m.mode === 'append' && !value) continue;
    const sep = key === 'name' || !existing ? ' ' : '\n';
    const text = m.mode === 'append' ? `${existing}${existing ? sep : ''}${value}` : value;
    const base = styleOf(sheetXml[m.sheet], m.cell);
    const style = styles.xml && text.includes('\n') ? styleVariant(styles, base ?? 0, { wrap: true }, cache) : base;
    sheetXml[m.sheet] = setCell(sheetXml[m.sheet], m.cell, text, style);
  }
  if (vals.timeline && mapping._timelines !== false) {
    for (const sheet of t.sheets.filter((sh) => !sh.hidden)) {
      for (const grid of detectTimelines(sheet)) {
        const list = grid.kind === 'sub' ? vals.timeline.sub : vals.timeline.actions;
        sheetXml[sheet.name] = fillGrid(sheetXml[sheet.name], grid, list, vals.timeline.start_year, styles, cache);
      }
    }
  }
  for (const sh of t.sheets) files[sh.file] = Buffer.from(sheetXml[sh.name], 'utf8');
  if (styles.xml) files['xl/styles.xml'] = Buffer.from(styles.xml, 'utf8');
  // Excel rebuilds the calculation chain itself; a stale one can trigger a repair prompt.
  if (files['xl/calcChain.xml']) {
    delete files['xl/calcChain.xml'];
    files['[Content_Types].xml'] = Buffer.from(files['[Content_Types].xml'].toString('utf8').replace(/<Override[^>]*calcChain[^>]*\/>/, ''), 'utf8');
    files['xl/_rels/workbook.xml.rels'] = Buffer.from(files['xl/_rels/workbook.xml.rels'].toString('utf8').replace(/<Relationship[^>]*calcChain[^>]*\/>/, ''), 'utf8');
  }
  return zip(files);
}

module.exports = {
  FIELDS, FIELD_LIST, REQUIRED, completeness, values, plainWorkbook, readTemplate, detectMapping, detectTimelines,
  validationList, fillTemplate, ragStatus,
};
