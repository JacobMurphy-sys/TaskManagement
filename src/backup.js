// Backups: a complete copy of the SQLite database file (open it in DBeaver,
// or restore it) plus a JSON export of every table. Old backups are pruned.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const log = require('./logger');
const { TABLE_NAMES } = require('./schema');

const JSON_DIR = path.join(config.backup.dir, 'json');
const DB_DIR = path.join(config.backup.dir, 'db');

function stamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function prune(dir, ext) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(ext)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - config.backup.keep))) {
    fs.unlinkSync(path.join(dir, f));
  }
}

function exportTables(conn = db.conn) {
  const tables = {};
  for (const t of TABLE_NAMES) {
    tables[t] = conn.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => ({ ...r }));
  }
  return tables;
}

function runBackup(reason = 'manual') {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  fs.mkdirSync(DB_DIR, { recursive: true });
  // Never overwrite an existing backup (two in the same second get a suffix).
  let name = `taskmgr-${stamp()}`;
  for (let i = 2; fs.existsSync(path.join(DB_DIR, `${name}.db`)) || fs.existsSync(path.join(JSON_DIR, `${name}.json`)); i++) {
    name = `taskmgr-${stamp()}-${i}`;
  }

  // VACUUM INTO writes a consistent, compacted copy even while the app is in use.
  const dbFile = path.join(DB_DIR, `${name}.db`);
  db.conn.prepare('VACUUM INTO ?').run(dbFile);
  prune(DB_DIR, '.db');

  const jsonFile = path.join(JSON_DIR, `${name}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ created_at: new Date().toISOString(), format: 2, tables: exportTables() }, null, 1));
  prune(JSON_DIR, '.json');

  log.info(`Backup completed (${reason})`, { db: dbFile, json: jsonFile });
  return { db: dbFile, json: jsonFile };
}

function listBackups() {
  const list = (dir, kind) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { kind, file: f, path: path.join(dir, f), size: st.size, created_at: st.mtime.toISOString() };
    });
  return [...list(DB_DIR, 'db'), ...list(JSON_DIR, 'json')]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Backs up now if the newest backup is older than the interval, then keeps checking.
function schedule() {
  const intervalMs = config.backup.intervalHours * 3600 * 1000;
  if (!(intervalMs > 0)) return;
  const check = () => {
    const newest = listBackups()[0];
    if (!newest || Date.now() - new Date(newest.created_at).getTime() >= intervalMs) {
      try { runBackup('scheduled'); } catch (err) { log.error('Scheduled backup failed', err.message); }
    }
  };
  check();
  // Check every 15 minutes so sleep/hibernate on a work laptop doesn't skip backups.
  setInterval(check, Math.min(intervalMs, 15 * 60 * 1000)).unref();
}

module.exports = { runBackup, listBackups, schedule, exportTables, JSON_DIR, DB_DIR };
