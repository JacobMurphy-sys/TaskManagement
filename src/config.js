// Loads settings from .env (if present) and the environment. No dependencies.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

const env = process.env;
const resolve = (p) => path.resolve(ROOT, p);
const num = (v, fallback) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

module.exports = {
  ROOT,
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  db: {
    host: env.PGHOST || 'localhost',
    port: num(env.PGPORT, 5432),
    database: env.PGDATABASE || 'taskmgr',
    user: env.PGUSER || 'postgres',
    password: env.PGPASSWORD || '',
  },
  backup: {
    dir: resolve(env.BACKUP_DIR || './backups'),
    intervalHours: num(env.BACKUP_INTERVAL_HOURS, 24),
    keep: Math.max(1, num(env.BACKUP_KEEP, 30)),
    pgDumpPath: env.PG_DUMP_PATH || '',
  },
  logDir: resolve(env.LOG_DIR || './logs'),
};
