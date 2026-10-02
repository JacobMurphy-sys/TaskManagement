'use strict';
// Weekly KPIs worked out by the CI Manager itself, straight from the source files
// (the hourly SSRS exports), instead of waiting for Excel to refresh. First pass:
// volumes — cards and PIN mailers personalised and shipped, and scrap (remakes).
//
// Each source is read whole (they're cumulative for the year), its header row found by
// column name, and its rows kept in a table here. The tables aren't part of backups:
// they can always be read again from the source files.

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { readBook, colLetters } = require('./xlsxread');

// ---- the sources --------------------------------------------------------------------------

// sheet: the sheet in the source file; workbook: the CI workbook sheet with the same
// rows (what Power Query loaded), used until the source files are set up.
const SOURCES = {
  perso: {
    label: 'Personalised (perso)', file: 'KPI_persoed_CI.xlsx', sheet: 'KPI_persoed_CI', workbook: 'PersoImport',
    columns: { customer: 'Customer', type: 'Type', due: 'duedate', day: 'Perso Date', scrap: 'Scrap', qty: 'Qty Persoed' },
  },
  shipped: {
    label: 'Shipped', file: 'KPI_shipped_CI.xlsx', sheet: 'KPI_shipped_CI', workbook: 'ShippedImport',
    columns: { customer: 'Customer', type: 'Type', due: 'duedate', day: 'shipping Date', qty: 'QtyShipped' },
  },
  remakes: {
    label: 'Remakes (scrap)', file: 'KPI_2_remakes.xlsx', sheet: 'KPI_2_remakes', workbook: 'Scrap2.0',
    columns: { customer: 'Customer', type: 'Type', mode: 'Mode', perso_day: 'Perso Date', wo: 'PersoWO', qty: '#remakes', machine: 'Machine', day: 'Date', time: 'Time', vault_wo: 'VaultWO' },
  },
};

const TABLES = `
  CREATE TABLE IF NOT EXISTS kpi_rows (
    source   TEXT    NOT NULL,
    day      TEXT    NOT NULL,
    week     TEXT    NOT NULL,
    customer TEXT,
    type     TEXT,
    qty      REAL    NOT NULL DEFAULT 0,
    scrap    REAL    NOT NULL DEFAULT 0,
    extra    TEXT
  );
  CREATE INDEX IF NOT EXISTS kpi_rows_week ON kpi_rows(source, week);
  CREATE TABLE IF NOT EXISTS kpi_sources (
    source      TEXT PRIMARY KEY,
    file        TEXT,
    modified    TEXT,
    imported_at TEXT,
    rows        INTEGER,
    skipped     INTEGER,
    first_day   TEXT,
    last_day    TEXT
  );`;
let ready = false;
const ensure = () => { if (!ready) { db.conn.exec(TABLES); ready = true; } };

// ---- dates and weeks ----------------------------------------------------------------------

// A cell's date as YYYY-MM-DD: Excel serial numbers, ISO text, or d/m/y text.
function dayOf(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((Math.floor(v) - 25569) * 86400000)).toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

// The site's week codes: weeks run Sunday–Saturday, numbered as Excel's WEEKNUM (week 1
// holds 1 January) — W2639. When a week's weekdays fall in two months they're split:
// W2640_1 (first month) and W2640_2. Saturdays and Sundays keep the plain code, as in the
// workbook's calendar; with splitWeekends they go to the part for their month instead.
function weekCode(day, { splitWeekends = false } = {}) {
  const d = new Date(`${day}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const jan1 = new Date(Date.UTC(y, 0, 1));
  const n = Math.floor(((d - jan1) / 86400000 + jan1.getUTCDay()) / 7) + 1;
  const code = `W${String(y).slice(2)}${String(n).padStart(2, '0')}`;
  const dow = d.getUTCDay();
  const sunday = new Date(d); sunday.setUTCDate(d.getUTCDate() - dow);
  const monday = new Date(sunday); monday.setUTCDate(sunday.getUTCDate() + 1);
  const friday = new Date(sunday); friday.setUTCDate(sunday.getUTCDate() + 5);
  const split = monday.getUTCMonth() !== friday.getUTCMonth();
  if (!split) return code;
  if (dow === 0 || dow === 6) {
    if (!splitWeekends) return code;
    return `${code}_${d.getUTCMonth() === monday.getUTCMonth() && d.getUTCFullYear() === monday.getUTCFullYear() ? 1 : 2}`;
  }
  return `${code}_${d.getUTCMonth() === monday.getUTCMonth() ? 1 : 2}`;
}

// The reporting weeks of a year, in order, with their month (as the Database sheet lists them).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
function weeksOf(year) {
  const out = [];
  const seen = new Set();
  for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += 86400000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const code = weekCode(d.toISOString().slice(0, 10));
    if (seen.has(code)) continue;
    seen.add(code);
    out.push({ week: code, month: MONTHS[d.getUTCMonth()] });
  }
  return out;
}

// ---- reading a source ---------------------------------------------------------------------

// Rows of a sheet as objects keyed by our names, from the row holding the column headings.
function sheetRows(sheet, columns) {
  const want = Object.entries(columns);
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  let headerRow = 0; let at = null;
  for (let r = 1; r <= Math.min(sheet.maxRow, 30) && !at; r++) {
    const heads = new Map();
    for (let c = 1; c <= sheet.maxCol; c++) { const v = sheet.cells.get(`${colLetters(c)}${r}`)?.v; if (v !== null && v !== undefined) heads.set(norm(v), c); }
    if (want.every(([, h]) => heads.has(norm(h)))) { headerRow = r; at = Object.fromEntries(want.map(([k, h]) => [k, heads.get(norm(h))])); }
  }
  if (!at) {
    const missing = want.map(([, h]) => h);
    throw new Error(`Can't find the columns ${missing.join(', ')} in "${sheet.name}"`);
  }
  const out = [];
  const letters = Object.fromEntries(Object.entries(at).map(([k, c]) => [k, colLetters(c)]));
  for (let r = headerRow + 1; r <= sheet.maxRow; r++) {
    const row = {};
    let any = false;
    for (const [k, l] of Object.entries(letters)) { const v = sheet.cells.get(`${l}${r}`)?.v ?? null; row[k] = v; if (v !== null && v !== '') any = true; }
    if (any) out.push(row);
  }
  return out;
}

