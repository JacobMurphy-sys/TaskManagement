// SQLite access using Node's built-in node:sqlite module (no install needed).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { schemaSql } = require('./schema');

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

function migrate() {
  tx(() => conn.exec(schemaSql()));
}

module.exports = { conn, all, get, run, tx, migrate, open };
