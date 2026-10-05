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
  // Kept by Production (Table1 of their OTD report); the week is typed in, the date often isn't.
  otd: {
    label: 'OTD delays', file: 'OTD Report.xlsx', sheet: 'Table1', table: 'Table1', workbook: 'OTD2.0', typedWeek: true, optional: ['day', 'month', 'reason'],
    columns: { customer: 'Customer', qty: 'Quantity', type: 'Type', day: 'Date', week: 'Week', month: 'Month', reason: 'Reason' },
  },
};
// Customer forecasts: read when an A3 is built, into the workbook sheet its query fills
// (the file's sheet, first row as headers, into the Excel table of that name).
const FORECASTS = {
  benelux: { label: 'BeNeLux forecast', file: 'Benelux Forecast.xlsx', sheet: 'LIVE_EU_PAY_CARDS', table: 'ForecastImport', workbook: 'BeNeLux Forecast' },
  amex: { label: 'Amex forecast', file: 'Amex Forecast.xlsx', sheet: 'Sittard', table: 'Sittard', workbook: 'Amex Forecast' },
};
const WEEK_RE = /^W\d{4}(_[12])?$/i;

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

// A week typed by hand (the OTD report's Week column) → a week code, or null.
// Takes W2639, 2639, W2640_1, W39, Wk 39, Week 39 or just 39. With only a week number the
// year comes from the date (or the year given), and for a week split across two months
// the part (_1/_2) from the date, else from the Month column.
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function monthIndex(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && v >= 1 && v <= 12) return v - 1;
  const t = String(v).trim().toLowerCase();
  if (/^\d{1,2}$/.test(t) && Number(t) >= 1 && Number(t) <= 12) return Number(t) - 1;
  const i = MONTH_NAMES.findIndex((m) => t.startsWith(m));
  return i >= 0 ? i : null;
}
function typedWeekCode(value, { day = null, month = null, year = null } = {}) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim().toUpperCase().replace(/\s+/g, ' ');
  if (!t) return null;
  let m = t.match(/^W?(\d{2})(\d{2})(?:_([12]))?$/);
  let yy; let n; let part;
  if (m) { [, yy, n, part] = m; return Number(n) >= 1 && Number(n) <= 53 ? `W${yy}${n}${part ? `_${part}` : ''}` : null; } // a full code: as typed
  else {
    m = t.match(/^(?:W|WK|WEEK)?\.? ?(\d{1,2})(?:\.0+)?(?:_([12]))?$/);
    if (!m) return null;
    n = Number(m[1]); part = m[2];
    const y = day ? Number(day.slice(0, 4)) : year;
    if (!y) return null;
    yy = String(y).slice(2);
  }
  if (n < 1 || n > 53) return null;
  const code = `W${yy}${String(n).padStart(2, '0')}`;
  if (part) return `${code}_${part}`;
  // A split week needs its part: from the date when it falls in that week, else the month.
  const y = 2000 + Number(yy);
  const jan1 = new Date(Date.UTC(y, 0, 1));
  const sunday = new Date(jan1); sunday.setUTCDate(1 - jan1.getUTCDay() + (n - 1) * 7);
  const monday = new Date(sunday); monday.setUTCDate(sunday.getUTCDate() + 1);
  const friday = new Date(sunday); friday.setUTCDate(sunday.getUTCDate() + 5);
  if (monday.getUTCMonth() === friday.getUTCMonth()) return code;
  if (day && weekCode(day).startsWith(code)) return weekCode(day).includes('_') ? weekCode(day) : `${code}_${new Date(`${day}T00:00:00Z`).getUTCMonth() === monday.getUTCMonth() ? 1 : 2}`;
  const mi = monthIndex(month);
  if (mi === monday.getUTCMonth()) return `${code}_1`;
  if (mi === friday.getUTCMonth()) return `${code}_2`;
  return code; // can't tell which part: left as the plain week (shown as not counted)
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
// range: only look inside it (an Excel table's cells, headings on its first row).
// When a heading appears twice, the left-most column is used.
function sheetRows(sheet, columns, optional = [], range = null) {
  const all = Object.entries(columns);
  const want = all.filter(([k]) => !optional.includes(k));
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const left = range?.left || 1; const right = range ? Math.min(range.right, sheet.maxCol) : sheet.maxCol;
  const top = range?.top || 1; const bottom = range ? Math.min(range.bottom, sheet.maxRow) : sheet.maxRow;
  let headerRow = 0; let at = null;
  for (let r = top; r <= (range ? top : Math.min(sheet.maxRow, 30)) && !at; r++) {
    const heads = new Map();
    for (let c = left; c <= right; c++) { const v = sheet.cells.get(`${colLetters(c)}${r}`)?.v; if (v !== null && v !== undefined && !heads.has(norm(v))) heads.set(norm(v), c); }
    if (want.every(([, h]) => heads.has(norm(h)))) { headerRow = r; at = Object.fromEntries(all.filter(([, h]) => heads.has(norm(h))).map(([k, h]) => [k, heads.get(norm(h))])); }
  }
  if (!at) {
    const missing = want.map(([, h]) => h);
    throw new Error(`Can't find the columns ${missing.join(', ')} in "${sheet.name}"${range ? ' (in its table)' : ''}`);
  }
  const out = [];
  const letters = Object.fromEntries(Object.entries(at).map(([k, c]) => [k, colLetters(c)]));
  for (let r = headerRow + 1; r <= bottom; r++) {
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
  // An Excel table by that name: just its cells, so helper columns next to it are never read.
  if (!fromWorkbook && src.table) {
    const t = book.tables().find((x) => [x.name, x.displayName].some((n) => String(n || '').toLowerCase() === src.table.toLowerCase()));
    if (t?.range) return sheetRows(book.sheet(t.sheet), src.columns, src.optional, t.range);
  }
  const named = book.sheets.find((s) => s.name.toLowerCase() === want.toLowerCase());
  if (fromWorkbook && !named) throw new Error(`"${want}" isn't in the file`);
  if (fromWorkbook) { // the import sheet's table (what Power Query loaded), if it has one
    const t = book.tables().find((x) => x.sheet === named.name && x.range);
    if (t) return sheetRows(book.sheet(t.sheet), src.columns, src.optional, t.range);
  }
  // The named sheet, else the first sheet with the right column headings (a table can sit on any sheet).
  const order = named ? [named, ...book.sheets.filter((s) => s !== named)] : book.sheets;
  let firstErr = null;
  for (const info of order) {
    try { return sheetRows(book.sheet(info.name), src.columns, src.optional); } catch (err) { firstErr = firstErr || err; if (fromWorkbook) break; }
  }
  throw firstErr || new Error('The file has no sheets');
}

// Replaces a source's rows. Rows without a usable date are counted as skipped.
function storeSource(name, rows, meta = {}) {
  ensure();
  const splitWeekends = meta.splitWeekends ?? false;
  let skipped = 0; let first = null; let last = null;
  const ins = db.conn.prepare('INSERT INTO kpi_rows (source, day, week, customer, type, qty, scrap, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  db.tx(() => {
    db.run('DELETE FROM kpi_rows WHERE source = ?', [name]);
    const typed = !!SOURCES[name].typedWeek;
    for (const r of rows) {
      const day = dayOf(r.day);
      const typedWeek = typed ? typedWeekCode(r.week, { day, month: r.month, year: meta.year || new Date().getFullYear() }) : null;
      // OTD rows are counted in the week typed against them, as Excel does: a row without a
      // usable week isn't counted (week ''), however its date reads — it's listed instead.
      if (typed && !typedWeek && !day && (r.week === null || r.week === undefined || r.week === '') && !Number(r.qty)) { skipped++; continue; }
      if (!typed && !day) { skipped++; continue; }
      if (day && (!first || day < first)) first = day;
      if (day && (!last || day > last)) last = day;
      const dateWeek = day ? weekCode(day, { splitWeekends }) : null;
      const extra = name === 'remakes' ? JSON.stringify({ wo: r.wo ?? null, machine: r.machine ?? null, mode: r.mode ?? null, time: r.time ?? null, perso_day: dayOf(r.perso_day) })
        : typed ? JSON.stringify({ reason: r.reason ?? null, typed_week: typedWeek, date_week: dateWeek, week_raw: r.week ?? null, month_raw: r.month ?? null })
          : (r.due !== undefined ? JSON.stringify({ due: dayOf(r.due) }) : null);
      ins.run(name, day || '', typed ? (typedWeek || '') : dateWeek, r.customer === null ? null : String(r.customer).trim(), r.type === null ? null : String(r.type).trim(),
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
  const days = db.all("SELECT DISTINCT day FROM kpi_rows WHERE day <> ''");
  // rows with a typed week (OTD) keep it
  const upd = db.conn.prepare("UPDATE kpi_rows SET week = ? WHERE day = ? AND source <> 'otd'");
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
  // OTD: delayed quantities by week, internal and external
  const otd = new Map(db.all(`SELECT week, SUM(CASE WHEN lower(type) = 'internal' THEN qty ELSE 0 END) AS internal,
      SUM(CASE WHEN lower(type) = 'external' THEN qty ELSE 0 END) AS external FROM kpi_rows WHERE source = 'otd' GROUP BY week`).map((r) => [r.week, r]));
  const manual = new Map(db.all('SELECT * FROM kpi_manual').map((r) => [r.week.toUpperCase(), r]));
  const ratio = (a, b) => (b ? a / b : null);
  for (const w of weeks) {
    const o = otd.get(w.week);
    w.otd_internal = k(o?.internal); w.otd_external = k(o?.external);
    w.otd_sc = w.shipped_total ? 1 - w.otd_internal / w.shipped_total : null;
    w.otd_global = w.shipped_total ? 1 - (w.otd_internal + w.otd_external) / w.shipped_total : null;
    const m = manual.get(w.week) || {};
    // hours from the Protime counts when typed (worked out again, so a change of rule applies to every week)
    w.hours = m.protime ? hoursFromProtime(JSON.parse(m.protime)) ?? m.hours ?? null : m.hours ?? null; w.contract = m.contract ?? null; w.temps = m.temps ?? null;
    w.cc_critical = m.cc_critical ?? null; w.cc_major = m.cc_major ?? null; w.cc_minor = m.cc_minor ?? null;
    // complaints not typed in count as none (0)
    w.complaints = (w.cc_critical || 0) + (w.cc_major || 0) + (w.cc_minor || 0);
    w.cpms = w.shipped_total ? (w.complaints / (w.shipped_total * 1000)) * 1e6 : null;
    w.scrap_rate = ratio(w.scrap / 1000, w.perso_total);
    w.productivity = w.hours ? (w.perso_total * 1000) / w.hours : null;
    w.hc = w.contract !== null || w.temps !== null ? (w.contract || 0) + (w.temps || 0) : null;
    w.protime = m.protime ? JSON.parse(m.protime) : null;
  }
  // activity filed under a week code the report doesn't list (weekends in split weeks)
  const listed = new Set(weeks.map((w) => w.week));
  const unlisted = sums.filter((r) => r.source !== 'otd' && !listed.has(r.week) && r.qty).map((r) => ({ source: r.source, week: r.week, ps: r.ps, isi: r.isi, pin: r.pin, qty: r.qty }));
  // OTD rows whose date and typed week disagree (dates read as month/day, usually)
  const otdRows = db.all("SELECT customer, qty, type, day, week, extra FROM kpi_rows WHERE source = 'otd'").map((r) => ({ ...r, ...JSON.parse(r.extra || '{}') }));
  // not counted: no usable week typed, or a split week without telling which part
  const otdUncounted = otdRows.filter((r) => !r.week || !listed.has(r.week)).map((r) => ({
    customer: r.customer, qty: r.qty, type: r.type, date: r.day || null, week_typed: r.week_raw === null || r.week_raw === undefined ? '' : String(r.week_raw),
    month: r.month_raw ?? null, reason: r.reason ?? null, date_week: r.date_week || null,
    why: !r.week ? (r.week_raw === null || r.week_raw === undefined || r.week_raw === '' ? 'no week typed' : 'week not recognised') : 'split week — which part?',
  }));
  const otdChecks = otdRows.filter((r) => r.day && r.week && r.typed_week && r.date_week && r.typed_week !== r.date_week)
    .map((r) => ({ customer: r.customer, qty: r.qty, type: r.type, date: r.day, typed_week: r.typed_week, date_week: r.date_week,
      swapped: (() => { const [y, mo, d] = r.day.split('-'); return Number(d) <= 12 && weekCode(`${y}-${d}-${mo}`) === r.typed_week; })() }));
  return { weeks, unlisted, otd_checks: otdChecks, otd_uncounted: otdUncounted };
}

// The week's top five scrap by customer (the three letters after the first in the
// work order) and by work order — as the Database sheet's top-5 tables, which take the
// week from the perso date.
function topScrap(week, n = 5) {
  ensure();
  const rows = db.all("SELECT qty, extra FROM kpi_rows WHERE source = 'remakes'").map((r) => ({ qty: r.qty, ...JSON.parse(r.extra || '{}') }))
    .filter((r) => r.perso_day && weekCode(r.perso_day) === week);
  const top = (key) => {
    const m = new Map();
    for (const r of rows) { const k = key(r); if (!k) continue; m.set(k, (m.get(k) || 0) + (r.qty || 0)); }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  };
  return { customers: top((r) => (r.wo ? String(r.wo).slice(1, 4) : null)), orders: top((r) => r.wo || null) };
}

// Cards shipped to one customer (exact name, type Card): in a month (1–12) or the whole year.
// until: last day counted (YYYY-MM-DD), e.g. the end of the reporting week.
function shippedFor(customer, year, month = null, until = null) {
  ensure();
  const like = month ? `${year}-${String(month).padStart(2, '0')}-%` : `${year}-%`;
  return db.get(`SELECT COALESCE(SUM(qty), 0) AS q FROM kpi_rows WHERE source = 'shipped' AND customer = ? COLLATE NOCASE AND type = 'Card' AND day LIKE ?${until ? ' AND day <= ?' : ''}`,
    until ? [customer, like, until] : [customer, like]).q;
}

// The last day of a reporting week (its part, for a split week).
function weekEnd(week) {
  const y = 2000 + Number(String(week).slice(1, 3));
  let last = null;
  for (let t = Date.UTC(y, 0, 1); t < Date.UTC(y + 1, 0, 1); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);
    const c = weekCode(day);
    if (c === week || c === week.replace(/_[12]$/, '') && weekCode(day, { splitWeekends: true }) === week) last = day;
  }
  return last;
}

// The OTD report rows behind a week's delays.
function otdRows(week) {
  ensure();
  return db.all("SELECT customer, qty, type, day, extra FROM kpi_rows WHERE source = 'otd' AND week = ? ORDER BY day, customer", [week])
    .map((r) => { const e = JSON.parse(r.extra || '{}'); return { customer: r.customer, qty: r.qty, type: r.type, date: r.day || null, week_typed: e.week_raw ?? null, month: e.month_raw ?? null, reason: e.reason ?? null, date_week: e.date_week || null }; });
}

function sourcesStatus() {
  ensure();
  const have = Object.fromEntries(db.all('SELECT * FROM kpi_sources').map((r) => [r.source, r]));
  return Object.entries(SOURCES).map(([name, s]) => ({ source: name, label: s.label, default_file: s.file, sheet: s.sheet, workbook_sheet: s.workbook, ...(have[name] || {}) }));
}

// Columns of the Database sheet's weekly block (rows 63+, week code in B) these match.
const DATABASE_COLUMNS = {
  perso_ps: 'D', perso_isi: 'E', perso_pin: 'F', perso_total: 'G', scrap: 'H', shipped_ps: 'I', shipped_isi: 'J', shipped_pin: 'K', shipped_total: 'L',
  otd_internal: 'M', otd_external: 'N', hours: 'O', contract: 'P', temps: 'Q', cc_critical: 'R', cc_major: 'S', cc_minor: 'T', complaints: 'U',
  otd_sc: 'V', otd_global: 'W', cpms: 'X', scrap_rate: 'Y', productivity: 'Z', hc: 'AA',
};
// What's typed in each week (the rest is worked out).
const MANUAL_FIELDS = ['hours', 'contract', 'temps', 'cc_critical', 'cc_major', 'cc_minor'];
// Working hours from Protime: days = the "present" counts for [Sunday night, Monday, …, Friday].
// Each person present works a 7.5 h shift, plus 7.5 h for the full-time support staff on each
// weekday (Mon–Fri) with a count above 0 — not a flat 37.5 h, so a short week isn't overstated.
const hoursFromProtime = (days) => {
  const val = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const all = (days || []).slice(0, 6).map(val).filter((v) => Number.isFinite(v));
  if (!all.length) return null;
  const weekdays = (days || []).slice(1, 6).map(val).filter((v) => Number.isFinite(v) && v > 0).length;
  return Math.round((all.reduce((a, b) => a + b, 0) * 7.5 + weekdays * 7.5) * 100) / 100;
};

module.exports = { SOURCES, FORECASTS, DATABASE_COLUMNS, MANUAL_FIELDS, hoursFromProtime, WEEK_RE, typedWeekCode, monthIndex, otdRows, topScrap, shippedFor, weekEnd, dayOf, weekCode, weeksOf, sheetRows, readSource, storeSource, importSources, rewriteWeeks, weeklyVolumes, sourcesStatus, ensure };