// Reads one source from a file buffer. fromWorkbook: the buffer is the CI workbook and the
// rows come from its import sheet.
function readSource(name, bufOrBook, { fromWorkbook = false } = {}) {
  const src = SOURCES[name];
  const book = Buffer.isBuffer(bufOrBook) ? readBook(bufOrBook) : bufOrBook;
  const want = fromWorkbook ? src.workbook : src.sheet;
  const info = book.sheets.find((s) => s.name.toLowerCase() === want.toLowerCase())
    || (!fromWorkbook ? book.sheets.find((s) => !s.hidden) : null);
  if (!info) throw new Error(`"${want}" isn't in the file`);
  const rows = sheetRows(book.sheet(info.name), src.columns);
  return rows;
}

// Replaces a source's rows. Rows without a usable date are counted as skipped.
function storeSource(name, rows, meta = {}) {
  ensure();
  const splitWeekends = meta.splitWeekends ?? false;
  let skipped = 0; let first = null; let last = null;
  const ins = db.conn.prepare('INSERT INTO kpi_rows (source, day, week, customer, type, qty, scrap, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.tx(() => {
    db.run('DELETE FROM kpi_rows WHERE source = ?', [name]);
    for (const r of rows) {
      const day = dayOf(r.day);
      if (!day) { skipped++; continue; }
      if (!first || day < first) first = day;
      if (!last || day > last) last = day;
      const extra = name === 'remakes' ? JSON.stringify({ wo: r.wo ?? null, machine: r.machine ?? null, mode: r.mode ?? null, time: r.time ?? null, perso_day: dayOf(r.perso_day) }) : (r.due !== undefined ? JSON.stringify({ due: dayOf(r.due) }) : null);
      ins.run(name, day, weekCode(day, { splitWeekends }), r.customer === null ? null : String(r.customer).trim(), r.type === null ? null : String(r.type).trim(),
        Number(r.qty) || 0, Number(r.scrap) || 0, extra);
    }
    db.run(`INSERT INTO kpi_sources (source, file, modified, imported_at, rows, skipped, first_day, last_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET file = excluded.file, modified = excluded.modified, imported_at = excluded.imported_at,
      rows = excluded.rows, skipped = excluded.skipped, first_day = excluded.first_day, last_day = excluded.last_day`,
    [name, meta.file || null, meta.modified || null, new Date().toISOString(), rows.length - skipped, skipped, first, last]);
  });
  return { source: name, rows: rows.length - skipped, skipped, first_day: first, last_day: last };
}

// Re-labels stored rows when the weekend setting changes (no need to read the files again).
function rewriteWeeks(splitWeekends) {
  ensure();
  const days = db.all('SELECT DISTINCT day FROM kpi_rows');
  const upd = db.conn.prepare('UPDATE kpi_rows SET week = ? WHERE day = ?');
  db.tx(() => { for (const { day } of days) upd.run(weekCode(day, { splitWeekends }), day); });
}

