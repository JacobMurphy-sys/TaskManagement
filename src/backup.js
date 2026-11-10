// Backups: a complete copy of the SQLite database file (open it in DBeaver,
// or restore it) plus a JSON export of every table.
//
// Compressed (BACKUP_COMPRESS, on unless 0): each file is gzipped once it's written, in the background so
// the app stays responsive, then checked by unzipping it again and comparing it byte for byte with the
// original (a checksum of each). Only then is the uncompressed copy removed; if the check fails, the
// uncompressed copy is kept and the problem logged. gzip is lossless: a restore gets back exactly the
// file that was backed up.
//
// Kept (pruned after each backup): by default the newest BACKUP_KEEP of each kind. With BACKUP_KEEP_DAYS,
// by age instead: everything from the last BACKUP_KEEP_ALL_HOURS (default: all of BACKUP_KEEP_DAYS), then
// the last one of each day, and nothing older than BACKUP_KEEP_DAYS.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Worker } = require('worker_threads');
const { writeJson: writeJsonFrom } = require('./jsonexport');
const config = require('./config');
const db = require('./db');
const log = require('./logger');
const { TABLE_NAMES } = require('./schema');

const JSON_DIR = path.join(config.backup.dir, 'json');
const DB_DIR = path.join(config.backup.dir, 'db');
const MIN_FREE = 1024 ** 3; // a backup isn't started with less than 1 GB free

function stamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
// taskmgr-20261110-140000(-2).db / .json, either of them .gz
const BACKUP_RE = /^taskmgr-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)(?:-\d+)?\.(db|json)(\.gz)?$/;
const baseOf = (f) => f.replace(/\.(db|json)(\.gz)?$/, '');
const timeOf = (f) => { const m = f.match(BACKUP_RE); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null; };

// which backups (base names, newest first) to keep
function keepSet(bases, now = new Date(), opts = config.backup) {
  if (!(opts.keepDays > 0)) return new Set(bases.slice(0, opts.keep));
  const allHours = opts.keepAllHours > 0 ? opts.keepAllHours : opts.keepDays * 24;
  const out = new Set(); const days = new Set();
  for (const b of bases) {
    const t = timeOf(`${b}.db`);
    if (!t) { out.add(b); continue; } // not one of ours by name: left alone
    const ageH = (now - t) / 3600000;
    if (ageH > opts.keepDays * 24) continue;
    if (ageH <= allHours) { out.add(b); continue; }
    const day = b.slice(8, 16); // the last one of each day
    if (!days.has(day)) { days.add(day); out.add(b); }
  }
  if (bases[0]) out.add(bases[0]); // never the newest
  return out;
}
function prune(dir, now = new Date()) {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => BACKUP_RE.test(f));
  const bases = [...new Set(files.map(baseOf))].sort().reverse();
  const keep = keepSet(bases, now);
  let removed = 0;
  for (const f of files) if (!keep.has(baseOf(f)) && !compressing.has(path.join(dir, f))) { fs.rmSync(path.join(dir, f), { force: true }); removed++; }
  return removed;
}

function exportTables(conn = db.conn) {
  const tables = {};
  for (const t of TABLE_NAMES) {
    tables[t] = conn.prepare(`SELECT * FROM ${t} ORDER BY id`).all().map((r) => ({ ...r }));
  }
  return tables;
}
// The JSON export (src/jsonexport.js): from the live database here, or in a worker from a snapshot.
const writeJson = (file, conn = db.conn) => writeJsonFrom(file, conn);
function jsonInWorker(dbFile, jsonFile) {
  return new Promise((resolve) => {
    const w = new Worker(path.join(__dirname, 'jsonexport.js'), { workerData: { db: dbFile, json: jsonFile } });
    let done = false;
    w.once('message', (m) => { done = true; resolve(m); });
    w.once('error', (err) => { if (!done) { done = true; resolve({ ok: false, error: err.message }); } });
    w.once('exit', (code) => { if (!done) resolve({ ok: false, error: `stopped (${code})` }); });
  });
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

// ---- compression: one file at a time, in the background ----------------------------------------
const compressing = new Set(); let queue = Promise.resolve();
const sha = () => crypto.createHash('sha256');
async function compressFile(file) {
  const gz = `${file}.gz`; const tmp = `${gz}.tmp`;
  try {
    const before = sha();
    await pipeline(fs.createReadStream(file), async function* (src) { for await (const c of src) { before.update(c); yield c; } }, zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp));
    // the check: unzip what was written and compare it with the original
    const after = sha();
    await pipeline(fs.createReadStream(tmp), zlib.createGunzip(), async (src) => { for await (const c of src) after.update(c); });
    const [a, b] = [before.digest('hex'), after.digest('hex')];
    if (a !== b) throw new Error('the compressed copy didn\'t unzip to the same file');
    fs.renameSync(tmp, gz);
    fs.rmSync(file, { force: true });
    return { ok: true, file: gz };
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    log.error(`Backup ${path.basename(file)}: kept uncompressed, compressing it failed`, err.message);
    return { ok: false, file, error: err.message };
  } finally { compressing.delete(file); }
}
function compressLater(files) {
  for (const f of files) compressing.add(f);
  const p = queue.then(() => Promise.all(files.map((f) => compressFile(f))));
  queue = p.catch(() => {});
  return p;
}
// uncompressed backups left by a stop mid-way (or made before compression was on), and half-written .gz
function sweep() {
  for (const dir of [DB_DIR, JSON_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (f.endsWith('.gz.tmp') || f.endsWith('.json.part')) { fs.rmSync(full, { force: true }); continue; }
      if (config.backup.compress && BACKUP_RE.test(f) && !f.endsWith('.gz') && !compressing.has(full)) {
        if (fs.existsSync(`${full}.gz`)) fs.rmSync(full, { force: true }); else compressLater([full]);
      }
    }
  }
}

