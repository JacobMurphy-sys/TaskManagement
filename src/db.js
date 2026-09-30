// SQLite access using Node's built-in node:sqlite module (no install needed).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const { schemaSql, dropTriggersSql } = require('./schema');

// node:sqlite prints an "experimental" warning on load; it's stable enough for this use.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite')) return;
  emitWarning.call(process, warning, ...rest);
};

let sqlite;
try {
  sqlite = require('node:sqlite');
} catch {
  console.error(`\nThis app needs Node.js 22.13 or newer (it uses Node's built-in SQLite). You have ${process.version}.\n` +
    'Install the current LTS version from https://nodejs.org and try again.\n');
  process.exit(1);
}

function open(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const conn = new sqlite.DatabaseSync(file);
  conn.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  return conn;
}

// One-off move of a database from the old location inside the app folder.
function migrateLegacyData() {
  const { legacy, dbFile, backup } = config;
  if (legacy.dbFile && !fs.existsSync(dbFile) && fs.existsSync(legacy.dbFile)) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    // VACUUM INTO also folds in anything still in the -wal file.
    const old = new sqlite.DatabaseSync(legacy.dbFile);
    old.prepare('VACUUM INTO ?').run(dbFile);
    old.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(legacy.dbFile + suffix)) fs.renameSync(legacy.dbFile + suffix, `${legacy.dbFile}${suffix}.migrated`);
    }
    log.info(`Moved database from ${legacy.dbFile} to ${dbFile}`);
  }
  if (legacy.backupDir && !fs.existsSync(backup.dir) && fs.existsSync(legacy.backupDir)) {
    fs.cpSync(legacy.backupDir, backup.dir, { recursive: true });
    log.info(`Copied backups from ${legacy.backupDir} to ${backup.dir}`);
  }
}
migrateLegacyData();

const conn = open(config.dbFile);

// node:sqlite accepts only null/number/bigint/string/buffer parameters.
const param = (v) => {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object' && !Buffer.isBuffer(v)) return JSON.stringify(v);
  return v;
};

const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = conn.prepare(sql); cache.set(sql, s); }
  return s;
}

const all = (sql, params = []) => stmt(sql).all(...params.map(param)).map((r) => ({ ...r }));
const get = (sql, params = []) => { const r = stmt(sql).get(...params.map(param)); return r ? { ...r } : undefined; };
const run = (sql, params = []) => stmt(sql).run(...params.map(param));

// Runs fn() inside a transaction.
function tx(fn) {
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

// One-off data changes, each recorded in settings so it runs only once. Triggers are
// dropped while they run so they don't bump updated_at or flood the audit log.
const DATA_MIGRATIONS = {
  // Due dates became whole days: move any stored time to the end of that local day.
  due_dates_end_of_day() {
    const endOfDay = (iso) => {
      const d = new Date(iso);
      d.setHours(23, 59, 59, 999);
      return d.toISOString();
    };
    for (const [table, cols] of [['tasks', ['due_at']], ['ideas', ['due_at']], ['projects', ['due_at', 'baseline_due_at']]]) {
      for (const col of cols) {
        for (const r of all(`SELECT id, ${col} AS v FROM ${table} WHERE ${col} IS NOT NULL`)) {
          const v = endOfDay(r.v);
          if (v !== r.v) run(`UPDATE ${table} SET ${col} = ? WHERE id = ?`, [v, r.id]);
        }
      }
    }
  },
};

function migrate() {
  tx(() => {
    conn.exec(schemaSql());
    const done = new Set(all("SELECT key FROM settings WHERE key LIKE 'migration:%'").map((r) => r.key));
    const pending = Object.keys(DATA_MIGRATIONS).filter((name) => !done.has(`migration:${name}`));
    if (!pending.length) return;
    conn.exec(dropTriggersSql());
    for (const name of pending) {
      DATA_MIGRATIONS[name]();
      run("INSERT INTO settings (key, value) VALUES (?, datetime('now'))", [`migration:${name}`]);
    }
    conn.exec(schemaSql());
  });
}

module.exports = { conn, all, get, run, tx, migrate, open };