// Imports the sources whose files changed since last time (or all, with force).
// paths: { perso: 'S:\\…\\KPI_persoed_CI.xlsx', … }; workbook: the CI workbook, used for
// any source without a path of its own.
function importSources({ paths = {}, workbook = null, force = false, splitWeekends = false } = {}) {
  ensure();
  const results = [];
  let wbBook = null; // the CI workbook is read once for all the sources it stands in for
  for (const name of Object.keys(SOURCES)) {
    const file = String(paths[name] || '').trim().replace(/^"|"$/g, '');
    const useWorkbook = !file;
    const target = file || workbook;
    if (!target) { results.push({ source: name, status: 'not set up' }); continue; }
    let stat;
    try { stat = fs.statSync(target); } catch { results.push({ source: name, status: 'missing', file: target }); continue; }
    const prev = db.get('SELECT * FROM kpi_sources WHERE source = ?', [name]);
    const modified = stat.mtime.toISOString();
    if (!force && prev && prev.file === target && prev.modified === modified) { results.push({ source: name, status: 'unchanged', file: target, rows: prev.rows }); continue; }
    try {
      const from = useWorkbook ? (wbBook ||= readBook(fs.readFileSync(target))) : fs.readFileSync(target);
      const rows = readSource(name, from, { fromWorkbook: useWorkbook });
      results.push({ ...storeSource(name, rows, { file: target, modified, splitWeekends }), status: 'imported', file: target, from: useWorkbook ? 'workbook' : 'file' });
    } catch (err) {
      results.push({ source: name, status: 'error', file: target, error: err.code === 'EBUSY' || err.code === 'EPERM' ? 'The file is locked — try again in a moment' : err.message });
    }
  }
  return results;
}

// ---- the weekly figures -------------------------------------------------------------------

const ISI_CUSTOMER = 'Techniker Krankenkasse';

// Volumes per reporting week, in thousands (kU) like the Database sheet; scrap in units.
//   perso_ps / perso_isi / perso_pin / perso_total, scrap, shipped_ps / _isi / _pin / _total
// PS = cards for every customer but the German health card (ISI); PIN = PIN mailers.
function weeklyVolumes(year) {
  ensure();
  const sums = db.all(`SELECT source, week,
      SUM(CASE WHEN lower(type) LIKE '%card%' AND customer <> ? THEN qty ELSE 0 END) AS ps,
      SUM(CASE WHEN lower(type) LIKE '%card%' AND customer = ? THEN qty ELSE 0 END) AS isi,
      SUM(CASE WHEN lower(type) LIKE '%pin%' THEN qty ELSE 0 END) AS pin,
      SUM(qty) AS qty
    FROM kpi_rows WHERE week LIKE ? GROUP BY source, week`, [ISI_CUSTOMER, ISI_CUSTOMER, `W${String(year).slice(2)}%`]);
  const at = new Map(sums.map((r) => [`${r.source}|${r.week}`, r]));
  const k = (v) => (v || 0) / 1000;
  const weeks = weeksOf(year).map((w) => {
    const p = at.get(`perso|${w.week}`); const s = at.get(`shipped|${w.week}`); const r = at.get(`remakes|${w.week}`);
    return {
      ...w,
      perso_ps: k(p?.ps), perso_isi: k(p?.isi), perso_pin: k(p?.pin), perso_total: k((p?.ps || 0) + (p?.isi || 0)),
      scrap: r?.qty || 0,
      shipped_ps: k(s?.ps), shipped_isi: k(s?.isi), shipped_pin: k(s?.pin), shipped_total: k((s?.ps || 0) + (s?.isi || 0)),
    };
  });
  // activity filed under a week code the report doesn't list (weekends in split weeks)
  const listed = new Set(weeks.map((w) => w.week));
  const unlisted = sums.filter((r) => !listed.has(r.week) && r.qty).map((r) => ({ source: r.source, week: r.week, ps: r.ps, isi: r.isi, pin: r.pin, qty: r.qty }));
  return { weeks, unlisted };
}

function sourcesStatus() {
  ensure();
  const have = Object.fromEntries(db.all('SELECT * FROM kpi_sources').map((r) => [r.source, r]));
  return Object.entries(SOURCES).map(([name, s]) => ({ source: name, label: s.label, default_file: s.file, sheet: s.sheet, workbook_sheet: s.workbook, ...(have[name] || {}) }));
}

// Columns of the Database sheet's weekly block (rows 63+, week code in B) these match.
const DATABASE_COLUMNS = { perso_ps: 'D', perso_isi: 'E', perso_pin: 'F', perso_total: 'G', scrap: 'H', shipped_ps: 'I', shipped_isi: 'J', shipped_pin: 'K', shipped_total: 'L' };

module.exports = { SOURCES, DATABASE_COLUMNS, dayOf, weekCode, weeksOf, sheetRows, readSource, storeSource, importSources, rewriteWeeks, weeklyVolumes, sourcesStatus, ensure };
