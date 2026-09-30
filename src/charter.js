// Project charter: the fields of the standard project template, how complete a
// project's charter is, and filling the user's own Excel template with it.
//
// Template filling: the uploaded .xlsx is read, each field's label ("Problem
// definition:", "Management Sponsor:", …) is found, and the value is written to
// the box beneath or beside it (or after the label when the label sits inside
// the box). The user can correct any cell on the Settings page. The rest of the
// workbook (styles, merges, logos, other sheets) is left untouched.
const { buildXlsx, zip, readZip, xmlEsc } = require('./xlsx');

// key -> label, and the regex used to find its label in a template.
const FIELDS = {
  name: { label: 'Project title', find: /project\s*title/i, prefer: 'right' },
  problem: { label: 'Problem definition', find: /problem\s*(definition|statement)?/i },
  goals: { label: 'Goals of the project', find: /goals?\b/i },
  team: { label: 'Team (incl. capacity p.p.)', find: /^team\b/i },
  in_scope: { label: 'In scope', find: /^in\s*scope/i },
  out_scope: { label: 'Out of scope', find: /out\s*of\s*scope/i },
  benefits_quantified: { label: 'Quantified business benefits', find: /^quantified/i },
  benefits_other: { label: 'Not quantified business benefits', find: /not\s*quantified|non[-\s]*quantified|unquantified/i },
  sponsor: { label: 'Management sponsor', find: /sponsor/i, prefer: 'below' },
  leader: { label: 'Project leader', find: /project\s*lead(er)?|project\s*manager/i, prefer: 'below' },
  date: { label: 'Current date', find: /current\s*date|^date\b/i, prefer: 'below' },
  policy_deployment: { label: 'Policy deployment', find: /policy/i },
  category: { label: 'Category', find: /^category/i },
  gm_effect: { label: 'Gross margin effect', find: /gross\s*margin/i },
  project_code: { label: 'Project ID', find: /project\s*(id|no\.?|number|code)\b/i, prefer: 'right' },
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

// ---- values written into the template ------------------------------------------

const d = (iso) => (iso ? new Date(iso.length === 10 ? `${iso}T12:00` : iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function values(p, extras) {
  const baseline = new Map(((p.baseline_snapshot && JSON.parse(p.baseline_snapshot)) || { tasks: [] }).tasks.map((t) => [t.id, t]));
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
      if (b && b.due_at && m.due_at && d(b.due_at) !== d(m.due_at)) parts.push(`baseline ${d(b.due_at)}`);
      if (m.status === 'done') parts.push(`done ${d(m.completed_at)}`);
      return `${m.title}: ${parts.join(', ')}`;
    }).join('\n'),
  };
}

// A simple workbook with the charter, used until a template is uploaded.
function plainWorkbook(v) {
  const rows = FIELD_LIST.map((f) => [f.label, v[f.key]]);
  return buildXlsx([{ name: 'Charter', columns: [{ header: 'Field', width: 30 }, { header: 'Value', type: 'wrap', width: 100 }], rows }]);
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
    const rid = m[0].match(/r:id="([^"]+)"/)[1];
    const file = rels[rid];
    const xml = str(file);
    const cells = new Map();
    for (const c of xml.matchAll(CELL_RE)) {
      const attrs = c[2];
      const inner = c[3] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1];
      let text = '';
      if (type === 's') text = shared[Number((inner.match(/<v>(\d+)<\/v>/) || [])[1])] || '';
      else if (type === 'inlineStr') text = textOf(inner);
      else if (type === 'str') text = decode((inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      if (text.trim()) cells.set(c[1], text.trim());
    }
    const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((m) => {
      const a = parseRef(m[1]);
      const b = parseRef(m[2]);
      return { top: a.row, left: a.col, bottom: b.row, right: b.col };
    });
    return { name, file, cells, merges };
  });
  return { files, sheets, shared };
}

