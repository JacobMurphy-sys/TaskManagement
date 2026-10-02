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

// Attachment files are copied into BACKUP_DIR/files (kept even after the attachment is
// deleted, so restoring an older backup finds its files); files no attachment uses any
// more are then removed from the live folder.
const FILES_DIR = path.join(config.backup.dir, 'files');
function syncAttachmentFiles() {
  const dir = config.attachDir;
  if (!fs.existsSync(dir)) return;
  fs.mkdirSync(FILES_DIR, { recursive: true });
  const used = new Set(db.conn.prepare('SELECT stored FROM attachments').all().map((r) => r.stored));
  for (const f of fs.readdirSync(dir)) {
    const src = path.join(dir, f);
    if (!fs.statSync(src).isFile()) continue;
    const dst = path.join(FILES_DIR, f);
    if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
    if (!used.has(f)) fs.rmSync(src, { force: true });
  }
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

  try { syncAttachmentFiles(); } catch (err) { log.error('Copying attachment files to the backup folder failed', err.message); }
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

module.exports = { runBackup, listBackups, schedule, exportTables, syncAttachmentFiles, JSON_DIR, DB_DIR, FILES_DIR };
