'use strict';
// 🛡 3-2-1 copies of the backups: besides the local backups (backup.js, on their own schedule), a copy at the end of
// each day to one folder (e.g. a share on another server) and one at the end of each week to another (e.g. a
// cloud-synced folder such as OneDrive) — three copies, on different kinds of storage, one away from the site.
//
// Each copy is a fresh backup (the .db and the JSON export, compressed and checked as usual), copied into the folder
// and checked again there (byte for byte against the local one), with the attachment files it needs (files/). The
// newest `keep` copies are kept in each folder. Set on the Backups page; kept in settings: backup_offsite (the
// set-up) and backup_offsite_state (each one's last run).
//
// Checked every 15 minutes: when the latest time it was due has passed without a copy (the server was off, or the
// folder couldn't be reached), it's made then; after a failure it waits an hour before trying again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const log = require('./logger');
const backup = require('./backup');

const KINDS = ['daily', 'weekly'];
const RETRY_MIN = 60;
const DEFAULT = { daily: { dir: '', time: '22:00', keep: 14 }, weekly: { dir: '', day: 5, time: '22:30', keep: 8 } };
const kv = (k) => db.get('SELECT value FROM settings WHERE key = ?', [k])?.value;
const setKv = (k, v) => db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
const json = (s, d) => { try { const v = JSON.parse(s || ''); return v ?? d; } catch { return d; } };
const pad = (n) => String(n).padStart(2, '0');
const localKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const err400 = (msg) => Object.assign(new Error(msg), { status: 400 });

const config = () => { const c = json(kv('backup_offsite'), {}); return { daily: { ...DEFAULT.daily, ...(c.daily || {}) }, weekly: { ...DEFAULT.weekly, ...(c.weekly || {}) } }; };
const states = () => json(kv('backup_offsite_state'), {});
const saveState = (kind, st) => { const all = states(); all[kind] = { ...(all[kind] || {}), ...st }; setKv('backup_offsite_state', JSON.stringify(all)); return all[kind]; };

// one copy's set-up, checked and tidied (throws a 400 with what's wrong)
function clean(kind, x = {}) {
  const label = kind === 'daily' ? 'The daily copy' : 'The weekly copy';
  const dir = String(x.dir || '').trim().replace(/^"|"$/g, '');
  if (dir && !path.isAbsolute(dir) && !/^\\\\/.test(dir)) throw err400(`${label}: the folder needs a full path, e.g. S:\\Backups or \\\\server\\share\\Backups`);
  const m = String(x.time || DEFAULT[kind].time).trim().match(/^(\d{1,2})[:.h]?(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw err400(`${label}: ${x.time} isn't a time (e.g. 22:00)`);
  const keep = Math.round(Number(x.keep ?? DEFAULT[kind].keep));
  if (!(keep >= 1 && keep <= 365)) throw err400(`${label}: keep between 1 and 365 copies`);
  const out = { dir, time: `${pad(Number(m[1]))}:${m[2]}`, keep };
  if (kind === 'weekly') { const day = Number(x.day ?? DEFAULT.weekly.day); if (!(Number.isInteger(day) && day >= 0 && day <= 6)) throw err400(`${label}: which day of the week?`); out.day = day; }
  return out;
}
function save(body = {}) {
  const c = config(); const next = { ...c };
  for (const k of KINDS) if (body[k]) next[k] = clean(k, { ...c[k], ...body[k] });
  setKv('backup_offsite', JSON.stringify(next));
  return next;
}

// the latest time a copy was due, at or before now (a local 'YYYY-MM-DDTHH:MM')
function lastSlot(kind, c, now = new Date()) {
  const [h, m] = c.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() - i); d.setHours(h, m, 0, 0);
    if (d > now) continue;
    if (kind === 'weekly' && d.getDay() !== c.day) continue;
    return localKey(d);
  }
  return null;
}
function nextSlot(kind, c, now = new Date()) {
  const [h, m] = c.time.split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
    if (d <= now) continue;
    if (kind === 'weekly' && d.getDay() !== c.day) continue;
    return localKey(d);
  }
  return null;
}