const mergeAt = (sheet, col, row) => sheet.merges.find((m) => row >= m.top && row <= m.bottom && col >= m.left && col <= m.right);
const areaOf = (sheet, ref) => { const { col, row } = parseRef(ref); return mergeAt(sheet, col, row) || { top: row, bottom: row, left: col, right: col }; };
const isFree = (sheet, col, row) => {
  const m = mergeAt(sheet, col, row);
  const tl = m ? refOf(m.left, m.top) : refOf(col, row);
  return !sheet.cells.has(tl) && (!m || (m.left === col && m.top === row));
};

// Finds each field's label and picks where its value should go.
function detectMapping(template) {
  const mapping = {};
  for (const [key, f] of Object.entries(FIELDS)) {
    for (const sheet of template.sheets) {
      const hit = [...sheet.cells.entries()].find(([, text]) => text.length < 60 && f.find.test(text.replace(/[:：]\s*$/, '')));
      if (!hit) continue;
      const [ref] = hit;
      const area = areaOf(sheet, ref);
      const below = { col: area.left, row: area.bottom + 1 };
      const right = { col: area.right + 1, row: area.top };
      const canBelow = isFree(sheet, below.col, below.row);
      const canRight = isFree(sheet, right.col, right.row);
      let target;
      // "Right" only when there's a box there (a merged area) or nothing free below.
      const rightIsBox = canRight && !!mergeAt(sheet, right.col, right.row);
      if (f.prefer === 'right' && canRight && (rightIsBox || !canBelow)) target = { cell: refOf(right.col, right.row), mode: 'replace' };
      else if (area.bottom - area.top >= 2) target = { cell: ref, mode: 'append' }; // label inside a tall box
      else if (canBelow) target = { cell: refOf(below.col, below.row), mode: 'replace' };
      else if (canRight) target = { cell: refOf(right.col, right.row), mode: 'replace' };
      else target = { cell: ref, mode: 'append' };
      mapping[key] = { sheet: sheet.name, ...target, label_cell: ref };
      break;
    }
  }
  return mapping;
}

// ---- writing values into the template -----------------------------------------------

// Adds a copy of cell style `s` with text wrapping on; returns the new style index.
function wrapStyle(styles, s, cache) {
  if (cache.has(s)) return cache.get(s);
  const m = styles.xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!m) return s;
  const xfs = [...m[1].matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map((x) => x[0]);
  let xf = xfs[s] || xfs[0] || '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
  if (/<alignment\b/.test(xf)) xf = xf.replace(/<alignment\b([^>]*?)\/?>/, (a, attrs) => `<alignment${attrs.replace(/\s(wrapText|vertical)="[^"]*"/g, '')} wrapText="1" vertical="top"/>`);
  else if (xf.endsWith('/>')) xf = `${xf.slice(0, -2)}><alignment wrapText="1" vertical="top"/></xf>`;
  else xf = xf.replace('</xf>', '<alignment wrapText="1" vertical="top"/></xf>');
  xf = xf.replace(/\sapplyAlignment="[^"]*"/, '').replace(/^<xf\b/, '<xf applyAlignment="1"');
  const index = xfs.length;
  styles.xml = styles.xml.replace(m[0], m[0].replace('</cellXfs>', `${xf}</cellXfs>`).replace(/(<cellXfs\b[^>]*count=")\d+"/, `$1${index + 1}"`));
  cache.set(s, index);
  return index;
}

function setCell(xml, ref, text, style) {
  const { col, row } = parseRef(ref);
  const cellXml = `<c r="${ref}"${style !== null ? ` s="${style}"` : ''} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(text)}</t></is></c>`;
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
    const text = m.mode === 'append' ? `${existing}${existing ? '\n' : ''}${value}` : value;
    const cur = sheetXml[m.sheet].match(new RegExp(`<c r="${m.cell}"([^>]*?)(?:/>|>)`));
    const s = cur && (cur[1].match(/\bs="(\d+)"/) || [])[1];
    const style = styles.xml && text.includes('\n') ? wrapStyle(styles, Number(s || 0), cache) : (s !== undefined && s !== null ? Number(s) : null);
    sheetXml[m.sheet] = setCell(sheetXml[m.sheet], m.cell, text, style);
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

module.exports = { FIELDS, FIELD_LIST, REQUIRED, completeness, values, plainWorkbook, readTemplate, detectMapping, fillTemplate };
