'use strict';
// 📊 DailyPersoData — the report the Power BI cards-persoed figures come from: one row per job, machine
// and shift (Production Date + Production Time, e.g. "22:00 - 06:00"), with Qty Persoed, Job Waste and
// Remake. Perso's 📈 History and the ⏳ Backlog's pace add up its Qty Persoed by Production Date, so the
// CI Manager shows what Power BI shows. (The ⏱ timing report, with each run's start and end, still drives
// the Gantt, speeds and anomalies.) Each read replaces the rows for the days the report covers.
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { readBook } = require('./xlsxread');
const { dateTime } = require('./prodactual');

const FIELDS = {
  imported: ['import date'], day: ['production date', 'prod date'], due: ['due date'], shift: ['production time', 'shift'], job: ['job', 'job name'],
  product: ['product type'], job_qty: ['job qty', 'job quantity'], waste: ['job waste', 'waste'], qty: ['qty persoed', 'qty produced'], remake: ['remake'],
  station: ['machine ws name', 'workstation'], machine: ['machine name', 'machine'], mode: ['production mode', 'mode'], item_name: ['item name'],
  item: ['axref', 'item axref', 'ax ref'], customer: ['customer name'], trigram: ['co ref'], operator: ['operator'],
};
const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const dayOf = (v) => (v === null || v === undefined || v === '' ? null : (dateTime(v, v) || '').slice(0, 10) || null);
const int = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v)));
const str = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const trigramOf = (job, own) => String(job || '').trim().match(/^[A-Z]([A-Z]{3})/i)?.[1]?.toUpperCase() || (own ? String(own).trim().toUpperCase() : null);

function parse(buf) {
  const book = readBook(buf);
  const info = book.sheets[0]; if (!info) throw new Error('The file has no sheets');
  const sh = book.sheet(info.name);
  const L = (n) => { let t = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) t = String.fromCharCode(65 + ((n - 1) % 26)) + t; return t; };
  let headRow = 0; const col = {};
  for (let r = 1; r <= Math.min(sh.maxRow, 10) && !headRow; r++) {
    const found = {};
    for (let c = 1; c <= sh.maxCol; c++) { const h = norm(sh.cells.get(`${L(c)}${r}`)?.v); for (const [k, names] of Object.entries(FIELDS)) if (!found[k] && names.includes(h)) found[k] = c; }
    if (found.day && found.job && found.qty) { headRow = r; Object.assign(col, found); }
  }
  if (!headRow) throw new Error(`Can't find the Production Date, job and Qty Persoed columns in "${info.name}"`);
  const rows = []; let skipped = 0;
  for (let r = headRow + 1; r <= sh.maxRow; r++) {
    const g = (k) => (col[k] ? sh.cells.get(`${L(col[k])}${r}`)?.v ?? null : null);
    const job = str(g('job')); if (!job) continue;
    const day = dayOf(g('day')); if (!day) { skipped++; continue; }
    rows.push({ day, shift: str(g('shift')), job, product: str(g('product')), job_qty: int(g('job_qty')), waste: int(g('waste')), qty: int(g('qty')) || 0,
      remake: /^(yes|y|true|1|ja)$/i.test(String(g('remake') ?? '').trim()) ? 1 : 0, station: str(g('station')), machine: str(g('machine')), mode: str(g('mode')),
      item: str(g('item')), item_name: str(g('item_name')), customer: str(g('customer')), trigram: trigramOf(job, g('trigram')), due: dayOf(g('due')), imported: dayOf(g('imported')), operator: str(g('operator')) });
  }
  return { sheet: info.name, rows, skipped };
}