const sha = (file) => new Promise((resolve, reject) => { const h = crypto.createHash('sha256'); fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject); });
// copy a file into the folder (as .part, then renamed: a half-copied file never looks like a backup), then check it
async function copyChecked(src, dir) {
  const dst = path.join(dir, path.basename(src)); const part = `${dst}.part`;
  await fs.promises.copyFile(src, part);
  const [a, b] = await Promise.all([sha(src), sha(part)]);
  if (a !== b) { fs.rmSync(part, { force: true }); throw new Error(`${path.basename(src)} didn't copy right (the copy differs)`); }
  fs.renameSync(part, dst);
  return dst;
}
// the newest `keep` backups in the folder stay (by their names); older ones go
function pruneDir(dir, keep) {
  const files = fs.readdirSync(dir).filter((f) => backup.BACKUP_RE.test(f));
  const bases = [...new Set(files.map(backup.baseOf))].sort().reverse();
  const stay = new Set(bases.slice(0, keep)); let removed = 0;
  for (const f of files) if (!stay.has(backup.baseOf(f))) { fs.rmSync(path.join(dir, f), { force: true }); removed += 1; }
  return removed;
}

const running = new Set();
async function run(kind, { slot = null, now = new Date() } = {}) {
  const c = config()[kind]; const at = now.toISOString();
  if (!c.dir) return saveState(kind, { ok: false, at, slot, error: 'No folder set' });
  if (running.has(kind)) return { ...states()[kind], ok: false, error: 'It\'s being copied already' };
  running.add(kind);
  try {
    try { fs.mkdirSync(c.dir, { recursive: true }); } catch (err) { throw new Error(`Can't reach the folder ${c.dir} (${err.code || err.message})`); }
    const b = backup.runBackup(`${kind} 3-2-1 copy`);
    await b.compressed; // compressed and checked locally first (when compression is on)
    const files = [b.db, b.json].map((f) => (fs.existsSync(`${f}.gz`) ? `${f}.gz` : f)).filter((f) => fs.existsSync(f));
    if (!files.length) throw new Error('The backup to copy wasn\'t found');
    const copied = [];
    for (const f of files) copied.push(path.basename(await copyChecked(f, c.dir)));
    // the attachment files (only the ones the folder doesn't have yet)
    let attached = 0;
    if (fs.existsSync(backup.FILES_DIR)) {
      const fdir = path.join(c.dir, 'files'); fs.mkdirSync(fdir, { recursive: true });
      for (const f of fs.readdirSync(backup.FILES_DIR)) {
        if (fs.existsSync(path.join(fdir, f))) continue;
        await copyChecked(path.join(backup.FILES_DIR, f), fdir); attached += 1;
      }
    }
    const removed = pruneDir(c.dir, c.keep);
    log.info(`Backup: ${kind} 3-2-1 copy saved`, { dir: c.dir, files: copied, attachments: attached, removed });
    return saveState(kind, { ok: true, at, slot: slot || lastSlot(kind, c, now), dir: c.dir, files: copied, error: null, failed_at: null });
  } catch (err) {
    log.error(`Backup: the ${kind} 3-2-1 copy failed`, err.message);
    return saveState(kind, { ok: false, at, failed_at: at, error: err.message });
  } finally { running.delete(kind); }
}

// every 15 minutes: a copy whose time has passed since its last one is made (unless it failed in the last hour)
async function tick(now = new Date()) {
  const c = config(); const st = states();
  for (const kind of KINDS) {
    if (!c[kind].dir) continue;
    const slot = lastSlot(kind, c[kind], now);
    if (!slot || (st[kind]?.slot && st[kind].slot >= slot)) continue;
    if (st[kind]?.failed_at && (now - new Date(st[kind].failed_at)) / 60000 < RETRY_MIN) continue;
    await run(kind, { slot, now });
  }
}
function start() {
  const go = () => tick().catch((err) => log.warn('Backup: 3-2-1 copies', err.message));
  setTimeout(go, 60 * 1000).unref();
  setInterval(go, 15 * 60 * 1000).unref();
}
function overview(now = new Date()) {
  const c = config(); const st = states();
  return Object.fromEntries(KINDS.map((k) => [k, { ...c[k], last: st[k] || null, next: c[k].dir ? nextSlot(k, c[k], now) : null }]));
}

module.exports = { config, save, clean, run, tick, start, overview, lastSlot, nextSlot, pruneDir };
