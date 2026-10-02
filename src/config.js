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
// code can never touch it. Windows: %LOCALAPPDATA%\CIManager.
const base = env.LOCALAPPDATA || os.homedir();
const defaultDataDir = path.join(base, env.LOCALAPPDATA ? 'CIManager' : '.cimanager');
// Before the app was renamed to CI Manager its data folder was ...\TaskManager.
const oldDataDir = path.join(base, env.LOCALAPPDATA ? 'TaskManager' : '.taskmanager');

// Moves the old data folder to the new name on first start. If it can't be moved
// (e.g. a file is open elsewhere) the old folder is used as it is.
let dataDirNote = null;
function defaultDir() {
  if (!fs.existsSync(oldDataDir) || oldDataDir === defaultDataDir) return defaultDataDir;
  if (fs.existsSync(defaultDataDir)) {
    const hasDb = (dir) => fs.existsSync(path.join(dir, 'taskmgr.db'));
    if (hasDb(defaultDataDir) || !hasDb(oldDataDir)) return defaultDataDir;
    dataDirNote = `Using the old data folder ${oldDataDir}: ${defaultDataDir} already exists without a database. Move or delete it (it has no database in it) and restart to finish the move.`;
    return oldDataDir;
  }
  try {
    fs.renameSync(oldDataDir, defaultDataDir);
    dataDirNote = `Moved the data folder from ${oldDataDir} to ${defaultDataDir}`;
    return defaultDataDir;
  } catch (err) {
    dataDirNote = `Couldn't move the data folder from ${oldDataDir} to ${defaultDataDir} (${err.code || err.message}); still using the old folder. Close anything using it and restart.`;
    return oldDataDir;
  }
}
const dataDir = env.DATA_DIR ? resolve(env.DATA_DIR) : defaultDir();
const inData = (setting, name) => (setting ? resolve(setting) : path.join(dataDir, name));

module.exports = {
  ROOT,
  port: num(env.PORT, 3000),
  host: env.HOST || '127.0.0.1',
  dataDir,
  dataDirNote,
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
  // Files attached to tasks and meetings (screenshots, documents…).
  attachDir: inData(env.ATTACH_DIR, 'attachments'),
};
