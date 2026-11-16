'use strict';
// 🗄 The report vault: a static copy of Reporting's source reports, month by month, so the figures outlive the files.
// The source exports (perso, shipped, remakes, OTD, Salesforce, the safety concern forms, consumption) cover 1 January
// to today: each import replaces a source's rows (kpidata.js), so when a file starts again on 1 January, last year
// would go with it. The vault keeps each month once it's over:
//  - sealed at month end: a few days into the next month (SEAL_AFTER_DAY, time for late corrections), after the source
//    is read once more, each source's rows for the month are copied here with the file as it was (compressed; one copy
//    of a file however many months it seals);
//  - kept when a file stops covering a month that isn't sealed yet (the 1 January reset, before December's seal):
//    sealed there and then from the rows SITHUB had, before they're replaced (no file: it's already the new one);
//  - by hand: an admin seals a month, reopens one (the next import's figures are used) and seals it again.
// Every report reads kpi_rows, so after each import the sealed months are put back there from the vault (after()):
// past months always read as sealed, wherever the reports are. A file whose figures for a sealed month differ is
// noted on the month (diff), not taken. 🚚 OTD counts the same whether it's read from the OTD report or typed into SITHUB
// (otdentry.js writes the entries in through here too): switching to the entries keeps the months the report had.

const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SEAL_AFTER_DAY = 5; // a month is sealed from the 5th of the next one
const MAX_FILE = 40 * 1024 * 1024; // a file bigger than this isn't kept (its rows are)
const TABLES = `
  CREATE TABLE IF NOT EXISTS vault_periods (
    id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, period TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'sealed',
    how TEXT, sealed_at TEXT NOT NULL, sealed_by TEXT, rows INTEGER NOT NULL DEFAULT 0, qty REAL NOT NULL DEFAULT 0, scrap REAL NOT NULL DEFAULT 0,
    file_id INTEGER, file_name TEXT, file_modified TEXT, diff TEXT, reopened_at TEXT, reopened_by TEXT, UNIQUE (source, period));
  CREATE TABLE IF NOT EXISTS vault_rows (period_id INTEGER NOT NULL, day TEXT NOT NULL, week TEXT NOT NULL, customer TEXT, type TEXT,
    qty REAL NOT NULL DEFAULT 0, scrap REAL NOT NULL DEFAULT 0, extra TEXT);
  CREATE INDEX IF NOT EXISTS vault_rows_period ON vault_rows(period_id);
  CREATE TABLE IF NOT EXISTS vault_files (id INTEGER PRIMARY KEY AUTOINCREMENT, sha TEXT NOT NULL UNIQUE, name TEXT, size INTEGER, gz BLOB NOT NULL, created_at TEXT NOT NULL);`;