// The report is the record for the days it covers: their rows are replaced by its own.
const COLS = ['day', 'shift', 'job', 'product', 'job_qty', 'waste', 'qty', 'remake', 'station', 'machine', 'mode', 'item', 'item_name', 'customer', 'trigram', 'due', 'imported', 'operator', 'file', 'read_at'];
function store(rows, file) {
  if (!rows.length) return { added: 0, replaced: 0 };
  const days = rows.map((r) => r.day).sort(); const from = days[0]; const to = days[days.length - 1];
  const now = new Date().toISOString(); let had = 0;
  db.tx(() => {
    had = db.get('SELECT COUNT(*) AS n FROM perso_output WHERE day >= ? AND day <= ?', [from, to]).n;
    db.run('DELETE FROM perso_output WHERE day >= ? AND day <= ?', [from, to]);
    for (const r of rows) db.run(`INSERT INTO perso_output (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`, COLS.map((c) => (c === 'file' ? file : c === 'read_at' ? now : r[c] ?? null)));
  });
  return { added: Math.max(0, rows.length - had), replaced: had, from, to };
}

const SEEN = 'pdata_seen';
function readLinked(file, { force = false } = {}) {
  if (!file) return { status: 'none' };
  let stat; try { stat = fs.statSync(file); } catch { return { status: 'missing', file }; }
  const sig = `${file}|${stat.mtimeMs}|${stat.size}`;
  if (!force && db.get('SELECT value FROM settings WHERE key = ?', [SEEN])?.value === sig) return { status: 'unchanged', file };
  try {
    const p = parse(fs.readFileSync(file));
    const r = store(p.rows, path.basename(file));
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [SEEN, sig]);
    return { status: 'read', file, rows: p.rows.length, skipped: p.skipped, ...r };
  } catch (err) {
    return { status: 'error', file, error: err.code === 'EBUSY' ? 'the file is open elsewhere and locked' : err.message };
  }
}

// Which rows count as cards persoed — set to match Power BI's measure (Reporting settings):
// kpi_pdata_remakes '0' leaves remakes out; kpi_pdata_live '1' counts LIVE production only;
// kpi_pdata_m '0' leaves M work orders out. By default every row counts.
const setting = (k, d) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value ?? d;
function filterSql() {
  const w = [];
  if (setting('kpi_pdata_remakes', '1') === '0') w.push('remake = 0');
  if (setting('kpi_pdata_live', '0') === '1') w.push("upper(coalesce(mode, '')) = 'LIVE'");
  if (setting('kpi_pdata_m', '1') === '0') w.push("job NOT LIKE 'M%'");
  return w.length ? ` AND ${w.join(' AND ')}` : '';
}
// in use while the report is linked and has been read
const has = () => { try { return !!String(setting('kpi_perso_data', '') || '').trim() && !!db.get('SELECT 1 FROM perso_output LIMIT 1'); } catch { return false; } };
// The rows counted since a day, shaped as runs for the history: one per row, "ended" on its Production Date.
function rowsSince(fromDay) {
  return db.all(`SELECT job, machine, day, qty, job_qty, due, imported, trigram, customer, remake FROM perso_output WHERE day >= ?${filterSql()} ORDER BY day`, [fromDay])
    .map((r) => ({ ...r, end_at: `${r.day}T12:00:00`, imported: r.imported ? `${r.imported}T12:00:00` : null }));
}
// Day by day, every way the cards can be counted — to see which matches Power BI.
function check(fromDay, toDay) {
  return db.all(`SELECT day, SUM(qty) AS all_rows, SUM(CASE WHEN remake = 1 THEN qty ELSE 0 END) AS remakes,
      SUM(CASE WHEN upper(coalesce(mode, '')) <> 'LIVE' THEN qty ELSE 0 END) AS not_live, SUM(CASE WHEN job LIKE 'M%' THEN qty ELSE 0 END) AS m_jobs,
      SUM(coalesce(waste, 0)) AS waste FROM perso_output WHERE day >= ? AND day <= ? GROUP BY day ORDER BY day`, [fromDay, toDay]);
}
const stamp = () => db.get('SELECT COUNT(*) AS n, MIN(day) AS first, MAX(day) AS last, MAX(read_at) AS read_at FROM perso_output');

module.exports = { parse, store, readLinked, rowsSince, check, stamp, has, filterSql };
