// SQLite access using Node's built-in node:sqlite module (no install needed).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const {
  tablesSql, triggersSql, addColumnsSql, dropTriggersSql, tablesToRebuild, createTableSql, columnsOf, TABLE_NAMES,
} = require('./schema');

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
  // Existing projects get a default project ID (new ones get it by trigger).
  project_codes() {
    run("UPDATE projects SET project_code = 'PRJ-' || printf('%04d', id) WHERE project_code IS NULL");
  },
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

// Rebuilds tables whose NOT NULL constraints changed (e.g. tasks.project_id became
// optional for standalone tasks), following SQLite's documented procedure:
// foreign keys off, copy into a new table, swap, then verify every reference.
// A copy of the database is saved first.
function rebuildTables() {
  const info = Object.fromEntries(TABLE_NAMES.map((t) => [t, all(`PRAGMA table_info(${t})`)]));
  const tables = tablesToRebuild(info);
  if (!tables.length) return;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const safety = path.join(config.backup.dir, 'db', `pre-upgrade-${stamp}.db`);
  fs.mkdirSync(path.dirname(safety), { recursive: true });
  conn.prepare('VACUUM INTO ?').run(safety);
  log.info(`Upgrading tables ${tables.join(', ')}; copy of the database saved first`, safety);
  conn.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(() => {
      conn.exec(dropTriggersSql());
      for (const t of tables) {
        const old = info[t].map((c) => c.name);
        const cols = columnsOf(t).filter((c) => old.includes(c)).join(', ');
        const seq = get('SELECT seq FROM sqlite_sequence WHERE name = ?', [t]);
        conn.exec(createTableSql(t, `${t}__new`));
        conn.exec(`INSERT INTO ${t}__new (${cols}) SELECT ${cols} FROM ${t}`);
        conn.exec(`DROP TABLE ${t}`);
        conn.exec(`ALTER TABLE ${t}__new RENAME TO ${t}`);
        if (seq) {
          if (!run('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?', [seq.seq, t]).changes) {
            run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [t, seq.seq]);
          }
        }
      }
      const broken = all('PRAGMA foreign_key_check');
      if (broken.length) throw new Error(`Upgrade stopped: ${broken.length} broken references (nothing was changed)`);
    });
  } finally {
    conn.exec('PRAGMA foreign_keys = ON');
  }
}

function migrate() {
  tx(() => conn.exec(tablesSql()));
  rebuildTables();
  tx(() => {
    const existing = Object.fromEntries(TABLE_NAMES.map((t) => [t, all(`PRAGMA table_info(${t})`).map((c) => c.name)]));
    for (const sql of addColumnsSql(existing)) {
      conn.exec(sql);
      log.info(`Database upgraded: ${sql}`);
    }
    conn.exec(triggersSql());
    const done = new Set(all("SELECT key FROM settings WHERE key LIKE 'migration:%'").map((r) => r.key));
    const pending = Object.keys(DATA_MIGRATIONS).filter((name) => !done.has(`migration:${name}`));
    if (!pending.length) return;
    conn.exec(dropTriggersSql());
    for (const name of pending) {
      DATA_MIGRATIONS[name]();
      run("INSERT INTO settings (key, value) VALUES (?, datetime('now'))", [`migration:${name}`]);
    }
    conn.exec(triggersSql());
  });
}

module.exports = { conn, all, get, run, tx, migrate, open };
