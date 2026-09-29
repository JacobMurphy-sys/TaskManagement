// Backups: a JSON export of every table (always), plus a native pg_dump
// custom-format dump when pg_dump can be found. Old backups are pruned.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const db = require('./db');
const log = require('./logger');

const TABLES = ['projects', 'tasks', 'notes', 'reminders', 'audit_log'];
const JSON_DIR = path.join(config.backup.dir, 'json');
const DUMP_DIR = path.join(config.backup.dir, 'pgdump');

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

async function jsonBackup(name) {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  const data = { created_at: new Date().toISOString(), format: 1, tables: {} };
  for (const t of TABLES) {
    data.tables[t] = (await db.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
  }
  const file = path.join(JSON_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
  prune(JSON_DIR, '.json');
  return file;
}

function findPgDump() {
  if (config.backup.pgDumpPath) return config.backup.pgDumpPath;
  const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'win32') {
    dirs.push('C:\\Program Files\\pgAdmin 4\\runtime', 'C:\\Program Files\\pgAdmin 4\\v8\\runtime');
    const pgRoot = 'C:\\Program Files\\PostgreSQL';
    if (fs.existsSync(pgRoot)) {
      for (const v of fs.readdirSync(pgRoot)) dirs.push(path.join(pgRoot, v, 'bin'));
    }
  }
  for (const d of dirs) {
    const candidate = path.join(d, exe);
    if (d && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function pgDumpBackup(name) {
  const pgDump = findPgDump();
  if (!pgDump) return Promise.resolve(null);
  fs.mkdirSync(DUMP_DIR, { recursive: true });
  const file = path.join(DUMP_DIR, `${name}.dump`);
  const { host, port, user, password, database } = config.db;
  const args = ['-h', host, '-p', String(port), '-U', user, '-F', 'c', '-f', file, database];
  return new Promise((resolve) => {
    execFile(pgDump, args, { env: { ...process.env, PGPASSWORD: password } }, (err, _out, stderr) => {
      if (err) {
        log.warn('pg_dump backup failed (JSON backup still taken)', (stderr || err.message).trim());
        fs.rmSync(file, { force: true });
        return resolve(null);
      }
      prune(DUMP_DIR, '.dump');
      resolve(file);
    });
  });
}

async function runBackup(reason = 'manual') {
  const name = `taskmgr-${stamp()}`;
  const json = await jsonBackup(name);
  const dump = await pgDumpBackup(name);
  log.info(`Backup completed (${reason})`, { json, pgdump: dump || 'not available' });
  return { json, pgdump: dump };
}

function listBackups() {
  const list = (dir, kind) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => !f.startsWith('.'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { kind, file: f, size: st.size, created_at: st.mtime.toISOString() };
    });
  return [...list(JSON_DIR, 'json'), ...list(DUMP_DIR, 'pgdump')]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Backs up now if the newest backup is older than the interval, then on a timer.
function schedule() {
  const intervalMs = config.backup.intervalHours * 3600 * 1000;
  if (!(intervalMs > 0)) return;
  const check = async () => {
    const newest = listBackups().find((b) => b.kind === 'json');
    if (!newest || Date.now() - new Date(newest.created_at).getTime() >= intervalMs) {
      await runBackup('scheduled').catch((err) => log.error('Scheduled backup failed', err.message));
    }
  };
  check();
  // Check every 15 minutes so sleep/hibernate on a work laptop doesn't skip backups.
  setInterval(check, Math.min(intervalMs, 15 * 60 * 1000)).unref();
}

module.exports = { runBackup, listBackups, schedule, TABLES, JSON_DIR };