// free space where the backups go (null when it can't be told)
function freeSpace() {
  try { fs.mkdirSync(config.backup.dir, { recursive: true }); const s = fs.statfsSync(config.backup.dir); return { free: s.bavail * s.bsize, total: s.blocks * s.bsize }; } catch { return null; }
}

function runBackup(reason = 'manual') {
  fs.mkdirSync(JSON_DIR, { recursive: true });
  fs.mkdirSync(DB_DIR, { recursive: true });
  const disk = freeSpace();
  if (disk && disk.free < MIN_FREE) {
    const msg = `Backup skipped: only ${(disk.free / 1024 ** 3).toFixed(1)} GB free on the backup drive (at least 1 GB needed)`;
    log.error(msg, { dir: config.backup.dir });
    throw Object.assign(new Error(msg), { status: 507 });
  }
  // Never overwrite an existing backup (two in the same second get a suffix).
  const taken = (n) => ['.db', '.db.gz'].some((e) => fs.existsSync(path.join(DB_DIR, n + e))) || ['.json', '.json.gz'].some((e) => fs.existsSync(path.join(JSON_DIR, n + e)));
  let name = `taskmgr-${stamp()}`;
  for (let i = 2; taken(name); i++) name = `taskmgr-${stamp()}-${i}`;

  // VACUUM INTO writes a consistent, compacted copy even while the app is in use (quick: the database's own
  // copy). The JSON export is then written from that copy in a worker thread, so it matches the .db backup and
  // a large one doesn't hold the app up; then both are compressed (and checked) in the background.
  const dbFile = path.join(DB_DIR, `${name}.db`);
  db.conn.prepare('VACUUM INTO ?').run(dbFile);
  const jsonFile = path.join(JSON_DIR, `${name}.json`);
  compressing.add(dbFile); compressing.add(jsonFile); // not pruned or swept while they're being worked on
  const pruned = prune(DB_DIR) + prune(JSON_DIR);

  try { syncAttachmentFiles(); } catch (err) { log.error('Copying attachment files to the backup folder failed', err.message); }
  const done = jsonInWorker(dbFile, jsonFile).then((j) => {
    if (!j.ok) log.error(`Backup ${name}: the JSON export failed (the .db backup is fine)`, j.error);
    const files = j.ok ? [dbFile, jsonFile] : [dbFile];
    if (!j.ok) compressing.delete(jsonFile);
    if (config.backup.compress) return compressLater(files);
    for (const f of files) compressing.delete(f);
    return null;
  });
  log.info(`Backup completed (${reason})`, { db: dbFile, json: jsonFile, compress: config.backup.compress, removed: pruned });
  // `compressed` resolves once both are compressed and checked (the CLI waits for it)
  return Object.defineProperty({ db: dbFile, json: jsonFile, compressing: config.backup.compress }, 'compressed', { value: done, enumerable: false });
}

function listBackups() {
  const list = (dir, kind) => (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => !f.startsWith('.') && !f.endsWith('.tmp') && !f.endsWith('.part'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { kind, file: f, path: path.join(dir, f), size: st.size, compressed: f.endsWith('.gz'), created_at: (timeOf(f) || st.mtime).toISOString() };
    });
  return [...list(DB_DIR, 'db'), ...list(JSON_DIR, 'json')]
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

// Backs up now if the newest backup is older than the interval, then keeps checking.
function schedule() {
  try { sweep(); } catch (err) { log.warn('Tidying the backup folder', err.message); }
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

module.exports = { runBackup, listBackups, schedule, exportTables, writeJson, syncAttachmentFiles, keepSet, prune, compressFile, freeSpace, sweep, JSON_DIR, DB_DIR, FILES_DIR };