let ready = false;
const ensure = () => { if (!ready) { db.conn.exec(TABLES); ready = true; } };
const kd = () => require('./kpidata');
const vaulted = (source) => !!kd().SOURCES[source];
const thisMonth = () => new Date().toISOString().slice(0, 7);
const nextMonth = (p) => { const [y, m] = p.split('-').map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`; };

// the month a row belongs to: its day, else (OTD's typed weeks) the week's last day
const weekMonth = new Map();
function periodOf(r) {
  if (r.day) return String(r.day).slice(0, 7);
  if (!r.week) return null;
  if (!weekMonth.has(r.week)) weekMonth.set(r.week, (kd().weekEnd(r.week) || '').slice(0, 7) || null);
  return weekMonth.get(r.week);
}
const ROW_COLS = 'day, week, customer, type, qty, scrap, extra';
const sums = (rows) => ({ rows: rows.length, qty: rows.reduce((a, r) => a + (Number(r.qty) || 0), 0), scrap: rows.reduce((a, r) => a + (Number(r.scrap) || 0), 0) });
const sealed = (source) => new Map(db.all("SELECT * FROM vault_periods WHERE source = ? AND status = 'sealed'", [source]).map((p) => [p.period, p]));

// the file kept with a seal (once, by its content)
function keepFile(file) {
  if (!file) return null;
  let buf; try { const st = fs.statSync(file); if (st.size > MAX_FILE) return null; buf = fs.readFileSync(file); } catch { return null; }
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const had = db.get('SELECT id FROM vault_files WHERE sha = ?', [sha]);
  if (had) return had.id;
  return Number(db.run('INSERT INTO vault_files (sha, name, size, gz, created_at) VALUES (?, ?, ?, ?, ?)', [sha, path.basename(file), buf.length, zlib.gzipSync(buf, { level: 6 }), new Date().toISOString()]).lastInsertRowid);
}
// a month of a source into the vault (rows given), replacing a seal reopened before (no transaction of its own)
function sealRows(source, period, rows, { how, by = null, file = null, fileModified = null } = {}) {
  ensure();
  const s = sums(rows); const now = new Date().toISOString();
  const fileId = file ? keepFile(file) : null;
  const old = db.get('SELECT id FROM vault_periods WHERE source = ? AND period = ?', [source, period]);
  if (old) { db.run('DELETE FROM vault_rows WHERE period_id = ?', [old.id]); db.run('DELETE FROM vault_periods WHERE id = ?', [old.id]); }
  const id = Number(db.run(`INSERT INTO vault_periods (source, period, status, how, sealed_at, sealed_by, rows, qty, scrap, file_id, file_name, file_modified)
    VALUES (?, ?, 'sealed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [source, period, how, now, by, s.rows, s.qty, s.scrap, fileId, file ? path.basename(file) : null, fileModified]).lastInsertRowid);
  const ins = db.conn.prepare(`INSERT INTO vault_rows (period_id, ${ROW_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(id, r.day || '', r.week || '', r.customer ?? null, r.type ?? null, Number(r.qty) || 0, Number(r.scrap) || 0, r.extra ?? null);
  require('./logger').info(`🗄 Report vault: ${source} ${period} sealed (${how}${by ? `, by ${by}` : ''}): ${s.rows} rows`);
  return id;
}

// ---- around an import (kpidata.storeSource / storeConsumption, inside their transaction) -------------------
// before the source's rows are replaced: what's there now, by month (only what isn't sealed and is over)
function before(source) {
  ensure();
  if (!vaulted(source)) return null;
  const done = sealed(source); const now = thisMonth(); const by = new Map();
  for (const r of db.all(`SELECT ${ROW_COLS} FROM kpi_rows WHERE source = ?`, [source])) {
    const p = periodOf(r); if (!p || p >= now || done.has(p)) continue;
    if (!by.has(p)) by.set(p, []); by.get(p).push(r);
  }
  return by;
}
// after the new rows are in: months the new file no longer covers are kept (sealed from what was there), then every
// sealed month is put back from the vault, a difference with the file noted on it
function after(source, kept) {
  ensure();
  if (!vaulted(source)) return;
  const live = new Map();
  for (const r of db.all(`SELECT rowid AS rid, ${ROW_COLS} FROM kpi_rows WHERE source = ?`, [source])) { const p = periodOf(r); if (!p) continue; if (!live.has(p)) live.set(p, []); live.get(p).push(r); }
  for (const [p, rows] of kept || []) if (!live.has(p)) sealRows(source, p, rows, { how: 'kept when the file stopped covering it' });
  const del = db.conn.prepare('DELETE FROM kpi_rows WHERE rowid = ?');
  const ins = db.conn.prepare(`INSERT INTO kpi_rows (source, ${ROW_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [p, v] of sealed(source)) {
    const now = live.get(p) || [];
    if (now.length) {
      const s = sums(now);
      const differs = s.rows !== v.rows || Math.abs(s.qty - v.qty) > 1e-6 || Math.abs(s.scrap - v.scrap) > 1e-6;
      db.run('UPDATE vault_periods SET diff = ? WHERE id = ?', [differs ? JSON.stringify({ ...s, at: new Date().toISOString() }) : null, v.id]);
      for (const r of now) del.run(r.rid);
    }
    for (const r of db.all(`SELECT ${ROW_COLS} FROM vault_rows WHERE period_id = ?`, [v.id])) ins.run(source, r.day, r.week, r.customer, r.type, r.qty, r.scrap, r.extra);
  }
}

// ---- sealing at month end ------------------------------------------------------------------------------
// what's due: each source's months that are over (past the 5th of the next), have rows and aren't sealed (or reopened)
function due(today = new Date()) {
  ensure();
  const iso = today.toISOString().slice(0, 10); const out = [];
  for (const source of Object.keys(kd().SOURCES)) {
    if (!vaulted(source)) continue;
    const have = new Set(db.all('SELECT period FROM vault_periods WHERE source = ?', [source]).map((p) => p.period));
    const months = new Set(); for (const r of db.all('SELECT DISTINCT day, week FROM kpi_rows WHERE source = ?', [source])) { const p = periodOf(r); if (p) months.add(p); }
    for (const p of months) if (!have.has(p) && iso >= `${nextMonth(p)}-${String(SEAL_AFTER_DAY).padStart(2, '0')}`) out.push({ source, period: p });
  }
  return out;
}
// seal months of a source from its rows now (the month-end seal, or by hand), with the file it was read from
function seal(source, periods, { how = 'month end', by = null } = {}) {
  ensure();
  if (!vaulted(source)) throw Object.assign(new Error(`No source called ${source}`), { status: 400 });
  const src = db.get('SELECT file, modified FROM kpi_sources WHERE source = ?', [source]) || {};
  const want = new Set(periods); const by_ = new Map();
  for (const r of db.all(`SELECT ${ROW_COLS} FROM kpi_rows WHERE source = ?`, [source])) { const p = periodOf(r); if (!want.has(p)) continue; if (!by_.has(p)) by_.set(p, []); by_.get(p).push(r); }
  let n = 0;
  db.tx(() => { for (const p of want) { if (p >= thisMonth()) continue; sealRows(source, p, by_.get(p) || [], { how, by, file: src.file, fileModified: src.modified }); n++; } });
  return n;
}
// reopened: the next import's figures are used for it until it's sealed again
function reopen(id, by) {
  ensure();
  const v = db.get('SELECT * FROM vault_periods WHERE id = ?', [id]); if (!v) return null;
  db.run("UPDATE vault_periods SET status = 'reopened', reopened_at = ?, reopened_by = ? WHERE id = ?", [new Date().toISOString(), by, id]);
  require('./logger').info(`🗄 Report vault: ${v.source} ${v.period} reopened by ${by || '?'}`);
  return v;
}

// ---- reading it ------------------------------------------------------------------------------------------
function overview(year) {
  ensure();
  const y = String(year);
  const periods = db.all('SELECT id, source, period, status, how, sealed_at, sealed_by, rows, qty, scrap, file_id, file_name, file_modified, diff, reopened_at, reopened_by FROM vault_periods WHERE period LIKE ? ORDER BY source, period', [`${y}-%`])
    .map((p) => ({ ...p, diff: p.diff ? JSON.parse(p.diff) : null }));
  // what the live rows hold per source and month (for months not sealed: what would be sealed)
  const live = {};
  for (const source of Object.keys(kd().SOURCES)) {
    const m = {}; for (const r of db.all('SELECT day, week, qty, scrap FROM kpi_rows WHERE source = ? AND (day LIKE ? OR week LIKE ?)', [source, `${y}-%`, `W${y.slice(2)}%`])) { const p = periodOf(r); if (!p || !p.startsWith(y)) continue; (m[p] ||= { rows: 0, qty: 0 }).rows++; m[p].qty += Number(r.qty) || 0; }
    live[source] = m;
  }
  const years = [...new Set([...db.all('SELECT DISTINCT substr(period, 1, 4) AS y FROM vault_periods').map((r) => +r.y), ...db.all("SELECT DISTINCT substr(day, 1, 4) AS y FROM kpi_rows WHERE day <> ''").map((r) => +r.y)])].filter(Boolean).sort();
  const files = db.get('SELECT count(*) AS n, coalesce(sum(length(gz)), 0) AS bytes FROM vault_files');
  return { year: Number(year), years, sources: Object.fromEntries(Object.entries(kd().SOURCES).map(([k, s]) => [k, { label: s.label, vaulted: vaulted(k) }])), periods, live, seal_after_day: SEAL_AFTER_DAY, files };
}
const fileOf = (id) => { ensure(); const f = db.get('SELECT name, gz FROM vault_files WHERE id = ?', [id]); return f ? { name: f.name, buf: zlib.gunzipSync(Buffer.from(f.gz)) } : null; };
const rowsOf = (id) => { ensure(); return db.all(`SELECT ${ROW_COLS} FROM vault_rows WHERE period_id = ? ORDER BY day, week`, [id]); };

module.exports = { ensure, before, after, due, seal, reopen, overview, fileOf, rowsOf, periodOf, SEAL_AFTER_DAY };
