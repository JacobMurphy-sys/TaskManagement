// Restoring ALL data from a backup (.db or .json), replacing what is in the
// database. Used by the Backups page and by scripts/restore.js. A safety backup
// of the current data is always taken first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('./db');
const backup = require('./backup');
const log = require('./logger');
const { dropTriggersSql, TABLE_NAMES } = require('./schema');

class BadBackup extends Error {}

const summarize = (tables) => Object.fromEntries(TABLE_NAMES.map((t) => [t, (tables[t] || []).length]));

// Reads a backup given as a file path or as uploaded bytes (+ its file name).
function readBackup(source, name = typeof source === 'string' ? source : '') {
  const buf = typeof source === 'string' ? fs.readFileSync(source) : source;
  const created = typeof source === 'string' ? fs.statSync(source).mtime.toISOString() : null;
  if (buf.subarray(0, 16).toString('latin1') === 'SQLite format 3\0') {
    // node:sqlite opens files, so an upload goes through a temporary copy.
    const tmp = typeof source === 'string' ? source : path.join(os.tmpdir(), `cimanager-restore-${process.pid}-${Date.now()}.db`);
    if (tmp !== source) fs.writeFileSync(tmp, buf);
    const { DatabaseSync } = require('node:sqlite');
    let src;
    try {
      src = new DatabaseSync(tmp, { readOnly: true });
      const have = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      if (!have.has('projects') || !have.has('tasks')) throw new BadBackup('This database is not a CI Manager backup');
      const tables = {};
      for (const t of TABLE_NAMES) tables[t] = have.has(t) ? src.prepare(`SELECT * FROM ${t}`).all().map((r) => ({ ...r })) : [];
      return { created, tables, counts: summarize(tables) };
    } catch (err) {
      if (err instanceof BadBackup) throw err;
      throw new BadBackup(`Couldn't read the database file: ${err.message}`);
    } finally {
      src?.close();
      if (tmp !== source) fs.rmSync(tmp, { force: true });
    }
  }
  let data;
  try { data = JSON.parse(buf.toString('utf8')); } catch { data = null; }
  if (!data || typeof data.tables !== 'object' || !Array.isArray(data.tables.projects)) {
    throw new BadBackup(`${name ? `"${path.basename(name)}" is` : 'That is'} not a CI Manager backup (.db or .json)`);
  }
  return { created: data.created_at || created, tables: data.tables, counts: summarize(data.tables) };
}

// Replaces all data with the backup's. Returns the safety backup of what was there.
function restoreData(data, reason = 'restore') {
  const safety = backup.runBackup(`safety copy before ${reason}`);
  // Triggers are dropped during the load so original timestamps are kept and the
  // restore doesn't flood the audit log; migrate() puts them back afterwards.
  // Columns the current version doesn't have (from much older backups) are skipped.
  db.conn.exec('PRAGMA foreign_keys = OFF');
  try {
    db.tx(() => {
      db.conn.exec(dropTriggersSql());
      for (const table of TABLE_NAMES) db.run(`DELETE FROM ${table}`);
      db.run(`DELETE FROM sqlite_sequence WHERE name IN (${TABLE_NAMES.map(() => '?').join(', ')})`, TABLE_NAMES);
      for (const table of TABLE_NAMES) {
        const known = new Set(db.all(`PRAGMA table_info(${table})`).map((c) => c.name));
        for (const row of data.tables[table] || []) {
          const cols = Object.keys(row).filter((c) => known.has(c));
          db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c]));
        }
      }
    });
  } finally {
    db.migrate();
    db.conn.exec('PRAGMA foreign_keys = ON');
  }
  const problems = db.all('PRAGMA foreign_key_check').length;
  log.info(`Data restored (${reason})`, { counts: summarize(data.tables), safety: safety.db, broken_references: problems });
  return { safety: safety.db, problems, counts: summarize(data.tables) };
}

module.exports = { readBackup, restoreData, BadBackup };
