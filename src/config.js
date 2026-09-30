// Loads settings from .env (if present) and the environment. No dependencies.
const fs = require('fs');
const os = require('os');
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

// Data lives outside the app folder so updating, re-cloning or replacing the
// code can never touch it. Windows: %LOCALAPPDATA%\TaskManager.
const defaultDataDir = env.LOCALAPPDATA
  ? path.join(env.LOCALAPPDATA, 'TaskManager')
  : path.join(os.homedir(), '.taskmanager');
const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : defaultDataDir;
const inData = (setting, name) => (setting ? resolve(setting) : path.join(dataDir, name));

module.exports = {
  ROOT,
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  dataDir,
  dbFile: inData(env.DB_FILE, 'taskmgr.db'),
  // Where older versions kept their data (inside the app folder); migrated on start-up.
  // Only when the location isn't set explicitly (so e.g. the test run never touches real data).
  legacy: {
    dbFile: env.DB_FILE ? null : path.join(ROOT, 'data', 'taskmgr.db'),
    backupDir: env.BACKUP_DIR ? null : path.join(ROOT, 'backups'),
  },
  backup: {
    dir: inData(env.BACKUP_DIR, 'backups'),
    intervalHours: num(env.BACKUP_INTERVAL_HOURS, 24),
    keep: Math.max(1, num(env.BACKUP_KEEP, 30)),
  },
  logDir: inData(env.LOG_DIR, 'logs'),
};
